import { sha256 } from '../environment/EnvironmentCatalog.js';
import { loadGeneratedFoliagePack } from '../scene/GeneratedFoliageTree.js';

export const FOLIAGE_PACK_COMPATIBILITY_VERSION = 1;

// Built-ins are immutable alias-to-pack roots. Course data never knows these
// URLs, and a future local-pack provider can implement the same descriptor
// contract without coupling gameplay to a generation transport.
export const BUILTIN_FOLIAGE_PACKS = Object.freeze({
  'builtin.douglas-fir.pnw.v1': Object.freeze({
    rootUrl: '/assets/trees_candidates/generated_fir_clusters/processed/v2',
    compatibilityVersion: FOLIAGE_PACK_COMPATIBILITY_VERSION,
  }),
  'builtin.italian-cypress.mediterranean.v1': Object.freeze({
    rootUrl: '/assets/trees_candidates/generated_italian_cypress/processed/v1',
    compatibilityVersion: FOLIAGE_PACK_COMPATIBILITY_VERSION,
  }),
  'builtin.monterey-cypress.coastal.v1': Object.freeze({
    rootUrl: '/assets/trees_candidates/generated_monterey_cypress/processed/v1',
    compatibilityVersion: FOLIAGE_PACK_COMPATIBILITY_VERSION,
  }),
  'builtin.valley-oak.california.v1': Object.freeze({
    rootUrl: '/assets/trees_candidates/generated_valley_oak/processed/v1',
    compatibilityVersion: FOLIAGE_PACK_COMPATIBILITY_VERSION,
  }),
  'builtin.sugar-maple.northeastern.v1': Object.freeze({
    rootUrl: '/assets/trees_candidates/generated_sugar_maple/processed/v1',
    compatibilityVersion: FOLIAGE_PACK_COMPATIBILITY_VERSION,
  }),
});

const ALIAS_RE = /^(builtin|local)\.[a-z0-9]+(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const verifiedManifests = new Map();

export class FoliagePackError extends Error {
  constructor(message) {
    super(`Foliage pack invalid: ${message}`);
    this.name = 'FoliagePackError';
  }
}

export function createLocalFoliagePackRegistry(records = []) {
  const entries = Array.isArray(records) ? records.map((record) => [record?.alias, record])
    : records && typeof records === 'object' ? Object.entries(records).map(([alias, descriptor]) => [alias, { alias, ...descriptor }])
      : null;
  if (!entries) throw new FoliagePackError('local registry must be an array or alias-keyed object');
  const registry = new Map();
  for (const [alias, record] of entries) {
    if (typeof alias !== 'string' || !alias.startsWith('local.') || !ALIAS_RE.test(alias)) {
      throw new FoliagePackError(`local registry alias "${alias}" is malformed`);
    }
    const keys = record && typeof record === 'object' ? Object.keys(record) : [];
    if (keys.some((key) => !['alias', 'rootUrl', 'compatibilityVersion'].includes(key))) {
      throw new FoliagePackError(`${alias} local descriptor contains unknown fields`);
    }
    const rootUrl = record?.rootUrl;
    if (typeof rootUrl !== 'string' || !/^\/[a-z0-9][a-z0-9./_-]*$/i.test(rootUrl)
      || rootUrl.includes('..') || rootUrl.includes('//') || rootUrl.includes('\\')
      || rootUrl.includes('?') || rootUrl.includes('#')) {
      throw new FoliagePackError(`${alias} rootUrl must be a same-origin absolute asset path`);
    }
    if (record.compatibilityVersion !== FOLIAGE_PACK_COMPATIBILITY_VERSION) {
      throw new FoliagePackError(`${alias} compatibilityVersion ${record.compatibilityVersion} is unsupported`);
    }
    if (registry.has(alias)) throw new FoliagePackError(`local registry repeats alias "${alias}"`);
    registry.set(alias, Object.freeze({ rootUrl: rootUrl.replace(/\/$/, ''), compatibilityVersion: record.compatibilityVersion }));
  }
  // Object.freeze(new Map()) still permits set/delete. Expose only reads so alias
  // ownership cannot change under a live course or between Range rebuilds.
  return Object.freeze({
    get size() { return registry.size; },
    get(alias) { return registry.get(alias); },
    has(alias) { return registry.has(alias); },
  });
}

export function resolveFoliageAliasDescriptor(alias, { builtins = BUILTIN_FOLIAGE_PACKS, local = null } = {}) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) throw new FoliagePackError(`malformed alias "${alias}"`);
  const descriptor = builtins[alias] ?? local?.get?.(alias);
  if (!descriptor) throw new FoliagePackError(`unresolved required alias "${alias}"; install or declare that exact pack`);
  if (descriptor.compatibilityVersion !== FOLIAGE_PACK_COMPATIBILITY_VERSION) {
    throw new FoliagePackError(`${alias} compatibilityVersion ${descriptor.compatibilityVersion} is unsupported`);
  }
  return Object.freeze({ alias, ...descriptor });
}

