import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CourseSchemaError, normalizeCourse } from '../src/course/course.js';
import { polygonArea } from '../src/course/featureGeometry.js';
import { validateEnvironmentCatalog } from '../src/environment/EnvironmentCatalog.js';
import { resolveEnvironmentPlacements } from '../src/environment/EnvironmentPlacement.js';
import { legacyTreeDefinition } from '../src/trees/TreeDefinition.js';

const coursePath = new URL('../course.json', import.meta.url);
const shippedCourse = JSON.parse(await readFile(coursePath, 'utf8'));
const catalogPath = new URL('../public/assets/environment/catalog.json', import.meta.url);
const shippedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
// Validation fixtures must not depend on the live course retaining catalog assemblies.
const forestFixture = {
  id: 'schema-forest', assetIds: ['polyhaven-pine-tree-01'], seed: 1, count: 0,
  minSpacing: 8, semantic: 'forest-cluster',
  region: { kind: 'bounds', minX: -420, maxX: -416, minZ: 0, maxZ: 4 },
};

test('shipped course validates against the shipped runtime catalog constraints', () => {
  const catalog = new Map(shippedCatalog.assets.map((asset) => [asset.id, asset]));
  const normalized = normalizeCourse(structuredClone(shippedCourse), { catalogAssetIds: catalog });
  assert.equal(normalized.environment.objectCount, 199);
});

test('shared-site normalization is deterministic and preserves every routed hole', () => {
  const first = normalizeCourse(structuredClone(shippedCourse));
  const second = normalizeCourse(structuredClone(shippedCourse));
  assert.deepEqual(first, second);
  assert.equal(first.greens.length, 3);
  assert.equal(first.bunkers.length, 7);
  assert.equal(first.ponds.length, 0);
  assert.equal(first.biome, 'temperate-alpine');
  assert.ok(first.greens.every((green) => green.shape?.length >= 18));
  assert.ok(first.bunkers.every((bunker) => !bunker.shape || bunker.shape.length >= 18));
  assert.equal(first.routing.holes.length, 3);
  assert.equal(first.environment.objectCount, 199);
  assert.deepEqual(first.environment.assembly, []);
  assert.deepEqual(first.environment.edgeDressing, []);
  assert.deepEqual(first.environment.scatter, []);
});

test('forest course uses the authored procedural pines across the routed course', () => {
  const { environment } = normalizeCourse(structuredClone(shippedCourse));
  assert.equal(environment.proceduralTrees.length, 111);
  assert.deepEqual([...new Set(environment.proceduralTrees.map(tree => tree.definitionId))], ['tall-pine']);
  assert.ok(environment.proceduralTreeDefinitions.some(definition => definition.id === 'tall-pine'));
  const trees = environment.proceduralTrees;
  assert.ok(trees.some(tree => tree.z > 300));
  assert.ok(trees.some(tree => tree.z < -170));
  assert.ok(trees.some(tree => tree.x < -350));
  assert.ok(trees.some(tree => tree.x > -45));
  assert.ok(environment.objectCount <= environment.objectBudget && environment.objectBudget <= 720);
});

test('Pineglass resolves its catalog ground dressing alongside the procedural canopy', () => {
  const catalog = validateEnvironmentCatalog(structuredClone(shippedCatalog));
  const normalized = normalizeCourse(structuredClone(shippedCourse), { catalogAssetIds: catalog.byId });
  const terrain = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }) };
  const placements = resolveEnvironmentPlacements(normalized, catalog, terrain);
  assert.equal(placements.length, 88);
  assert.equal(placements.filter(({ assetId }) => catalog.byId.get(assetId).category === 'tree').length, 0);
  assert.equal(placements.filter(({ assetId }) => assetId === 'polyhaven-fern-02').length, 70);
  assert.equal(placements.filter(({ assetId }) => ['deadwood', 'rock'].includes(catalog.byId.get(assetId).category)).length, 18);
  assert.equal(placements.length + normalized.environment.proceduralTrees.length, normalized.environment.objectCount);
});

test('forest routing stays water-free and uses shaped strategic surfaces', () => {
  const normalized = normalizeCourse(structuredClone(shippedCourse));
  assert.deepEqual(normalized.ponds, []);
  assert.ok(normalized.greens.every(({ shape }) => shape.length >= 18));
  assert.ok(normalized.bunkers.every(({ shape }) => shape.length >= 18));
  assert.ok(Math.abs(polygonArea(normalized.greens[0].shape)) > 250);
});

test('feature outlines reject self intersections and preserve the circle fallback', () => {
  const invalid = structuredClone(shippedCourse);
  const green = invalid.greens[0];
  invalid.greens[0].shape = [
    { x: green.x - 6, z: green.z - 6 }, { x: green.x + 6, z: green.z + 6 }, { x: green.x - 6, z: green.z + 6 },
    { x: green.x + 6, z: green.z - 6 }, { x: green.x, z: green.z - 8 }, { x: green.x, z: green.z + 8 },
  ];
  assert.throws(() => normalizeCourse(invalid), /self-intersect|contain the feature center|insufficient area/);
  const legacy = structuredClone(shippedCourse);
  delete legacy.greens[0].shape;
  const normalized = normalizeCourse(legacy);
  assert.equal(normalized.greens[0].shape, undefined);
});

test('course schema rejects unknown fields and unknown catalog assets instead of dropping them', () => {
  const unknownField = structuredClone(shippedCourse);
  unknownField.greens[0].typo = true;
  assert.throws(() => normalizeCourse(unknownField), CourseSchemaError);

  const unknownAsset = structuredClone(shippedCourse);
  unknownAsset.environment.placements.push({
    id: 'bad-tree', assetId: 'not-in-catalog', x: 100, z: -300, rotationY: 0, scale: 1,
  });
  assert.throws(() => normalizeCourse(unknownAsset), /unknown catalog asset/);
});

