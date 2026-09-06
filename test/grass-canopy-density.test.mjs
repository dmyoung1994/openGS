import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  bakeDenseCanopyMask, CANOPY_DISTANCE_MAX_METERS, canopyForestFloorWeight,
  decodeCanopyDistanceMeters, deriveCanopyHabitatPrimitives,
  sampleCanopyForestFloorWeight,
} from '../src/terrain/CanopyField.js';

const grassSource = () => readFile(new URL('../src/terrain/Grass.js', import.meta.url), 'utf8');
const canopySource = () => readFile(new URL('../src/terrain/CanopyField.js', import.meta.url), 'utf8');
const terrainSource = () => readFile(new URL('../src/terrain/Terrain.js', import.meta.url), 'utf8');
const rangeSource = () => readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');

const field = () => new Uint8Array(41 * 21);
const grid = Object.freeze({ minX: -20, minZ: -10, spacing: 1 });
const at = (data, x, z) => data[(z - grid.minZ) * 41 + (x - grid.minX)];

test('clearing an empty canopy preserves surface eligibility and removes old distances', () => {
  const data = field();
  data.fill(127); data[0] = 255;
  assert.equal(bakeDenseCanopyMask(data, 41, 21, grid, []), data);
  assert.equal(data[0], 128);
  assert.ok(data.subarray(1).every(value => value === 0));
});

test('dense-canopy bake keeps suppression bounded when perimeter crowns overlap', () => {
  const isolated = bakeDenseCanopyMask(field(), 41, 21, grid, [
    { x: 0, z: 0, canopyRadius: 10 },
  ]);
  assert.ok(decodeCanopyDistanceMeters(at(isolated, 0, 0)) > 8.1,
    'one crown centre should preserve the physical depth of its full visible crown');
  assert.equal(at(isolated, -12, 0), 0);
  assert.ok(at(isolated, -7, 0) < at(isolated, -3, 0),
    'single-crown suppression must taper smoothly rather than punch a hard hole');

  const placements = [
    { x: -2, z: 0, canopyRadius: 10 },
    { x: 2, z: 0, canopyRadius: 10 },
  ];
  const first = bakeDenseCanopyMask(field(), 41, 21, grid, placements);
  const second = bakeDenseCanopyMask(field(), 41, 21, grid, placements);
  assert.deepEqual(first, second, 'the authored world-space field must be deterministic');
  assert.ok(at(first, 0, 0) <= at(isolated, 0, 0),
    'adding neighboring crowns must not repeatedly erase the same grass roots');
  assert.equal(at(first, -13, 0), 0, 'the mask cannot extend beyond authored crown bounds');
  assert.equal(at(first, 13, 0), 0, 'the mask cannot extend beyond authored crown bounds');

  const occupiedX = [];
  for (let x = -20; x <= 20; x++) if (at(first, x, 0) > 0) occupiedX.push(x);
  assert.ok(occupiedX.length > 3, 'overlap should form a readable connected understory footprint');
  for (let i = 1; i < occupiedX.length; i++) {
    assert.equal(occupiedX[i], occupiedX[i - 1] + 1,
      'smooth overlapping kernels must not create disconnected radial holes');
  }
  assert.ok(at(first, occupiedX[0], 0) < at(first, 0, 0));
  assert.ok(at(first, occupiedX.at(-1), 0) < at(first, 0, 0));
});

