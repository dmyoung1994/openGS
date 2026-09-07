import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  dampNearBallTurfDetail,
  nearBallTurfDetailTarget,
  nearBallTurfFocusFollowAlpha,
  nearBallTurfFootprintWeight,
  NEAR_BALL_TURF_DETAIL,
} from '../src/terrain/NearBallTurfDetail.js';

const ROOT = new URL('../', import.meta.url);

test('near-ball turf activates only for a low camera near a grounded ball', () => {
  const target = (overrides = {}) => nearBallTurfDetailTarget({
    enabled: true,
    ballState: 'rest',
    cameraHeightMeters: 1.45,
    cameraBallDistanceMeters: 4.5,
    ...overrides,
  });

  assert.equal(target(), 1);
  assert.equal(target({ ballState: 'rolling' }), 1);
  assert.equal(target({ ballState: 'airborne' }), 0);
  assert.equal(target({ enabled: false }), 0);
  assert.equal(target({ cameraHeightMeters: 2.6 }), 0);
  assert.equal(target({ cameraBallDistanceMeters: 9 }), 0);
  assert.ok(target({ cameraHeightMeters: 2.2 }) > 0
    && target({ cameraHeightMeters: 2.2 }) < 1);
  assert.ok(target({ cameraBallDistanceMeters: 7.5 }) > 0
    && target({ cameraBallDistanceMeters: 7.5 }) < 1);
});

test('near-ball footprint is a forward 15-yard trapezoid rather than a radial disc', () => {
  assert.equal(NEAR_BALL_TURF_DETAIL.forwardEndMeters, 13.716);
  assert.equal(nearBallTurfFootprintWeight(5, 0), 1);
  assert.equal(nearBallTurfFootprintWeight(-5, 0), 0);
  assert.equal(nearBallTurfFootprintWeight(13.716, 0), 0);
  assert.equal(nearBallTurfFootprintWeight(5, 4), 0);
  assert.ok(nearBallTurfFootprintWeight(11, 0) > 0);
  assert.ok(nearBallTurfFootprintWeight(5, 1.8) > 0);
  assert.ok(nearBallTurfFootprintWeight(5, 1.8)
    < nearBallTurfFootprintWeight(5, 1.0));
});

test('activation damping converges consistently at presentation frame rates', () => {
  const advance = (hz, target, seconds, start = 0) => {
    let value = start;
    const frames = Math.round(hz * seconds);
    for (let frame = 0; frame < frames; frame++) {
      value = dampNearBallTurfDetail(value, target, 1 / hz);
    }
    return value;
  };
  const activated = [30, 60, 120].map((hz) => advance(hz, 1, 1));
  const deactivated = [30, 60, 120].map((hz) => advance(hz, 0, 1, 1));
  assert.ok(Math.max(...activated) - Math.min(...activated) < 0.01);
  assert.ok(Math.max(...deactivated) - Math.min(...deactivated) < 0.01);
  assert.ok(activated.every((value) => value > 0.98));
  assert.ok(deactivated.every((value) => value < 0.04));
  assert.ok(nearBallTurfFocusFollowAlpha(1 / 60) > 0);
  assert.ok(nearBallTurfFocusFollowAlpha(1 / 60) < 1);
});

test('terrain enhances resident maintained-turf relief without geometry or asset swaps', async () => {
  const terrain = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
  const lie = await readFile(new URL('src/scene/NearTurfPolicy.js', ROOT), 'utf8');

  assert.match(terrain, /setNearBallTurfDetail\(\{ activation = 0, cameraXZ, forwardXZ \}/);
  assert.match(terrain, /nearMaintainedMask = m\.visualFairway\.add\(m\.fringe\)\.add\(m\.green\)\.add\(m\.tee\)[\s\S]*?smoothstep\(0\.18, 0\.35, mownW\)/);
  assert.match(terrain, /nearLeading\.mul\(nearTrailing\)\.mul\(nearLateralWeight\)[\s\S]*?\.toVarying\('vNearTurfFootprint'\)/,
    'the moving low-frequency wedge must not spend quintic arithmetic per fragment');
  assert.match(terrain, /relief:[\s\S]*?nearTurfDetailWeight\.mul\(NEAR_BALL_TURF_DETAIL\.normalGain\)/);
  assert.doesNotMatch(terrain, /nrhLod|nrhLodBias/,
    'moving close detail must not change packed height, AO, or self-shadow LOD');
  assert.match(terrain, /normalGain/);
  assert.doesNotMatch(terrain, /nearTurf[\s\S]{0,120}(TextureLoader|needsUpdate|new Mesh)/,
    'per-frame near detail must not load textures, recompile materials, or add geometry');
  assert.match(main, /updateNearBallTurfDetail\(dt\)/);
  assert.match(main, /range\.sceneKind === 'range'[\s\S]*?range\.sceneKind === 'play'/,
    'creator scenes must never enable the play-only presentation policy');
  assert.match(main, /nearBallTurfFocusFollowAlpha\(dt\)/,
    'the moving footprint transform must follow continuously rather than snap');
  assert.match(lie, /NEAR_TURF_SURFACES = new Set\(\['rough', 'deepRough'\]\)/,
    'rough-only blade geometry remains unchanged');
});
