import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_FRAME_STATE_VERSION,
  ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from '../src/environment/EnvironmentFrameState.js';

function config(overrides = {}) {
  return {
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 0x1a2b3c4d,
    tickSeconds: 1 / 120,
    sun: { azimuthRadians: 1.2, elevationRadians: 0.8, intensity: 85000, color: { r: 1, g: 0.93, b: 0.78 } },
    moon: { azimuthRadians: 4.3, elevationRadians: -0.4, intensity: 0, color: { r: 0.78, g: 0.84, b: 1 }, illuminatedFraction: 0.8, angularRadiusRadians: 0.0045, phaseAngleRadians: 0.64 },
    atmosphere: { turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005, mieDirectionalG: 0.76, exposure: 1.1 },
    clouds: { coverage: 0.35, density: 0.6, baseHeight: 1300, thickness: 700, advectionScale: 1.0 },
    wind: {
      speed: 6, directionRadians: 0.7, referenceHeight: 10, shearExponent: 0.18,
      gustStrength: 0.3, turbulenceStrength: 0.65, gustSpatialFrequency: 0.04, gustTemporalFrequency: 0.3,
    },
    ...overrides,
  };
}

test('same configuration creates identical wind and named events', () => {
  const first = new EnvironmentFrameState(config());
  const second = new EnvironmentFrameState(config());
  first.advanceFixedTicks(37);
  second.advanceFixedTicks(37);
  const a = first.sampleWind({ x: 12.5, y: 4, z: -8.75 }, first.time, {});
  const b = second.sampleWind({ x: 12.5, y: 4, z: -8.75 }, second.time, {});
  assert.deepEqual(a, b);
  assert.deepEqual(first.nextEvent('ball.water-entry'), second.nextEvent('ball.water-entry'));
  assert.deepEqual(first.nextEvent('ball.water-entry'), second.nextEvent('ball.water-entry'));
});

test('fixed stepping preserves previous and current GPU snapshots', () => {
  const state = new EnvironmentFrameState(config());
  const initial = state.currentGpuUniforms;
  state.advanceFixedTicks(3);
  assert.equal(state.tick, 3);
  assert.equal(state.time, 3 / 120);
  assert.strictEqual(state.previousGpuUniforms, initial);
  assert.equal(state.previousGpuUniforms.time, 0);
  assert.equal(state.currentGpuUniforms.time, 3 / 120);
  const snapshots = state.gpuUniformSnapshots();
  assert.strictEqual(snapshots.current, state.currentGpuUniforms);
  assert.strictEqual(snapshots.previous, initial);
  assert.notStrictEqual(snapshots.current.data, snapshots.previous.data);
});

test('vertical shear raises the base-wind contribution with height', () => {
  const state = new EnvironmentFrameState(config({ wind: {
    ...config().wind, gustStrength: 0, turbulenceStrength: 0,
  } }));
  const low = state.sampleWind({ x: 0, y: 1, z: 0 }, 0, {});
  const high = state.sampleWind({ x: 0, y: 20, z: 0 }, 0, {});
  assert.ok(Math.hypot(high.x, high.z) > Math.hypot(low.x, low.z));
});

test('wind direction follows golf convention: zero helps down-range', () => {
  const environment = new EnvironmentFrameState(config({ wind: {
    ...config().wind, directionRadians: 0, gustStrength: 0, turbulenceStrength: 0,
  } }));
  const wind = environment.sampleWind({ x: 0, y: 10, z: 0 }, 0, {});
  assert.equal(wind.x, 0);
  assert.ok(wind.z < 0);
});

test('seed changes gust field without changing authored base wind', () => {
  const first = new EnvironmentFrameState(config({ seed: 1 }));
  const second = new EnvironmentFrameState(config({ seed: 2 }));
  const point = { x: 12, y: 8, z: -6 };
  const a = first.sampleWind(point, 3.5, {});
  const b = second.sampleWind(point, 3.5, {});
  assert.notDeepEqual(a, b);
  assert.equal(first.baseWindX, second.baseWindX);
  assert.equal(first.baseWindZ, second.baseWindZ);
});

test('strict config and public input validation fail closed', () => {
  assert.throws(() => new EnvironmentFrameState(config({ version: 1 })), /version/);
  assert.throws(() => new EnvironmentFrameState(config({ seed: -1 })), /seed/);
  assert.throws(() => new EnvironmentFrameState(config({ wind: { ...config().wind, speed: 99 } })), /wind.speed/);
  const state = new EnvironmentFrameState(config());
  assert.throws(() => state.advanceFixedTicks(0.5), /unsigned integer/);
  assert.throws(() => state.sampleWind({ x: NaN, y: 0, z: 0 }, 0, {}), /position/);
  assert.throws(() => state.sampleWind({ x: 0, y: 0, z: 0 }, -1, {}), /time/);
  assert.throws(() => state.nextEvent('Water Entry'), /lowercase/);
});