test('habitatMassId is strict and limited to forest-layer assemblies', () => {
  const wrongSemantic = structuredClone(shippedCourse);
  wrongSemantic.environment.assembly.push({ ...structuredClone(forestFixture), semantic: 'habitat-cluster', habitatMassId: 'invalid-habitat-mass' });
  assert.throws(() => normalizeCourse(wrongSemantic), /habitatMassId is allowed only for forest-layer/);

  const malformed = structuredClone(shippedCourse);
  malformed.environment.assembly.push({ ...structuredClone(forestFixture), habitatMassId: 'Bad Mass' });
  assert.throws(() => normalizeCourse(malformed), /habitatMassId must be a stable kebab-case identifier/);
});

test('course procedural trees use reusable strict definitions instead of foliage aliases', () => {
  const authored = structuredClone(shippedCourse);
  authored.environment.proceduralTreeDefinitions.push(legacyTreeDefinition('douglas-fir'));
  const normalized = normalizeCourse(authored);
  assert.equal(normalized.environment.proceduralTreeDefinitions.at(-1).id, 'builtin-douglas-fir');
  assert.ok(Object.isFrozen(normalized.environment.proceduralTreeDefinitions.at(-1)));

  const missing = structuredClone(shippedCourse);
  missing.environment.proceduralTrees.push({
    id: 'missing-definition-tree', definitionId: 'does-not-exist', x: 100, z: -300,
    rotationY: 0, scale: 1, seed: 1, age: 1, health: 1, windExposure: 0.5,
  });
  assert.throws(() => normalizeCourse(missing), /missing definition/);

  const rawPath = structuredClone(authored);
  rawPath.environment.proceduralTreeDefinitions[0].materials.leaves.textureUrl = '/private/generated.png';
  assert.throws(() => normalizeCourse(rawPath), /same-origin procedural-tree/);

  const legacy = structuredClone(shippedCourse);
  legacy.environment.foliageAlias = 'builtin.douglas-fir.pnw.v1';
  assert.throws(() => normalizeCourse(legacy), /foliageAlias is not allowed/);
});

test('explicit environment objects cannot violate protected course clearances', () => {
  const onGreen = structuredClone(shippedCourse);
  const green = onGreen.greens[0];
  onGreen.environment.placements.push({
    id: 'tree-on-green', assetId: 'polyhaven-tree-small-02', x: green.x, z: green.z, rotationY: 0, scale: 1,
  });
  assert.throws(() => normalizeCourse(onGreen), /green clearance/);

  const inFairway = structuredClone(shippedCourse);
  const routePoint = inFairway.routing.holes[0].route.points[2];
  inFairway.environment.placements.push({
    id: 'tree-in-fairway', assetId: 'polyhaven-tree-small-02', x: routePoint.x, z: routePoint.z, rotationY: 0, scale: 1,
  });
  assert.throws(() => normalizeCourse(inFairway), /fairway clearance/);
});

test('distributed regions apply the declared clearance for each protected feature', () => {
  const candidate = structuredClone(shippedCourse);
  candidate.environment.objectBudget += 1;
  const safe = forestFixture.region;
  candidate.environment.placements = []; candidate.environment.proceduralTrees = [];
  delete candidate.routing; candidate.meta.schema = 3;
  candidate.ponds = [{ x: -400, z: 2, r: 8, depth: 1 }];
  candidate.environment.scatter.push({
    id: 'water-bank-specific-clearance',
    assetIds: ['polyhaven-boulder-01'],
    seed: 77,
    count: 1,
    minSpacing: 2.2,
    // Outside the boulder's 1 m radius + 3 m water clearance, but well inside
    // its unrelated 14 m green clearance. The former max-clearance shortcut
    // incorrectly rejected this valid shoreline region.
    region: { kind: 'bounds', ...safe },
  });
  assert.doesNotThrow(() => normalizeCourse(candidate));
});

test('forest-layer envelopes may cross a fairway buffer while other distributed semantics remain strict', () => {
  const separatorForest = structuredClone(shippedCourse);
  const forest = structuredClone(forestFixture);
  separatorForest.environment.assembly.push(forest);
  forest.count = 0;
  forest.region = {
    kind: 'bounds', minX: -167, maxX: -163, minZ: -147, maxZ: -145,
  };
  assert.doesNotThrow(() => normalizeCourse(separatorForest));

  const separatorUnderstory = structuredClone(separatorForest);
  separatorUnderstory.environment.assembly.find(({ id }) => id === forest.id).semantic = 'forest-understory';
  assert.doesNotThrow(() => normalizeCourse(separatorUnderstory));

  const ordinaryTreeLine = structuredClone(separatorForest);
  const ordinary = ordinaryTreeLine.environment.assembly.find(({ id }) => id === forest.id);
  ordinary.semantic = 'tree-line';
  ordinary.assetIds = ['polyhaven-pine-tree-01'];
  delete ordinary.habitatMassId;
  assert.throws(
    () => normalizeCourse(ordinaryTreeLine),
    /region intersects fairway clearance/,
  );
});

test('course environment budget is hard-capped at 3000 objects', () => {
  const overBudget = structuredClone(shippedCourse);
  overBudget.environment.objectBudget = 3000;
  const safe = forestFixture.region;
  overBudget.environment.scatter.push({
    id: 'too-many-trees',
    assetIds: ['polyhaven-tree-small-02'],
    seed: 5,
    count: 3001,
    minSpacing: 6,
    region: { kind: 'bounds', ...safe },
  });
  assert.throws(() => normalizeCourse(overBudget), /exceeding its hard budget/);
});
