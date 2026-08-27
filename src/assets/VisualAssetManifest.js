/**
 * Versioned, renderer-independent visual asset residency manifest.
 *
 * The manifest describes shipped bytes, not loader behavior.  A consumer can
 * therefore stage and verify assets without changing the existing Three.js
 * loaders or making a lower-quality substitution when a required file is
 * missing or has changed.
 */

export const VISUAL_ASSET_MANIFEST_VERSION = 1;
export const VISUAL_ASSET_VARIANTS = Object.freeze([
  'critical',
  'balanced',
  'quality',
  'ultra',
]);

const VARIANT_SET = new Set(VISUAL_ASSET_VARIANTS);
const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9-]{2,79}$/;
const ASSET_URL_RE = /^\/assets\/[A-Za-z0-9_./-]+$/;
const FILE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'hdr', 'glb']);
const ASSET_KINDS = new Set(['texture', 'environment', 'heightfield', 'geometry', 'ball']);
const PRIORITY_BANDS = Object.freeze(['near', 'mid', 'far']);

const ROOT_KEYS = new Set(['version', 'manifestId', 'files', 'assets', 'variants']);
const FILE_KEYS = new Set([
  'id', 'version', 'url', 'format', 'bytes', 'sha256', 'memoryBytes', 'dimensions', 'memoryBasis',
]);
const DIMENSION_KEYS = new Set(['width', 'height']);
const ASSET_KEYS = new Set(['id', 'version', 'kind', 'semantic', 'priority', 'variants']);
const PRIORITY_KEYS = new Set(['base', 'projectedNeed']);
const PROJECTED_NEED_KEYS = new Set(PRIORITY_BANDS);
const ASSET_VARIANT_KEYS = new Set(['version', 'fileId', 'lod']);
const LOD_KEYS = new Set(['family', 'level', 'maxDistanceMeters', 'authored']);
const PROFILE_KEYS = new Set(['version', 'extends', 'entries']);
const PROFILE_ENTRY_KEYS = new Set(['assetId', 'required']);

export class VisualAssetManifestError extends Error {
  constructor(message) {
    super(`Visual asset manifest invalid: ${message}`);
    this.name = 'VisualAssetManifestError';
  }
}

/**
 * Validate and normalize a visual asset manifest.
 *
 * Unknown keys, missing physical metadata, missing profile variants, duplicate
 * IDs, and unresolved authored LOD relationships all fail closed.  The return
 * value is immutable and includes lookup maps used by residency consumers.
 */
export function validateVisualAssetManifest(raw) {
  const root = strictObject(raw, 'manifest');
  rejectUnknown(root, ROOT_KEYS, 'manifest');
  exactInteger(root.version, 'manifest.version');
  if (root.version !== VISUAL_ASSET_MANIFEST_VERSION) {
    fail(`manifest.version must be ${VISUAL_ASSET_MANIFEST_VERSION}`);
  }
  identifier(root.manifestId, 'manifest.manifestId');
  if (!Array.isArray(root.files) || root.files.length === 0) {
    fail('manifest.files must be a non-empty array');
  }
  if (!Array.isArray(root.assets) || root.assets.length === 0) {
    fail('manifest.assets must be a non-empty array');
  }
  strictObject(root.variants, 'manifest.variants');
  rejectUnknown(root.variants, VARIANT_SET, 'manifest.variants');

  const files = [];
  const fileById = new Map();
  root.files.forEach((rawFile, index) => {
    const file = validateFile(rawFile, `manifest.files[${index}]`);
    if (fileById.has(file.id)) fail(`duplicate file id "${file.id}"`);
    fileById.set(file.id, file);
    files.push(file);
  });

  const assets = [];
  const assetById = new Map();
  root.assets.forEach((rawAsset, index) => {
    const asset = validateAsset(rawAsset, `manifest.assets[${index}]`, fileById);
    if (assetById.has(asset.id)) fail(`duplicate asset id "${asset.id}"`);
    assetById.set(asset.id, asset);
    assets.push(asset);
  });
  validateAuthoredLodRelationships(assets);

  const variants = {};
  for (const variantName of VISUAL_ASSET_VARIANTS) {
    variants[variantName] = validateVariantProfile(
      root.variants[variantName],
      `manifest.variants.${variantName}`,
      variantName,
      assetById,
    );
  }

  // Resolve inheritance now, while the error still points at the manifest.
  // Runtime callers never need to guess whether a profile inherited an entry.
  const resolvedProfiles = new Map();
  for (const variantName of VISUAL_ASSET_VARIANTS) {
    resolveProfileEntries(variants, variantName, resolvedProfiles, []);
    for (const entry of resolvedProfiles.get(variantName).entries) {
      const asset = assetById.get(entry.assetId);
      if (!asset.variants[variantName]) {
        fail(`asset "${asset.id}" has no ${variantName} variant required by profile`);
      }
    }
  }

  return Object.freeze({
    version: root.version,
    manifestId: root.manifestId,
    files: Object.freeze(files),
    assets: Object.freeze(assets),
    variants: Object.freeze(variants),
    assetById,
    fileById,
    resolvedProfiles,
  });
}

