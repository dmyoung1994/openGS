import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';

function state() {
  return new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 42,
    tickSeconds: 1 / 120,
    sun: { azimuthRadians: 1.1, elevationRadians: 0.7, intensity: 80000, color: { r: 1, g: 0.95, b: 0.8 } },
    moon: { azimuthRadians: 4.2, elevationRadians: -0.3, intensity: 0, color: { r: 0.78, g: 0.84, b: 1 }, illuminatedFraction: 0.7, angularRadiusRadians: 0.0045, phaseAngleRadians: 0.8 },
    atmosphere: { turbidity: 2.2, rayleigh: 1.6, mieCoefficient: 0.004, mieDirectionalG: 0.75, exposure: 1 },
    clouds: { coverage: 0.32, density: 0.58, baseHeight: 1200, thickness: 650, advectionScale: 1 },
    wind: {
      speed: 5, directionRadians: 0.4, referenceHeight: 10, shearExponent: 0.2,
      gustStrength: 0.25, turbulenceStrength: 0.5,
      gustSpatialFrequency: 0.035, gustTemporalFrequency: 0.27,
    },
  });
}

test('GPU bindings mirror authoritative current and previous environment snapshots', () => {
  const environment = state();
  const bindings = new EnvironmentGpuBindings(environment);
  environment.advanceFixedTicks(3);
  bindings.update(environment);
  const data = environment.currentGpuUniforms.data;
  assert.equal(bindings.time.value, 3 / 120);
  assert.equal(bindings.previousTime.value, 0);
  assert.equal(bindings.sunIntensity.value, data[7]);
  assert.equal(bindings.sunIlluminanceScale.value, data[7] / 85000);
  assert.deepEqual(bindings.sunColor.value.toArray(), Array.from(data.slice(8, 11)));
  data.slice(48, 51).forEach((value, index) => {
    assert.ok(Math.abs(bindings.moonDirection.value.toArray()[index] - value) < 1e-6);
  });
  assert.equal(bindings.moonIlluminanceScale.value, data[51] / 0.25);
  assert.deepEqual(bindings.moonColor.value.toArray(), Array.from(data.slice(52, 55)));
  assert.equal(bindings.moonIlluminatedFraction.value, data[55]);
  assert.equal(bindings.atmosphereExposure.value, data[11]);
  assert.ok(bindings.skyRadiance(bindings.sunDirection)?.isNode);
  assert.ok(bindings.horizonColor.value.x > bindings.zenithColor.value.x);
  assert.deepEqual(bindings.baseWind.value.toArray(), [data[21], 0, data[22]]);
  assert.deepEqual(bindings.coefficientA.value.toArray(), Array.from(data.slice(32, 36)));
  assert.equal(bindings.cloudAdvectionScale.value, environment.config.clouds.advectionScale);
  assert.equal(bindings._gustSpatialUniform.value, environment.config.wind.gustSpatialFrequency);
  assert.equal(bindings._gustTemporalUniform.value, environment.config.wind.gustTemporalFrequency);
});

test('shared clear-day palette retains a blue sky under a near-neutral elevated sun', () => {
  const environment = state();
  const bindings = new EnvironmentGpuBindings(environment);
  const horizon = bindings.horizonColor.value;
  const zenith = bindings.zenithColor.value;
  assert.ok(horizon.z > horizon.y && horizon.y > horizon.x);
  assert.ok(zenith.z > zenith.y * 2.5, 'zenith must not collapse to a pale neutral wash');
  assert.ok(horizon.z < 0.9, 'clear-air horizon must leave tone-map highlight headroom');
  assert.ok(horizon.z < 0.8, 'shared IBL horizon should retain bark/foliage colour separation');
});

test('daylight revision changes only when authored sun or atmosphere changes', () => {
  const environment = state();
  const bindings = new EnvironmentGpuBindings(environment);
  const revision = bindings.daylightRevision;
  environment.advanceFixedTicks(12);
  bindings.update(environment);
  assert.equal(bindings.daylightRevision, revision);
});

test('GPU bindings fail closed without the versioned environment snapshot', () => {
  assert.throws(() => new EnvironmentGpuBindings({}), /EnvironmentFrameState/);
});
