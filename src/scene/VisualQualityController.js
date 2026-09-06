import {
  ENVIRONMENT_DEVICE_TIERS,
  VISUAL_QUALITY_MODES,
  environmentTierSnapshot,
  selectEnvironmentDeviceTier,
  selectInitialVisualQualityMode,
} from './EnvironmentDeviceTier.js';

const STORAGE_KEY = 'golf.visualQuality.v1';
const PROFILE_MODE_ORDER = Object.freeze(['battery', 'balanced', 'quality', 'ultra']);
const EPSILON = 1e-6;

const freezeProfile = (profile) => Object.freeze({
  ...profile,
  minRenderScale: profile.renderScale.min,
  maxRenderScale: profile.renderScale.max,
  initialRenderScale: profile.renderScale.initial,
  renderScale: Object.freeze({ ...profile.renderScale }),
});

// Keep the scene pass at presentation resolution in every mode. Three r185's
// TRAA history is source-resolution, so a sub-native source scale is only a
// spatial stretch, not temporal upscaling. That made the whole course soft and
// caused thin authored foliage to read like a blurry impostor. Performance now
// adapts through bounded workload modes and output pixel caps instead.
export const VISUAL_QUALITY_MODE_PROFILES = Object.freeze({
  battery: freezeProfile({
    id: 'battery',
    targetMs: 33.3,
    renderScale: { min: 1.00, max: 1.00, initial: 1.00 },
    scaleStepDown: 0.06,
    scaleStepUp: 0.04,
  }),
  balanced: freezeProfile({
    id: 'balanced',
    targetMs: 33.3,
    renderScale: { min: 1.00, max: 1.00, initial: 1.00 },
    scaleStepDown: 0.07,
    scaleStepUp: 0.04,
  }),
  quality: freezeProfile({
    id: 'quality',
    // Quality is the high-fidelity 30 fps contract used by the current A18 Pro
    // machine and capable phones. Ultra alone targets the 4090-class 60 fps path.
    targetMs: 33.3,
    renderScale: { min: 1.00, max: 1.00, initial: 1.00 },
    scaleStepDown: 0.08,
    scaleStepUp: 0.05,
  }),
  ultra: freezeProfile({
    id: 'ultra',
    targetMs: 16.7,
    renderScale: { min: 1.00, max: 1.00, initial: 1.00 },
    scaleStepDown: 0.08,
    scaleStepUp: 0.05,
  }),
});

export const VISUAL_QUALITY_PROFILES = VISUAL_QUALITY_MODE_PROFILES;

const MODE_SET = new Set(VISUAL_QUALITY_MODES);

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const integerAtLeast = (value, fallback, minimum = 1) => {
  const candidate = Math.floor(finite(value, fallback));
  return Math.max(minimum, candidate);
};

const normalizeMode = (mode) => {
  if (typeof mode !== 'string' || !MODE_SET.has(mode)) {
    throw new RangeError(`Unknown visual quality mode: ${String(mode)}.`);
  }
  return mode;
};

const profileFor = (mode) => {
  const profile = VISUAL_QUALITY_MODE_PROFILES[mode];
  if (!profile) throw new Error(`Visual quality profile is missing for ${mode}.`);
  return profile;
};

const validMetric = (value) => Number.isFinite(value) && value > 0 ? value : null;

const metricFrom = (sample, names) => {
  for (const name of names) {
    const value = validMetric(sample?.[name]);
    if (value !== null) return value;
  }
  return null;
};

const cloneAdaptation = (adaptation) => adaptation ? { ...adaptation } : null;

const defaultNow = () => {
  if (typeof globalThis !== 'undefined' && typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
};

const browserStorage = () => {
  // Access to browser storage can itself throw in private browsing or when a
  // document's storage policy denies access.  Node tests have neither window nor
  // localStorage, so both paths must remain harmless.
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    return null;
  }
  return null;
};

const readStoredMode = (storage, key) => {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const mode = typeof parsed === 'string' ? parsed : parsed?.mode;
    return typeof mode === 'string' && MODE_SET.has(mode) ? mode : null;
  } catch {
    return null;
  }
};

const writeStoredMode = (storage, key, mode) => {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(key, JSON.stringify({ version: 1, mode }));
    return true;
  } catch {
    return false;
  }
};