/**
 * Load and validate the public manifest.  The fetch is deliberately separate
 * from binary verification so callers can choose when to pay the residency
 * cost, while malformed JSON can never enter the renderer.
 */
export async function loadVisualAssetManifest(
  url = '/assets/visual-quality-manifest.json',
  fetchImpl = globalThis.fetch,
) {
  if (typeof fetchImpl !== 'function') throw new VisualAssetManifestError('fetch is required');
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store' });
  } catch (cause) {
    throw new VisualAssetManifestError(`manifest load failed: ${cause.message}`);
  }
  if (!response?.ok) {
    throw new VisualAssetManifestError(`manifest load failed: ${response?.status ?? 'network error'}`);
  }
  let raw;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new VisualAssetManifestError(`manifest JSON parse failed: ${cause.message}`);
  }
  return validateVisualAssetManifest(raw);
}

/** Resolve one profile and attach its selected file and authored LOD metadata. */
export function resolveVisualAssetProfile(manifest, variantName) {
  const validated = ensureValidatedManifest(manifest);
  assertVariantName(variantName);
  const profile = validated.resolvedProfiles.get(variantName);
  if (!profile) fail(`unknown visual asset variant "${variantName}"`);

  const entries = profile.entries.map((entry) => {
    const asset = validated.assetById.get(entry.assetId);
    if (!asset) fail(`profile ${variantName} references unknown asset "${entry.assetId}"`);
    const assetVariant = asset.variants[variantName];
    if (!assetVariant) {
      fail(`asset "${asset.id}" has no ${variantName} variant`);
    }
    const file = validated.fileById.get(assetVariant.fileId);
    if (!file) fail(`asset "${asset.id}" references unknown file "${assetVariant.fileId}"`);
    return Object.freeze({
      assetId: asset.id,
      required: entry.required,
      kind: asset.kind,
      semantic: asset.semantic,
      priority: asset.priority,
      asset,
      variant: assetVariant,
      file,
    });
  });

  const fileIds = new Set(entries.map((entry) => entry.file.id));
  const transferBytes = [...fileIds].reduce((sum, id) => sum + validated.fileById.get(id).bytes, 0);
  const memoryBytes = [...fileIds].reduce((sum, id) => sum + validated.fileById.get(id).memoryBytes, 0);
  return Object.freeze({
    name: variantName,
    version: profile.version,
    entries: Object.freeze(entries),
    transferBytes,
    memoryBytes,
    fileCount: fileIds.size,
    requiredCount: entries.filter((entry) => entry.required).length,
    optionalCount: entries.filter((entry) => !entry.required).length,
  });
}

