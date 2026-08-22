import { createHash } from 'node:crypto';

export const FOLIAGE_WORKFLOW_SCHEMA_VERSION = 1;
const ALIAS_RE = /^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/;
const ID_RE = /^[a-z][a-z0-9.-]{1,95}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`Foliage authoring workflow invalid: ${message}`);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unknown field "${unknown[0]}"`);
}

function text(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const normalized = value.replaceAll('\r\n', '\n').trim();
  if (!normalized || normalized.length > 12_000) fail(`${label} is empty or too long`);
  return normalized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function normalizeFoliageGenerationSpec(raw) {
  exactKeys(raw, new Set(['schemaVersion', 'foliageAlias', 'species', 'source', 'processor']), 'spec');
  if (raw.schemaVersion !== FOLIAGE_WORKFLOW_SCHEMA_VERSION) fail('unsupported schemaVersion');
  if (!ALIAS_RE.test(raw.foliageAlias || '')) fail('foliageAlias must be a versioned local.* alias');

  exactKeys(raw.species, new Set(['id', 'commonName', 'botanicalName', 'visualIntent']), 'species');
  if (!ID_RE.test(raw.species.id || '')) fail('species.id is malformed');
  const species = Object.freeze({
    id: raw.species.id,
    commonName: text(raw.species.commonName, 'species.commonName'),
    botanicalName: text(raw.species.botanicalName, 'species.botanicalName'),
    visualIntent: text(raw.species.visualIntent, 'species.visualIntent'),
  });

  exactKeys(raw.source, new Set(['providerId', 'providerVersion', 'model', 'mode', 'prompt', 'layout', 'clusterCount']), 'source');
  if (!ID_RE.test(raw.source.providerId || '') || !ID_RE.test(raw.source.providerVersion || '')
    || !ID_RE.test(raw.source.model || '')) fail('source provider/model identity is malformed');
  if (!['single-shot', 'multi-step'].includes(raw.source.mode)) fail('source.mode is unsupported');
  if (raw.source.layout !== 'components-2x4' || raw.source.clusterCount !== 8) {
    fail('source must request the approved eight-cluster components-2x4 layout');
  }
  const source = Object.freeze({
    providerId: raw.source.providerId,
    providerVersion: raw.source.providerVersion,
    model: raw.source.model,
    mode: raw.source.mode,
    prompt: text(raw.source.prompt, 'source.prompt'),
    layout: raw.source.layout,
    clusterCount: raw.source.clusterCount,
  });

  exactKeys(raw.processor, new Set(['id', 'version', 'configSha256']), 'processor');
  if (!ID_RE.test(raw.processor.id || '') || !ID_RE.test(raw.processor.version || '')
    || !SHA256_RE.test(raw.processor.configSha256 || '')) fail('processor identity/config hash is malformed');
  const processor = Object.freeze({
    id: raw.processor.id,
    version: raw.processor.version,
    configSha256: raw.processor.configSha256,
  });

  return Object.freeze({
    schemaVersion: FOLIAGE_WORKFLOW_SCHEMA_VERSION,
    foliageAlias: raw.foliageAlias,
    species,
    source,
    processor,
  });
}

export function foliageGenerationCacheKey(rawSpec) {
  const normalized = normalizeFoliageGenerationSpec(rawSpec);
  const canonical = JSON.stringify(stableValue(normalized));
  return `foliage-source-v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

function validateProvider(provider, source) {
  if (!provider || typeof provider.generate !== 'function') fail('provider.generate is required');
  if (provider.id !== source.providerId || provider.version !== source.providerVersion) {
    fail('provider identity does not match the normalized source spec');
  }
  if (typeof provider.network !== 'boolean') fail('provider.network must be explicit');
}

function validateSourceArtifact(value, cacheKey) {
  if (!value || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 64) {
    fail('provider/cache returned no usable source bytes');
  }
  if (value.cacheKey !== cacheKey) fail('source artifact cacheKey mismatch');
  if (typeof value.providerReceipt !== 'string' || !value.providerReceipt.trim()) {
    fail('source artifact requires an auditable providerReceipt');
  }
  const sourceSha256 = createHash('sha256').update(value.bytes).digest('hex');
  if (value.sourceSha256 !== sourceSha256) fail('source artifact SHA-256 mismatch');
  return Object.freeze({
    cacheKey,
    sourceSha256,
    providerReceipt: value.providerReceipt,
    bytes: new Uint8Array(value.bytes),
  });
}

export async function acquireFoliageSource(rawSpec, {
  provider, cache, allowNetwork = false,
} = {}) {
  const spec = normalizeFoliageGenerationSpec(rawSpec);
  const cacheKey = foliageGenerationCacheKey(spec);
  if (!cache || typeof cache.get !== 'function' || typeof cache.put !== 'function') {
    fail('cache.get and cache.put are required');
  }
  const cached = await cache.get(cacheKey);
  if (cached) return Object.freeze({ spec, artifact: validateSourceArtifact(cached, cacheKey), reused: true });

  validateProvider(provider, spec.source);
  if (provider.network && allowNetwork !== true) {
    fail('network generation requires explicit allowNetwork=true consent');
  }
  // Providers receive only the normalized generation request. Course files,
  // screenshots, local paths, and unrelated assets are never implicit inputs.
  const generated = await provider.generate(Object.freeze({ spec, cacheKey }));
  const artifact = validateSourceArtifact(generated, cacheKey);
  await cache.put(cacheKey, artifact);
  return Object.freeze({ spec, artifact, reused: false });
}

export async function executeFoliageAuthoringWorkflow(rawSpec, {
  provider, cache, processor, reviewer, installer, allowNetwork = false, install = false,
} = {}) {
  if (!processor || typeof processor.process !== 'function') fail('processor.process is required');
  if (!reviewer || typeof reviewer.review !== 'function') fail('reviewer.review is required');
  if (install && (!installer || typeof installer.install !== 'function')) fail('installer.install is required for installation');

  const acquired = await acquireFoliageSource(rawSpec, { provider, cache, allowNetwork });
  const candidate = await processor.process(Object.freeze({
    spec: acquired.spec,
    source: acquired.artifact,
  }));
  if (!candidate || candidate.foliageAlias !== acquired.spec.foliageAlias
    || typeof candidate.packRoot !== 'string' || !candidate.packRoot) {
    fail('processor returned a malformed candidate pack');
  }
  const review = await reviewer.review(Object.freeze({ spec: acquired.spec, candidate }));
  if (!review || typeof review.approved !== 'boolean' || !Array.isArray(review.evidence)) {
    fail('reviewer returned a malformed decision');
  }
  if (!review.approved || !install) {
    return Object.freeze({ ...acquired, candidate, review, installed: false });
  }
  const installation = await installer.install(Object.freeze({ spec: acquired.spec, candidate, review }));
  if (!installation || installation.foliageAlias !== acquired.spec.foliageAlias
    || typeof installation.rootUrl !== 'string' || !installation.rootUrl) {
    fail('installer returned a malformed local alias descriptor');
  }
  return Object.freeze({ ...acquired, candidate, review, installed: true, installation });
}
