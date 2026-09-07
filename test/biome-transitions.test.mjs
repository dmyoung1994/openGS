import test from 'node:test';
import assert from 'node:assert/strict';
import { DataUtils } from 'three';
import shippedCourse from '../course.json' with { type: 'json' };
import { normalizeCourse } from '../src/course/course.js';
import {
  classifyBiomeAt, compileBiomeTransitionField, TRANSITION_WEIGHT_NAMES,
} from '../src/course/BiomeRegistry.js';

function coastalCourse(profile = 'natural-resort-beach') {
  const course = structuredClone(shippedCourse);
  course.meta.schema = 3;
  course.meta.name = 'Biome transition fixture';
  course.biome = 'temperate-maritime';
  course.bounds = { minX: -110, maxX: 110, minZ: -340, maxZ: 30 };
  course.tee = { x: 0, z: 2, boxHalfX: 4, z0: -3, z1: 7 };
  course.corridor = { c0: 28, k: 0.02, rough: 14 };
  course.fringeW = 5;
  course.greens = [{ yards: 200, x: 0, z: -182.88, r: 10, contour: 'tilt' }];
  course.bunkers = [];
  course.ponds = [];
  course.forestFloorAreas = [];
  course.landforms = [];
  delete course.routing;
  course.environment = { ...course.environment, placements: [], proceduralTrees: [], scatter: [], assembly: [], edgeDressing: [], exclusions: [], objectBudget: 0 };
  course.biomeTransitions = [{
    id: 'ocean-edge', from: 'temperate-maritime', to: 'marine-ocean',
    boundary: { kind: 'course-edge', sides: ['min-x', 'min-z'] },
    profile, seed: 1843021, widthScale: 1, priority: 100,
  }];
  return course;
}

test('schema v3 requires explicit migration and preserves empty-transition behavior', () => {
  const legacy = structuredClone(shippedCourse);
  legacy.meta.schema = 2;
  delete legacy.biomeTransitions;
  assert.throws(() => normalizeCourse(legacy), /requires explicit migration to 3/);
  const transitionFree = structuredClone(shippedCourse);
  transitionFree.biomeTransitions = [];
  const normalized = normalizeCourse(transitionFree);
  assert.deepEqual(normalized.biomeTransitions, []);
  assert.equal(classifyBiomeAt(normalized, 0, 0).weights.primary, 1);
});

test('coastal fixture authors a restrained two-sided resort shoreline', () => {
  const normalized = normalizeCourse(coastalCourse());
  assert.deepEqual(normalized.biomeTransitions, [{
    id: 'ocean-edge',
    from: 'temperate-maritime',
    to: 'marine-ocean',
    boundary: { kind: 'course-edge', sides: ['min-x', 'min-z'] },
    profile: 'natural-resort-beach',
    seed: 1843021,
    widthScale: 1,
    priority: 100,
  }]);
  assert.equal(classifyBiomeAt(normalized, 0, normalized.bounds.maxZ).transitionId, null,
    'the landward edge behind the tee must not become coastline');
});

test('coastal fixture keeps protected play authoritative and orders every coastal band', () => {
  const authored = coastalCourse();
  const normalized = normalizeCourse(authored);
  const withoutTransition = structuredClone(authored);
  withoutTransition.biomeTransitions = [];
  const baseline = normalizeCourse(withoutTransition);

  for (const key of ['tee', 'corridor', 'fringeW', 'greens', 'bunkers', 'ponds']) {
    assert.deepEqual(normalized[key], baseline[key], `${key} gameplay authority must not change`);
  }
  const protectedCenters = [
    [normalized.tee.x, (normalized.tee.z0 + normalized.tee.z1) * 0.5],
    ...normalized.greens.map(({ x, z }) => [x, z]),
    ...normalized.bunkers.map(({ x, z }) => [x, z]),
    ...normalized.ponds.map(({ x, z }) => [x, z]),
  ];
  for (const [x, z] of protectedCenters) {
    const weights = classifyBiomeAt(normalized, x, z).weights;
    assert.equal(weights.primary, 1, `protected feature at ${x},${z} remains primary biome`);
    assert.equal(weights.wetSand + weights.shallowShelf + weights.deepOcean, 0,
      `protected feature at ${x},${z} remains dry`);
  }

  const z = -260;
  const edgeX = normalized.bounds.minX;
  const orderedSamples = [
    [edgeX + 30, 'primary'], [edgeX + 10, 'strandGrass'], [edgeX, 'dune'], [edgeX - 15, 'drySand'],
    [edgeX - 40, 'wetSand'], [edgeX - 70, 'shallowShelf'], [edgeX - 110, 'deepOcean'],
  ];
  for (const [x, expected] of orderedSamples) {
    const weights = classifyBiomeAt(normalized, x, z).weights;
    const dominant = Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(dominant, expected, `expected ${expected} to own ${x},${z}`);
  }

  assert.deepEqual(
    classifyBiomeAt(normalized, -120, z),
    classifyBiomeAt(normalizeCourse(coastalCourse()), -120, z),
    'authored shoreline ownership is deterministic',
  );
});

