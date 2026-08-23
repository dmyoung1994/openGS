import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCourse } from '../src/course/course.js';

const premiumPath = new URL('../premium-range.json', import.meta.url);
const premiumCourse = JSON.parse(await readFile(premiumPath, 'utf8'));

test('Premium Range is a separate long-range Augusta geometry test', () => {
  const first = normalizeCourse(structuredClone(premiumCourse));
  const second = normalizeCourse(structuredClone(premiumCourse));
  assert.deepEqual(first, second);
  assert.equal(first.meta.name, 'Premium Range');
  assert.equal(first.biome, 'temperate-maritime');
  assert.deepEqual(first.bounds, { minX: -150, maxX: 150, minZ: -480, maxZ: 34 });
  assert.equal(first.greens.length, 9);
  assert.deepEqual(first.greens.map(({ yards }) => yards), [40, 80, 120, 165, 215, 275, 335, 395, 450]);
  assert.equal(first.bunkers.length, 11);
  assert.equal(first.ponds.length, 0);
  assert.equal(first.environment.objectBudget, 40);
  assert.equal(first.environment.objectCount, 40);
  assert.equal(first.environment.placements.length, 40);
  assert.deepEqual([...new Set(first.environment.placements.map(({ assetId }) => assetId))].sort(), [
    'polyhaven-fir-tree-01',
    'polyhaven-fir-tree-01-variant-b',
    'polyhaven-fir-tree-01-variant-c',
    'polyhaven-island-tree-01',
    'polyhaven-pine-tree-01',
    'polyhaven-tree-small-02',
  ]);
  assert.equal(first.corridor.c0, 22);
  assert.equal(first.corridor.k, 0.055);
});

test('Premium Range uses the new Poly Haven tree kit rather than legacy runtime packs', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/assets/environment/catalog.json', import.meta.url), 'utf8'));
  const premiumAssets = new Set(normalizeCourse(structuredClone(premiumCourse)).environment.placements.map(({ assetId }) => assetId));
  assert.ok(premiumAssets.has('polyhaven-fir-tree-01'));
  assert.ok(premiumAssets.has('polyhaven-pine-tree-01'));
  for (const assetId of premiumAssets) {
    const asset = catalog.assets.find((candidate) => candidate.id === assetId);
    assert.ok(asset, `${assetId} must exist in the runtime catalog`);
    assert.equal(asset.license.spdx, 'CC0-1.0');
    assert.match(asset.license.sourceUrl, /^https:\/\/polyhaven\.com\/a\//);
  }
  assert.doesNotMatch(JSON.stringify(catalog), /blenderkit|conifer_v8|polyhaven-fir-sapling-medium/i);
});

test('Premium Range selection is query-gated in the production bootstrap', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /startupQuery\.get\('course'\) === 'premium-range' \? '\/premium-range\.json'/);
  assert.match(source, /loadCourse\(coursePath, \{ catalogAssetIds: environmentCatalog\.byId \}\)/);
});
