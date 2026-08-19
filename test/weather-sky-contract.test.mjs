import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';
import { WEATHER_SKY_WORKLOADS, WeatherSky, cloudsAreEnabled } from '../src/scene/WeatherSky.js';

function state(cloudCoverage = 0.38) {
  return new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 8008,
    tickSeconds: 1 / 120,
    sun: { azimuthRadians: 0.8, elevationRadians: 0.65, intensity: 85000, color: { r: 1, g: 0.96, b: 0.84 } },
    atmosphere: { turbidity: 2.4, rayleigh: 1.5, mieCoefficient: 0.004, mieDirectionalG: 0.76, exposure: 1 },
    clouds: { coverage: cloudCoverage, density: cloudCoverage > 0 ? 0.62 : 0.0, baseHeight: 1250, thickness: 700, advectionScale: 1 },
    wind: {
      speed: 5, directionRadians: 0.4, referenceHeight: 10, shearExponent: 0.2,
      gustStrength: 0.25, turbulenceStrength: 0.5,
      gustSpatialFrequency: 0.035, gustTemporalFrequency: 0.27,
    },
  });
}

const renderer = () => ({
  isWebGPURenderer: true,
  compute(node) { this.lastCompute = node; },
  backend: {
    async copyTextureToBuffer() {
      const pixels = new Uint8Array(64 * 64 * 4);
      for (let index = 0; index < 64 * 64; index++) {
        const value = index & 255;
        pixels[index * 4] = pixels[index * 4 + 1] = pixels[index * 4 + 2] = value;
        pixels[index * 4 + 3] = 255;
      }
      return pixels;
    },
  },
});

test('WeatherSky accepts only the authoritative GPU environment bridge and exposes a background node', async () => {
  const bindings = new EnvironmentGpuBindings(state());
  const gpu = renderer();
  const sky = new WeatherSky(gpu, bindings, WEATHER_SKY_WORKLOADS.high);
  assert.equal(sky.environment, bindings);
  assert.equal(sky.outputNode, sky.backgroundNode);
  assert.ok(sky.iblBackgroundNode?.isNode);
  assert.equal(sky.workload.id, 'high');
  assert.ok(sky.backgroundNode?.isNode);
  assert.ok(sky.skyRadiance(bindings.sunDirection, { includeSun: false })?.isNode);
  const diagnostics = await sky.readDiagnostics();
  assert.equal(diagnostics.enabled, false);
  assert.throws(() => new WeatherSky({}, bindings, WEATHER_SKY_WORKLOADS.high), /WebGPU renderer/);
  assert.throws(() => new WeatherSky(renderer(), {}, WEATHER_SKY_WORKLOADS.high), /EnvironmentGpuBindings/);
});

test('zero cloud coverage uses the shared analytic sky without volumetric setup or pass work', async () => {
  const gpu = renderer();
  const sky = new WeatherSky(gpu, new EnvironmentGpuBindings(state(0)), WEATHER_SKY_WORKLOADS.high);
  assert.equal(sky.cloudsEnabled, false);
  assert.equal(sky.usesVolumetricClouds, false);
  assert.equal(gpu.lastCompute, undefined);
  assert.equal(sky.noiseVolume, null);
  assert.equal((await sky.readDiagnostics()).enabled, false);
  assert.ok(sky.backgroundNode?.isNode);
});

