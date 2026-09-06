const ID_PATTERN = /^[a-z][a-zA-Z0-9.-]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new TypeError(`Invalid audio manifest: ${message}`);
}

export function validateAudioManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('root must be an object');
  if (value.version !== 1) fail('version must equal 1');
  if (value.licensePolicy !== 'CC0-1.0') fail('licensePolicy must equal CC0-1.0');
  if (value.sampleRate !== 48000) fail('sampleRate must equal 48000');
  if (!Array.isArray(value.sources) || !value.sources.length) fail('sources must be non-empty');
  if (!Array.isArray(value.assets) || !value.assets.length) fail('assets must be non-empty');

  const sourceIds = new Set();
  const sources = value.sources.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) fail(`sources[${index}] must be an object`);
    if (!ID_PATTERN.test(source.id || '') || sourceIds.has(source.id)) fail(`sources[${index}].id must be unique`);
    if (source.license !== 'CC0-1.0') fail(`sources[${index}] is not CC0-1.0`);
    for (const key of ['creator', 'title', 'url']) if (typeof source[key] !== 'string' || !source[key]) fail(`sources[${index}].${key} is required`);
    sourceIds.add(source.id);
    return Object.freeze({ ...source });
  });

  const assetIds = new Set();
  const assets = value.assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) fail(`assets[${index}] must be an object`);
    if (!ID_PATTERN.test(asset.id || '') || assetIds.has(asset.id)) fail(`assets[${index}].id must be unique`);
    if (typeof asset.group !== 'string' || !/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(asset.group)) fail(`assets[${index}].group is invalid`);
    if (typeof asset.file !== 'string' || !/^[a-z0-9-]+\.ogg$/.test(asset.file)) fail(`assets[${index}].file is invalid`);
    if (!sourceIds.has(asset.source)) fail(`assets[${index}].source is unknown`);
    if (!['loop', 'oneShot'].includes(asset.kind)) fail(`assets[${index}].kind is invalid`);
    if (![1, 2].includes(asset.channels)) fail(`assets[${index}].channels must be 1 or 2`);
    if (!HASH_PATTERN.test(asset.sha256 || '')) fail(`assets[${index}].sha256 is invalid`);
    assetIds.add(asset.id);
    return Object.freeze({ ...asset });
  });

  return Object.freeze({
    version: value.version,
    licensePolicy: value.licensePolicy,
    sampleRate: value.sampleRate,
    sources: Object.freeze(sources),
    assets: Object.freeze(assets),
  });
}

export function groupAudioAssets(manifest) {
  const groups = new Map();
  for (const asset of manifest.assets) {
    if (!groups.has(asset.group)) groups.set(asset.group, []);
    groups.get(asset.group).push(asset);
  }
  return groups;
}
