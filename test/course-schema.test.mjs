import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CourseSchemaError, normalizeCourse } from '../src/course/course.js';
import { polygonArea } from '../src/course/featureGeometry.js';

const coursePath = new URL('../course.json', import.meta.url);
const shippedCourse = JSON.parse(await readFile(coursePath, 'utf8'));
const catalogPath = new URL('../public/assets/environment/catalog.json', import.meta.url);
const shippedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));

test('shipped course validates against the shipped runtime catalog constraints', () => {
  const catalog = new Map(shippedCatalog.assets.map((asset) => [asset.id, asset]));
  const normalized = normalizeCourse(structuredClone(shippedCourse), { catalogAssetIds: catalog });
  assert.equal(normalized.environment.objectCount, 515);
});

test('course v2 normalization is deterministic and preserves gameplay features', () => {
  const first = normalizeCourse(structuredClone(shippedCourse));
  const second = normalizeCourse(structuredClone(shippedCourse));
  assert.deepEqual(first, second);
  assert.equal(first.greens.length, 6);
  assert.equal(first.bunkers.length, 7);
  assert.equal(first.ponds.length, 1);
  assert.ok(first.ponds[0].shape?.length >= 18, 'ponds use the normalized authored outline');
  assert.equal(first.biome, 'temperate-alpine');
  assert.ok(first.greens.every((green) => green.shape?.length >= 18));
  assert.ok(first.bunkers.every((bunker) => !bunker.shape || bunker.shape.length >= 18));
  assert.equal(first.environment.objectCount, 515);
  assert.deepEqual(first.environment.edgeDressing, [],
    'photographic HDR forest supplies the distant enclosure without authored edge rows');
  assert.deepEqual(first.environment.assembly.filter(({ id }) => id.startsWith('forest-cluster-')).map(({ id, semantic, count }) => ({ id, semantic, count })), [
    { id: 'forest-cluster-left-foreground', semantic: 'forest-cluster', count: 9 },
    { id: 'forest-cluster-right-foreground', semantic: 'forest-cluster', count: 8 },
    { id: 'forest-cluster-left-midground', semantic: 'forest-cluster', count: 10 },
    { id: 'forest-cluster-right-midground', semantic: 'forest-cluster', count: 9 },
    { id: 'forest-cluster-left-shoulder', semantic: 'forest-cluster', count: 7 },
    { id: 'forest-cluster-right-shoulder', semantic: 'forest-cluster', count: 6 },
    { id: 'forest-cluster-left-backdrop', semantic: 'forest-cluster', count: 8 },
    { id: 'forest-cluster-right-backdrop', semantic: 'forest-cluster', count: 7 },
  ]);
  assert.deepEqual(first.environment.scatter.map((record) => record.id), [
    'fern-drift-left-foreground', 'fern-drift-right-moisture', 'fern-drift-left-mid',
    'fern-drift-right-mid', 'fern-drift-left-backdrop', 'fern-drift-right-backdrop',
    'fern-contact-left-front-log', 'fern-contact-right-mid-log', 'fern-contact-left-back-log',
    'fern-contact-left-outcrop', 'fern-contact-pond-outcrop', 'fern-contact-back-outcrop',
    'fern-understory-left-foreground', 'fern-understory-right-foreground',
    'fern-understory-left-midground', 'fern-understory-right-midground',
  ]);
});