const capabilityOptions = (options) => {
  const supplied = options?.capabilities ?? options?.capability;
  const nested = supplied && typeof supplied === 'object'
    ? supplied
    : {};
  const result = { ...nested };
  for (const key of [
    'limits',
    'adapterLimits',
    'deviceLimits',
    'hardwareConcurrency',
    'deviceMemoryGiB',
  ]) {
    if (options?.[key] !== undefined) result[key] = options[key];
  }
  return result;
};

const resolveTier = (options, capabilities) => {
  const supplied = options?.environmentTier
    ?? options?.tier
    ?? capabilities.environmentTier
    ?? capabilities.tier;
  if (typeof supplied === 'string' && ENVIRONMENT_DEVICE_TIERS[supplied]) {
    return ENVIRONMENT_DEVICE_TIERS[supplied];
  }
  if (supplied && ENVIRONMENT_DEVICE_TIERS[supplied.id]) {
    return ENVIRONMENT_DEVICE_TIERS[supplied.id];
  }
  return selectEnvironmentDeviceTier(capabilities);
};

export class VisualQualityController {
  constructor(options = {}) {
    const capabilities = capabilityOptions(options);
    this._tier = resolveTier(options, capabilities);
    this._startingMode = selectInitialVisualQualityMode({
      ...capabilities,
      tier: this._tier,
    });

    this._storageKey = typeof options.storageKey === 'string' && options.storageKey.length > 0
      ? options.storageKey
      : STORAGE_KEY;
    this._persist = options.persist !== false;
    this._storage = options.storage !== undefined ? options.storage : browserStorage();

    const explicitMode = options.mode !== undefined ? options.mode : options.initialMode;
    const restoredMode = explicitMode === undefined && this._persist
      ? readStoredMode(this._storage, this._storageKey)
      : null;
    this._mode = normalizeMode(explicitMode !== undefined
      ? explicitMode
      : restoredMode ?? 'auto');
    this._activeMode = this._mode === 'auto' ? this._startingMode : this._mode;

    this._now = typeof options.now === 'function'
      ? options.now
      : typeof options.clock === 'function' ? options.clock : defaultNow;
    this._ewmaAlpha = clamp(finite(options.ewmaAlpha ?? options.sampleAlpha, 0.12), 0.01, 1);
    this._overloadRatio = Math.max(1.01, finite(options.overloadRatio, 1.08));
    this._recoveryRatio = clamp(finite(options.recoveryRatio, 0.82), 0.10, 0.99);
    this._degradeAfterSamples = integerAtLeast(
      options.degradeAfterSamples ?? options.highPressureSamples,
      8,
    );
    this._upgradeAfterSamples = integerAtLeast(
      options.upgradeAfterSamples ?? options.lowPressureSamples,
      45,
    );
    this._cooldownMs = Math.max(0, finite(options.cooldownMs ?? options.adaptationCooldownMs, 2000));
    this._gpuEwma = null;
    this._frameEwma = null;
    this._sampleCount = 0;
    this._highPressureSamples = 0;
    this._lowPressureSamples = 0;
    this._lastSampleAt = null;
    this._lastAdaptationAt = null;
    this._lastAdaptation = null;
    this._adaptationCount = 0;
    this._presentationLock = null;
    this._nextPresentationLockId = 1;
    this._resetObservation();

    const profile = profileFor(this._activeMode);
    const requestedScale = options.renderScale ?? profile.renderScale.initial;
    this._renderScale = clamp(
      finite(requestedScale, profile.renderScale.initial),
      profile.renderScale.min,
      profile.renderScale.max,
    );
  }

  get mode() {
    return this._mode;
  }

  get activeMode() {
    return this._activeMode;
  }

  get renderScale() {
    return this._renderScale;
  }

  get environmentTier() {
    return this._tier;
  }

