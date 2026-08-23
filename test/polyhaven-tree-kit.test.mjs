import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/catalog.json', import.meta.url), 'utf8'));
const required = [
  'polyhaven-tree-small-02',
  'polyhaven-island-tree-01',
  'polyhaven-fir-tree-01',
  'polyhaven-fir-tree-01-variant-b',
  'polyhaven-fir-tree-01-variant-c',
  'polyhaven-pine-tree-01',
];

function localUrl(assetUrl) {
  return new URL(`../public/assets${assetUrl.slice('/assets'.length)}`, import.meta.url);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('runtime tree catalog is Poly Haven-only and exposes the new source kit', () => {
  const assets = manifest.assets.filter(({ category }) => category === 'tree');
  assert.deepEqual(assets.map(({ id }) => id), [
    'polyhaven-tree-small-02',
    'polyhaven-island-tree-01',
    'polyhaven-fir-tree-01',
    'polyhaven-fir-tree-01-variant-b',
    'polyhaven-fir-tree-01-variant-c',
    'polyhaven-pine-tree-01',
  ]);
  for (const asset of assets) {
    assert.equal(asset.license.spdx, 'CC0-1.0');
    assert.match(asset.license.sourceUrl, /^https:\/\/polyhaven\.com\/a\//);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /blenderkit|conifer_v8|polyhaven-fir-sapling-medium/i);
});

test('new Fir and Pine derivatives match their catalog hashes', async () => {
  for (const id of ['polyhaven-fir-tree-01', 'polyhaven-fir-tree-01-variant-b', 'polyhaven-fir-tree-01-variant-c', 'polyhaven-pine-tree-01']) {
    const asset = manifest.assets.find((candidate) => candidate.id === id);
    assert.ok(asset, `${id} is present`);
    for (const lod of asset.lods) {
      const bytes = await readFile(localUrl(lod.url));
      assert.equal(hash(bytes), lod.sha256, `${id} LOD${lod.level} hash`);
    }
    if (asset.impostor.kind === 'baked-atlas') {
      const bytes = await readFile(localUrl(asset.impostor.url));
      assert.equal(hash(bytes), asset.impostor.sha256, `${id} impostor hash`);
    }
  }
});

test('Fir variants remain direct Poly Haven source silhouettes instead of generated tree packs', async () => {
  for (const [id, variant] of [['polyhaven-fir-tree-01-variant-b', 'b'], ['polyhaven-fir-tree-01-variant-c', 'c']]) {
    const asset = manifest.assets.find((candidate) => candidate.id === id);
    const bytes = await readFile(localUrl(asset.lods[0].url));
    const jsonLength = bytes.readUInt32LE(12);
    const document = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
    assert.equal(document.extras.sourceAsset, 'fir_tree_01');
    assert.equal(document.extras.sourceVariant, variant);
    assert.equal(asset.impostor.kind, 'none');
  }
});