export function getVisualAsset(manifest, assetId) {
  const validated = ensureValidatedManifest(manifest);
  const asset = validated.assetById.get(assetId);
  if (!asset) fail(`unknown visual asset "${assetId}"`);
  return asset;
}

export function getVisualAssetFile(manifest, fileId) {
  const validated = ensureValidatedManifest(manifest);
  const file = validated.fileById.get(fileId);
  if (!file) fail(`unknown visual asset file "${fileId}"`);
  return file;
}

export function resolveVisualAssetVariant(manifest, assetId, variantName) {
  const profile = resolveVisualAssetProfile(manifest, variantName);
  const entry = profile.entries.find((candidate) => candidate.assetId === assetId);
  if (entry) return entry;
  const asset = getVisualAsset(manifest, assetId);
  const variant = asset.variants[variantName];
  if (!variant) fail(`asset "${assetId}" has no ${variantName} variant`);
  const file = getVisualAssetFile(manifest, variant.fileId);
  return Object.freeze({
    assetId: asset.id,
    required: false,
    kind: asset.kind,
    semantic: asset.semantic,
    priority: asset.priority,
    asset,
    variant,
    file,
  });
}

function validateFile(raw, path) {
  const file = strictObject(raw, path);
  rejectUnknown(file, FILE_KEYS, path);
  identifier(file.id, `${path}.id`);
  exactInteger(file.version, `${path}.version`);
  if (file.version !== 1) fail(`${path}.version must be 1`);
  if (typeof file.url !== 'string' || !ASSET_URL_RE.test(file.url)) {
    fail(`${path}.url must be a local /assets/ URL`);
  }
  if (!FILE_FORMATS.has(file.format)) fail(`${path}.format is unsupported`);
  positiveInteger(file.bytes, `${path}.bytes`);
  hash(file.sha256, `${path}.sha256`);
  positiveInteger(file.memoryBytes, `${path}.memoryBytes`);
  if (file.memoryBytes < file.bytes) fail(`${path}.memoryBytes must be >= bytes`);
  const dimensions = file.dimensions === undefined
    ? undefined
    : validateDimensions(file.dimensions, `${path}.dimensions`);
  if (file.memoryBasis !== undefined) nonEmptyString(file.memoryBasis, `${path}.memoryBasis`);
  return Object.freeze({
    id: file.id,
    version: file.version,
    url: file.url,
    format: file.format,
    bytes: file.bytes,
    sha256: file.sha256,
    memoryBytes: file.memoryBytes,
    ...(dimensions ? { dimensions } : {}),
    ...(file.memoryBasis ? { memoryBasis: file.memoryBasis } : {}),
  });
}

function validateDimensions(raw, path) {
  const dimensions = strictObject(raw, path);
  rejectUnknown(dimensions, DIMENSION_KEYS, path);
  positiveInteger(dimensions.width, `${path}.width`);
  positiveInteger(dimensions.height, `${path}.height`);
  return Object.freeze({ width: dimensions.width, height: dimensions.height });
}

function validateAsset(raw, path, fileById) {
  const asset = strictObject(raw, path);
  rejectUnknown(asset, ASSET_KEYS, path);
  identifier(asset.id, `${path}.id`);
  exactInteger(asset.version, `${path}.version`);
  if (asset.version !== 1) fail(`${path}.version must be 1`);
  enumValue(asset.kind, ASSET_KINDS, `${path}.kind`);
  if (asset.semantic !== undefined) nonEmptyString(asset.semantic, `${path}.semantic`);
  const priority = validatePriority(asset.priority, `${path}.priority`);
  const rawVariants = strictObject(asset.variants, `${path}.variants`);
  rejectUnknown(rawVariants, VARIANT_SET, `${path}.variants`);
  if (Object.keys(rawVariants).length === 0) fail(`${path}.variants must not be empty`);

  const variants = {};
  for (const name of Object.keys(rawVariants)) {
    variants[name] = validateAssetVariant(rawVariants[name], `${path}.variants.${name}`, fileById);
    const format = fileById.get(variants[name].fileId).format;
    if (asset.kind === 'geometry' && format !== 'glb') fail(`${path}.variants.${name} must reference a GLB`);
    if (asset.kind === 'environment' && format !== 'hdr') fail(`${path}.variants.${name} must reference an HDR`);
    if (asset.kind === 'heightfield' && !['png', 'jpg', 'jpeg'].includes(format)) {
      fail(`${path}.variants.${name} must reference an image`);
    }
  }
  return Object.freeze({
    id: asset.id,
    version: asset.version,
    kind: asset.kind,
    ...(asset.semantic ? { semantic: asset.semantic } : {}),
    priority,
    variants: Object.freeze(variants),
  });
}