// The authored default is broken fair-weather cumulus. Pin the invariants that the
// look and the validator depend on, not the literal digits: coverage must be inside the
// validator's (0, 0.7] window, and the slab must sit high and thin enough that the
// horizon mask can fade it out before the cloudDistance clamp band.
test('production state authors a bounded, non-zero cloud layer in both entry points', async () => {
  const game = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const defaultCoverage = game.match(/const DEFAULT_CLOUD_COVERAGE = ([\d.]+);/);
  assert.ok(defaultCoverage, 'src/main.js must declare DEFAULT_CLOUD_COVERAGE');
  const coverage = Number(defaultCoverage[1]);
  assert.ok(coverage > 0 && coverage <= 0.7, `coverage ${coverage} must be in (0, 0.7]`);
  assert.match(game, /clouds:\s*\{\s*coverage:\s*cloudCoverage,\s*density:\s*([\d.]+),\s*baseHeight:\s*(\d+),\s*thickness:\s*(\d+)/);
  const [, gameDensity, gameBase, gameThickness] = game.match(
    /clouds:\s*\{\s*coverage:\s*cloudCoverage,\s*density:\s*([\d.]+),\s*baseHeight:\s*(\d+),\s*thickness:\s*(\d+)/,
  );
  assert.ok(Number(gameDensity) > 0 && Number(gameDensity) <= 1);
  assert.ok(Number(gameBase) >= 2000, 'the slab must clear the alpine skyline');
  assert.ok(Number(gameThickness) <= 800, 'a thin slab subtends less of the low sky');

  // The viewer shares one sky with the game so captures from either are comparable.
  const viewer = await readFile(new URL('../src/viewer/main.js', import.meta.url), 'utf8');
  const viewerClouds = viewer.match(
    /clouds:\s*\{\s*coverage:\s*([\d.]+),\s*density:\s*([\d.]+),\s*baseHeight:\s*(\d+),\s*thickness:\s*(\d+)/,
  );
  assert.ok(viewerClouds, 'src/viewer/main.js must author the same cloud layer');
  assert.equal(Number(viewerClouds[1]), coverage);
  assert.equal(Number(viewerClouds[2]), Number(gameDensity));
  assert.equal(Number(viewerClouds[3]), Number(gameBase));
  assert.equal(Number(viewerClouds[4]), Number(gameThickness));
});

// SceneManager.refreshWeatherSkyClouds() rebuilds the sky only when coverage crosses
// the clear/cloudy boundary. That is only sound if crossing it genuinely changes the
// compiled graph and never introduces a second pass.
test('cloud coverage crossing zero flips the compiled sky graph and nothing else', () => {
  const clear = new WeatherSky(renderer(), new EnvironmentGpuBindings(state(0)), WEATHER_SKY_WORKLOADS.high);
  const cloudy = new WeatherSky(renderer(), new EnvironmentGpuBindings(state(0.4)), WEATHER_SKY_WORKLOADS.high);
  assert.equal(clear.cloudsEnabled, false);
  assert.equal(cloudy.cloudsEnabled, true);
  assert.notEqual(clear.backgroundNode, cloudy.backgroundNode);
  // Neither state may allocate the low-resolution atmosphere pass: `_setupPost` keys
  // off this flag, and a refresh that skipped it would leave a stale pipeline.
  assert.equal(clear.usesVolumetricClouds, false);
  assert.equal(cloudy.usesVolumetricClouds, false);
  // Clouds are visible-background only. If the IBL node ever varied with coverage the
  // refresh path would owe a PMREM recapture it deliberately does not perform.
  assert.ok(clear.iblBackgroundNode?.isNode);
  assert.ok(cloudy.iblBackgroundNode?.isNode);
});

test('the shared cloud predicate is the one WeatherSky latches on', () => {
  assert.equal(cloudsAreEnabled({ x: 0, y: 0 }), false);
  assert.equal(cloudsAreEnabled({ x: 0.4, y: 0 }), false);
  assert.equal(cloudsAreEnabled({ x: 0, y: 0.8 }), false);
  assert.equal(cloudsAreEnabled({ x: 0.4, y: 0.8 }), true);
  const bindings = new EnvironmentGpuBindings(state(0.4));
  const sky = new WeatherSky(renderer(), bindings, WEATHER_SKY_WORKLOADS.high);
  assert.equal(sky.cloudsEnabled, cloudsAreEnabled(bindings.clouds.value));
});

test('all weather tiers retain the same cloud/atmosphere contract and differ only in bounded workload values', () => {
  const required = ['id', 'internalScale', 'raySteps', 'sunTransmittanceSteps', 'noiseOctaves', 'jitterPeriod'];
  for (const workload of Object.values(WEATHER_SKY_WORKLOADS)) {
    assert.deepEqual(Object.keys(workload).sort(), required.slice().sort());
    assert.ok(Object.isFrozen(workload));
    assert.ok(workload.raySteps >= 4);
    assert.ok(workload.sunTransmittanceSteps >= 2);
    assert.ok(workload.noiseOctaves >= 2);
  }
});

test('WeatherSky fails closed for incomplete or out-of-contract workloads', () => {
  const bindings = new EnvironmentGpuBindings(state());
  assert.throws(() => new WeatherSky(renderer(), bindings, { id: 'high' }), /internalScale/);
  assert.throws(() => new WeatherSky(renderer(), bindings, { ...WEATHER_SKY_WORKLOADS.high, raySteps: 0 }), /raySteps/);
  assert.throws(() => new WeatherSky(renderer(), bindings, { ...WEATHER_SKY_WORKLOADS.high, id: 'cinematic' }), /id/);
});

test('temporal jitter is deterministic, current/previous, and validates external renderer hooks', () => {
  const sky = new WeatherSky(renderer(), new EnvironmentGpuBindings(state()), WEATHER_SKY_WORKLOADS.balanced);
  sky.setTemporalFrame(7);
  const firstCurrent = sky.currentJitter.value.toArray();
  const firstPrevious = sky.previousJitter.value.toArray();
  sky.setTemporalFrame(7);
  assert.deepEqual(sky.currentJitter.value.toArray(), firstCurrent);
  assert.deepEqual(sky.previousJitter.value.toArray(), firstPrevious);
  assert.notDeepEqual(firstCurrent, firstPrevious);
  sky.setTemporalJitter({ x: 0.25, y: -0.25 }, { x: -0.125, y: 0.125 });
  assert.deepEqual(sky.currentJitter.value.toArray(), [0.25, -0.25]);
  assert.throws(() => sky.setTemporalJitter({ x: 1, y: 0 }, { x: 0, y: 0 }), /current.x/);
});

test('WeatherSky uses the verified local HDR or analytic procedural path, never a fallback renderer', async () => {
  const source = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(source, /HDRLoader/);
  assert.doesNotMatch(source, /RGBELoader/);
  assert.match(source, /EquirectangularReflectionMapping|textureNode/);
  assert.doesNotMatch(source, /WebGLRenderer|createFallback|fallback\s*:/);
  assert.doesNotMatch(source, /WebGLRenderer|WebGLBackend|createFallback|fallback\s*:/);
  assert.match(source, /Rayleigh|Mie|wind field/i);
  assert.match(source, /mx_noise_float[\s\S]*_fbm2/);
  assert.match(source, /usesAnalyticClouds/);
  assert.match(source, /skyRadiance\(direction, \{ includeSun = false \} = \{\}\)/);
  assert.doesNotMatch(source, /Storage3DTexture|storageTexture3D|texture3D|ray march|sun transmittance/i);
});

test('HDR PMREM waits for decoded pixels and keeps the solar disc out of IBL', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  const weather = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(weather, /skyTextureLoaded = false/);
  assert.match(weather, /skyTextureLoaded = true/);
  assert.match(source, /if \(this\.skyManifest && !this\.weatherSky\.skyTextureLoaded\) return/);
  assert.match(source, /captureScene\.backgroundNode = this\.weatherSky\.iblBackgroundNode/);
  assert.match(source, /fromScene\(captureScene/);
  assert.doesNotMatch(source, /fromEquirectangular\(this\.weatherSky\.skyTexture\)/);
  assert.match(weather, /includeSun = false/);
  assert.match(weather, /directMask/);
  assert.match(weather, /sourceSunDirection/);
  assert.match(weather, /Math\.cos\(5 \* Math\.PI \/ 180\)/);
  assert.match(weather, /environment\.skyRadiance\(normalized, \{ includeSun: true \}\)\.sub\(clearSky\)/);
  assert.match(weather, /rotationRadians/);
  assert.match(weather, /normalized\.x\.mul\(c\)\.add\(normalized\.z\.mul\(s\)\)/);
  assert.match(weather, /normalized\.z\.mul\(c\)\.sub\(normalized\.x\.mul\(s\)\)/);
  assert.match(source, /environmentRotation\.set\(0, 0, 0\)/);
});

test('WeatherSky and SceneManager own rebuild/disposal boundaries', async () => {
  const weather = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  const scene = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.match(weather, /this\._disposed = true/);
  assert.match(weather, /this\.skyTexture = null/);
  assert.match(scene, /this\._daylightPmremTarget\?\.dispose\(\)/);
  assert.match(scene, /this\.scene\.environment = null/);
  assert.match(scene, /previous\?\.dispose\(\)/);
});

test('WeatherSky disposes the actual late HDR callback handle after reconfigure', async () => {
  const source = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(source, /loader\.load\(this\.skyManifest\.url, \(loadedTexture\) =>/);
  assert.match(source, /this\._disposed \|\| this\.skyTexture !== loadedTexture/);
  assert.match(source, /loadedTexture\?\.dispose\(\)/);
  assert.match(source, /resolveReady\(loadedTexture\)/);
  assert.doesNotMatch(source, /if \(this\._disposed\) \{\s*this\.skyTexture\?\.dispose/);
});