test('registered coast profiles compile deterministic ordered normalized weights', () => {
  for (const profile of ['natural-resort-beach', 'narrow-wild-shore', 'broad-pristine-beach']) {
    const normalized = normalizeCourse(coastalCourse(profile));
    const inland = classifyBiomeAt(normalized, 0, -100);
    const edge = classifyBiomeAt(normalized, normalized.bounds.minX, -100);
    const offshore = classifyBiomeAt(normalized, normalized.bounds.minX - 400, -100);
    assert.equal(inland.weights.primary, 1);
    assert.ok(edge.weights.dune + edge.weights.drySand > 0.9);
    assert.ok(offshore.weights.deepOcean > 0.99);
    for (const classification of [inland, edge, offshore]) {
      const sum = TRANSITION_WEIGHT_NAMES.reduce((total, name) => total + classification.weights[name], 0);
      assert.ok(Math.abs(sum - 1) < 1e-9);
    }
    assert.deepEqual(classifyBiomeAt(normalized, normalized.bounds.minX - 20, -123), classifyBiomeAt(normalized, normalized.bounds.minX - 20, -123));
  }
});

test('coastal habitat kernels overlap smoothly instead of exposing painted stripes', () => {
  const normalized = normalizeCourse(coastalCourse());
  const z = -123;
  let maximumOverlap = 0;

  let previous = classifyBiomeAt(normalized, normalized.bounds.minX + 8, z).weights;
  for (let distance = -7.75; distance <= 60; distance += 0.25) {
    const next = classifyBiomeAt(normalized, normalized.bounds.minX - distance, z).weights;
    maximumOverlap = Math.max(maximumOverlap,
      TRANSITION_WEIGHT_NAMES.filter((name) => next[name] > 0.02).length);
    const delta = TRANSITION_WEIGHT_NAMES.reduce(
      (sum, name) => sum + Math.abs(next[name] - previous[name]), 0,
    );
    assert.ok(delta < 0.16, `transition weight jump ${delta} at ${distance}m`);
    previous = next;
  }
  assert.ok(maximumOverlap >= 3,
    `expected at least one multi-habitat ecotone sample, got ${maximumOverlap} channels`);
});

test('multi-side coast rounds exterior corners instead of compiling box terraces', () => {
  const normalized = normalizeCourse(coastalCourse());
  const { minX, minZ } = normalized.bounds;
  const classification = classifyBiomeAt(normalized, minX - 12, minZ - 16);
  assert.ok(Math.abs(classification.distance - 20) < 1e-9,
    `expected Euclidean exterior corner distance, got ${classification.distance}`);
});

test('transition field CPU classification matches its baked half-float texel', () => {
  const normalized = normalizeCourse(coastalCourse());
  const field = compileBiomeTransitionField(normalized, { texelsPerM: 0.25 });
  const i = 0, j = Math.floor(field.height * 0.5);
  const x = field.bounds.minX + (i + 0.5) / field.texelsPerM;
  const z = field.bounds.minZ + (j + 0.5) / field.texelsPerM;
  const cpu = field.sample(x, z).weights;
  const data = field.landTexture.image.data;
  const k = (j * field.width + i) * 4;
  assert.ok(Math.abs(DataUtils.fromHalfFloat(data[k]) - cpu.primary) < 0.001);
  assert.ok(Math.abs(DataUtils.fromHalfFloat(data[k + 1]) - cpu.strandGrass) < 0.001);
  field.dispose();
});

test('a course without biome boundaries uses an exact constant texel', () => {
  for (const biome of ['temperate-maritime', 'temperate-alpine', 'marine-ocean']) {
    const course = { biome, biomeTransitions: [], bounds: { minX: -1000, maxX: 1000, minZ: -500, maxZ: 500 } };
    const field = compileBiomeTransitionField(course);
    assert.equal(field.width, 1); assert.equal(field.height, 1);
    assert.equal(field.hasTransitions, false);
    const pixels = [...field.landTexture.image.data, ...field.waterTexture.image.data].map(DataUtils.fromHalfFloat);
    for (const [x, z] of [[-1000, -500], [0, 0], [1000, 500], [2000, 1000]]) {
      const cpu = field.sample(x, z).weights;
      assert.deepEqual(pixels, TRANSITION_WEIGHT_NAMES.map(name => cpu[name]));
    }
    field.dispose();
  }
});

test('transition validation rejects incompatible pairs, unsafe water polygons, widths, and ambiguous ownership', () => {
  const incompatible = coastalCourse();
  incompatible.biomeTransitions[0].to = 'temperate-alpine';
  assert.throws(() => normalizeCourse(incompatible), /incompatible/);

  const waterPocket = coastalCourse();
  waterPocket.biomeTransitions[0].boundary = { kind: 'polygon-region', points: [{ x: -90, z: -300 }, { x: -60, z: -300 }, { x: -75, z: -270 }] };
  assert.throws(() => normalizeCourse(waterPocket), /water-producing profiles require a course-edge/);

  const width = coastalCourse();
  width.biomeTransitions[0].widthScale = 2.1;
  assert.throws(() => normalizeCourse(width), /widthScale/);

  const overlap = coastalCourse();
  overlap.biomeTransitions.push({ ...structuredClone(overlap.biomeTransitions[0]), id: 'ocean-edge-two', seed: 9 });
  assert.throws(() => normalizeCourse(overlap), /equal-priority.*overlap/);
});

test('maritime alpine polygon ecotone is valid and never produces water', () => {
  const course = coastalCourse();
  course.biomeTransitions = [{
    id: 'alpine-pocket', from: 'temperate-maritime', to: 'temperate-alpine',
    boundary: { kind: 'polygon-region', points: [{ x: -90, z: -300 }, { x: -55, z: -302 }, { x: -58, z: -260 }, { x: -92, z: -265 }] },
    profile: 'maritime-alpine-ecotone', seed: 41, widthScale: 0.8, priority: 50,
  }];
  const normalized = normalizeCourse(course);
  const classification = classifyBiomeAt(normalized, -72, -282);
  assert.ok(classification.weights.alpine > 0.5);
  assert.equal(classification.weights.shallowShelf + classification.weights.deepOcean, 0);
});
