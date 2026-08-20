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

function smoothstep01(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function jointCarrier(rawCarrier, detail, erosionChannel, coverage = 0.38) {
  const threshold = 0.10 + (1 - coverage) * 0.06;
  const base = smoothstep01(threshold, threshold + 0.18, rawCarrier);
  const edgeWindow = 1 - smoothstep01(0.48, 0.84, base);
  const detailSignal = detail * 0.58 + erosionChannel * 0.42;
  const erosion = smoothstep01(0.20, 0.78, erosionChannel);
  const shift = ((detailSignal - 0.5) * 0.035 + (erosion - 0.5) * 0.025) * edgeWindow;
  return smoothstep01(threshold + shift, threshold + shift + 0.18, rawCarrier);
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
  assert.equal(sky.usesVolumetricClouds, true);
  assert.ok(sky.skyRadiance(bindings.sunDirection, { includeSun: false })?.isNode);
  const diagnostics = await sky.readDiagnostics();
  assert.equal(diagnostics.enabled, true);
  assert.equal(diagnostics.mode, 'gpu-volume-raymarch');
  assert.equal(diagnostics.proceduralNoise, true);
  assert.equal(diagnostics.gpuOnly, true);
  assert.equal(diagnostics.raySteps, sky.workload.raySteps);
  assert.equal(WEATHER_SKY_WORKLOADS.high.raySteps, 6);
  assert.equal(diagnostics.lightTransportSamples, sky.workload.lightTransportSamples);
  assert.equal(diagnostics.lightProbeSteps, 3);
  assert.equal(diagnostics.lightTransportMode, 'paired-sun-offset-volume-probe');
  assert.equal(Object.hasOwn(diagnostics, 'hasSkyPass'), false);
  assert.equal(diagnostics.renderTopology, 'fused-temporal-volume');
  assert.equal(diagnostics.noiseOctaves, sky.workload.noiseOctaves);
  assert.deepEqual(diagnostics.cloudVolume.dimensions, [96, 96, 96]);
  assert.equal(diagnostics.cloudVolume.channels, 4);
  assert.equal(diagnostics.cloudVolume.format, 'rgba8unorm');
  assert.equal(diagnostics.cloudVolume.gpuResident, true);
  assert.equal(diagnostics.cloudVolume.initStatus, 'submitted');
  assert.equal(diagnostics.cloudVolume.sampledInRaymarch, true);
  assert.equal(diagnostics.cloudHistory.pingPong, true);
  assert.equal(diagnostics.cloudHistory.previousFrameSampling, true);
  assert.equal(diagnostics.cloudHistory.cameraReprojection, true);
  assert.equal(diagnostics.cloudHistory.disocclusionRejection, true);
  assert.equal(diagnostics.cloudHistory.transmittanceAware, true);
  assert.equal(Object.hasOwn(diagnostics, 'cloudProxies'), false);
  for (const fabricatedField of ['sampleCount', 'minimum', 'maximum', 'mean', 'nonZeroFraction']) {
    assert.equal(Object.hasOwn(diagnostics, fabricatedField), false,
      `${fabricatedField} must not masquerade as a measured GPU density diagnostic`);
  }
  assert.throws(() => new WeatherSky({}, bindings, WEATHER_SKY_WORKLOADS.high), /WebGPU renderer/);
  assert.throws(() => new WeatherSky(renderer(), {}, WEATHER_SKY_WORKLOADS.high), /EnvironmentGpuBindings/);
});

test('zero cloud coverage uses the shared analytic sky without volumetric setup or pass work', async () => {
  const gpu = renderer();
  const sky = new WeatherSky(gpu, new EnvironmentGpuBindings(state(0)), WEATHER_SKY_WORKLOADS.high);
  assert.equal(sky.cloudsEnabled, false);
  assert.equal(sky.usesVolumetricClouds, false);
  assert.equal(gpu.lastCompute, undefined);
  const diagnostics = await sky.readDiagnostics();
  assert.equal(diagnostics.enabled, false);
  assert.deepEqual(diagnostics.cloudVolume.dimensions, [0, 0, 0]);
  assert.equal(diagnostics.cloudVolume.gpuResident, false);
  assert.equal(diagnostics.cloudVolume.initStatus, 'none');
  assert.equal(diagnostics.cloudVolume.sampledInRaymarch, false);
  assert.equal(Object.hasOwn(diagnostics, 'hasSkyPass'), false);
  assert.equal(diagnostics.cloudHistory.pingPong, false);
  assert.ok(sky.backgroundNode?.isNode);
});