test('alpine forest revision uses the dense fir in layered side lines with a central window', () => {
  const normalized = normalizeCourse(structuredClone(shippedCourse));
  const environment = normalized.environment;
  const catalog = new Map(shippedCatalog.assets.map((asset) => [asset.id, asset]));
  const isTree = (assetId) => catalog.get(assetId)?.category === 'tree';
  const explicitTrees = environment.placements.filter(({ assetId }) => isTree(assetId));
  const distributedTreeRecords = [...environment.assembly, ...environment.edgeDressing]
    .filter(({ assetIds }) => assetIds.some(isTree));
  const distributedTrees = distributedTreeRecords.reduce((sum, record) => sum + record.count, 0);
  assert.equal(explicitTrees.length, 17, 'all authored anchor/mid-tier/understory trees remain');
  assert.equal(distributedTrees, 162);
  assert.equal(explicitTrees.length + distributedTrees, 179);
  // One reviewed source now owns every standing tree. Scale still supplies
  // deliberate young, middle, and mature silhouettes without another species
  // batch or a mismatched LOD family.
  const species = new Set(explicitTrees.map(({ assetId }) => assetId));
  assert.deepEqual([...species], ['polyhaven-fir-sapling-medium']);
  assert.ok(distributedTreeRecords.every(({ assetIds }) => assetIds.length === 1 && assetIds[0] === 'polyhaven-fir-sapling-medium'));
  const heights = explicitTrees.map(({ assetId, scale }) => catalog.get(assetId).dimensions.height * scale);
  const ageClasses = new Set(heights.map((h) => (h < 12 ? 'young' : h > 15 ? 'mature' : 'middle')));
  assert.equal(ageClasses.size, 3, 'explicit anchors retain young, middle, and mature height classes');
  const forestRecords = distributedTreeRecords.filter(({ semantic }) => semantic === 'forest-cluster' || semantic === 'course-boundary');
  assert.ok(forestRecords.some(({ region }) => region.maxZ > -125), 'foreground community exists');
  assert.ok(forestRecords.some(({ region }) => region.minZ < -180 && region.maxZ > -250), 'midground community exists');
  assert.ok(forestRecords.some(({ region }) => region.minZ < -300),
    'authored backdrop communities reinforce the photographic horizon');
  assert.ok(forestRecords.every(({ region }) => region.maxX < -52 || region.minX > 52),
    'tree bands frame the narrower range while preserving the central downrange opening');
  const sideLines = forestRecords.filter(({ id }) => id.startsWith('grandfir-side-line-'));
  assert.equal(sideLines.length, 4);
  assert.ok(sideLines.some(({ id, region, count }) => id.endsWith('-left')
    && region.minZ <= -330 && region.maxZ >= 10 && count === 42),
  'the unobstructed left side line runs continuously through the back range');
  assert.ok(sideLines.filter(({ id }) => id.startsWith('grandfir-side-line-right-')).length === 3,
    'the pond side uses three overlapping depth bands instead of forcing trees through water');
  assert.equal(forestRecords.filter(({ id }) => id.includes('understory')).length, 0,
    'forest communities should not recreate a repeated understory curtain');
  assert.ok(environment.objectCount <= 525, 'authored ecology must remain below the 525-object composition ceiling');
  assert.ok(environment.objectCount <= environment.objectBudget && environment.objectBudget <= 700);
});

test('pond uses an asymmetric alpine basin with one shallow neck and preserved scale', () => {
  const pond = shippedCourse.ponds[0];
  const radii = pond.shape.map(({ x, z }) => Math.hypot(x - pond.x, z - pond.z));
  assert.ok(pond.shape.length >= 12, 'basin needs enough authored controls for a readable inlet');
  assert.ok(Math.min(...radii) < 9 && Math.max(...radii) > 15,
    'kidney basin needs a narrow neck and two broader lobes');
  assert.ok(Math.max(...radii) - Math.min(...radii) > 6,
    'pond outline must not collapse to an ellipse');
  assert.ok(Math.abs(polygonArea(pond.shape)) > 520 && Math.abs(polygonArea(pond.shape)) < 680,
    'basin area must stay close to the authored pond strategy');
  const normalized = normalizeCourse(structuredClone(shippedCourse));
  assert.ok(normalized.ponds[0].shape.length >= 18,
    'the authoritative contour pipeline must retain the high-resolution basin');
});

