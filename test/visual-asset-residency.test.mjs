import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  VISUAL_ASSET_VARIANTS,
  VisualAssetManifestError,
  resolveVisualAssetProfile,
  validateVisualAssetManifest,
} from '../src/assets/VisualAssetManifest.js';
import {
  VisualAssetResidency,
  sha256Bytes,
} from '../src/assets/VisualAssetResidency.js';

const manifestRaw = JSON.parse(await readFile(
  new URL('../public/assets/visual-quality-manifest.json', import.meta.url),
  'utf8',
));

test('visual manifest is versioned, conservative, and resolves authored LOD variants', () => {
  const manifest = validateVisualAssetManifest(manifestRaw);
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.variants), VISUAL_ASSET_VARIANTS);
  assert.equal(manifest.files.length, 38);
  assert.equal(manifest.assets.length, 35);
  assert.ok(manifest.files.every((file) => /^\/assets\//.test(file.url)));
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(manifest.files.every((file) => file.memoryBytes >= file.bytes));

  const critical = resolveVisualAssetProfile(manifest, 'critical');
  const balanced = resolveVisualAssetProfile(manifest, 'balanced');
  const quality = resolveVisualAssetProfile(manifest, 'quality');
  const ultra = resolveVisualAssetProfile(manifest, 'ultra');
  assert.equal(critical.entries.length, balanced.entries.length);
  const moon = critical.entries.find((entry) => entry.assetId === 'environment-moon-lroc-albedo');
  assert.equal(moon.required, true);
  assert.equal(moon.file.sha256, 'f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170');
  assert.ok(quality.entries.length > balanced.entries.length);
  assert.ok(ultra.entries.length > quality.entries.length);

  const criticalTree = critical.entries.find((entry) => entry.assetId === 'tree-small-02-geometry');
  const qualityTree = quality.entries.find((entry) => entry.assetId === 'tree-small-02-geometry');
  const heroTree = ultra.entries.find((entry) => entry.assetId === 'tree-small-02-hero-geometry');
  assert.equal(criticalTree.variant.lod.level, 1);
  assert.equal(qualityTree.variant.lod.level, 0);
  assert.equal(heroTree.variant.lod.family, 'polyhaven-tree-small-02-hero');
  assert.equal(heroTree.file.url, '/assets/trees/tree_small_02_hero_lod0.glb');
  for (const assetId of ['coast-sand-albedo', 'coast-sand-normal']) {
    const coastMap = critical.entries.find((entry) => entry.assetId === assetId);
    assert.equal(coastMap.required, true);
    assert.match(coastMap.file.url, /^\/assets\/materials\/aerial_beach_01\//);
    assert.equal(coastMap.file.dimensions.width, 2048);
    assert.equal(coastMap.file.dimensions.height, 2048);
  }
  const packedCoast = critical.entries.find((entry) => entry.assetId === 'coast-sand-albedo');
  assert.equal(packedCoast.file.url,
    '/assets/materials/aerial_beach_01/aerial_beach_01_diff_rough_2k.png');
  assert.match(packedCoast.asset.semantic, /albedo-roughness-packed/);
  for (const assetId of ['creator-earth-albedo', 'creator-earth-normal', 'creator-earth-roughness']) {
    const earthMap = critical.entries.find((entry) => entry.assetId === assetId);
    assert.equal(earthMap.required, true);
    assert.match(earthMap.file.url, /^\/assets\/materials\/dirt\//);
    assert.deepEqual(earthMap.file.dimensions, { width: 1024, height: 1024 });
  }
  const flagstickWood = critical.entries.find((entry) => entry.assetId === 'flagstick-premium-walnut-albedo');
  assert.equal(flagstickWood.required, true);
  assert.equal(flagstickWood.file.url, '/assets/materials/flagstick/premium_walnut_albedo_1k.png');
  assert.equal(flagstickWood.file.sha256, '98029f83b7a0559e6eee1c37542ca5e85cb94f23a144d64c308c41502998fab7');
  assert.deepEqual(flagstickWood.file.dimensions, { width: 1024, height: 1024 });
});

test('manifest validation fails closed for unknown keys and malformed hashes', () => {
  const unknownKey = structuredClone(manifestRaw);
  unknownKey.extra = true;
  assert.throws(() => validateVisualAssetManifest(unknownKey), VisualAssetManifestError);

  const changedHash = structuredClone(manifestRaw);
  changedHash.files[0].sha256 = changedHash.files[0].sha256.slice(0, -1);
  assert.throws(() => validateVisualAssetManifest(changedHash), /SHA-256/);

  const missingVariant = structuredClone(manifestRaw);
  delete missingVariant.assets.find((asset) => asset.id === 'tree-small-02-geometry').variants.quality;
  assert.throws(() => validateVisualAssetManifest(missingVariant), /no quality variant/);
});

async function fixtureManifest() {
  const payloads = {
    '/assets/test/near.glb': new Uint8Array([1, 2, 3, 4]),
    '/assets/test/shared.glb': new Uint8Array([5, 6, 7, 8, 9]),
    '/assets/test/far.glb': new Uint8Array([10, 11, 12]),
  };
  const files = await Promise.all(Object.entries(payloads).map(async ([url, bytes]) => ({
    id: url.split('/').at(-1).replace('.glb', ''),
    version: 1,
    url,
    format: 'glb',
    bytes: bytes.byteLength,
    sha256: await sha256Bytes(bytes),
    memoryBytes: bytes.byteLength * 2,
    memoryBasis: 'test-fixture',
  })));
  const fileId = (url) => url.split('/').at(-1).replace('.glb', '');
  const asset = (id, file, base, projectedNeed) => ({
    id,
    version: 1,
    kind: 'geometry',
    semantic: id,
    priority: { base, projectedNeed },
    variants: Object.fromEntries(VISUAL_ASSET_VARIANTS.map((variant) => [variant, {
      version: 1,
      fileId: file,
      lod: { family: id, level: 0, maxDistanceMeters: 100, authored: true },
    }])),
  });
  return validateVisualAssetManifest({
    version: 1,
    manifestId: 'fixture-visual-assets',
    files,
    assets: [
      asset('near-geometry', fileId('/assets/test/near.glb'), 100, { near: 1, mid: 0.5, far: 0.1 }),
      asset('shared-geometry', fileId('/assets/test/shared.glb'), 70, { near: 0.4, mid: 0.7, far: 0.9 }),
      asset('far-geometry', fileId('/assets/test/far.glb'), 80, { near: 0.1, mid: 0.4, far: 1 }),
    ],
    variants: {
      critical: {
        version: 1,
        extends: null,
        entries: [
          { assetId: 'near-geometry', required: true },
          { assetId: 'shared-geometry', required: true },
          { assetId: 'far-geometry', required: false },
        ],
      },
      balanced: { version: 1, extends: 'critical', entries: [] },
      quality: { version: 1, extends: 'balanced', entries: [] },
      ultra: { version: 1, extends: 'quality', entries: [] },
    },
  });
}

test('projected need changes deterministic load order while deduplicating files', async () => {
  const manifest = await fixtureManifest();
  const residency = VisualAssetResidency.fromManifest(manifest, { fetchImpl: async () => ({ ok: true }) });
  const nearPlan = residency.plan('critical', { projectedNeed: { near: 1, mid: 0, far: 0 } });
  const farPlan = residency.plan('critical', { projectedNeed: { near: 0, mid: 0, far: 1 } });
  assert.notDeepEqual(
    nearPlan.entries.map((entry) => entry.assetId),
    farPlan.entries.map((entry) => entry.assetId),
  );
  assert.ok(nearPlan.entries[0].priorityScore > farPlan.entries[0].priorityScore);
  assert.equal(nearPlan.files.length, 3);
  assert.equal(nearPlan.transferBytes, 12);
});

test('readiness promises verify bytes, share requests, and expose snapshots', async () => {
  const manifest = await fixtureManifest();
  const payloads = new Map([
    ['/assets/test/near.glb', new Uint8Array([1, 2, 3, 4])],
    ['/assets/test/shared.glb', new Uint8Array([5, 6, 7, 8, 9])],
    ['/assets/test/far.glb', new Uint8Array([10, 11, 12])],
  ]);
  const calls = [];
  const residency = VisualAssetResidency.fromManifest(manifest, {
    maxConcurrent: 2,
    fetchImpl: async (url) => {
      calls.push(url);
      const bytes = payloads.get(url);
      return {
        ok: Boolean(bytes),
        status: bytes ? 200 : 404,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  });

  const snapshot = await residency.ready('critical');
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.requiredReady, true);
  assert.equal(snapshot.files.verified, 3);
  assert.equal(snapshot.files.verifiedBytes, 12);
  assert.equal(new Set(calls).size, 3);

  await residency.ready('critical');
  assert.equal(calls.length, 3, 'cached readiness must not refetch verified files');
  assert.equal(residency.snapshot('critical').allReady, true);
});

test('a changed response rejects and remains failed instead of falling back', async () => {
  const manifest = await fixtureManifest();
  const residency = VisualAssetResidency.fromManifest(manifest, {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        if (url.endsWith('/near.glb')) return new Uint8Array([99, 98, 97, 96]).buffer;
        return new Uint8Array([5, 6, 7, 8, 9]).buffer;
      },
    }),
  });
  await assert.rejects(() => residency.ready('critical'), /SHA-256|bytes/);
  const failed = residency.snapshot().fileStates.find((state) => state.fileId === 'near');
  assert.equal(failed.state, 'failed');
  assert.equal(residency.snapshot('critical').requiredReady, false);
});

test('native-style fetch is invoked without the residency object as receiver', async () => {
  const manifest = await fixtureManifest();
  const payloads = new Map([
    ['/assets/test/near.glb', new Uint8Array([1, 2, 3, 4])],
    ['/assets/test/shared.glb', new Uint8Array([5, 6, 7, 8, 9])],
    ['/assets/test/far.glb', new Uint8Array([10, 11, 12])],
  ]);
  let receiver = Symbol('unset');
  function receiverSensitiveFetch(url) {
    'use strict';
    receiver = this;
    if (this !== undefined) throw new TypeError('Illegal invocation');
    const bytes = payloads.get(url);
    return Promise.resolve({
      ok: Boolean(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
  const residency = VisualAssetResidency.fromManifest(manifest, {
    fetchImpl: receiverSensitiveFetch,
  });
  await residency.ready('critical');
  assert.equal(receiver, undefined);
});
