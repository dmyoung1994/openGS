/**
 * Strict, versioned environment-asset catalog.
 *
 * This module intentionally has no renderer dependency.  Course parsing uses the
 * synchronous validator to make authoring deterministic, while the renderer must
 * call loadEnvironmentCatalog before it consumes a runtime asset.  That second
 * step verifies every declared binary hash: an absent or changed derivative is a
 * startup error, never a substitute asset or lower-quality path.
 */

export const ENVIRONMENT_CATALOG_VERSION = 2;
export const ENVIRONMENT_OBJECT_BUDGET = 3000;
// Course validation is synchronous so it can reject a bad live edit before a
// renderer fetch begins. Keep this list in lockstep with catalog.json; the
// catalog's own loader remains the authoritative integrity check for binaries.
export const BUILTIN_ENVIRONMENT_ASSETS = Object.freeze({
  'polyhaven-tree-small-02': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 2.3 }),
    placement: Object.freeze({ minSpacing: 5, clearance: Object.freeze({ tee: 12, green: 18, bunker: 8, water: 6, fairway: 10 }) }),
  }),
  'polyhaven-island-tree-01': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 2.5 }),
    placement: Object.freeze({ minSpacing: 7, clearance: Object.freeze({ tee: 12, green: 18, bunker: 8, water: 6, fairway: 10 }) }),
  }),
  'polyhaven-fern-02': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 1.4 }),
    placement: Object.freeze({ minSpacing: 1.8, clearance: Object.freeze({ tee: 8, green: 4, bunker: 3, water: 2, fairway: 6 }) }),
  }),
  'polyhaven-boulder-01': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 1.0 }),
    placement: Object.freeze({ minSpacing: 2.2, clearance: Object.freeze({ tee: 12, green: 14, bunker: 5, water: 3, fairway: 5 }) }),
  }),
  'polyhaven-dead-tree-trunk': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 1.55 }),
    placement: Object.freeze({ minSpacing: 4, clearance: Object.freeze({ tee: 12, green: 12, bunker: 5, water: 3, fairway: 7 }) }),
  }),
  'polyhaven-fir-tree-01': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 3.30 }),
    placement: Object.freeze({ minSpacing: 7, clearance: Object.freeze({ tee: 12, green: 18, bunker: 8, water: 6, fairway: 8 }) }),
  }),
  'polyhaven-fir-tree-01-variant-b': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 3.15 }),
    placement: Object.freeze({ minSpacing: 7, clearance: Object.freeze({ tee: 12, green: 18, bunker: 8, water: 6, fairway: 8 }) }),
  }),
  'polyhaven-fir-tree-01-variant-c': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 3.20 }),
    placement: Object.freeze({ minSpacing: 7, clearance: Object.freeze({ tee: 12, green: 18, bunker: 8, water: 6, fairway: 8 }) }),
  }),
  'polyhaven-pine-tree-01': Object.freeze({
    biomes: Object.freeze(['temperate-maritime', 'temperate-alpine']),
    bounds: Object.freeze({ radius: 4.05 }),
    placement: Object.freeze({ minSpacing: 8, clearance: Object.freeze({ tee: 12, green: 18, bunker: 8, water: 6, fairway: 8 }) }),
  }),
});
export const BUILTIN_ENVIRONMENT_ASSET_IDS = Object.freeze(Object.keys(BUILTIN_ENVIRONMENT_ASSETS));

// Licences a runtime asset may ship under. CC0 remains the default and covers every
// Poly Haven derivative. BlenderKit's free tier is "Royalty Free", not CC0: it permits
// use of the model inside a rendered/interactive product but restricts redistributing
// the asset itself, so it is recorded as an explicit SPDX LicenseRef rather than being
// quietly folded into CC0. Each such asset must name its BlenderKit source in
// `derivativeLineage.sourceUrl` and carry a provenance doc under docs/.
export const ACCEPTED_LICENSES = Object.freeze(new Set([
  'CC0-1.0',
  'LicenseRef-BlenderKit-RoyaltyFree',
]));

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const URL_RE = /^https:\/\/.+/;
const ASSET_KEYS = new Set([
  'id', 'category', 'biomes', 'license', 'derivativeLineage', 'dimensions',
  'bounds', 'placement', 'grounding', 'lods', 'impostor', 'wind',
]);
const ROOT_KEYS = new Set(['version', 'catalogId', 'assets']);
const CATEGORIES = new Set(['tree', 'shrub', 'groundcover', 'deadwood', 'rock', 'wall', 'building']);
const BIOMES = new Set(['temperate-maritime', 'temperate-alpine']);