  setMode(mode, { persist = true, resetScale = true } = {}) {
    this._assertPresentationUnlocked('change visual quality mode');
    const nextMode = normalizeMode(mode);
    const previousMode = this._mode;
    const previousActiveMode = this._activeMode;
    this._mode = nextMode;
    this._activeMode = nextMode === 'auto' ? this._startingMode : nextMode;

    if (resetScale || previousActiveMode !== this._activeMode) {
      const profile = profileFor(this._activeMode);
      this._renderScale = clamp(
        resetScale ? profile.renderScale.initial : this._renderScale,
        profile.renderScale.min,
        profile.renderScale.max,
      );
    }
    // A manual mode selection starts a new performance observation window. Carrying
    // an EWMA from a different camera, resolution, or workload makes the new mode
    // adapt before it has measured a single representative frame. Keep cumulative
    // sample/adaptation counters for diagnostics, but clear the pressure estimator.
    this._gpuEwma = null;
    this._frameEwma = null;
    this._lastSampleAt = null;
    this._resetObservation();
    this._resetPressureCounters();
    this._lastAdaptation = {
      atMs: null,
      direction: 'manual',
      kind: 'mode',
      fromMode: previousMode,
      toMode: nextMode,
      fromActiveMode: previousActiveMode,
      toActiveMode: this._activeMode,
    };
    // A manual change should not have to wait through the adaptive cooldown
    // before responding to a genuinely overloaded frame stream.
    this._lastAdaptationAt = null;
    if (persist && this._persist) writeStoredMode(this._storage, this._storageKey, nextMode);
    return this.snapshot();
  }

  setRenderScale(scale) {
    this._assertPresentationUnlocked('change render scale');
    const profile = profileFor(this._activeMode);
    if (!Number.isFinite(scale)) throw new RangeError('Render scale must be finite.');
    this._renderScale = clamp(scale, profile.renderScale.min, profile.renderScale.max);
    return this.snapshot();
  }

  // Deterministic captures use the production renderer and scene, but must not let
  // frame-time pressure resize their backing stores halfway through a sequence.
  // This lock is deliberately part of the existing quality policy: it fixes the
  // same mode/scale consumed by applyVisualQuality, then restores every policy and
  // estimator value so diagnostics do not perturb the user's next live frame.
  acquirePresentationLock({ mode = this._activeMode, renderScale } = {}) {
    if (this._presentationLock) {
      throw new Error(`Visual presentation is already locked (${this._presentationLock.id}).`);
    }
    const nextMode = normalizeMode(mode);
    if (nextMode === 'auto') {
      throw new RangeError('Presentation lock requires a fixed visual quality mode.');
    }
    const profile = profileFor(nextMode);
    const nextScale = renderScale === undefined ? profile.renderScale.max : renderScale;
    if (!Number.isFinite(nextScale)) throw new RangeError('Presentation render scale must be finite.');

    const id = `presentation-${this._nextPresentationLockId++}`;
    const previous = this._captureMutableState();
    this._mode = nextMode;
    this._activeMode = nextMode;
    this._renderScale = clamp(nextScale, profile.renderScale.min, profile.renderScale.max);
    this._gpuEwma = null;
    this._frameEwma = null;
    this._lastSampleAt = null;
    this._lastAdaptationAt = null;
    this._resetPressureCounters();
    this._presentationLock = {
      id,
      mode: nextMode,
      renderScale: this._renderScale,
      previous,
    };
    return this.snapshot();
  }

  releasePresentationLock(lockId) {
    const lock = this._presentationLock;
    if (!lock) throw new Error('Visual presentation is not locked.');
    const requestedId = typeof lockId === 'object' && lockId !== null
      ? lockId.id ?? lockId.presentationLock?.id
      : lockId;
    if (requestedId !== lock.id) {
      throw new Error(`Presentation lock token does not match active lock ${lock.id}.`);
    }
    this._restoreMutableState(lock.previous);
    this._presentationLock = null;
    return this.snapshot();
  }