function validateManifest(manifest, descriptor, { allowCandidate }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new FoliagePackError('manifest must be an object');
  if (manifest.schemaVersion !== 1 || manifest.compatibilityVersion !== FOLIAGE_PACK_COMPATIBILITY_VERSION) {
    throw new FoliagePackError('manifest schema/compatibility version is unsupported');
  }
  if (manifest.foliageAlias !== descriptor.alias) throw new FoliagePackError('manifest alias does not match the requested alias');
  const state = manifest.validation?.state;
  if (state !== 'approved' && !(allowCandidate && state === 'candidate')) {
    throw new FoliagePackError(`${descriptor.alias} validation state "${state}" is not production-approved`);
  }
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.length < 3) {
    throw new FoliagePackError('manifest requiredFiles is incomplete');
  }
  if (!SHA256_RE.test(manifest.generationSpecHash || '')) {
    throw new FoliagePackError('manifest generationSpecHash is malformed');
  }
  if (manifest.candidateOnly !== (state === 'candidate')) {
    throw new FoliagePackError('manifest candidateOnly does not match validation state');
  }
  const seen = new Set();
  for (const record of manifest.requiredFiles) {
    if (!record || typeof record.file !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(record.file)
      || record.file.includes('..') || !SHA256_RE.test(record.sha256) || !Number.isInteger(record.bytes) || record.bytes <= 0) {
      throw new FoliagePackError('manifest contains a malformed required file record');
    }
    if (seen.has(record.file)) throw new FoliagePackError(`manifest repeats required file "${record.file}"`);
    seen.add(record.file);
  }
  const runtime = manifest.runtime;
  const shippingFiles = [runtime?.metadata, runtime?.albedo?.ktx2, runtime?.materialMask?.ktx2,
    runtime?.bark?.albedo, runtime?.bark?.normal, runtime?.bark?.arm];
  if (shippingFiles.some((file) => typeof file !== 'string')) throw new FoliagePackError('manifest runtime roles are incomplete');
  for (const required of shippingFiles) {
    if (!seen.has(required)) throw new FoliagePackError(`manifest omits shipping file "${required}"`);
  }
  return manifest;
}

export async function verifyFoliageAlias(alias, {
  fetchImpl = globalThis.fetch, builtins, local, allowCandidate = false, memoize = true,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new FoliagePackError('fetch is required');
  const descriptor = resolveFoliageAliasDescriptor(alias, { builtins, local });
  const manifestResponse = await fetchImpl(`${descriptor.rootUrl}/foliage-pack.json`, { cache: 'no-store' });
  if (!manifestResponse?.ok) throw new FoliagePackError(`${alias} manifest is unavailable`);
  const manifest = validateManifest(await manifestResponse.json(), descriptor, { allowCandidate });
  const cacheKey = `${descriptor.rootUrl}:${alias}:${manifest.generationSpecHash}:${manifest.validation.state}`;
  if (memoize && verifiedManifests.has(cacheKey)) return verifiedManifests.get(cacheKey);
  for (const file of manifest.requiredFiles) {
    const response = await fetchImpl(`${descriptor.rootUrl}/${file.file}`, { cache: 'reload' });
    if (!response?.ok) throw new FoliagePackError(`${alias} required file is unavailable: ${file.file}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== file.bytes) throw new FoliagePackError(`${alias} byte length mismatch: ${file.file}`);
    if (await sha256(bytes) !== file.sha256) throw new FoliagePackError(`${alias} hash mismatch: ${file.file}`);
  }
  const resolved = Object.freeze({ descriptor, manifest });
  if (memoize) verifiedManifests.set(cacheKey, resolved);
  return resolved;
}

export async function loadFoliageAlias(alias, {
  renderer, textureMode = 'ktx2', allowCandidate = false, ...resolverOptions
} = {}) {
  const resolved = await verifyFoliageAlias(alias, { ...resolverOptions, allowCandidate });
  const pack = await loadGeneratedFoliagePack(resolved.descriptor.rootUrl, { renderer, textureMode });
  if (pack.metadata.foliageAlias !== alias) {
    pack.atlas.dispose(); pack.materialMask.dispose();
    for (const texture of Object.values(pack.bark)) texture.dispose();
    throw new FoliagePackError(`${alias} runtime metadata alias mismatch`);
  }
  return { ...pack, resolved };
}
