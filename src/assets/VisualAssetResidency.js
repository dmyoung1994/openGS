import {
  VISUAL_ASSET_VARIANTS,
  VisualAssetManifestError,
  getVisualAssetFile,
  loadVisualAssetManifest,
  resolveVisualAssetProfile,
  validateVisualAssetManifest,
} from './VisualAssetManifest.js';

const RESIDENCY_SNAPSHOT_VERSION = 1;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_PROJECTED_WEIGHTS = Object.freeze({ near: 0.5, mid: 0.35, far: 0.15 });
const PRIORITY_BANDS = Object.freeze(['near', 'mid', 'far']);

export class VisualAssetResidencyError extends Error {
  constructor(message, { code = 'VISUAL_ASSET_RESIDENCY_FAILED', fileId, assetId, url, cause } = {}) {
    super(`Visual asset residency failed: ${message}`);
    this.name = 'VisualAssetResidencyError';
    this.code = code;
    if (fileId) this.fileId = fileId;
    if (assetId) this.assetId = assetId;
    if (url) this.url = url;
    if (cause) this.cause = cause;
  }
}

/**
 * Calculate and verify a file's exact byte length and SHA-256 digest.
 * This shared primitive is used by the browser residency path and the offline
 * verifier so the two paths cannot quietly disagree about integrity.
 */
export async function verifyVisualAssetBytes(file, bytes) {
  const view = asUint8Array(bytes);
  if (view.byteLength !== file.bytes) {
    throw new VisualAssetResidencyError(
      `${file.url} has ${view.byteLength} bytes; expected ${file.bytes}`,
      { code: 'VISUAL_ASSET_SIZE_MISMATCH', fileId: file.id, url: file.url },
    );
  }
  const digest = await sha256Bytes(view);
  if (digest !== file.sha256) {
    throw new VisualAssetResidencyError(
      `${file.url} has SHA-256 ${digest}; expected ${file.sha256}`,
      { code: 'VISUAL_ASSET_HASH_MISMATCH', fileId: file.id, url: file.url },
    );
  }
  return Object.freeze({
    fileId: file.id,
    url: file.url,
    bytes: view.byteLength,
    sha256: digest,
  });
}

export async function sha256Bytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new VisualAssetResidencyError(
      'Web Crypto SHA-256 is required for fail-closed visual asset verification',
      { code: 'VISUAL_ASSET_CRYPTO_UNAVAILABLE' },
    );
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', asUint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Progressive visual-file residency coordinator.
 *
 * It does not create or replace Three.js loaders.  Consumers request a
 * manifest variant, receive a deterministic projected-need plan, and await a
 * promise that resolves only after every requested file has passed exact size
 * and hash verification.  A failed file is never substituted or marked ready.
 */
export class VisualAssetResidency {
  constructor({
    manifest,
    fetchImpl = globalThis.fetch,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    now = defaultNow,
  } = {}) {
    if (!manifest) throw new VisualAssetManifestError('manifest is required');
    this.manifest = manifest?.assetById instanceof Map
      ? manifest
      : validateVisualAssetManifest(manifest);
    if (typeof fetchImpl !== 'function') {
      throw new VisualAssetResidencyError('fetch is required', { code: 'VISUAL_ASSET_FETCH_UNAVAILABLE' });
    }
    // Browser-native fetch performs a receiver check. Storing it directly and
    // later invoking `this.fetchImpl(...)` binds the residency object as `this`,
    // which Chrome rejects with "Illegal invocation". The lexical wrapper keeps
    // native fetch as a normal function call while preserving injectable tests.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.maxConcurrent = clampInteger(maxConcurrent, 1, 32, DEFAULT_MAX_CONCURRENT);
    this._now = typeof now === 'function' ? now : defaultNow;
    this._filePromises = new Map();
    this._fileStates = new Map(this.manifest.files.map((file) => [file.id, {
      fileId: file.id,
      url: file.url,
      state: 'idle',
      startedAt: null,
      verifiedAt: null,
      bytes: file.bytes,
      memoryBytes: file.memoryBytes,
      error: null,
    }]));
    this._profilePromises = new Map();
    this._profileRequests = new Map();
  }