export class EnvironmentCatalogError extends Error {
  constructor(message) {
    super(`Environment catalog invalid: ${message}`);
    this.name = 'EnvironmentCatalogError';
  }
}

export function validateEnvironmentCatalog(raw) {
  const catalog = strictObject(raw, 'catalog');
  rejectUnknown(catalog, ROOT_KEYS, 'catalog');
  exactNumber(catalog.version, 'catalog.version');
  if (catalog.version !== ENVIRONMENT_CATALOG_VERSION) {
    fail(`catalog.version must be ${ENVIRONMENT_CATALOG_VERSION}`);
  }
  identifier(catalog.catalogId, 'catalog.catalogId');
  if (!Array.isArray(catalog.assets) || catalog.assets.length === 0) fail('catalog.assets must be a non-empty array');

  const byId = new Map();
  for (let index = 0; index < catalog.assets.length; index++) {
    const asset = validateAsset(catalog.assets[index], `catalog.assets[${index}]`);
    if (byId.has(asset.id)) fail(`duplicate asset id "${asset.id}"`);
    byId.set(asset.id, asset);
  }

  // Map insertion follows the manifest order, but callers must never derive
  // placement identity from that order. Stable IDs are the sole lookup key.
  return Object.freeze({
    version: catalog.version,
    catalogId: catalog.catalogId,
    assets: Object.freeze([...byId.values()]),
    byId,
  });
}

export function getCatalogAsset(catalog, assetId) {
  const asset = catalog?.byId?.get(assetId);
  if (!asset) fail(`unknown asset id "${assetId}"`);
  return asset;
}

/**
 * Fetch and validate the catalog manifest. Binary verification is intentionally
 * a separate operation: callers can parse the course and identify the exact
 * asset IDs that can be reached by this build before paying to hash unrelated
 * catalog derivatives.
 */
export async function loadEnvironmentCatalog(url = '/assets/environment/catalog.json', {
  fetchImpl = globalThis.fetch, assetIds, onStage, memoize = false,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new EnvironmentCatalogError('fetch is required to load runtime assets');
  onStage?.({ stage: 'catalog-fetch', completed: 0, total: 1 });
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response?.ok) throw new EnvironmentCatalogError(`catalog load failed: ${response?.status ?? 'network error'}`);
  let raw;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new EnvironmentCatalogError(`catalog JSON parse failed: ${cause.message}`);
  }
  const catalog = validateEnvironmentCatalog(raw);
  onStage?.({ stage: 'catalog-ready', completed: 1, total: 1, catalog });
  // Keep the old all-assets behavior when no selection is supplied. This makes
  // the catalog helper safe for release audits and preserves its standalone API;
  // the production bootstrap passes [] first, then verifies course references.
  if (assetIds === undefined) await verifyEnvironmentCatalogAssets(catalog, { fetchImpl, onStage });
  else {
    if (!assetIds || typeof assetIds[Symbol.iterator] !== 'function') {
      throw new EnvironmentCatalogError('assetIds must be an iterable of catalog IDs');
    }
    assetIds = [...assetIds];
    if (assetIds.length > 0) await verifyEnvironmentCatalogAssets(catalog, { fetchImpl, assetIds, onStage, memoize });
  }
  return catalog;
}

/**
 * Verify every binary derivative reachable from the supplied asset IDs.
 *
 * A used asset always verifies all declared GLB LODs and its baked atlas before
 * the caller may build a production Range. An empty ID list is a deliberate
 * metadata-only operation. Unknown IDs fail closed rather than being ignored.
 */
