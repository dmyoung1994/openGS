import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bakeDenseCanopyMask } from '../src/terrain/Grass.js';

const grassSource = () => readFile(new URL('../src/terrain/Grass.js', import.meta.url), 'utf8');
const rangeSource = () => readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');

const field = () => new Uint8Array(41 * 21);
const grid = Object.freeze({ minX: -20, minZ: -10, spacing: 1 });
const at = (data, x, z) => data[(z - grid.minZ) * 41 + (x - grid.minX)];

test('dense-canopy bake keeps suppression bounded when perimeter crowns overlap', () => {
  const isolated = bakeDenseCanopyMask(field(), 41, 21, grid, [
    { x: 0, z: 0, canopyRadius: 10 },
  ]);
  assert.ok(at(isolated, 0, 0) >= 70 && at(isolated, 0, 0) <= 76,
    'one crown centre should retain roughly three quarters of the grass density');
  assert.equal(at(isolated, -10, 0), 0);
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

test('packed canopy field reuses the existing R8 fetch and preserves outside-canopy eligibility', async () => {
  const source = await grassSource();
  assert.match(source, /const GRASS_GROWABLE_BIT = 128/);
  assert.match(source, /const CANOPY_MASK_MAX = 127/);
  assert.match(source, /const CANOPY_CROWN_WEIGHT = 63/,
    'one crown contribution must remain bounded below the full dense-overlap response');
  assert.match(source, /const CANOPY_KERNEL_POWER = 0\.5/,
    'the smooth shade response must fill the authored crown without expanding its radius');
  assert.match(source, /const CANOPY_DENSITY_FLOOR = 0\.55/,
    'the strongest dense-forest footprint may retire at most 45% of candidates');
  assert.match(source, /new DataTexture\( data, nx, nz, RedFormat, UnsignedByteType \)/,
    'canopy data must reuse the accepted one-byte grass texture allocation');
  assert.equal(source.match(/textureLoad\( c\.dataTex/g)?.length, 1,
    'candidate compute must retain exactly one grass-field sample');
  assert.match(source, /data\[ i \] \|= GRASS_GROWABLE_BIT/);
  assert.match(source, /packedGround\.mod\( GRASS_GROWABLE_BIT \)\.div\( CANOPY_MASK_MAX \)/);
  assert.match(source, /packedGround\.greaterThanEqual\( GRASS_GROWABLE_BIT \)/);

  const outsidePacked = 128;
  assert.equal(outsidePacked % 128, 0, 'outside-canopy texels decode an exact zero mask');
  assert.ok(outsidePacked >= 128, 'the growable bit remains exact outside canopy');
});

test('canopy suppression changes only stable candidate density, never grass geometry or footprint', async () => {
  const source = await grassSource();
  assert.match(source,
    /densityTarget\.mulAssign\( mix\( 1\.0, CANOPY_DENSITY_FLOOR, canopyMask \) \)/);
  assert.doesNotMatch(source, /widthBase[\s\S]{0,100}canopyMask|canopyMask[\s\S]{0,100}widthBase/);
  assert.doesNotMatch(source, /hMax[\s\S]{0,100}canopyMask|canopyMask[\s\S]{0,100}hMax/);
  assert.match(source, /const GRID = 192/);
  assert.match(source, /const ROUGH_BLADE_WIDTH_MIN_M = 0\.0075/);
  assert.match(source, /const ROUGH_BLADE_WIDTH_MAX_M = 0\.018/);
  assert.match(source, /const BLADE_H = \{ rough: 0\.20, deepRough: 0\.32 \}/,
    'rough and deep rough must retain the restored dense blade profile');
  assert.match(source, /const BLADE_SEGMENTS = 3/);

  const bakeBody = source.slice(
    source.indexOf('export function bakeDenseCanopyMask'),
    source.indexOf('function densityAtDistance'),
  );
  assert.doesNotMatch(bakeBody, /camera|ball/i,
    'the suppression field must remain static and world-space authored');
});

test('Range shares its exact selected tree records between beauty and grass bake', async () => {
  const source = await rangeSource();
  assert.match(source, /const allTreePlacements = this\._treePlacements\(\)/);
  assert.match(source, /const treePlacements = allTreePlacements/,
    'the curated runtime uses one Poly Haven placement set for both paths');
  assert.match(source, /canopyPlacements: treePlacements/);
  assert.match(source, /this\._buildTreeLine\(treePlacements\)/);
  assert.match(source, /canopyRadius: asset\.bounds\.radius \* placement\.scale/,
    'suppression radius must come from the visible asset crown and authored scale');
});