// The authored default is broken alpine cumulus. Pin the physical authoring envelope
// rather than one arbitrary literal: coverage stays bounded, and the layer has enough
// vertical depth to resolve rounded GPU billows without becoming a horizon-spanning
// overcast.
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
  assert.ok(Number(gameBase) >= 700 && Number(gameBase) <= 1100,
    'the alpine cumulus base must stay in the authored 0.7–1.1 km band');
  assert.ok(Number(gameThickness) >= 1200 && Number(gameThickness) <= 2200,
    'the cloud volume needs 1.2–2.2 km depth for rounded billows');
  assert.ok(Number(gameBase) + Number(gameThickness) <= 3600,
    'the authored deck must leave the high massif readable');

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

// SceneManager.refreshWeatherSkyClouds() rebuilds the sky graph only when coverage
// crosses the clear/cloudy boundary. Cloudy weather owns the existing low-res pass.
test('cloud coverage crossing zero flips the compiled volumetric graph', () => {
  const clear = new WeatherSky(renderer(), new EnvironmentGpuBindings(state(0)), WEATHER_SKY_WORKLOADS.high);
  const cloudy = new WeatherSky(renderer(), new EnvironmentGpuBindings(state(0.4)), WEATHER_SKY_WORKLOADS.high);
  assert.equal(clear.cloudsEnabled, false);
  assert.equal(cloudy.cloudsEnabled, true);
  assert.notEqual(clear.backgroundNode, cloudy.backgroundNode);
  assert.equal(clear.usesVolumetricClouds, false);
  assert.equal(cloudy.usesVolumetricClouds, true);
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
  const required = ['id', 'internalScale', 'raySteps', 'lightTransportSamples', 'lightProbeSteps', 'noiseOctaves', 'jitterPeriod'];
  for (const workload of Object.values(WEATHER_SKY_WORKLOADS)) {
    assert.deepEqual(Object.keys(workload).sort(), required.slice().sort());
    assert.ok(Object.isFrozen(workload));
    assert.ok(workload.raySteps >= 4);
    assert.equal(workload.lightTransportSamples, 1);
    assert.equal(workload.lightProbeSteps, 3);
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

test('WeatherSky uses one GPU sky-volume path and never a proxy/fallback renderer', async () => {
  const source = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(source, /HDRLoader/);
  assert.doesNotMatch(source, /RGBELoader/);
  assert.match(source, /EquirectangularReflectionMapping|textureNode/);
  assert.doesNotMatch(source, /WebGLRenderer|WebGLBackend|createFallback|fallback\s*:/);
  assert.match(source, /wind field/i);
  assert.match(source, /Storage3DTexture/);
  assert.match(source, /textureStore\(volume, voxel/);
  assert.match(source, /mx_noise_float[\s\S]*mx_worley_noise_float/);
  assert.match(source, /skyRadiance\(direction, \{ includeSun = false \} = \{\}\)/);
  assert.match(source, /If\(validRay\.and\(horizonMask/,
    'bounded ray integration must skip empty sky rays');
  assert.match(source, /sunProbePosition/,
    'light transport must use a true sun-offset volume probe');
  assert.match(source, /const volume = this\._cloudVolumeSample\(/,
    'each view tap must retain one RGBA volume fetch for density and erosion');
  assert.match(source, /CLOUD_EMPTY_THRESHOLD/);
  assert.match(source, /texture3D\(this\._cloudVolume/);
  assert.doesNotMatch(source, /BoxGeometry|InstancedMesh|CLOUD_PROXY|scene-mrt-proxy|cloudProxies/);
  assert.match(source, /const detailSignal = volume\.y\.mul\(0\.58\)\.add\(volume\.z\.mul\(0\.42\)\)/);
  assert.match(source, /const rawCarrier = volume\.x\.mul\(volume\.w\)\.clamp\(0, 1\)/,
    'cloud occupancy must use the initialized joint R/A carrier');
  assert.match(source, /const baseCarrier = smoothstep\(coverageThreshold, coverageThreshold\.add\(0\.18\), rawCarrier\)/,
    'joint R/A carrier must establish an unshifted core before boundary erosion');
  assert.match(source, /const edgeWindow = oneMinus\(smoothstep\(0\.48, 0\.84, baseCarrier\)\)/,
    'detail threshold shifts must be limited to the carrier margin');
  assert.match(source, /const thresholdShift = detailSignal\.sub\(0\.5\)\.mul\(0\.035\)/,
    'existing detail and erosion channels must perturb the carrier threshold');
  assert.match(source, /const carrier = smoothstep\(shiftedThreshold, shiftedThreshold\.add\(0\.18\), rawCarrier\)/,
    'joint R/A carrier must use the shifted material threshold');
  assert.doesNotMatch(source, /variation[\s\S]*erosion\.mul\(0\.06\)/,
    'erosion must not be a positive fog floor in density');
  assert.match(source, /return carrier\.mul\(vertical\)/,
    'cloud density must consume the identical joint carrier');
  assert.doesNotMatch(source, /smoothstep\(0\.001, 0\.(08|10|12),/,
    'cloud density must not use catastrophic near-zero remaps');
  assert.doesNotMatch(source, /_cloudHistory|previousHistory|previousClip/);
  assert.doesNotMatch(source, /copyTextureToBuffer/);
});

test('cloud carrier boundary math preserves solid cores and breaks sparse margins', () => {
  const coreLowDetail = jointCarrier(0.95, 0.1, 0.2);
  const coreHighDetail = jointCarrier(0.95, 0.9, 0.8);
  assert.ok(Math.abs(coreLowDetail - coreHighDetail) < 1e-9,
    'saturated carrier cores must remain unchanged by boundary channels');
  assert.ok(coreLowDetail > 0.999, 'solid core carrier must remain fully occupied');

  const sparseA = jointCarrier(0.15, 0.1, 0.2);
  const sparseB = jointCarrier(0.15, 0.9, 0.8);
  assert.ok(Math.abs(sparseA - sparseB) > 1e-3,
    'detail/erosion channels must increase sparse edge variance');
  assert.equal(jointCarrier(0.01, 0.1, 0.2), 0,
    'empty exterior must remain empty after threshold perturbation');
});

test('cloud graph is a true global AABB view-ray volume with front-to-back transport', async () => {
  const source = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(source, /boundsMin[\s\S]*boundsMax/);
  assert.match(source, /inverseDirection/);
  assert.match(source, /sampleDistance = rayEntry\.add\(stepLength/);
  assert.match(source, /const marchLength = rayLength;/,
    'cloud rays must integrate the complete bounded AABB interval');
  assert.match(source, /\.mul\(float\(step\)\.add\(jitter\)\)/,
    'view samples must use one deterministic phase inside each stratified interval');
  assert.match(source, /const framePhase = fract\(/,
    'cloud sampling must rotate its phase with the deterministic temporal sequence');
  assert.match(source, /const pixelGradient = fract\(pixel\.dot\(vec2\(0\.06711056, 0\.00583715\)\)\)/,
    'cloud sampling must use high-frequency interleaved gradient noise');
  assert.doesNotMatch(source, /pixelPhase = mx_noise_float\(pixel\.mul\(0\.08\)\)/,
    'cloud sampling must not use a low-frequency screen-correlated phase');
  assert.match(source, /const jitter = fract\(framePhase\.add\(pixelPhase\)\)/,
    'cloud sampling must combine frame rotation and stable pixel phase without clamping');
  assert.doesNotMatch(source, /rayLength\.min\(steps \* 700\)/,
    'cloud rays must not truncate the authored slab to a card-like horizon slice');
  assert.match(source, /const position = cameraOrigin\.add\(direction\.mul\(sampleDistance\)\)/);
  assert.match(source, /segmentTransmittance = exp\(opticalDepth\.negate\(\)\)/);
  assert.match(source, /scattered\.addAssign\(transmittance\.mul\(segmentAlpha\)/);
  assert.match(source, /transmittance\.mulAssign\(segmentTransmittance\)/);
  assert.match(source, /density\.greaterThan\(CLOUD_EMPTY_THRESHOLD\)/);
  assert.match(source, /henyeyGreenstein\(cosine, 0\.60\)/);
  assert.match(source, /henyeyGreenstein\(cosine, 0\.93\)/);
  assert.match(source, /clouds\.z/);
  assert.match(source, /clouds\.w/);
  assert.match(source, /cloudAdvectionScale/);
  assert.match(source, /sunProbe = this\._cloudVolumeSample/);
  assert.match(source, /const sunPath = cloudTop\.sub\(probePosition\.y\)[\s\S]*\.clamp\(240, 1400\)/,
    'cloud self-shadowing must use the height-aware Beer path through the slab');
  assert.match(source, /const sunProbeDistance = sunPath\.mul\(0\.45\)\.min\(600\)/,
    'the paired probe must remain a bounded fraction of the physical sun path');
  assert.match(source, /neighborDensity\.mul\(sunPath\)\.mul\(SUN_EXTINCTION\)/,
    'sun transmittance must vary with the sampled Beer path length');
  assert.doesNotMatch(source, /sunDirection\.mul\(240\)/,
    'cloud transport must not use a fixed 240 m probe offset');
  assert.doesNotMatch(source, /localSunTransmittance/,
    'cloud transport must not double-count a second per-primary attenuation path');
  assert.match(source, /for \(let pair = 0; pair < 3; pair\+\+\)/,
    'six primary samples must be grouped into three adjacent probe-sharing pairs');
  assert.match(source, /float\(pair \* 2\)\.add\(0\.5\)\.add\(jitter\)/,
    'each paired sun probe must be sampled at the adjacent-segment midpoint');
  assert.match(source, /for \(let segment = 0; segment < 2; segment\+\+\)/,
    'each pair must update front-to-back transmittance for both primary segments');
});

test('cloud formation has no static noise texture, bake, readback, or renderer fallback', async () => {
  const source = await readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8');
  assert.match(source, /_initCloudVolume/);
  assert.match(source, /Storage3DTexture/);
  assert.match(source, /texture3D/);
  assert.match(source, /textureStore/);
  assert.doesNotMatch(source, /noiseVolume|_noiseInitCompute|copyTextureToBuffer/);
  assert.doesNotMatch(source, /WebGLRenderer|WebGLBackend|createFallback|fallback\s*:/);
  assert.match(source, /const base = mx_noise_float\(domain\.mul\(0\.78\)\)/);
  assert.match(source, /const detail = mx_noise_float\(domain\.mul\(4\.40\)/);
  assert.match(source, /const erosion = mx_noise_float\(domain\.mul\(6\.20\)/);
  assert.match(source, /mx_worley_noise_float/);
  assert.match(source, /const domain = uv\.mul\(vec3\(4\.6, 2\.3, 4\.6\)\)/);
});

test('cloud temporal resolve is a real same-target ping-pong with reprojection and rejection', async () => {
  const source = await readFile(new URL('../src/scene/CloudTemporalNode.js', import.meta.url), 'utf8');
  assert.match(source, /new RenderTarget\(1, 1/);
  assert.match(source, /this\._history = this\._resolve/);
  assert.match(source, /previous\.sample\(previousUv\)/);
  assert.match(source, /previousProjection[\s\S]*previousView[\s\S]*farPoint/);
  assert.match(source, /opacityAgreement/);
  assert.doesNotMatch(source, /copyTextureToTexture/,
    'fused temporal resolve must not initialize or copy an intermediate current-sky target');
  assert.match(source, /const currentColor = this\.weatherSky[\s\S]*radianceForRay/,
    'temporal resolve must evaluate current cloud radiance in the same material');
  assert.doesNotMatch(source, /spatialDelta|offset of \[\[1, 1\]/,
    'temporal resolve must not add a destructive quincunx preblur');
  assert.match(source, /fused raymarch \+ temporal resolve/);
  assert.match(source, /currentProjectionInverse[\s\S]*currentWorld/,
    'fullscreen cloud rays must be built from explicit scene-camera matrices');
  assert.match(source, /currentUv\.y\.mul\(-2\)\.add\(1\)/,
    'fullscreen UV.y must be converted from QuadMesh texture orientation to clip-space Y');
  assert.match(source, /currentWorld\.mul\(vec4\(viewDirection\.mul\(10000\), 1\)\)/,
    'camera-local sky rays must receive one world transform during reprojection');
  assert.match(source, /previousNdc\.y\.mul\(-0\.5\)\.add\(0\.5\)/,
    'reprojected clip-space Y must return to the same top-left history UV convention');
  assert.doesNotMatch(source, /worldDirection\.mul\(10000\)/,
    'reprojection must not double-transform a world-space direction');
  assert.match(source, /transmittance-aware temporal\s+reconstruction/);
  assert.doesNotMatch(source, /copyTextureToBuffer|readback|noise/i);
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