test('feature outlines reject self intersections and preserve the circle fallback', () => {
  const invalid = structuredClone(shippedCourse);
  invalid.greens[0].shape = [
    { x: -12, z: -50 }, { x: 0, z: -39 }, { x: -12, z: -39 },
    { x: 0, z: -50 }, { x: -6, z: -52 }, { x: -6, z: -38 },
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

test('course foliage uses a stable versioned alias instead of runtime asset paths', () => {
  const aliased = structuredClone(shippedCourse);
  aliased.environment.foliageAlias = 'builtin.douglas-fir.pnw.v1';
  assert.equal(normalizeCourse(aliased).environment.foliageAlias, 'builtin.douglas-fir.pnw.v1');
  for (const invalid of ['/assets/tree.ktx2', 'douglas-fir', 'builtin.douglas-fir.pnw.v0']) {
    const malformed = structuredClone(shippedCourse);
    malformed.environment.foliageAlias = invalid;
    assert.throws(() => normalizeCourse(malformed), /versioned.*alias/);
  }

  const mixed = structuredClone(shippedCourse);
  mixed.environment.foliageAliases = [
    'builtin.douglas-fir.pnw.v1',
    'builtin.italian-cypress.mediterranean.v1',
    'local.monterey-cypress.coastal.v1',
  ];
  const normalized = normalizeCourse(mixed);
  assert.deepEqual(normalized.environment.foliageAliases, mixed.environment.foliageAliases);
  assert.ok(Object.isFrozen(normalized.environment.foliageAliases));

  for (const foliageAliases of [[], ['douglas-fir'], [
    'builtin.douglas-fir.pnw.v1', 'builtin.douglas-fir.pnw.v1',
  ], [
    'local.first.private.v1', 'local.second.private.v1',
    'local.third.private.v1', 'local.fourth.private.v1',
  ]]) {
    const malformed = structuredClone(shippedCourse);
    malformed.environment.foliageAliases = foliageAliases;
    assert.throws(() => normalizeCourse(malformed), /foliageAliases/);
  }
  const ambiguous = structuredClone(mixed);
  ambiguous.environment.foliageAlias = 'builtin.douglas-fir.pnw.v1';
  assert.throws(() => normalizeCourse(ambiguous), /not both/);
});

test('explicit environment objects cannot violate protected course clearances', () => {
  const onGreen = structuredClone(shippedCourse);
  onGreen.environment.placements.push({
    id: 'tree-on-green', assetId: 'polyhaven-tree-small-02', x: -6, z: -45.72, rotationY: 0, scale: 1,
  });
  assert.throws(() => normalizeCourse(onGreen), /green clearance/);

  const inFairway = structuredClone(shippedCourse);
  inFairway.environment.placements.push({
    id: 'tree-in-fairway', assetId: 'polyhaven-tree-small-02', x: 0, z: -320, rotationY: 0, scale: 1,
  });
  assert.throws(() => normalizeCourse(inFairway), /fairway clearance/);
});

test('distributed regions apply the declared clearance for each protected feature', () => {
  const candidate = structuredClone(shippedCourse);
  candidate.environment.scatter.push({
    id: 'water-bank-specific-clearance',
    assetIds: ['polyhaven-boulder-01'],
    seed: 77,
    count: 1,
    minSpacing: 2.2,
    // Outside the boulder's 1 m radius + 3 m water clearance, but well inside
    // its unrelated 14 m green clearance. The former max-clearance shortcut
    // incorrectly rejected this valid shoreline region.
    region: { kind: 'bounds', minX: 83.1, maxX: 83.4, minZ: -110.2, maxZ: -109.8 },
  });
  assert.doesNotThrow(() => normalizeCourse(candidate));
});

test('course environment budget is hard-capped at 3000 objects', () => {
  const overBudget = structuredClone(shippedCourse);
  overBudget.environment.objectBudget = 3000;
  overBudget.environment.scatter.push({
    id: 'too-many-trees',
    assetIds: ['polyhaven-tree-small-02'],
    seed: 5,
    count: 3001,
    minSpacing: 6,
    region: { kind: 'bounds', minX: 92, maxX: 104, minZ: -330, maxZ: -300 },
  });
  assert.throws(() => normalizeCourse(overBudget), /exceeding its hard budget/);
});
