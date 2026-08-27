import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { EnvironmentFrameState, ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION } from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';
import { WEATHER_SKY_WORKLOADS, WeatherSky } from '../src/scene/WeatherSky.js';

function environmentState(coverage = 0.35) {
  return new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 713,
    tickSeconds: 1 / 120,
    sun: {
      azimuthRadians: 0.8,
      elevationRadians: 0.65,
      intensity: 85000,
      color: { r: 1, g: 0.96, b: 0.84 },
    },
    atmosphere: {
      turbidity: 2.4,
      rayleigh: 1.5,
      mieCoefficient: 0.004,
      mieDirectionalG: 0.76,
      exposure: 1,
    },
    clouds: {
      coverage,
      density: coverage > 0 ? 0.62 : 0,
      baseHeight: 1250,
      thickness: 700,
      advectionScale: 1,
    },
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
  });
}

function renderer() {
  return {
    isWebGPURenderer: true,
    computeCount: 0,
    compute() { this.computeCount += 1; },
  };
}

test('weather tiers spend genuinely different budgets on the same cloud equations', async () => {
  const high = WEATHER_SKY_WORKLOADS.high;
  const balanced = WEATHER_SKY_WORKLOADS.balanced;
  const conservative = WEATHER_SKY_WORKLOADS.conservative;

  assert.ok(high.raySteps > balanced.raySteps && balanced.raySteps > conservative.raySteps);
  assert.ok(high.lightProbeSteps > balanced.lightProbeSteps
    && balanced.lightProbeSteps > conservative.lightProbeSteps);
  assert.ok(high.noiseOctaves > balanced.noiseOctaves
    && balanced.noiseOctaves > conservative.noiseOctaves);
  assert.ok(high.jitterPeriod > balanced.jitterPeriod
    && balanced.jitterPeriod > conservative.jitterPeriod);
  assert.equal(high.lightTransportSamples, 1);
  assert.equal(balanced.lightTransportSamples, 1);
  assert.equal(conservative.lightTransportSamples, 1);

  const source = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(source, /Loop\(this\.workload\.lightProbeSteps/);
  assert.match(source, /const detailBudget = float\(/);
  assert.match(source, /\.mul\(detailBudget\)/);
  assert.match(source, /const steps = this\.workload\.raySteps/);
  assert.match(source, /jitterForFrame\(frame, this\.workload\.jitterPeriod\)/);
});

test('clear sky remains a true zero-work path while cloudy weather initializes the shared volume', async () => {
  const clearRenderer = renderer();
  const clearSky = new WeatherSky(
    clearRenderer,
    new EnvironmentGpuBindings(environmentState(0)),
    WEATHER_SKY_WORKLOADS.high,
  );
  assert.equal(clearRenderer.computeCount, 0);
  assert.equal(clearSky.cloudsEnabled, false);
  assert.equal((await clearSky.readDiagnostics()).cloudVolume.gpuResident, false);

  const cloudyRenderer = renderer();
  const cloudySky = new WeatherSky(
    cloudyRenderer,
    new EnvironmentGpuBindings(environmentState()),
    WEATHER_SKY_WORKLOADS.balanced,
  );
  assert.equal(cloudyRenderer.computeCount, 1);
  assert.equal(cloudySky.cloudsEnabled, true);
  assert.equal((await cloudySky.readDiagnostics()).cloudVolume.gpuResident, true);
});

test('backdrop frequency handoffs and atmosphere use stable world-space contracts', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  const waterDetail = await readFile(new URL('../src/scene/WaterDetail.js', import.meta.url), 'utf8');

  assert.match(source, /const worldFootprint = world\.x\.fwidth\(\)/);
  assert.match(source, /const stableFootprint = worldFootprint\.mul\(/);
  assert.match(source, /const grazingStability = smoothstep\(0\.16, 0\.76, viewCosine\)/);
  assert.match(source, /const fineVisibility = float\(0\.04\)/);
  assert.match(source, /backdropSource = 'maritime-coast-ocean'/);
  assert.match(source, /function maritimeOceanMaterial\(/);
  assert.match(source, /acquireWaterDetailTexture/);
  assert.match(source, /sampleWaterDetail/);
  assert.match(waterDetail, /const footprint = dFdx\(worldXZ\)\.length\(\)/,
    'ocean detail must choose stable mips from its world-space pixel footprint');
  assert.match(source, /environment\.skyRadiance\(reflectedDirection/,
    'ocean reflection must use the shared daylight sky');
  assert.match(source, /stableFootprint/);
  assert.match(source, /const atmosphericDistance = toCamera\.length\(\)\.max\(0\.5\)/);
  assert.match(source, /aerialPerspective\(outputNode\.rgb, toCamera, atmosphericDistance\)/);
  assert.doesNotMatch(source, /class .*Fallback|buildFallback|billboard/i,
    'backdrop material must remain on authored shell geometry');
});