  static async load(
    url = '/assets/visual-quality-manifest.json',
    { fetchImpl = globalThis.fetch, ...options } = {},
  ) {
    const manifest = await loadVisualAssetManifest(url, fetchImpl);
    return new VisualAssetResidency({ manifest, fetchImpl, ...options });
  }

  static fromManifest(manifest, options = {}) {
    return new VisualAssetResidency({ manifest, ...options });
  }

  /**
   * Return the load order for a profile.  `projectedNeed` can be:
   *   - a number in [0, 1] applied to every asset;
   *   - { near, mid, far } camera-band weights;
   *   - a Map/object keyed by asset ID; or
   *   - a function receiving the resolved profile entry.
   */
  plan(variantName = 'critical', {
    projectedNeed,
    includeOptional = true,
  } = {}) {
    assertVariantName(variantName);
    if (typeof includeOptional !== 'boolean') {
      throw new VisualAssetResidencyError('includeOptional must be boolean', { code: 'VISUAL_ASSET_PLAN_INVALID' });
    }
    const profile = resolveVisualAssetProfile(this.manifest, variantName);
    const entries = profile.entries
      .filter((entry) => includeOptional || entry.required)
      .map((entry) => {
        const projected = projectedNeedFor(entry, projectedNeed);
        const priorityScore = entry.priority.base * (0.25 + projected * 0.75);
        return {
          ...entry,
          projectedNeed: projected,
          priorityScore,
        };
      });

    // Required work is kept at the front so a critical readiness promise can
    // establish a valid scene quickly.  Within each class projected screen
    // need is the deterministic ordering signal.
    entries.sort((left, right) => (
      Number(right.required) - Number(left.required)
      || right.priorityScore - left.priorityScore
      || left.assetId.localeCompare(right.assetId)
    ));

    const fileIds = new Set(entries.map((entry) => entry.file.id));
    const files = [...fileIds].map((fileId) => this.manifest.fileById.get(fileId));
    return Object.freeze({
      version: RESIDENCY_SNAPSHOT_VERSION,
      variant: variantName,
      profileVersion: profile.version,
      includeOptional,
      entries: Object.freeze(entries.map((entry, index) => Object.freeze({
        assetId: entry.assetId,
        required: entry.required,
        kind: entry.kind,
        semantic: entry.semantic,
        variant: entry.variant,
        file: entry.file,
        projectedNeed: entry.projectedNeed,
        priorityScore: entry.priorityScore,
        order: index,
      }))),
      files: Object.freeze(files),
      transferBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      memoryBytes: files.reduce((sum, file) => sum + file.memoryBytes, 0),
      requiredCount: entries.filter((entry) => entry.required).length,
      optionalCount: entries.filter((entry) => !entry.required).length,
    });
  }

  /** Request and verify a profile. The promise rejects on any missing/changed file. */
  ready(variantName = 'critical', {
    projectedNeed,
    includeOptional = true,
    signal,
    onStage,
  } = {}) {
    const plan = this.plan(variantName, { projectedNeed, includeOptional });
    const cacheable = projectedNeed === undefined && !signal;
    const cacheKey = `${variantName}:${includeOptional ? 'all' : 'required'}`;
    if (cacheable && this._profilePromises.has(cacheKey)) return this._profilePromises.get(cacheKey);

    this._profileRequests.set(cacheKey, {
      variant: variantName,
      includeOptional,
      plan,
      state: 'loading',
      requestedAt: this._now(),
      completedAt: null,
      error: null,
    });

    const promise = this._runPlan(plan, { signal, onStage })
      .then(() => {
        const request = this._profileRequests.get(cacheKey);
        if (request) {
          request.state = 'ready';
          request.completedAt = this._now();
        }
        const snapshot = this.snapshot(variantName);
        return Object.freeze({
          ...snapshot,
          ready: includeOptional ? snapshot.allReady : snapshot.requiredReady,
          readyFor: includeOptional ? 'all' : 'required',
        });
      })
      .catch((cause) => {
        const request = this._profileRequests.get(cacheKey);
        if (request) {
          request.state = 'failed';
          request.completedAt = this._now();
          request.error = errorMessage(cause);
        }
        throw cause;
      });

    if (cacheable) this._profilePromises.set(cacheKey, promise);
    return promise;
  }

  readinessPromise(variantName = 'critical', options = {}) {
    return this.ready(variantName, options);
  }

  request(variantName = 'critical', options = {}) {
    return this.ready(variantName, options);
  }

