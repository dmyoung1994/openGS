import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_FRAME_STATE_VERSION,
  ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';
import { SceneManager } from '../src/scene/SceneManager.js';
import { WEATHER_SKY_WORKLOADS, WeatherSky } from '../src/scene/WeatherSky.js';

function environment() {
  return new EnvironmentGpuBindings(new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 4242,
    tickSeconds: 1 / 120,
    sun: {
      azimuthRadians: 0.8,
      elevationRadians: 0.65,
      intensity: 85000,
      color: { r: 1, g: 0.96, b: 0.84 },
    },
    moon: { azimuthRadians: 4, elevationRadians: -0.4, intensity: 0, color: { r: 0.78, g: 0.84, b: 1 }, illuminatedFraction: 0.8, angularRadiusRadians: 0.0045, phaseAngleRadians: 0.6 },
    atmosphere: {
      turbidity: 2.4,
      rayleigh: 1.5,
      mieCoefficient: 0.004,
      mieDirectionalG: 0.76,
      exposure: 1,
    },
    clouds: { coverage: 0.38, density: 0.62, baseHeight: 1250, thickness: 700, advectionScale: 1 },
    wind: {
      speed: 5,
      directionRadians: 0.4,
      referenceHeight: 10,
      shearExponent: 0.2,
      gustStrength: 0.25,
      turbulenceStrength: 0.5,
      gustSpatialFrequency: 0.035,
      gustTemporalFrequency: 0.27,
    },
  }));
}

function renderer() {
  return {
    isWebGPURenderer: true,
    compute(node) { this.lastCompute = node; },
  };
}

function managerWithWorkload(workloadId = 'high') {
  const manager = Object.create(SceneManager.prototype);
  const bindings = environment();
  const gpu = renderer();
  const skyManifest = null;
  const events = [];
  manager.renderer = gpu;
  manager.environmentTier = { id: 'high' };
  manager._environmentBindings = bindings;
  manager.skyManifest = skyManifest;
  manager.scene = { backgroundNode: null };
  manager._weatherSkyGraphRevision = 3;
  manager._weatherSkyWorkloadSwitchCount = 0;
  manager._lastWeatherSkyWorkloadSwitch = null;
  manager._setupPost = function setupPost() {
    events.push('setup-post');
    this._weatherSkyGraphRevision += 1;
  };
  manager.invalidateTemporalHistory = (reason) => { events.push(`invalidate:${reason}`); };
  manager.weatherSky = new WeatherSky(gpu, bindings, WEATHER_SKY_WORKLOADS[workloadId]);
  manager.weatherSky.setTemporalFrame(11);
  const previous = manager.weatherSky;
  const originalDispose = previous.dispose.bind(previous);
  previous.dispose = () => {
    events.push('dispose-previous');
    originalDispose();
  };
  return { manager, bindings, gpu, skyManifest, previous, events };
}

test('setWeatherSkyWorkload replaces the fixed GPU workload at an explicit boundary', () => {
  const { manager, bindings, skyManifest, previous, events } = managerWithWorkload('high');
  try {
    const result = manager.setWeatherSkyWorkload('balanced');

    assert.equal(result.changed, true);
    assert.equal(result.reason, 'workload-changed');
    assert.equal(result.previousWorkloadId, 'high');
    assert.equal(result.workloadId, 'balanced');
    assert.notEqual(manager.weatherSky, previous);
    assert.equal(manager.weatherSky.environment, bindings);
    assert.equal(manager.weatherSky.skyManifest, undefined);
    assert.equal(manager.weatherSky.workload.id, 'balanced');
    assert.equal(manager.weatherSky.temporalFrame, 0);
    assert.equal(manager.weatherSky.usesVolumetricClouds, true);
    assert.deepEqual(events, [
      'dispose-previous',
      'setup-post',
      'invalidate:weather-sky workload: high -> balanced',
    ]);

    const diagnostics = manager.readWeatherSkyDiagnostics();
    assert.equal(diagnostics.workloadId, 'balanced');
    assert.equal(diagnostics.representation, 'gpu-volume-raymarch');
    assert.equal(diagnostics.workload.raySteps, WEATHER_SKY_WORKLOADS.balanced.raySteps);
    assert.equal(diagnostics.workload.lightProbeSteps, WEATHER_SKY_WORKLOADS.balanced.lightProbeSteps);
    assert.equal(diagnostics.workloadSwitchCount, 1);
    assert.deepEqual(diagnostics.lastWorkloadSwitch, {
      from: 'high', to: 'balanced', graphRevision: 4,
    });
  } finally {
    manager.weatherSky?.dispose();
  }
});

test('an unchanged id or equivalent fixed workload snapshot is a true no-op', () => {
  const { manager, previous, events } = managerWithWorkload('balanced');
  try {
    const result = manager.setWeatherSkyWorkload({ ...WEATHER_SKY_WORKLOADS.balanced });

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'unchanged');
    assert.equal(result.previousWorkloadId, 'balanced');
    assert.equal(result.workloadId, 'balanced');
    assert.equal(manager.weatherSky, previous);
    assert.deepEqual(events, []);
    assert.equal(result.diagnostics.workloadSwitchCount, 0);
    assert.equal(result.diagnostics.graphRevision, 3);
    assert.equal(result.diagnostics.temporalFrame, 11);
  } finally {
    manager.weatherSky?.dispose();
  }
});

test('the selector rejects unknown or modified workload budgets before graph churn', () => {
  const { manager, previous, events } = managerWithWorkload('high');
  try {
    assert.throws(
      () => manager.setWeatherSkyWorkload('cinematic'),
      /must be high, balanced, or conservative/,
    );
    assert.throws(
      () => manager.setWeatherSkyWorkload({ ...WEATHER_SKY_WORKLOADS.high, raySteps: 31 }),
      /must match the fixed high workload budgets/,
    );
    assert.equal(manager.weatherSky, previous);
    assert.deepEqual(events, []);
  } finally {
    manager.weatherSky?.dispose();
  }
});

test('workload switching fails clearly before weather configuration exists', () => {
  const manager = Object.create(SceneManager.prototype);
  manager.weatherSky = null;
  manager._environmentBindings = null;
  assert.throws(
    () => manager.setWeatherSkyWorkload('balanced'),
    /requires configured weather/,
  );
});