  // Ingest either { gpuMs, frameMs } or the more verbose gpuTimeMs/frameTimeMs
  // names.  A number is accepted as a frame-time shorthand for simple callers.
  ingestSample(sample, atMs) {
    if (this._presentationLock) return this.snapshot();
    const input = typeof sample === 'number' ? { frameMs: sample } : sample;
    if (!input || typeof input !== 'object') return this.snapshot();
    if (input.eligible === false) { this._resetObservation(); return this.snapshot(); }

    const gpuMs = metricFrom(input, ['gpuMs', 'gpuTimeMs', 'gpuFrameMs']);
    const frameMs = metricFrom(input, ['frameMs', 'frameTimeMs', 'cpuFrameMs', 'frame']);
    if (gpuMs === null && frameMs === null) return this.snapshot();

    if (gpuMs !== null) this._gpuEwma = this._nextEwma(this._gpuEwma, gpuMs);
    if (frameMs !== null) this._frameEwma = this._nextEwma(this._frameEwma, frameMs);
    this._sampleCount += 1;

    const requestedAt = atMs !== undefined
      ? atMs
      : input.atMs ?? input.timestampMs ?? input.timeMs;
    const timestamp = Number.isFinite(requestedAt) ? requestedAt : this._now();
    this._lastSampleAt = this._lastSampleAt === null
      ? timestamp
      : Math.max(this._lastSampleAt, timestamp);

    if (this._mode === 'auto') {
      this._observeAuto({ gpuMs, frameMs, cpuMs: metricFrom(input, ['cpuMs']) }, this._lastSampleAt);
      return this.snapshot();
    }
    const pressureMs = this._pressureMs();
    if (pressureMs === null) return this.snapshot();
    const profile = profileFor(this._activeMode);
    if (pressureMs > profile.targetMs * this._overloadRatio) {
      this._highPressureSamples += 1;
      this._lowPressureSamples = 0;
    } else if (pressureMs < profile.targetMs * this._recoveryRatio) {
      this._lowPressureSamples += 1;
      this._highPressureSamples = 0;
    } else {
      this._resetPressureCounters();
    }

    this._maybeAdapt(this._lastSampleAt, profile);
    return this.snapshot();
  }

  // Aliases make the policy usable from frame loops that call their sampler an
  // update or record operation without creating a second state path.
  update(sample, atMs) {
    return this.ingestSample(sample, atMs);
  }

  recordSample(sample, atMs) {
    return this.ingestSample(sample, atMs);
  }

  snapshot() {
    const profile = profileFor(this._activeMode);
    const pressureMs = this._pressureMs();
    const targetMs = this._mode === 'auto' ? 33.3 : profile.targetMs;
    return {
      version: 1,
      mode: this._mode,
      activeMode: this._activeMode,
      startingMode: this._startingMode,
      tierId: this._tier.id,
      environmentTier: environmentTierSnapshot(this._tier),
      profile: {
        id: profile.id,
        targetMs,
        renderScale: { ...profile.renderScale },
      },
      renderScale: this._renderScale,
      renderScaleRange: {
        min: profile.renderScale.min,
        max: profile.renderScale.max,
      },
      targetMs,
      frameTargetMs: targetMs,
      gpuTargetMs: targetMs,
      gpuMs: this._gpuEwma,
      frameMs: this._frameEwma,
      pressureMs,
      ewma: {
        gpuMs: this._gpuEwma,
        frameMs: this._frameEwma,
        pressureMs,
      },
      observation: this._observation.lastWindow ? { ...this._observation.lastWindow } : null,
      promotionTrial: this._observation.trial ? { ...this._observation.trial } : null,
      promotionRetryAfter: this._observation.retryAfter,
      sampleCount: this._sampleCount,
      highPressureSamples: this._highPressureSamples,
      lowPressureSamples: this._lowPressureSamples,
      cooldownMs: this._cooldownMs,
      lastSampleAt: this._lastSampleAt,
      lastAdaptationAt: this._lastAdaptationAt,
      lastAdaptation: cloneAdaptation(this._lastAdaptation),
      adaptationCount: this._adaptationCount,
      presentationLock: this._presentationLock ? {
        active: true,
        id: this._presentationLock.id,
        mode: this._presentationLock.mode,
        renderScale: this._presentationLock.renderScale,
      } : null,
      atLowerRenderScaleBound: this._renderScale <= profile.renderScale.min + EPSILON,
      atUpperRenderScaleBound: this._renderScale >= profile.renderScale.max - EPSILON,
      persistenceAvailable: Boolean(
        this._persist
        && this._storage
        && typeof this._storage.getItem === 'function'
        && typeof this._storage.setItem === 'function',
      ),
    };
  }

  getSnapshot() {
    return this.snapshot();
  }

  _nextEwma(previous, sample) {
    return previous === null
      ? sample
      : previous + this._ewmaAlpha * (sample - previous);
  }