test('canopy habitat keeps exact grass eligibility and a smooth material-distance sample', async () => {
  const source = await grassSource();
  const canopy = await canopySource();
  const terrain = await terrainSource();
  assert.match(canopy, /export const GRASS_GROWABLE_BIT = 128/);
  assert.match(canopy, /export const CANOPY_MASK_MAX = 127/);
  assert.match(canopy, /export const CANOPY_DISTANCE_MAX_METERS = 12/,
    'the packed field must retain physical crown depth through the largest authored feather');
  assert.match(terrain, /this\.uCrownCoreGrassDensity = uniform\(0\.0\)/,
    'the compatibility field records the exclusive zero-grass contract');
  assert.match(canopy, /result\.minFilter = result\.magFilter = NearestFilter/,
    'grass eligibility must remain exact at texel boundaries');
  assert.match(canopy, /export function createCanopyDistanceTexture[\s\S]*LinearFilter/,
    'the visible forest-floor edge must sample a separate linearly filtered R8 field');
  assert.match(terrain, /this\._canopyDistanceSpacing = this\._forestFloorMaps \? Math\.min\(spacing, 0\.3\) : spacing/,
    'a tight maintained edge needs a finer visual SDF than the grass eligibility grid');
  assert.match(terrain, /this\._canopyDistanceNx \* this\._canopyDistanceNz/);
  assert.match(terrain, /bakeDenseCanopyMask\(\s*this\._canopyDistanceData, this\._canopyDistanceNx, this\._canopyDistanceNz/,
    'the visual distance field must be baked independently at its finer resolution');
  assert.match(terrain, /texture\(this\._canopyDistanceTexture, macroUv\)\.r/);
  assert.match(terrain, /groundCoverTriangles: 0/,
    'pine litter remains a terrain material and contributes no geometry');
  assert.match(source, /terrain\.canopyTexture/,
    'grass must borrow the exact terrain-owned habitat texture');
  assert.equal(source.match(/textureLoad\( c\.dataTex/g)?.length, 1,
    'candidate compute must retain exactly one grass-field sample');
  assert.match(terrain, /this\._canopyData\[index\] \|= this\._growableData\[index\]/);
  assert.match(terrain, /GRASS_CANDIDATE_SURFACES\.has\(config\.surfaceFn\(x, z\)\)/);
  assert.match(source, /packedGround\.mod\( GRASS_GROWABLE_BIT \)\.div\( CANOPY_MASK_MAX \)/);
  assert.match(source, /const grassSurfaceCandidate = packedGround\.greaterThanEqual\( GRASS_GROWABLE_BIT \)/);
  // Only a ground cover that owns an exclusive canopy material may retire blades
  // outright, because a litter bed replaces them. Anywhere else the same mask has
  // to thin the grass instead: the hard reject used to leave a bald disc of bare
  // terrain under every crown with nothing drawn in it.
  assert.match(source, /const turfCandidate = canopyExclusiveSurface\s*\?\s*grassSurfaceCandidate\.and\( canopyMask\.lessThanEqual\( 0\.0 \) \)\s*:\s*grassSurfaceCandidate;/,
    'the exclusive-material reject must be conditional on the ground cover owning one');
  assert.match(source, /const canopyKeep = canopyExclusiveSurface \? null : mix\(/,
    'non-exclusive ground covers must thin beneath a crown rather than retire blades');
  assert.match(source, /this\.canopyExclusiveSurface = canopyOwnsExclusiveSurface\( terrain\.groundCover \)/,
    'grass and terrain must resolve the exclusive-surface decision from one shared predicate');

  const outsidePacked = 128;
  assert.equal(outsidePacked % 128, 0, 'outside-canopy texels decode an exact zero mask');
  assert.ok(outsidePacked >= 128, 'the growable bit remains exact outside canopy');
});

test('fine visual canopy field removes coarse-grid protrusions from a tight curved edge', () => {
  const bake = (spacing) => {
    const extent = 15;
    const size = Math.floor(extent * 2 / spacing) + 1;
    const sampleGrid = { minX: -extent, minZ: -extent, spacing };
    const data = bakeDenseCanopyMask(new Uint8Array(size * size), size, size, sampleGrid, [
      { x: 0, z: 0, canopyRadius: 10 },
    ]);
    const weights = [];
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const angle = degrees * Math.PI / 180;
      weights.push(sampleCanopyForestFloorWeight(
        data, size, size, sampleGrid,
        Math.cos(angle) * 11.2, Math.sin(angle) * 11.2, 0.45,
      ));
    }
    return Math.max(...weights);
  };
  assert.ok(bake(0.3) < bake(0.6) * 0.2,
    'the visual field must not leave angle-dependent stair-step spikes outside a round crown');
});

test('live crown feather changes the pine-floor boundary without changing habitat ownership', async () => {
  const data = bakeDenseCanopyMask(field(), 41, 21, grid, [
    { x: 0, z: 0, canopyRadius: 10 },
  ]);
  const boundaryPacked = at(data, 8, 0);
  const corePacked = at(data, 0, 0);
  assert.ok(boundaryPacked > 0, 'an inside-crown boundary texel must remain exclusive pine habitat');
  assert.ok(canopyForestFloorWeight(boundaryPacked, 1) > canopyForestFloorWeight(boundaryPacked, 5),
    'a broader feather must move the same boundary sample toward turf');
  assert.equal(canopyForestFloorWeight(corePacked, 1), 1);
  assert.equal(canopyForestFloorWeight(corePacked, 5), 1,
    'feather edits must retain the fully resolved mature crown core');
  assert.equal(canopyForestFloorWeight(0, CANOPY_DISTANCE_MAX_METERS), 0,
    'outside-canopy turf must never gain pine-floor weight');
  assert.equal(sampleCanopyForestFloorWeight(data, 41, 21, grid, 0, 0, 2), 1,
    'minimap sampling must retain the same fully resolved crown core');
  assert.equal(sampleCanopyForestFloorWeight(data, 41, 21, grid, -20, -10, 2), 0,
    'minimap sampling must retain exact turf outside the crown habitat');

  const terrain = await terrainSource();
  assert.match(terrain, /const canopyInwardMeters = canopyMask\.mul\(CANOPY_DISTANCE_MAX_METERS\)/);
  assert.match(terrain, /smoothstep\(\s*0\.0, this\.uCrownFeatherMeters, canopyInwardMeters,\s*\)/,
    'the live uniform must control the GPU forest-floor boundary rather than requiring a rebake');
});

test('forest assemblies join their crowns without painting region rectangles', () => {
  const region = Object.freeze({ minX: -24, maxX: 24, minZ: -16, maxZ: 16 });
  const grouped = [
    { sourceId: 'mass-a-1', habitatGroupId: 'record-a', habitatMassId: 'mass-a', semantic: 'forest-cluster', region, seed: 71, x: -18, z: 0, canopyRadius: 7 },
    { sourceId: 'mass-a-2', habitatGroupId: 'record-a', habitatMassId: 'mass-a', semantic: 'forest-cluster', region, seed: 71, x: 18, z: 0, canopyRadius: 7 },
  ];
  const primitives = deriveCanopyHabitatPrimitives(grouped);
  assert.deepEqual(primitives, deriveCanopyHabitatPrimitives([...grouped].reverse()),
    'crown topology must not depend on resolved tree order');
  assert.equal(primitives.crowns.length, 0, 'grouped crowns remain owned by their habitat mass');
  assert.equal(primitives.masses.length, 1);
  assert.equal(primitives.masses[0].crowns.length, 2);
  assert.equal(primitives.masses[0].connectors.length, 1,
    'one habitat mass must remain a continuous pine-floor room');

  const data = bakeDenseCanopyMask(new Uint8Array(61 * 41), 61, 41, {
    minX: -30, minZ: -20, spacing: 1,
  }, grouped);
  const sample = (x, z) => data[(z + 20) * 61 + (x + 30)];
  assert.ok(sample(-18, 0) > 0);
  assert.ok(sample(18, 0) > 0);
  assert.ok(sample(0, 0) > 0,
    'the minimum crown connector must join the stand through its centre');
  assert.equal(sample(0, 12), 0,
    'space away from the minimum connector must not become a rectangular carpet');
  assert.equal(sample(29, 0), 0, 'habitat must remain inside the authored safe rectangle');
});

test('same-mass crowns join only across short gaps and never bridge across mass IDs', () => {
  const record = (sourceId, habitatMassId, region, seed) => ({
    sourceId, habitatGroupId: sourceId, habitatMassId, semantic: 'forest-cluster',
    region, seed, x: (region.minX + region.maxX) * 0.5,
    z: (region.minZ + region.maxZ) * 0.5, canopyRadius: 7,
  });
  const left = { minX: -24, maxX: -14, minZ: -8, maxZ: 8 };
  const right = { minX: -8, maxX: 2, minZ: -8, maxZ: 8 };
  const other = { minX: 12, maxX: 22, minZ: -8, maxZ: 8 };
  const placements = [
    record('left-record', 'joined-mass', left, 1),
    record('right-record', 'joined-mass', right, 2),
    record('other-record', 'other-mass', other, 3),
  ];
  const primitives = deriveCanopyHabitatPrimitives(placements);
  const joined = primitives.masses.find(({ habitatMassId }) => habitatMassId === 'joined-mass');
  assert.equal(joined.connectors.length, 1);
  assert.equal(primitives.masses.find(({ habitatMassId }) => habitatMassId === 'other-mass').connectors.length, 0);
  const data = bakeDenseCanopyMask(new Uint8Array(101 * 31), 101, 31, {
    minX: -45, minZ: -15, spacing: 1,
  }, placements);
  const sample = (x, z) => data[(z + 15) * 101 + (x + 45)];
  for (let x = -15; x <= -5; x += 1) assert.ok(sample(x, 0) > 0,
    `same-mass short crown connector must stay continuous at x=${x}`);
  assert.equal(sample(8, 0), 0,
    'nearby crowns with different habitatMassId must never receive a connector');
});

test('same-mass crowns remain one continuous forest-floor stand across large openings', () => {
  const primitives = deriveCanopyHabitatPrimitives([
    { sourceId: 'far-a', habitatGroupId: 'far-a', habitatMassId: 'same', semantic: 'forest-cluster', region: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, seed: 1, x: 5, z: 5, canopyRadius: 8 },
    { sourceId: 'far-b', habitatGroupId: 'far-b', habitatMassId: 'same', semantic: 'forest-cluster', region: { minX: 30.01, maxX: 40.01, minZ: 0, maxZ: 10 }, seed: 2, x: 35, z: 5, canopyRadius: 8 },
  ]);
  assert.equal(primitives.masses[0].connectors.length, 1);
  assert.ok(primitives.masses[0].connectors[0].halfWidth >= 6);
});

test('pine habitat excludes grass candidates without changing rough geometry or footprint', async () => {
  const source = await grassSource();
  assert.match(source, /grassSurfaceCandidate\.and\( canopyMask\.lessThanEqual\( 0\.0 \) \)/);
  assert.doesNotMatch(source, /widthBase[\s\S]{0,100}canopyMask|canopyMask[\s\S]{0,100}widthBase/);
  assert.doesNotMatch(source, /hMax[\s\S]{0,100}canopyMask|canopyMask[\s\S]{0,100}hMax/);
  assert.match(source, /const GRID = 192/);
  assert.match(source, /const ROUGH_BLADE_WIDTH_MIN_M = 0\.0075/);
  assert.match(source, /const ROUGH_BLADE_WIDTH_MAX_M = 0\.018/);
  assert.match(source, /const BLADE_H = \{ rough: 0\.20, deepRough: 0\.32 \}/,
    'rough and deep rough must retain the restored dense blade profile');
  assert.match(source, /const BLADE_SEGMENTS = 3/);

  const bakeBody = await canopySource();
  assert.doesNotMatch(bakeBody, /camera|ball/i,
    'the suppression field must remain static and world-space authored');
});

test('Range shares catalog and procedural tree sources between beauty and grass bake', async () => {
  const source = await rangeSource();
  assert.match(source, /const catalogTreePlacements = this\._treePlacements\(\)/);
  assert.match(source, /const proceduralTreePlacements = this\._proceduralTreePlacements\(\)/);
  assert.match(source, /const canopyPlacements = \[\.\.\.catalogTreePlacements, \.\.\.proceduralTreePlacements\]/,
    'catalog and explicit procedural trees must share their exact beauty records with the grass bake');
  assert.match(source, /canopyPlacements,/);
  assert.match(source, /this\._buildTreeLine\(catalogTreePlacements, proceduralTreePlacements\)/);
  assert.match(source, /canopyRadius: asset\.bounds\.radius \* placement\.scale/,
    'suppression radius must come from the visible asset crown and authored scale');
  assert.match(source, /canopyRadius: proceduralTreeCanopyRadius\(placement, definitions\)/,
    'procedural suppression radius must come from the same reusable definition used for beauty');
});