export async function verifyEnvironmentCatalogAssets(catalog, {
  fetchImpl = globalThis.fetch, assetIds, onStage, memoize = false,
} = {}) {
  if (!catalog?.assets || !(catalog.byId instanceof Map)) {
    throw new EnvironmentCatalogError('a validated catalog is required for binary verification');
  }
  if (typeof fetchImpl !== 'function') throw new EnvironmentCatalogError('fetch is required to load runtime assets');
  const selected = selectCatalogAssets(catalog, assetIds);
  const files = selected.flatMap((asset) => {
    const derivatives = asset.lods.map((lod) => ({
      assetId: asset.id, url: lod.url, sha256: lod.sha256, label: `LOD ${lod.level}`,
    }));
    if (asset.impostor.kind === 'baked-atlas') derivatives.push({
      assetId: asset.id, url: asset.impostor.url, sha256: asset.impostor.sha256, label: 'baked impostor atlas',
    });
    return derivatives;
  });
  const cacheKey = (file) => `${catalog.catalogId}@${catalog.version}:${file.url}:${file.sha256}`;
  const pending = memoize ? files.filter((file) => !verifiedDerivativeKeys.has(cacheKey(file))) : files;
  onStage?.({ stage: 'asset-integrity', completed: files.length - pending.length, total: files.length, assetIds: selected.map((asset) => asset.id) });
  let completed = 0;
  // Do not retain response bodies after hashing. A small worker pool keeps the
  // network busy without retaining one 40+ MB ArrayBuffer for every derivative
  // at once; GLTFLoader/TextureLoader owns the later runtime decode separately.
  let nextFile = 0;
  const verifyNext = async () => {
    while (nextFile < pending.length) {
      const file = pending[nextFile++];
      // `reload` bypasses a stale browser entry but permits the response to be
      // written to HTTP cache. The immediately-following GLTFLoader/TextureLoader
      // can therefore reuse these verified bytes instead of issuing a second
      // no-store transfer. Catalog JSON itself remains no-store above.
      const assetResponse = await fetchImpl(file.url, { cache: 'reload' });
      if (!assetResponse?.ok) throw new EnvironmentCatalogError(`${file.assetId} ${file.label} unavailable: ${file.url}`);
      const bytes = await assetResponse.arrayBuffer();
      const digest = await sha256(bytes);
      if (digest !== file.sha256) {
        throw new EnvironmentCatalogError(`${file.assetId} ${file.label} hash mismatch for ${file.url}`);
      }
      if (memoize) verifiedDerivativeKeys.add(cacheKey(file));
      completed += 1;
      onStage?.({ stage: 'asset-integrity', completed: files.length - pending.length + completed, total: files.length, assetIds: selected.map((asset) => asset.id) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, verifyNext));
  onStage?.({ stage: 'asset-integrity-ready', completed: files.length, total: files.length, assetIds: selected.map((asset) => asset.id) });
  return Object.freeze({ assetIds: Object.freeze(selected.map((asset) => asset.id)), files: files.length });
}

// Metadata-only memoization: no response bodies are retained. The key includes
// the no-store catalog identity and declared digest, so an edited manifest never
// inherits an old verification result. Production rebuilds opt into this cache
// after a successful startup to avoid rehashing unchanged derivatives.
const verifiedDerivativeKeys = new Set();

function selectCatalogAssets(catalog, assetIds) {
  if (assetIds === undefined) return catalog.assets;
  if (!assetIds || typeof assetIds[Symbol.iterator] !== 'function') {
    throw new EnvironmentCatalogError('assetIds must be an iterable of catalog IDs');
  }
  const ids = [...new Set(assetIds)];
  return ids.map((id) => {
    const asset = catalog.byId.get(id);
    if (!asset) throw new EnvironmentCatalogError(`unknown asset id "${id}"`);
    return asset;
  });
}

/** Return all IDs mentioned by a normalized course environment declaration. */
export function collectEnvironmentAssetIds(course) {
  const ids = new Set();
  const environment = course?.environment;
  if (!environment) return ids;
  for (const record of environment.placements || []) if (record.assetId) ids.add(record.assetId);
  for (const kind of ['scatter', 'assembly', 'edgeDressing']) {
    for (const record of environment[kind] || []) for (const assetId of record.assetIds || []) ids.add(assetId);
  }
  return ids;
}

function validateAsset(raw, path) {
  const asset = strictObject(raw, path);
  rejectUnknown(asset, ASSET_KEYS, path);
  identifier(asset.id, `${path}.id`);
  enumValue(asset.category, CATEGORIES, `${path}.category`);
  if (!Array.isArray(asset.biomes) || asset.biomes.length === 0) fail(`${path}.biomes must be a non-empty array`);
  asset.biomes.forEach((biome, i) => enumValue(biome, BIOMES, `${path}.biomes[${i}]`));
  const license = strictObject(asset.license, `${path}.license`);
  rejectUnknown(license, new Set(['spdx', 'sourceUrl']), `${path}.license`);
  if (!ACCEPTED_LICENSES.has(license.spdx)) {
    fail(`${path}.license.spdx must be one of ${[...ACCEPTED_LICENSES].join(', ')}`);
  }
  httpsUrl(license.sourceUrl, `${path}.license.sourceUrl`);

  const lineage = strictObject(asset.derivativeLineage, `${path}.derivativeLineage`);
  rejectUnknown(lineage, new Set(['sourceAssetId', 'sourceUrl', 'sourceHash', 'pipelineVersion']), `${path}.derivativeLineage`);
  identifier(lineage.sourceAssetId, `${path}.derivativeLineage.sourceAssetId`);
  httpsUrl(lineage.sourceUrl, `${path}.derivativeLineage.sourceUrl`);
  hash(lineage.sourceHash, `${path}.derivativeLineage.sourceHash`);
  nonEmptyString(lineage.pipelineVersion, `${path}.derivativeLineage.pipelineVersion`);

  const dimensions = vectorObject(asset.dimensions, `${path}.dimensions`, ['width', 'height', 'depth'], 0);
  const bounds = vectorObject(asset.bounds, `${path}.bounds`, ['radius', 'baseY', 'topY'], undefined);
  if (!(bounds.radius > 0 && bounds.topY > bounds.baseY)) fail(`${path}.bounds must describe a positive volume`);
  const placement = strictObject(asset.placement, `${path}.placement`);
  rejectUnknown(placement, new Set(['minSpacing', 'maxSlopeDegrees', 'clearance']), `${path}.placement`);
  positive(placement.minSpacing, `${path}.placement.minSpacing`);
  range(placement.maxSlopeDegrees, 0, 90, `${path}.placement.maxSlopeDegrees`);
  const clearance = strictObject(placement.clearance, `${path}.placement.clearance`);
  rejectUnknown(clearance, new Set(['tee', 'green', 'bunker', 'water', 'fairway']), `${path}.placement.clearance`);
  for (const key of ['tee', 'green', 'bunker', 'water', 'fairway']) positive(clearance[key], `${path}.placement.clearance.${key}`, true);
  const grounding = strictObject(asset.grounding, `${path}.grounding`);
  rejectUnknown(grounding, new Set(['burialFraction']), `${path}.grounding`);
  range(grounding.burialFraction, 0, 0.4, `${path}.grounding.burialFraction`);

  if (!Array.isArray(asset.lods) || asset.lods.length === 0) fail(`${path}.lods must be a non-empty array`);
  const lods = asset.lods.map((lod, i) => validateLod(lod, `${path}.lods[${i}]`));
  const levels = new Set(lods.map((lod) => lod.level));
  if (levels.size !== lods.length || !levels.has(0)) fail(`${path}.lods must include unique level 0`);
  for (let i = 0; i < lods.length; i++) {
    if (lods[i].level !== i) fail(`${path}.lods must be ordered contiguous levels starting at 0`);
    if (i > 0 && lods[i].maxDistance <= lods[i - 1].maxDistance) {
      fail(`${path}.lods maxDistance values must increase with each level`);
    }
  }
  const impostor = validateImpostor(asset.impostor, `${path}.impostor`, levels);
  const wind = validateWind(asset.wind, `${path}.wind`);
  return Object.freeze({
    id: asset.id, category: asset.category, biomes: Object.freeze([...asset.biomes]),
    license: Object.freeze({ ...license }), derivativeLineage: Object.freeze({ ...lineage }),
    dimensions: Object.freeze(dimensions), bounds: Object.freeze(bounds), grounding: Object.freeze({ ...grounding }),
    placement: Object.freeze({ ...placement, clearance: Object.freeze({ ...clearance }) }),
    lods: Object.freeze(lods), impostor: Object.freeze(impostor), wind: Object.freeze(wind),
  });
}

function validateLod(raw, path) {
  const lod = strictObject(raw, path);
  rejectUnknown(lod, new Set(['level', 'url', 'sha256', 'maxDistance', 'geometry']), path);
  if (!Number.isInteger(lod.level) || lod.level < 0) fail(`${path}.level must be an integer >= 0`);
  if (typeof lod.url !== 'string' || !lod.url.startsWith('/assets/')) fail(`${path}.url must be a public /assets/ path`);
  hash(lod.sha256, `${path}.sha256`);
  positive(lod.maxDistance, `${path}.maxDistance`);
  if (lod.geometry !== 'glb') fail(`${path}.geometry must be glb`);
  return Object.freeze({ ...lod });
}

function validateImpostor(raw, path, levels) {
  const impostor = strictObject(raw, path);
  if (impostor.kind === 'none') {
    rejectUnknown(impostor, new Set(['kind']), path);
    return { kind: 'none' };
  }
  rejectUnknown(impostor, new Set([
    'kind', 'url', 'sha256', 'sourceLod', 'generator', 'azimuthFrames',
    'elevationFrames', 'columns', 'rows', 'frameSize', 'normalDepth',
    'cardAspect', 'frameUv',
  ]), path);
  if (impostor.kind !== 'baked-atlas') fail(`${path}.kind must be baked-atlas`);
  if (typeof impostor.url !== 'string' || !impostor.url.startsWith('/assets/')) fail(`${path}.url must be a public /assets/ path`);
  hash(impostor.sha256, `${path}.sha256`);
  if (!levels.has(impostor.sourceLod)) fail(`${path}.sourceLod must identify a declared LOD`);
  nonEmptyString(impostor.generator, `${path}.generator`);
  for (const key of ['azimuthFrames', 'elevationFrames', 'columns', 'rows', 'frameSize']) {
    if (!Number.isInteger(impostor[key]) || impostor[key] < 1) fail(`${path}.${key} must be a positive integer`);
  }
  if (impostor.columns * impostor.rows < impostor.azimuthFrames * impostor.elevationFrames) {
    fail(`${path} atlas grid cannot contain all declared frames`);
  }
  if (typeof impostor.normalDepth !== 'boolean') fail(`${path}.normalDepth must be boolean`);
  if (impostor.cardAspect !== undefined
    && (typeof impostor.cardAspect !== 'number' || !Number.isFinite(impostor.cardAspect)
      || impostor.cardAspect <= 0 || impostor.cardAspect > 2)) {
    fail(`${path}.cardAspect must be a finite number in (0, 2]`);
  }
  if (impostor.frameUv !== undefined) {
    const frameUv = strictObject(impostor.frameUv, `${path}.frameUv`);
    rejectUnknown(frameUv, new Set(['offsetU', 'offsetV', 'scaleU', 'scaleV']), `${path}.frameUv`);
    for (const key of ['offsetU', 'offsetV', 'scaleU', 'scaleV']) {
      if (typeof frameUv[key] !== 'number' || !Number.isFinite(frameUv[key])) fail(`${path}.frameUv.${key} must be finite`);
    }
    if (frameUv.offsetU < 0 || frameUv.offsetV < 0 || frameUv.scaleU <= 0 || frameUv.scaleV <= 0
      || frameUv.offsetU + frameUv.scaleU > 1 || frameUv.offsetV + frameUv.scaleV > 1) {
      fail(`${path}.frameUv must remain inside one atlas frame`);
    }
  }
  return { ...impostor };
}

function validateWind(raw, path) {
  const wind = strictObject(raw, path);
  if (wind.model === 'none') {
    rejectUnknown(wind, new Set(['model']), path);
    return { model: 'none' };
  }
  rejectUnknown(wind, new Set(['model', 'trunkStiffness', 'branchStiffness', 'leafStiffness', 'gustResponse']), path);
  if (wind.model !== 'hierarchical-tree-v1') fail(`${path}.model must be hierarchical-tree-v1`);
  for (const key of ['trunkStiffness', 'branchStiffness', 'leafStiffness', 'gustResponse']) range(wind[key], 0, 1, `${path}.${key}`);
  return { ...wind };
}

export async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new EnvironmentCatalogError('Web Crypto SHA-256 is required for strict asset integrity');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function strictObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}
function rejectUnknown(object, allowed, path) {
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
}
function identifier(value, path) { if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${path} must be a stable kebab-case identifier`); }
function httpsUrl(value, path) { if (typeof value !== 'string' || !URL_RE.test(value)) fail(`${path} must be an https URL`); }
function nonEmptyString(value, path) { if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`); }
function hash(value, path) { if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(`${path} must be a lowercase SHA-256 hex digest`); }
function exactNumber(value, path) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`); }
function positive(value, path, allowZero = false) { exactNumber(value, path); if (allowZero ? value < 0 : value <= 0) fail(`${path} must be ${allowZero ? '>= 0' : '> 0'}`); }
function range(value, min, maxValue, path) { exactNumber(value, path); if (value < min || value > maxValue) fail(`${path} must be in [${min}, ${maxValue}]`); }
function enumValue(value, values, path) { if (!values.has(value)) fail(`${path} has unsupported value "${value}"`); }
function vectorObject(raw, path, keys, minimum) {
  const value = strictObject(raw, path);
  rejectUnknown(value, new Set(keys), path);
  for (const key of keys) {
    exactNumber(value[key], `${path}.${key}`);
    if (minimum !== undefined && value[key] <= minimum) fail(`${path}.${key} must be > ${minimum}`);
  }
  return { ...value };
}
function fail(message) { throw new EnvironmentCatalogError(message); }