function validatePriority(raw, path) {
  const priority = strictObject(raw, path);
  rejectUnknown(priority, PRIORITY_KEYS, path);
  positiveInteger(priority.base, `${path}.base`);
  const projectedNeed = strictObject(priority.projectedNeed, `${path}.projectedNeed`);
  rejectUnknown(projectedNeed, PROJECTED_NEED_KEYS, `${path}.projectedNeed`);
  const result = {};
  for (const band of PRIORITY_BANDS) {
    range(projectedNeed[band], 0, 1, `${path}.projectedNeed.${band}`);
    result[band] = projectedNeed[band];
  }
  return Object.freeze({ base: priority.base, projectedNeed: Object.freeze(result) });
}

function validateAssetVariant(raw, path, fileById) {
  const variant = strictObject(raw, path);
  rejectUnknown(variant, ASSET_VARIANT_KEYS, path);
  exactInteger(variant.version, `${path}.version`);
  if (variant.version !== 1) fail(`${path}.version must be 1`);
  identifier(variant.fileId, `${path}.fileId`);
  if (!fileById.has(variant.fileId)) fail(`${path}.fileId references an unknown file`);
  const lod = variant.lod === undefined ? undefined : validateLod(variant.lod, `${path}.lod`);
  return Object.freeze({
    version: variant.version,
    fileId: variant.fileId,
    ...(lod ? { lod } : {}),
  });
}

function validateLod(raw, path) {
  const lod = strictObject(raw, path);
  rejectUnknown(lod, LOD_KEYS, path);
  identifier(lod.family, `${path}.family`);
  exactInteger(lod.level, `${path}.level`);
  if (lod.level < 0) fail(`${path}.level must be >= 0`);
  positive(lod.maxDistanceMeters, `${path}.maxDistanceMeters`);
  if (typeof lod.authored !== 'boolean' || !lod.authored) {
    fail(`${path}.authored must be true for shipped authored LODs`);
  }
  return Object.freeze({
    family: lod.family,
    level: lod.level,
    maxDistanceMeters: lod.maxDistanceMeters,
    authored: true,
  });
}

function validateVariantProfile(raw, path, name, assetById) {
  const profile = strictObject(raw, path);
  rejectUnknown(profile, PROFILE_KEYS, path);
  exactInteger(profile.version, `${path}.version`);
  if (profile.version !== 1) fail(`${path}.version must be 1`);
  if (profile.extends !== null && profile.extends !== undefined) {
    assertVariantName(profile.extends, `${path}.extends`);
    if (profile.extends === name) fail(`${path}.extends cannot reference itself`);
  }
  if (!Array.isArray(profile.entries) || (profile.entries.length === 0 && !profile.extends)) {
    fail(`${path}.entries must be a non-empty array unless the profile extends another profile`);
  }
  const ids = new Set();
  const entries = profile.entries.map((rawEntry, index) => {
    const entryPath = `${path}.entries[${index}]`;
    const entry = strictObject(rawEntry, entryPath);
    rejectUnknown(entry, PROFILE_ENTRY_KEYS, entryPath);
    identifier(entry.assetId, `${entryPath}.assetId`);
    if (!assetById.has(entry.assetId)) fail(`${entryPath}.assetId references an unknown asset`);
    if (typeof entry.required !== 'boolean') fail(`${entryPath}.required must be boolean`);
    if (ids.has(entry.assetId)) fail(`${path} contains duplicate asset "${entry.assetId}"`);
    ids.add(entry.assetId);
    return Object.freeze({ assetId: entry.assetId, required: entry.required });
  });
  return Object.freeze({
    name,
    version: profile.version,
    extends: profile.extends ?? null,
    entries: Object.freeze(entries),
  });
}

