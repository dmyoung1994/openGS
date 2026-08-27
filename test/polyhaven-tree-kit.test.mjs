import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/catalog.json', import.meta.url), 'utf8'));
const required = [
  'polyhaven-tree-small-02',
  'polyhaven-tree-small-02-hero',
  'polyhaven-island-tree-02',
  'polyhaven-island-tree-01',
  'blendkit-palm-tree-medium-dense',
];

function localUrl(assetUrl) {
  return new URL(`../public/assets${assetUrl.slice('/assets'.length)}`, import.meta.url);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('runtime tree catalog exposes the reviewed CC0 source kit', () => {
  const assets = manifest.assets.filter(({ category }) => category === 'tree');
  assert.deepEqual(assets.map(({ id }) => id), required);
  for (const asset of assets) {
    assert.equal(asset.license.spdx, 'CC0-1.0');
  }
  assert.match(assets.at(-1).license.sourceUrl, /^https:\/\/www\.blendkit\.com\/asset-gallery-detail\//);
  assert.doesNotMatch(JSON.stringify(manifest), /conifer_v8|polyhaven-fir-sapling-medium/i);
});

test('promoted broadleaf derivatives match their catalog hashes', async () => {
  for (const id of ['polyhaven-tree-small-02-hero', 'polyhaven-island-tree-02', 'polyhaven-island-tree-01']) {
    const asset = manifest.assets.find((candidate) => candidate.id === id);
    assert.ok(asset, `${id} is present`);
    const lod0 = asset.lods.find(({ level }) => level === 0);
    const bytes = await readFile(localUrl(lod0.url));
    assert.equal(hash(bytes), lod0.sha256, `${id} LOD0 hash`);
    for (const alphaMap of asset.alphaMaps) {
      const alphaBytes = await readFile(localUrl(alphaMap.url));
      assert.equal(hash(alphaBytes), alphaMap.sha256, `${id} ${alphaMap.material} alpha hash`);
    }
  }
});

test('promoted palm LODs match their catalog hashes', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'blendkit-palm-tree-medium-dense');
  assert.ok(asset);
  assert.equal(asset.lods.length, 2);
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `palm LOD${lod.level} hash`);
  }
});
