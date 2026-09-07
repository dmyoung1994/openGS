import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCourse } from '../src/course/course.js';

const range = JSON.parse(await readFile(new URL('../beach-range.json', import.meta.url), 'utf8'));

test('Beach Range is the sole deterministic practice-range dataset', () => {
  const first = normalizeCourse(structuredClone(range));
  assert.deepEqual(first, normalizeCourse(structuredClone(range)));
  assert.equal(first.meta.name, 'Beach Range');
  assert.equal(first.meta.schema, 3);
  assert.equal(first.greens.length, 6);
  assert.equal(first.environment.objectCount, 509);
  assert.ok(first.biomeTransitions.some(({ to }) => to === 'marine-ocean'));
  assert.ok(first.environment.placements.some(
    ({ assetId }) => assetId === 'blendkit-palm-tree-medium-dense',
  ));
});

test('range routing has no obsolete course selector', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /isRangePage \? '\/beach-range\.json' : '\/course\.json'/);
  assert.doesNotMatch(source, /premium-range|requestedCourse/);
  assert.match(source, /loadCourse\(coursePath, \{ catalogAssetIds: environmentCatalog\.byId \}\)/);
});