function validateAuthoredLodRelationships(assets) {
  const families = new Map();
  for (const asset of assets) {
    for (const assetVariant of Object.values(asset.variants)) {
      if (!assetVariant.lod) continue;
      const { family, level, maxDistanceMeters } = assetVariant.lod;
      if (!families.has(family)) families.set(family, new Map());
      const levels = families.get(family);
      const previous = levels.get(level);
      if (previous && (previous.fileId !== assetVariant.fileId
        || previous.maxDistanceMeters !== maxDistanceMeters)) {
        fail(`authored LOD ${family}/${level} has conflicting file or distance metadata`);
      }
      levels.set(level, {
        fileId: assetVariant.fileId,
        maxDistanceMeters,
      });
    }
  }
  for (const [family, levels] of families) {
    const ordered = [...levels.entries()].sort(([left], [right]) => left - right);
    if (ordered[0][0] !== 0) fail(`authored LOD family ${family} must include level 0`);
    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index][1].maxDistanceMeters <= ordered[index - 1][1].maxDistanceMeters) {
        fail(`authored LOD family ${family} distances must increase with level`);
      }
    }
  }
}

function resolveProfileEntries(variants, name, cache, stack) {
  if (cache.has(name)) return cache.get(name);
  if (stack.includes(name)) fail(`variant profile inheritance cycle: ${[...stack, name].join(' -> ')}`);
  const profile = variants[name];
  if (!profile) fail(`missing variant profile "${name}"`);
  const parentEntries = profile.extends
    ? resolveProfileEntries(variants, profile.extends, cache, [...stack, name]).entries
    : [];
  const entries = [...parentEntries];
  const ids = new Set(entries.map((entry) => entry.assetId));
  for (const entry of profile.entries) {
    if (ids.has(entry.assetId)) fail(`variant ${name} redeclares inherited asset "${entry.assetId}"`);
    ids.add(entry.assetId);
    entries.push(entry);
  }
  const resolved = Object.freeze({
    name,
    version: profile.version,
    entries: Object.freeze(entries),
  });
  cache.set(name, resolved);
  return resolved;
}

function ensureValidatedManifest(manifest) {
  if (manifest?.assetById instanceof Map && manifest?.fileById instanceof Map
    && manifest?.resolvedProfiles instanceof Map) return manifest;
  return validateVisualAssetManifest(manifest);
}

function assertVariantName(value, path = 'variant') {
  if (typeof value !== 'string' || !VARIANT_SET.has(value)) {
    fail(`${path} must be one of ${VISUAL_ASSET_VARIANTS.join(', ')}`);
  }
}

function strictObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}

function rejectUnknown(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
  }
}

function identifier(value, path) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${path} must be a stable kebab-case identifier`);
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
}

function hash(value, path) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(`${path} must be a lowercase SHA-256 digest`);
}

function exactInteger(value, path) {
  if (!Number.isInteger(value)) fail(`${path} must be an integer`);
}

function positiveInteger(value, path) {
  exactInteger(value, path);
  if (value <= 0) fail(`${path} must be > 0`);
}

function positive(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${path} must be > 0`);
}

function range(value, min, max, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${path} must be in [${min}, ${max}]`);
  }
}

function enumValue(value, values, path) {
  if (!values.has(value)) fail(`${path} has unsupported value "${value}"`);
}

function fail(message) {
  throw new VisualAssetManifestError(message);
}