  /** Verify an individual manifest file without changing any existing loader. */
  verifyFile(fileOrId, { signal, onStage } = {}) {
    const file = typeof fileOrId === 'string'
      ? getVisualAssetFile(this.manifest, fileOrId)
      : fileOrId;
    if (!file?.id || !this.manifest.fileById.has(file.id)) {
      throw new VisualAssetResidencyError('unknown manifest file', { code: 'VISUAL_ASSET_FILE_UNKNOWN' });
    }
    return this._ensureFile(file, { signal, onStage });
  }

  snapshot(variantName = null) {
    if (variantName !== null) assertVariantName(variantName);
    const states = [...this._fileStates.values()];
    const verified = states.filter((state) => state.state === 'verified');
    const loading = states.filter((state) => state.state === 'loading');
    const failed = states.filter((state) => state.state === 'failed');
    const profile = variantName ? resolveVisualAssetProfile(this.manifest, variantName) : null;
    const profileState = profile ? {
      variant: variantName,
      requiredReady: profile.entries
        .filter((entry) => entry.required)
        .every((entry) => this._fileStates.get(entry.file.id)?.state === 'verified'),
      allReady: profile.entries
        .every((entry) => this._fileStates.get(entry.file.id)?.state === 'verified'),
      fileCount: profile.fileCount,
      transferBytes: profile.transferBytes,
      memoryBytes: profile.memoryBytes,
    } : null;

    return {
      version: RESIDENCY_SNAPSHOT_VERSION,
      manifestVersion: this.manifest.version,
      manifestId: this.manifest.manifestId,
      requestedVariant: variantName,
      ready: profileState?.allReady ?? false,
      requiredReady: profileState?.requiredReady ?? false,
      allReady: profileState?.allReady ?? false,
      profile: profileState,
      files: {
        total: states.length,
        verified: verified.length,
        loading: loading.length,
        failed: failed.length,
        idle: states.length - verified.length - loading.length - failed.length,
        verifiedBytes: verified.reduce((sum, state) => sum + state.bytes, 0),
        residentMemoryBytes: verified.reduce((sum, state) => sum + state.memoryBytes, 0),
      },
      fileStates: states.map((state) => ({ ...state })),
      requests: [...this._profileRequests.values()].map((request) => ({
        variant: request.variant,
        includeOptional: request.includeOptional,
        state: request.state,
        requestedAt: request.requestedAt,
        completedAt: request.completedAt,
        error: request.error,
      })),
    };
  }

  getSnapshot(variantName = null) {
    return this.snapshot(variantName);
  }

  async _runPlan(plan, { signal, onStage } = {}) {
    const queue = [...plan.entries];
    let cursor = 0;
    const workerCount = Math.min(this.maxConcurrent, Math.max(queue.length, 1));
    const worker = async () => {
      while (cursor < queue.length) {
        const entry = queue[cursor++];
        await this._ensureFile(entry.file, {
          signal,
          assetId: entry.assetId,
          onStage,
        });
      }
    };
    // Drain every worker before rejecting.  This leaves snapshots truthful
    // (no sibling fetch remains in an unexplained `loading` state after a
    // failed readiness promise) while still failing the whole request closed.
    const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  _ensureFile(file, { signal, assetId, onStage } = {}) {
    if (this._filePromises.has(file.id)) return this._filePromises.get(file.id);
    const state = this._fileStates.get(file.id);
    const request = Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw abortError();
        state.state = 'loading';
        state.startedAt = this._now();
        onStage?.({ stage: 'loading', fileId: file.id, assetId, url: file.url });
        // Preloads/loaders may already have fetched this exact URL. Honor HTTP
        // freshness/revalidation instead of downloading it again unconditionally;
        // cached responses still pass the same size + SHA-256 verification below.
        return this.fetchImpl(file.url, { cache: 'default', signal });
      })
      .then((response) => {
        if (!response?.ok) {
          throw new VisualAssetResidencyError(
            `${file.url} is unavailable (${response?.status ?? 'network error'})`,
            { code: 'VISUAL_ASSET_UNAVAILABLE', fileId: file.id, assetId, url: file.url },
          );
        }
        if (typeof response.arrayBuffer !== 'function') {
          throw new VisualAssetResidencyError(
            `${file.url} response has no arrayBuffer()`,
            { code: 'VISUAL_ASSET_RESPONSE_INVALID', fileId: file.id, assetId, url: file.url },
          );
        }
        return response.arrayBuffer();
      })
      .then((bytes) => verifyVisualAssetBytes(file, bytes))
      .then((result) => {
        state.state = 'verified';
        state.verifiedAt = this._now();
        state.error = null;
        onStage?.({ stage: 'verified', fileId: file.id, assetId, url: file.url, bytes: result.bytes });
        return result;
      })
      .catch((cause) => {
        state.state = 'failed';
        state.error = errorMessage(cause);
        onStage?.({ stage: 'failed', fileId: file.id, assetId, url: file.url, error: state.error });
        if (cause instanceof VisualAssetResidencyError) throw cause;
        throw new VisualAssetResidencyError(
          `${file.url}: ${cause.message}`,
          { code: 'VISUAL_ASSET_FETCH_FAILED', fileId: file.id, assetId, url: file.url, cause },
        );
      });
    this._filePromises.set(file.id, request);
    // A failed attempt is not treated as a valid cache entry.  A later explicit
    // retry can fetch the exact same URL again, but it still has to pass hashes.
    request.catch(() => {
      if (this._filePromises.get(file.id) === request) this._filePromises.delete(file.id);
    });
    return request;
  }
}

