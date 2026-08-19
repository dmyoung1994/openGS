import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BUILTIN_ENVIRONMENT_ASSET_IDS,
  EnvironmentCatalogError,
  getCatalogAsset,
  loadEnvironmentCatalog,
  collectEnvironmentAssetIds,
  verifyEnvironmentCatalogAssets,
  validateEnvironmentCatalog,
} from '../src/environment/EnvironmentCatalog.js';

const manifestPath = new URL('../public/assets/environment/catalog.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

test('CC0 environment catalog validates the shipped runtime tree record', () => {
  const catalog = validateEnvironmentCatalog(manifest);
  const tree = getCatalogAsset(catalog, 'polyhaven-tree-small-02');
  assert.equal(catalog.version, 2);
  assert.equal(tree.license.spdx, 'CC0-1.0');
  assert.equal(tree.lods[0].sha256, '1566c2de9c40cfa4d144089c818f7c67b4cd4283a237e89a3a05b5464f895813');
  assert.equal(tree.lods[1].sha256, 'ac3e7ab2bbec249e55ce330c24d7460d01ce10e8ce2435ce11c84e186616a211');
  assert.equal(tree.impostor.kind, 'baked-atlas');
  assert.equal(tree.impostor.sha256, '04de7c72460a6e7f30831abd4e901e9cf82152e2f711c770de40480e7b8c4bb6');
  assert.equal(tree.impostor.azimuthFrames, 8);
  assert.deepEqual([...BUILTIN_ENVIRONMENT_ASSET_IDS], catalog.assets.map((asset) => asset.id));
});

test('catalog lookup is stable when manifest records are reordered', () => {
  const second = structuredClone(manifest.assets[0]);
  second.id = 'polyhaven-tree-small-test';
  second.derivativeLineage.sourceAssetId = 'polyhaven-tree-small-test';
  const reordered = { ...manifest, assets: [second, structuredClone(manifest.assets[0])] };
  const catalog = validateEnvironmentCatalog(reordered);
  assert.equal(getCatalogAsset(catalog, 'polyhaven-tree-small-02').id, 'polyhaven-tree-small-02');
  assert.equal(getCatalogAsset(catalog, 'polyhaven-tree-small-test').id, 'polyhaven-tree-small-test');
});

test('catalog rejects unknown license and malformed content hashes', () => {
  const badLicense = structuredClone(manifest);
  badLicense.assets[0].license.spdx = 'LicenseRef-Unknown';
  assert.throws(() => validateEnvironmentCatalog(badLicense), EnvironmentCatalogError);

  // BlenderKit's free tier is Royalty Free rather than CC0; it is accepted only
  // under its own explicit identifier, never by relaxing the check to any string.
  const blenderkit = structuredClone(manifest);
  blenderkit.assets[0].license.spdx = 'LicenseRef-BlenderKit-RoyaltyFree';
  assert.doesNotThrow(() => validateEnvironmentCatalog(blenderkit));

  const badHash = structuredClone(manifest);
  badHash.assets[0].lods[0].sha256 = 'not-a-hash';
  assert.throws(() => validateEnvironmentCatalog(badHash), /SHA-256/);
});

test('runtime catalog load fails closed when a declared derivative is unavailable', async () => {
  const fetchImpl = async (url) => {
    if (url === '/catalog.json') return new Response(JSON.stringify(manifest), { status: 200 });
    return new Response('', { status: 404 });
  };
  await assert.rejects(
    loadEnvironmentCatalog('/catalog.json', { fetchImpl }),
    /LOD 0 unavailable/,
  );
});

test('all shipped runtime derivatives pass their declared SHA-256 integrity checks', async () => {
  const fetchImpl = async (url) => {
    if (url === '/catalog.json') return new Response(JSON.stringify(manifest), { status: 200 });
    try {
      const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
      return new Response(bytes, { status: 200 });
    } catch {
      return new Response('', { status: 404 });
    }
  };
  const catalog = await loadEnvironmentCatalog('/catalog.json', { fetchImpl });
  // Every asset the shipped manifest declares must survive the hash check; a
  // fixed count here only tracked the manifest's size at the time of writing.
  assert.equal(catalog.assets.length, manifest.assets.length);
  assert.ok(catalog.assets.length >= 6);
});

test('catalog bootstrap can verify only course-referenced assets', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url === '/catalog.json') return new Response(JSON.stringify(manifest), { status: 200 });
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
    return new Response(bytes, { status: 200 });
  };
  await loadEnvironmentCatalog('/catalog.json', {
    fetchImpl, assetIds: ['polyhaven-fern-02'],
  });
  assert.deepEqual(requested, ['/catalog.json', '/assets/environment/models/fern_02.glb']);
});

test('verified derivative memo avoids rehash/download on an unchanged rebuild', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push([url, options?.cache]);
    if (url === '/catalog.json') return new Response(JSON.stringify(manifest), { status: 200 });
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
    return new Response(bytes, { status: 200 });
  };
  const catalog = await loadEnvironmentCatalog('/catalog.json', { fetchImpl, assetIds: [] });
  await verifyEnvironmentCatalogAssets(catalog, { fetchImpl, assetIds: ['polyhaven-fern-02'], memoize: true });
  const before = requested.length;
  await verifyEnvironmentCatalogAssets(catalog, { fetchImpl, assetIds: ['polyhaven-fern-02'], memoize: true });
  assert.equal(requested.length, before);
  assert.deepEqual(requested.at(-1), ['/assets/environment/models/fern_02.glb', 'reload']);
});

test('verified derivative memo safely verifies only newly referenced files', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push([url, options?.cache]);
    if (url === '/catalog.json') return new Response(JSON.stringify(manifest), { status: 200 });
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
    return new Response(bytes, { status: 200 });
  };
  const catalog = await loadEnvironmentCatalog('/catalog.json', { fetchImpl, assetIds: [] });
  await verifyEnvironmentCatalogAssets(catalog, { fetchImpl, assetIds: ['polyhaven-fern-02'], memoize: true });
  const before = requested.length;
  await verifyEnvironmentCatalogAssets(catalog, {
    fetchImpl, assetIds: ['polyhaven-fern-02', 'polyhaven-boulder-01'], memoize: true,
  });
  assert.equal(requested.length, before + 1, 'only the newly referenced derivative should be fetched');
  assert.deepEqual(requested.at(-1), ['/assets/environment/models/boulder_01.glb', 'reload']);
});

test('course asset collection includes explicit and distributed environment records', () => {
  const ids = collectEnvironmentAssetIds({ environment: {
    placements: [{ assetId: 'tree-a' }],
    scatter: [{ assetIds: ['fern-a', 'rock-a'] }],
    assembly: [{ assetIds: ['tree-a', 'log-a'] }],
    edgeDressing: [{ assetIds: ['rock-a'] }],
  } });
  assert.deepEqual([...ids], ['tree-a', 'fern-a', 'rock-a', 'log-a']);
});
