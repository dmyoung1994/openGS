import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  acquireFoliageSource, executeFoliageAuthoringWorkflow, foliageGenerationCacheKey,
  normalizeFoliageGenerationSpec,
} from '../tools/foliage-pipeline/workflow-contract.mjs';

const bytes = new Uint8Array(96).map((_, index) => index);
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
const baseSpec = {
  schemaVersion: 1,
  foliageAlias: 'local.monterey-cypress.coastal.v1',
  species: {
    id: 'monterey-cypress', commonName: 'Monterey cypress',
    botanicalName: 'Hesperocyparis macrocarpa', visualIntent: 'Exposed crooked trunks and broad coastal canopy pads.',
  },
  source: {
    providerId: 'fixture-provider', providerVersion: 'fixture-v1', model: 'fixture-image-v1',
    mode: 'single-shot', prompt: 'Eight isolated RGBA foliage clusters.', layout: 'components-2x4', clusterCount: 8,
  },
  processor: { id: 'foliage-pipeline', version: 'foliage-pipeline-v2', configSha256: 'a'.repeat(64) },
};

function memoryCache() {
  const values = new Map();
  return { values, get: (key) => values.get(key), put: (key, value) => values.set(key, value) };
}

function artifact(cacheKey) {
  return { cacheKey, sourceSha256, providerReceipt: 'fixture:immutable-generation-1', bytes };
}

test('foliage workflow normalization and cache key are stable and strict', () => {
  const normalized = normalizeFoliageGenerationSpec(baseSpec);
  assert.equal(normalized.source.prompt, baseSpec.source.prompt);
  assert.equal(foliageGenerationCacheKey(baseSpec), foliageGenerationCacheKey(structuredClone(baseSpec)));
  assert.match(foliageGenerationCacheKey(baseSpec), /^foliage-source-v1:[a-f0-9]{64}$/);
  assert.throws(() => normalizeFoliageGenerationSpec({ ...baseSpec, courseAssetPaths: ['/private/course.json'] }),
    /unknown field "courseAssetPaths"/);
  assert.throws(() => normalizeFoliageGenerationSpec({ ...baseSpec, foliageAlias: 'builtin.hidden.v1' }),
    /versioned local/);
});

test('unchanged generation specs reuse immutable source bytes without another generation', async () => {
  const cache = memoryCache();
  let calls = 0;
  const provider = { id: 'fixture-provider', version: 'fixture-v1', network: false,
    generate: async ({ cacheKey }) => { calls++; return artifact(cacheKey); } };
  const first = await acquireFoliageSource(baseSpec, { provider, cache });
  const second = await acquireFoliageSource(baseSpec, { provider: null, cache });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.artifact.bytes, bytes);
});

test('network providers require explicit consent before receiving a normalized prompt', async () => {
  const cache = memoryCache();
  let calls = 0;
  const provider = { id: 'fixture-provider', version: 'fixture-v1', network: true,
    generate: async ({ cacheKey }) => { calls++; return artifact(cacheKey); } };
  await assert.rejects(() => acquireFoliageSource(baseSpec, { provider, cache }), /explicit allowNetwork=true/);
  assert.equal(calls, 0);
  await acquireFoliageSource(baseSpec, { provider, cache, allowNetwork: true });
  assert.equal(calls, 1);
});

test('candidate processing never installs without explicit install and QA approval', async () => {
  const events = [];
  const cache = memoryCache();
  const provider = { id: 'fixture-provider', version: 'fixture-v1', network: false,
    generate: async ({ cacheKey }) => artifact(cacheKey) };
  const processor = { process: async ({ spec }) => ({ foliageAlias: spec.foliageAlias, packRoot: '/candidate/pack' }) };
  const installer = { install: async () => { events.push('install'); return {
    foliageAlias: baseSpec.foliageAlias, rootUrl: '/local/approved-pack', compatibilityVersion: 1,
  }; } };

  const rejected = await executeFoliageAuthoringWorkflow(baseSpec, {
    provider, cache, processor, reviewer: { review: async () => ({ approved: false, evidence: ['matrix failed'] }) },
    installer, install: true,
  });
  assert.equal(rejected.installed, false);
  assert.deepEqual(events, []);

  const approvedNotRequested = await executeFoliageAuthoringWorkflow(baseSpec, {
    provider, cache, processor, reviewer: { review: async () => ({ approved: true, evidence: ['matrix passed'] }) },
    installer,
  });
  assert.equal(approvedNotRequested.installed, false);
  assert.deepEqual(events, []);

  const installed = await executeFoliageAuthoringWorkflow(baseSpec, {
    provider, cache, processor, reviewer: { review: async () => ({ approved: true, evidence: ['matrix passed'] }) },
    installer, install: true,
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.installation.rootUrl, '/local/approved-pack');
  assert.deepEqual(events, ['install']);
});