export async function createVisualAssetResidency(
  url = '/assets/visual-quality-manifest.json',
  options = {},
) {
  return VisualAssetResidency.load(url, options);
}

function projectedNeedFor(entry, projectedNeed) {
  const priority = entry.priority;
  let value;
  if (projectedNeed === undefined || projectedNeed === null) {
    value = weightedProjectedNeed(priority.projectedNeed, DEFAULT_PROJECTED_WEIGHTS);
  } else if (typeof projectedNeed === 'function') {
    value = projectedNeed(entry);
  } else if (typeof projectedNeed === 'number') {
    value = projectedNeed;
  } else if (projectedNeed instanceof Map) {
    value = projectedNeed.has(entry.assetId)
      ? projectedNeed.get(entry.assetId)
      : weightedProjectedNeed(priority.projectedNeed, DEFAULT_PROJECTED_WEIGHTS);
  } else if (typeof projectedNeed === 'object') {
    if (Object.prototype.hasOwnProperty.call(projectedNeed, entry.assetId)) {
      value = projectedNeed[entry.assetId];
    } else if (PRIORITY_BANDS.some((band) => Object.prototype.hasOwnProperty.call(projectedNeed, band))) {
      value = weightedProjectedNeed(priority.projectedNeed, projectedNeed);
    } else {
      value = weightedProjectedNeed(priority.projectedNeed, DEFAULT_PROJECTED_WEIGHTS);
    }
  }
  if (!Number.isFinite(value)) {
    throw new VisualAssetResidencyError(
      `projected need for ${entry.assetId} must be a finite number`,
      { code: 'VISUAL_ASSET_PROJECTED_NEED_INVALID', assetId: entry.assetId },
    );
  }
  return clamp(value, 0, 1);
}

function weightedProjectedNeed(projected, weights) {
  let weightTotal = 0;
  let value = 0;
  for (const band of PRIORITY_BANDS) {
    const weight = Number.isFinite(weights?.[band]) && weights[band] > 0 ? weights[band] : 0;
    weightTotal += weight;
    value += projected[band] * weight;
  }
  return weightTotal > 0 ? value / weightTotal : 0;
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new VisualAssetResidencyError('asset bytes must be an ArrayBuffer or typed array', {
    code: 'VISUAL_ASSET_BYTES_INVALID',
  });
}

function assertVariantName(value) {
  if (typeof value !== 'string' || !VISUAL_ASSET_VARIANTS.includes(value)) {
    throw new VisualAssetResidencyError(
      `variant must be one of ${VISUAL_ASSET_VARIANTS.join(', ')}`,
      { code: 'VISUAL_ASSET_VARIANT_INVALID' },
    );
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value, min, max, fallback) {
  const candidate = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, candidate));
}

function defaultNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function errorMessage(error) {
  return error?.message || String(error);
}

function abortError() {
  return new VisualAssetResidencyError('request was aborted', { code: 'VISUAL_ASSET_ABORTED' });
}