  _pressureMs() {
    const values = [this._gpuEwma, this._frameEwma].filter(Number.isFinite);
    return values.length > 0 ? Math.max(...values) : null;
  }

  _resetPressureCounters() {
    this._highPressureSamples = 0;
    this._lowPressureSamples = 0;
  }

  _assertPresentationUnlocked(action) {
    if (this._presentationLock) {
      throw new Error(`Cannot ${action} while presentation lock ${this._presentationLock.id} is active.`);
    }
  }

  _captureMutableState() {
    return {
      observation: structuredClone(this._observation),
      mode: this._mode,
      activeMode: this._activeMode,
      renderScale: this._renderScale,
      gpuEwma: this._gpuEwma,
      frameEwma: this._frameEwma,
      sampleCount: this._sampleCount,
      highPressureSamples: this._highPressureSamples,
      lowPressureSamples: this._lowPressureSamples,
      lastSampleAt: this._lastSampleAt,
      lastAdaptationAt: this._lastAdaptationAt,
      lastAdaptation: cloneAdaptation(this._lastAdaptation),
      adaptationCount: this._adaptationCount,
    };
  }

  _restoreMutableState(state) {
    this._observation = structuredClone(state.observation);
    this._mode = state.mode;
    this._activeMode = state.activeMode;
    this._renderScale = state.renderScale;
    this._gpuEwma = state.gpuEwma;
    this._frameEwma = state.frameEwma;
    this._sampleCount = state.sampleCount;
    this._highPressureSamples = state.highPressureSamples;
    this._lowPressureSamples = state.lowPressureSamples;
    this._lastSampleAt = state.lastSampleAt;
    this._lastAdaptationAt = state.lastAdaptationAt;
    this._lastAdaptation = cloneAdaptation(state.lastAdaptation);
    this._adaptationCount = state.adaptationCount;
  }

  _resetObservation() {
    this._observation = { startedAt: null, frames: [], gpus: [], cpus: [], overWindows: 0,
      headroomSince: null, trial: null, retryAfter: 0, lastWindow: null };
  }

  _observeAuto({ frameMs, gpuMs, cpuMs }, atMs) {
    const state = this._observation;
    state.startedAt ??= atMs;
    if (frameMs !== null) state.frames.push(frameMs);
    if (gpuMs !== null) state.gpus.push(gpuMs);
    if (cpuMs !== null) state.cpus.push(cpuMs);
    if (atMs - state.startedAt < 2000) return;
    const p95 = values => {
      if (!values.length) return null;
      values.sort((a, b) => a - b);
      return values[Math.ceil(values.length * 0.95) - 1];
    };
    const window = {
      startedAt: state.startedAt, endedAt: atMs,
      frameP95: p95(state.frames), gpuP95: p95(state.gpus), cpuP95: p95(state.cpus),
      frameMean: state.frames.length ? state.frames.reduce((a, b) => a + b, 0) / state.frames.length : null,
    };
    const overloaded = window.gpuP95 > 33.3 || window.cpuP95 > 33.3
      || window.frameP95 > 34 || window.frameMean > 1000 / 30 + 0.1;
    // A complete presentation frame is the conservative fallback on adapters
    // without timestamps; never treat a missing GPU sample as zero GPU cost.
    const headroom = (window.gpuP95 ?? window.frameP95 ?? Infinity) < 27
      && (window.cpuP95 ?? window.frameP95 ?? Infinity) < 27
      && (window.frameP95 ?? Infinity) <= 34;
    window.limitingWork = window.gpuP95 > 33.3 ? 'gpu'
      : window.cpuP95 > 33.3 ? 'cpu' : overloaded ? 'presentation' : 'none';
    state.lastWindow = window;
    state.startedAt = atMs; state.frames = []; state.gpus = []; state.cpus = [];
    state.overWindows = overloaded ? state.overWindows + 1 : 0;
    state.headroomSince = headroom ? state.headroomSince ?? window.startedAt : null;
    if (state.trial && overloaded) {
      this._changeAutoActiveMode(-1, atMs, 'promotion-trial-failed');
      state.trial = null; state.retryAfter = atMs + 30000;
      state.overWindows = 0; state.headroomSince = null;
      return;
    }
    if (state.trial && atMs - state.trial.startedAt >= 5000) state.trial = null;
    if (state.overWindows >= 2) {
      this._changeAutoActiveMode(-1, atMs, 'performance');
      state.overWindows = 0; state.headroomSince = null;
    } else if (!state.trial && atMs >= state.retryAfter && state.headroomSince !== null
      && atMs - state.headroomSince >= 10000) {
      if (this._changeAutoActiveMode(1, atMs, 'headroom')) state.trial = { startedAt: atMs };
      state.headroomSince = null;
    }
  }

  _maybeAdapt(atMs, profile) {
    if (this._lastAdaptationAt !== null && atMs - this._lastAdaptationAt < this._cooldownMs) return;

    if (this._highPressureSamples >= this._degradeAfterSamples) {
      this._adaptDown(atMs, profile);
    } else if (this._lowPressureSamples >= this._upgradeAfterSamples) {
      this._adaptUp(atMs, profile);
    }
  }

  _adaptDown(atMs, profile) {
    const previousScale = this._renderScale;
    const nextScale = clamp(
      previousScale - profile.scaleStepDown,
      profile.renderScale.min,
      profile.renderScale.max,
    );
    if (nextScale < previousScale - EPSILON) {
      this._renderScale = nextScale;
      this._recordAdaptation({
        atMs,
        direction: 'down',
        kind: 'resolution',
        fromScale: previousScale,
        toScale: nextScale,
        mode: this._activeMode,
      });
      return;
    }

    if (this._mode === 'auto') {
      const changed = this._changeAutoActiveMode(-1, atMs, 'performance');
      if (changed) return;
    }
    this._recordBound(atMs, 'down', 'lower-render-scale-bound');
  }

  _adaptUp(atMs, profile) {
    const previousScale = this._renderScale;
    const nextScale = clamp(
      previousScale + profile.scaleStepUp,
      profile.renderScale.min,
      profile.renderScale.max,
    );
    if (nextScale > previousScale + EPSILON) {
      this._renderScale = nextScale;
      this._recordAdaptation({
        atMs,
        direction: 'up',
        kind: 'resolution',
        fromScale: previousScale,
        toScale: nextScale,
        mode: this._activeMode,
      });
      return;
    }

    if (this._mode === 'auto') {
      const changed = this._changeAutoActiveMode(1, atMs, 'headroom');
      if (changed) return;
    }
    this._recordBound(atMs, 'up', 'upper-render-scale-bound');
  }

  _changeAutoActiveMode(delta, atMs, reason) {
    const currentIndex = PROFILE_MODE_ORDER.indexOf(this._activeMode);
    const nextIndex = currentIndex + delta;
    const startingIndex = PROFILE_MODE_ORDER.indexOf(this._startingMode);
    // Auto may recover only as far as the capability-derived starting ceiling.
    // Spare capacity can restore quality without exceeding the hardware ceiling.
    if (delta > 0 && nextIndex > startingIndex) return false;
    const nextMode = PROFILE_MODE_ORDER[nextIndex];
    if (!nextMode) return false;

    const previousMode = this._activeMode;
    const nextProfile = profileFor(nextMode);
    this._activeMode = nextMode;
    this._renderScale = clamp(
      this._renderScale,
      nextProfile.renderScale.min,
      nextProfile.renderScale.max,
    );
    this._recordAdaptation({
      atMs,
      direction: delta < 0 ? 'down' : 'up',
      kind: 'workload',
      fromMode: previousMode,
      toMode: nextMode,
      reason,
      scale: this._renderScale,
    });
    return true;
  }

  _recordAdaptation(adaptation) {
    this._lastAdaptationAt = adaptation.atMs;
    this._lastAdaptation = { ...adaptation };
    this._adaptationCount += 1;
    this._resetPressureCounters();
  }

  _recordBound(atMs, direction, reason) {
    this._lastAdaptationAt = atMs;
    this._lastAdaptation = {
      atMs,
      direction,
      kind: 'bounded',
      mode: this._activeMode,
      scale: this._renderScale,
      reason,
    };
    this._adaptationCount += 1;
    this._resetPressureCounters();
  }
}

export { STORAGE_KEY as VISUAL_QUALITY_STORAGE_KEY };
export { VISUAL_QUALITY_MODES };
