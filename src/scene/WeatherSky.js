import {
  ClampToEdgeWrapping, EquirectangularReflectionMapping, LinearFilter, Vector2,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Storage3DTexture } from 'three/webgpu';
import {
  Break, cameraPosition, exp, float, fract, Fn, globalId, If, Loop,
  max, min, mix, mx_noise_float, mx_worley_noise_float, oneMinus, equirectUV,
  positionWorldDirection, screenCoordinate, smoothstep,
  texture as textureNode, texture3D, textureStore, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { EnvironmentGpuBindings } from '../environment/EnvironmentGpuBindings.js';

// Analytic daylight plus a bounded, GPU-generated volumetric cloud layer. Cloud shape,
// detail, transport, and lighting are integrated in one global camera-ray graph. The
// optional HDR is only a clear-sky/IBL source; it never supplies cloud data.

const MIN_RAY_STEPS = 4;
const MAX_RAY_STEPS = 32;
const MIN_LIGHT_SAMPLES = 1;
const MAX_LIGHT_SAMPLES = 1;
const MIN_LIGHT_PROBE_STEPS = 3;
const MAX_LIGHT_PROBE_STEPS = 16;
const MIN_NOISE_OCTAVES = 2;
const MAX_NOISE_OCTAVES = 4;
const MIN_INTERNAL_SCALE = 0.125;
const MAX_INTERNAL_SCALE = 1;
const CLOUD_TARGET_SCALE = 0.25;

// Finite X/Z bounds prevent horizon rays from marching forever. The extent covers
// the playable range and distant alpine wall while keeping the AABB arithmetic small.
const CLOUD_HORIZONTAL_EXTENT = 24000;
const CLOUD_VISIBLE_DISTANCE = 5000;
const CLOUD_EMPTY_THRESHOLD = 0.018;
// Extinction is in inverse world metres. Keep optical thickness in the stable range
// of the bounded low-resolution raymarch so crowns retain gray cores and bases.
const CLOUD_EXTINCTION = 0.00115;
const SUN_EXTINCTION = 0.0018;
const CLOUD_VOLUME_SIZE = 96;
const CLOUD_VOLUME_WORKGROUP = 4;
const CLOUD_VOLUME_DISPATCH = CLOUD_VOLUME_SIZE / CLOUD_VOLUME_WORKGROUP;
const CLOUD_VOLUME_FORMAT = 'rgba8unorm';

// Deterministic mirror of the GPU ray-interval rule used by contract tests.
// Rendering remains entirely shader-side; this performs no cloud evaluation.
export function resolveCloudRayInterval(rayEntry, rayExit, opaqueDistance, hasOpaqueGeometry) {
  if (![rayEntry, rayExit].every(Number.isFinite)) {
    throw new TypeError('cloud ray entry/exit must be finite numbers.');
  }
  const clippedExit = hasOpaqueGeometry && Number.isFinite(opaqueDistance)
    ? Math.min(rayExit, opaqueDistance) : rayExit;
  const entry = Math.max(0, rayEntry);
  const length = Math.max(0, clippedExit - entry);
  return Object.freeze({ entry, exit: clippedExit, length, intersects: length > 0 });
}

function fail(message) {
  throw new TypeError(`Invalid WeatherSky workload: ${message}`);
}

function finite(value, name, minValue, maxValue) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minValue || value > maxValue) {
    fail(`${name} must be a finite number in [${minValue}, ${maxValue}].`);
  }
  return value;
}

function positiveInteger(value, name, minValue, maxValue) {
  if (!Number.isInteger(value) || value < minValue || value > maxValue) {
    fail(`${name} must be an integer in [${minValue}, ${maxValue}].`);
  }
  return value;
}

function normaliseWorkload(workload) {
  if (!workload || typeof workload !== 'object' || Array.isArray(workload)) {
    fail('a fixed workload object is required.');
  }
  if (typeof workload.id !== 'string' || !/^(high|balanced|conservative)$/.test(workload.id)) {
    fail('id must be high, balanced, or conservative.');
  }
  // Tiers compile the same graph. These are fixed budget constants only: no tier
  // selects a different renderer, cloud representation, or asset.
  return Object.freeze({
    id: workload.id,
    internalScale: finite(workload.internalScale, 'internalScale', MIN_INTERNAL_SCALE, MAX_INTERNAL_SCALE),
    raySteps: positiveInteger(workload.raySteps, 'raySteps', MIN_RAY_STEPS, MAX_RAY_STEPS),
    lightTransportSamples: positiveInteger(
      workload.lightTransportSamples, 'lightTransportSamples', MIN_LIGHT_SAMPLES, MAX_LIGHT_SAMPLES,
    ),
    lightProbeSteps: positiveInteger(
      workload.lightProbeSteps, 'lightProbeSteps', MIN_LIGHT_PROBE_STEPS, MAX_LIGHT_PROBE_STEPS,
    ),
    noiseOctaves: positiveInteger(workload.noiseOctaves, 'noiseOctaves', MIN_NOISE_OCTAVES, MAX_NOISE_OCTAVES),
    jitterPeriod: positiveInteger(workload.jitterPeriod, 'jitterPeriod', 2, 256),
  });
}

function jitterComponent(index, base) {
  let value = index;
  let inverse = 1 / base;
  let result = 0;
  while (value > 0) {
    result += (value % base) * inverse;
    value = Math.floor(value / base);
    inverse /= base;
  }
  return result - 0.5;
}

function jitterForFrame(frame, period) {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new TypeError('WeatherSky temporal frame must be a non-negative integer.');
  }
  const sample = frame % period;
  return Object.freeze({ x: jitterComponent(sample + 1, 2), y: jitterComponent(sample + 1, 3) });
}

function validateJitter(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`WeatherSky ${name} jitter is required.`);
  return {
    x: finite(value.x, `${name}.x`, -0.5, 0.5),
    y: finite(value.y, `${name}.y`, -0.5, 0.5),
  };
}

// Henyey-Greenstein phase used for the broad forward lobe and tight silver lining.
function henyeyGreenstein(cosine, g) {
  const gg = g * g;
  return float(1 - gg)
    .div(float(1 + gg).sub(cosine.mul(2 * g)).max(0.0001).pow(1.5))
    .mul(0.0795775);
}

// A single predicate is shared by SceneManager and the graph compiler. Coverage and
// density changes inside this range stay uniform-only; crossing it is a graph change.
export function cloudsAreEnabled(clouds) {
  return clouds.x > 0.0001 && clouds.y > 0.0001;
}

export const WEATHER_SKY_WORKLOADS = Object.freeze({
  // One low-resolution target performs a global AABB/slab march. The history node
  // ping-pongs that same target before the full-resolution scene TRAA.
  high: Object.freeze({
    id: 'high', internalScale: CLOUD_TARGET_SCALE, raySteps: 16, lightTransportSamples: 1, lightProbeSteps: 8, noiseOctaves: 2, jitterPeriod: 64,
  }),
  balanced: Object.freeze({
    id: 'balanced', internalScale: CLOUD_TARGET_SCALE, raySteps: 16, lightTransportSamples: 1, lightProbeSteps: 8, noiseOctaves: 2, jitterPeriod: 64,
  }),
  conservative: Object.freeze({
    id: 'conservative', internalScale: CLOUD_TARGET_SCALE, raySteps: 16, lightTransportSamples: 1, lightProbeSteps: 8, noiseOctaves: 2, jitterPeriod: 64,
  }),
});

/** Strict WebGPU/TSL sky source. Cloud weather is integrated through a global
 * camera-ray slab in a bounded sky target; the 96^3 field is generated on-GPU. */
export class WeatherSky {
  constructor(renderer, environment, workload, skyManifest = null) {
    if (!renderer?.isWebGPURenderer || typeof renderer.compute !== 'function') {
      throw new TypeError('WeatherSky requires the strict WebGPU renderer.');
    }
    if (!(environment instanceof EnvironmentGpuBindings)) {
      throw new TypeError('WeatherSky requires shared EnvironmentGpuBindings.');
    }
    this.renderer = renderer;
    this.environment = environment;
    this.workload = normaliseWorkload(workload);
    this.skyManifest = skyManifest;
    this.cloudsEnabled = cloudsAreEnabled(environment.clouds.value);
    this.usesVolumetricClouds = this.cloudsEnabled;
    this.currentJitter = uniform(new Vector2(0, 0));
    this.previousJitter = uniform(new Vector2(0, 0));
    this.temporalFrame = 0;
    this.setTemporalFrame(0);

    this._cloudVolume = null;
    this._cloudVolumeInit = null;
    this._cloudVolumeInitDispatched = false;
    if (this.cloudsEnabled) this._initCloudVolume();

    const volumeDiagnostics = Object.freeze({
      dimensions: this.cloudsEnabled
        ? [CLOUD_VOLUME_SIZE, CLOUD_VOLUME_SIZE, CLOUD_VOLUME_SIZE] : [0, 0, 0],
      channels: this.cloudsEnabled ? 4 : 0,
      format: this.cloudsEnabled ? CLOUD_VOLUME_FORMAT : null,
      gpuResident: this.cloudsEnabled,
      initStatus: this.cloudsEnabled
        ? (this._cloudVolumeInitDispatched ? 'submitted' : 'not-submitted') : 'none',
      sampledInRaymarch: this.cloudsEnabled,
    });
    this._cloudDiagnostics = Object.freeze({
      enabled: this.cloudsEnabled,
      mode: this.cloudsEnabled ? 'gpu-volume-raymarch' : 'clear-sky',
      renderTopology: this.cloudsEnabled ? 'fused-temporal-volume' : 'analytic-background',
      usesVolumetricClouds: this.cloudsEnabled,
      proceduralNoise: this.cloudsEnabled,
      gpuOnly: true,
      internalScale: this.cloudsEnabled ? this.workload.internalScale : 0,
      raySteps: this.cloudsEnabled ? this.workload.raySteps : 0,
      lightTransportSamples: this.cloudsEnabled ? this.workload.lightTransportSamples : 0,
      lightProbeSteps: this.cloudsEnabled ? this.workload.lightProbeSteps : 0,
      lightTransportMode: this.cloudsEnabled ? 'paired-sun-offset-volume-probe' : 'none',
      noiseOctaves: this.cloudsEnabled ? this.workload.noiseOctaves : 0,
      jitterPeriod: this.cloudsEnabled ? this.workload.jitterPeriod : 0,
      cloudVolume: volumeDiagnostics,
      cloudHistory: Object.freeze({
        resolutionScale: this.cloudsEnabled ? this.workload.internalScale : 0,
        pingPong: this.cloudsEnabled,
        previousFrameSampling: this.cloudsEnabled,
        cameraReprojection: this.cloudsEnabled,
        disocclusionRejection: this.cloudsEnabled,
        transmittanceAware: this.cloudsEnabled,
        temporalResolve: this.cloudsEnabled ? 'fused-raymarch-history' : 'none',
      }),
    });
    this.skyTexture = null;
    this.skyTextureLoaded = false;
    this._disposed = false;
    this.skyTextureReady = this._loadSkyTexture();
    this.ready = this.skyTextureReady.then(() => this._cloudDiagnostics);

    // IBL intentionally excludes the measured solar disc; the authoritative
    // DirectionalLight owns direct sun/shadows and visible sky adds its analytic disc.
    this.clearBackgroundNode = this._buildSkyRadianceNode({ includeSun: true });
    this.iblBackgroundNode = this._buildSkyRadianceNode({ includeSun: false });
    this.backgroundNode = this._buildBackgroundNode();
    this.outputNode = this.backgroundNode;
  }

  // Generate the compact cloud field once on the GPU. RGBA8 is enough for a filtered
  // density field at this scale: R is connected billow shape, G is broad detail,
  // B is erosion, and A is a conservative occupancy gate. The texture is never read
  // back or rebuilt per frame; world-space advection moves samples through this field.
  _initCloudVolume() {
    const volume = new Storage3DTexture(CLOUD_VOLUME_SIZE, CLOUD_VOLUME_SIZE, CLOUD_VOLUME_SIZE);
    volume.name = 'weather-cloud-volume-gpu';
    volume.minFilter = volume.magFilter = LinearFilter;
    volume.wrapS = volume.wrapT = volume.wrapR = ClampToEdgeWrapping;
    volume.generateMipmaps = false;
    volume.mipmapsAutoUpdate = false;
    this._cloudVolume = volume;

    const seedA = Number(this.environment.coefficientA.value.w) || 0;
    const seedB = Number(this.environment.coefficientB.value.w) || 0;
    const voxelSize = CLOUD_VOLUME_SIZE;
    this._cloudVolumeInit = Fn(() => {
      const voxel = globalId;
      const uv = vec3(
        float(voxel.x).add(0.5).div(voxelSize),
        float(voxel.y).add(0.5).div(voxelSize),
        float(voxel.z).add(0.5).div(voxelSize),
      );
      // The carrier is a 3-D weather field. Worley parcels form the connected
      // horizontal scaffold and the Y-dependent tower profile gives each parcel
      // a distinct crown rather than a flat sheet.
      const domain = uv.mul(vec3(4.6, 2.3, 4.6));
      const seededDomain = domain.add(vec3(seedA * 0.17, seedB * 0.13, seedA * 0.23));
      const weatherXZ = vec2(seededDomain.x, seededDomain.z).mul(0.42);
      const carrierXZ = weatherXZ.mul(1.55);
      const cellDistance = mx_worley_noise_float(carrierXZ, 1).max(0).sqrt();
      const cellBillow = oneMinus(smoothstep(0.10, 0.68, cellDistance));
      const weatherNoise = mx_noise_float(carrierXZ.mul(0.58).add(vec2(13.7, 41.9)))
        .mul(0.5).add(0.5);
      const parcelDistance = mx_worley_noise_float(
        seededDomain.mul(vec3(0.72, 0.94, 0.72)).add(vec3(7.1, 19.3, 3.7)), 1,
      ).max(0).sqrt();
      const parcelBillow = oneMinus(smoothstep(0.12, 0.70, parcelDistance));
      const weather3D = mx_noise_float(
        seededDomain.mul(vec3(0.46, 0.58, 0.46)).add(vec3(9.7, 2.1, 27.3)),
      ).mul(0.5).add(0.5);
      const lobeDistance = mx_worley_noise_float(
        seededDomain.mul(vec3(3.05, 2.42, 3.05)).add(vec3(31.7, 5.3, 17.9)), 1,
      ).max(0).sqrt();
      const lobeBillow = oneMinus(smoothstep(0.09, 0.66, lobeDistance));
      const macroCarrier = parcelBillow.mul(0.76).add(weather3D.mul(0.24));
      const macroWeather = smoothstep(0.16, 0.54,
        macroCarrier.mul(0.88).add(weatherNoise.mul(0.12)));
      const lobeGate = smoothstep(0.16, 0.62,
        lobeBillow.mul(0.82).add(weatherNoise.mul(0.18)));
      // The lobe field must own enough of the boundary to break kilometre-scale
      // carrier balloons into connected cauliflower towers. This is a remap of an
      // already generated channel, so it adds no runtime raymarch samples.
      const weatherGate = macroWeather.mul(float(0.60).add(lobeGate.mul(0.40)));
      const columnNoise = mx_noise_float(weatherXZ.mul(0.82).add(vec2(73.1, 19.4)))
        .mul(0.5).add(0.5);
      const cloudTop = float(0.60).add(columnNoise.mul(0.27));
      const normalizedHeight = uv.y;
      const localBase = oneMinus(parcelBillow).mul(0.065)
        .add(oneMinus(weatherNoise).mul(0.025));
      const baseProfile = smoothstep(localBase, localBase.add(0.14), normalizedHeight);
      const shoulderProfile = smoothstep(0.10, 0.34, normalizedHeight);
      const topProfile = oneMinus(smoothstep(
        cloudTop.sub(0.14), cloudTop.add(0.035), normalizedHeight,
      ));
      const towerProfile = baseProfile.mul(topProfile)
        .mul(float(0.58).add(shoulderProfile.mul(0.42)));

      const broad = mx_noise_float(seededDomain.mul(0.52).add(vec3(17.3, 5.1, 29.7)))
        .mul(0.5).add(0.5);
      const base = mx_noise_float(domain.mul(0.78)).mul(0.5).add(0.5);
      const worleyDistance = mx_worley_noise_float(seededDomain.mul(1.18), 1).max(0).sqrt();
      const worleyBillow = oneMinus(worleyDistance).clamp(0, 1);
      const billow = base.mul(0.54).add(worleyBillow.mul(0.31)).add(broad.mul(0.15)).clamp(0, 1);
      const cauliflower = worleyBillow.mul(0.74).add(base.mul(0.16)).add(broad.mul(0.10));
      const billowShape = cauliflower.mul(0.66).add(billow.mul(0.22)).add(broad.mul(0.12));
      const detail = mx_noise_float(domain.mul(2.55).add(vec3(11.7, 31.2, 7.4)))
        .mul(0.5).add(0.5);
      const erosion = mx_noise_float(domain.mul(3.65).add(vec3(23.1, 4.7, 11.9)))
        .mul(0.5).add(0.5);
      const billowBoundary = smoothstep(0.18, 0.48, billowShape)
        .mul(oneMinus(smoothstep(0.58, 0.86, billowShape)));
      const boundaryErosion = float(0.74).mix(erosion, billowBoundary);
      const occupancy = weatherGate.mul(towerProfile)
        .mul(float(0.72).add(cauliflower.mul(0.28))).clamp(0, 1);
      // Keep intrinsic billow density independent from occupancy. Runtime combines
      // R × A exactly once; baking occupancy into R here squared the carrier,
      // erasing margins and leaving broad, posterized interior plateaus.
      const density = smoothstep(0.15, 0.48, billowShape).mul(0.76).add(0.24);
      textureStore(volume, voxel, vec4(density, detail, boundaryErosion, occupancy)).toWriteOnly();
    })().compute(
      [CLOUD_VOLUME_DISPATCH, CLOUD_VOLUME_DISPATCH, CLOUD_VOLUME_DISPATCH],
      [CLOUD_VOLUME_WORKGROUP, CLOUD_VOLUME_WORKGROUP, CLOUD_VOLUME_WORKGROUP],
    );
    this._cloudVolumeInit.name = 'Weather cloud volume initialize';
    this.renderer.compute(this._cloudVolumeInit);
    this._cloudVolumeInitDispatched = true;
  }

  _loadSkyTexture() {
    if (!this.skyManifest) return Promise.resolve(null);
    const loader = new HDRLoader();
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.skyTexture = loader.load(this.skyManifest.url, (loadedTexture) => {
      if (this._disposed || this.skyTexture !== loadedTexture) {
        loadedTexture?.dispose();
        resolveReady(null);
        return;
      }
      this.skyTextureLoaded = true;
      resolveReady(loadedTexture);
    }, undefined, rejectReady);
    this.skyTexture.mapping = EquirectangularReflectionMapping;
    this.skyTexture.name = this.skyManifest.id;
    this.skyTexture.userData.rotationRadians = this.skyManifest.rotationRadians;
    return ready;
  }

  _buildSkyRadianceNode({ includeSun = false } = {}) {
    return this.skyRadiance(positionWorldDirection.normalize(), { includeSun });
  }

  skyRadiance(direction, { includeSun = false } = {}) {
    if (!direction?.isNode) throw new TypeError('WeatherSky.skyRadiance requires a TSL direction node.');
    const normalized = direction.normalize();
    if (!this.skyManifest || !this.skyTexture) {
      return this.environment.skyRadiance(normalized, { includeSun });
    }
    const angle = this.skyManifest.rotationRadians;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rotated = vec3(
      normalized.x.mul(c).add(normalized.z.mul(s)),
      normalized.y,
      normalized.z.mul(c).sub(normalized.x.mul(s)),
    );
    const hdr = textureNode(this.skyTexture, equirectUV(rotated));
    const sourceSun = vec3(...this.skyManifest.sourceSunDirection);
    const sourceAlignment = rotated.dot(sourceSun).clamp(-1, 1);
    const directMask = smoothstep(
      Math.cos(5 * Math.PI / 180), Math.cos(1 * Math.PI / 180), sourceAlignment,
    );
    const clearSky = this.environment.skyRadiance(normalized, { includeSun: false });
    const skyWithoutMeasuredSun = mix(hdr, clearSky, directMask);
    if (!includeSun) return skyWithoutMeasuredSun;
    return skyWithoutMeasuredSun.add(
      this.environment.skyRadiance(normalized, { includeSun: true }).sub(clearSky),
    );
  }

  async readDiagnostics() {
    await this.ready;
    return this._cloudDiagnostics;
  }

  setTemporalFrame(frame) {
    const current = jitterForFrame(frame, this.workload.jitterPeriod);
    const previous = jitterForFrame(frame === 0 ? 0 : frame - 1, this.workload.jitterPeriod);
    this.currentJitter.value.set(current.x, current.y);
    this.previousJitter.value.set(previous.x, previous.y);
    this.temporalFrame = frame;
    return this;
  }

  setTemporalJitter(current, previous) {
    const currentValue = validateJitter(current, 'current');
    const previousValue = validateJitter(previous, 'previous');
    this.currentJitter.value.set(currentValue.x, currentValue.y);
    this.previousJitter.value.set(previousValue.x, previousValue.y);
    return this;
  }

  cloudDensityAt(worldPosition, { previous = false } = {}) {
    if (!worldPosition?.isNode) throw new TypeError('WeatherSky.cloudDensityAt requires a TSL world-position node.');
    return this._cloudDensity(worldPosition, previous ? this.environment.previousTime : this.environment.time);
  }

  // The shared wind field advects every volume tap. X/Z are broad enough for connected
  // kilometre-scale parcels; Y is deliberately different so vertical samples traverse
  // genuine 3-D detail instead of repeating one 2-D carrier through the slab.
  _cloudCoordinates(worldPosition, time, wind = null, advectionTime = null) {
    const localWind = wind ?? this.environment.windAt(worldPosition, time);
    const localAdvectionTime = advectionTime ?? time.mul(this.environment.cloudAdvectionScale);
    const advected = worldPosition.sub(localWind.mul(localAdvectionTime));
    const rotatedX = advected.x.mul(0.8480).sub(advected.z.mul(0.5299));
    const rotatedZ = advected.x.mul(0.5299).add(advected.z.mul(0.8480));
    const phase = vec3(
      rotatedX.mul(0.00032),
      advected.y.mul(0.00036),
      rotatedZ.mul(0.00032),
    ).add(vec3(0.37, 0.13, 0.61));
    // Mirror the finite volume instead of fract-wrapping a non-tileable field.
    // The old discontinuity jumped between unrelated edge voxels and produced
    // kilometer-tall rectangular seams. Triangle folding is continuous at both
    // ends and costs no additional volume sample.
    return oneMinus(fract(phase.mul(0.5)).mul(2).sub(1).abs());
  }

  _cloudVolumeSample(worldPosition, time, wind = null, advectionTime = null) {
    if (!this._cloudVolume) return vec4(0, 0, 0, 0);
    return texture3D(this._cloudVolume, this._cloudCoordinates(
      worldPosition, time, wind, advectionTime,
    ));
  }

  _heightGradient(normalizedHeight, volume) {
    const h = normalizedHeight.clamp(0, 1);
    // The base is tapered by the same local R/A field that owns occupancy. This keeps
    // the underside broken in X/Z while preserving a readable broad crown profile.
    const baseEdge = volume.w.mul(0.055).add(volume.x.mul(0.025));
    const base = smoothstep(baseEdge, baseEdge.add(0.18), h);
    // The generated A occupancy already carries each parcel's own top. Avoid a
    // second hard top ramp here: multiplying two vertical cuts creates visible
    // horizontal bands at sparse view-step counts.
    return base.mul(float(0.78).add(h.mul(0.22)));
  }

  // R/A are one joint GPU carrier. The threshold is materially above zero and was
  // calibrated to the initialized field's interior product (~0.1), so empty voxels
  // remain empty without a coverage floor or a near-zero remap.
  _cloudDensityFromVolume(volume, normalizedHeight, clouds, detail = true) {
    const rawCarrier = volume.x.mul(volume.w).clamp(0, 1);
    const coverageThreshold = float(0.08).add(oneMinus(clouds.x.clamp(0, 1)).mul(0.06));
    const baseCarrier = smoothstep(coverageThreshold, coverageThreshold.add(0.18), rawCarrier);
    const vertical = this._heightGradient(normalizedHeight, volume);
    const detailSignal = volume.y.mul(0.58).add(volume.z.mul(0.42));
    const erosion = smoothstep(0.20, 0.78, volume.z);
    // Only the carrier margin is allowed to move. Dense interiors have a saturated
    // baseCarrier and therefore zero edgeWindow, preserving their core extinction;
    // sparse parcels inherit bounded detail/erosion breakup at the boundary.
    const edgeWindow = oneMinus(smoothstep(0.56, 0.94, baseCarrier));
    const thresholdShift = detailSignal.sub(0.5).mul(0.080)
      .add(erosion.mul(0.105)).mul(edgeWindow);
    const shiftedThreshold = coverageThreshold.add(thresholdShift);
    const carrier = smoothstep(shiftedThreshold, shiftedThreshold.add(0.18), rawCarrier);
    // The carrier controls parcel occupancy; this second bounded field controls
    // cauliflower breakup inside an occupied parcel. Keeping it multiplicative
    // creates rounded crowns and shadow pockets instead of a uniform translucent
    // sheet while still using only channels from the same GPU-generated voxel.
    const fineShape = smoothstep(
      0.44, 0.61,
      volume.y.mul(0.62).add(oneMinus(volume.z).mul(0.38)),
    );
    const solidCore = smoothstep(0.84, 0.98, baseCarrier);
    const carvedShape = max(solidCore, fineShape.mul(float(0.38).add(baseCarrier.mul(0.62))));
    const variation = detail
      ? carvedShape.mul(0.94).add(detailSignal.mul(0.06))
      : float(0.72).add(volume.y.mul(0.08));
    return carrier.mul(vertical).mul(variation).mul(clouds.y.mul(1.55)).clamp(0, 1);
  }

  _cloudDensity(worldPosition, time, wind = null, advectionTime = null,
    octaves = this.workload.noiseOctaves, detail = true) {
    void octaves;
    const clouds = this.environment.clouds;
    const normalizedHeight = worldPosition.y.sub(clouds.z).div(clouds.w.max(1));
    const volume = this._cloudVolumeSample(worldPosition, time, wind, advectionTime);
    return this._cloudDensityFromVolume(volume, normalizedHeight, clouds, detail);
  }

  _buildBackgroundNode() {
    const direction = positionWorldDirection.normalize();
    if (!this.cloudsEnabled) return this._buildSkyRadianceNode({ includeSun: true });
    // Keep the public background node useful for callers that render a scene
    // background directly. The fused temporal path below passes all three ray
    // inputs explicitly and never inherits the fullscreen quad camera context.
    return this.radianceForRay(direction, cameraPosition, screenCoordinate.xy.floor());
  }

  // Evaluate cloud transport only. The returned vec4 is a composable layer:
  // RGB is in-scattered radiance and A is ray transmittance. It deliberately does
  // not contain the analytic sky or scene color; the TRAA compositor owns
  // `sceneRadiance * T + cloudScatter` after the authoritative MRT is complete.
  // `opaqueDistance` is reconstructed from that MRT's depth and is only active for
  // finite geometry pixels. A clear-depth pixel keeps the complete cloud AABB.
  cloudTransportForRay(
    direction,
    cameraOrigin,
    pixel = screenCoordinate.xy.floor(),
    opaqueDistance = null,
    opaqueHit = null,
    marchState = null,
  ) {
    if (!direction?.isNode || !cameraOrigin?.isNode || !pixel?.isNode) {
      throw new TypeError('WeatherSky.cloudTransportForRay requires direction, camera origin, and pixel nodes.');
    }
    if (!this.cloudsEnabled) return vec4(0, 0, 0, 1);

    const sunDirection = this.environment.sunDirection.normalize();
    const clouds = this.environment.clouds;
    // The ray's clear-sky radiance must use this explicit world direction too;
    // positionWorldDirection would resolve against the fullscreen quad camera.
    const time = this.environment.time;
    const slab = clouds.w.max(1);
    const boundsMin = vec3(
      float(-CLOUD_HORIZONTAL_EXTENT), clouds.z, float(-CLOUD_HORIZONTAL_EXTENT),
    );
    const boundsMax = vec3(
      float(CLOUD_HORIZONTAL_EXTENT), clouds.z.add(slab), float(CLOUD_HORIZONTAL_EXTENT),
    );
    const inverseDirection = vec3(
      direction.x.greaterThanEqual(0).select(1, -1).div(direction.x.abs().max(0.0001)),
      direction.y.greaterThanEqual(0).select(1, -1).div(direction.y.abs().max(0.0001)),
      direction.z.greaterThanEqual(0).select(1, -1).div(direction.z.abs().max(0.0001)),
    );
    const t0 = boundsMin.sub(cameraOrigin).mul(inverseDirection);
    const t1 = boundsMax.sub(cameraOrigin).mul(inverseDirection);
    const tMin = min(t0, t1);
    const tMax = max(t0, t1);
    const rayEntry = max(tMin.x, max(tMin.y, tMin.z)).max(0);
    const rayExit = min(tMax.x, min(tMax.y, tMax.z));
    // Depth-aware interval: finite geometry truncates the cloud march at the
    // reconstructed opaque ray distance. Background pixels intentionally select
    // the unmodified AABB exit, so the cloud deck remains a true world volume.
    const depthDistance = opaqueDistance?.isNode ? opaqueDistance : float(0);
    const depthHit = opaqueHit?.isNode ? opaqueHit : float(0);
    const opaqueClampedExit = depthHit.greaterThan(0.5)
      .select(min(rayExit, depthDistance), rayExit);
    const rayExitForMarch = opaqueClampedExit;
    const rayLength = rayExitForMarch.sub(rayEntry).max(0);
    // A near opaque hit can end before cloud entry. Keep representative-point
    // clamps well-formed in that empty interval while retaining the raw clamped
    // exit for the transport validity predicate.
    const safeRayExitForMarch = rayEntry.add(rayLength);
    const steps = this.workload.raySteps;
    // Integrate the complete finite AABB interval. The authored horizontal bounds
    // make even a grazing sky ray finite; truncating this interval creates a hard
    // 2.8 km horizon slice that reads as a rectangular cloud card.
    const marchLength = rayLength.min(CLOUD_VISIBLE_DISTANCE);
    const centre = cameraOrigin.add(direction.mul(rayEntry.add(marchLength.mul(0.5))));
    const wind = this.environment.windAt(centre, time);
    const advectionTime = time.mul(this.environment.cloudAdvectionScale);
    const validRay = rayExitForMarch.greaterThan(rayEntry)
      .and(rayLength.greaterThan(1))
      .and(direction.y.greaterThan(0.024));
    if (marchState && typeof marchState === 'object') {
      // CloudTemporalNode consumes these nodes to reproject a representative
      // world point without issuing a second raymarch.
      marchState.rayEntry = rayEntry;
      marchState.rayExitForMarch = safeRayExitForMarch;
    }
    const horizonMask = oneMinus(smoothstep(7000, 18000, rayEntry))
      .mul(smoothstep(0.03, 0.11, direction.y));
    const cosine = direction.dot(sunDirection).clamp(-1, 1);
    const phase = max(henyeyGreenstein(cosine, 0.60), henyeyGreenstein(cosine, 0.93).mul(0.62))
      .mul(4.4).clamp(0.30, 2.9);
    const sunTint = this.environment.sunColor
      .mul(this.environment.sunIlluminanceScale.max(0).pow(0.35));
    const ambientTop = this.environment.skyRadiance(vec3(0, 1, 0), { includeSun: false });
    const ambientLuma = ambientTop.dot(vec3(0.2126, 0.7152, 0.0722));
    const cloudAmbient = mix(ambientTop, vec3(ambientLuma), 0.75);

    // Adaptive marcher: empty macro cells advance coarsely; occupied cells use
    // short integration steps and a paired sun probe. This follows the production
    // SDF/coarse-to-fine pattern without a CPU cloud proxy or texture readback.
    const hasMarchState = marchState && typeof marchState === 'object';
    const representativeDistance = hasMarchState ? float(0).toVar() : null;
    if (hasMarchState) {
      // Assign the node before constructing the lazy Fn. TSL evaluates Fn bodies
      // during material build, so consumers must receive a stable node handle now.
      marchState.representativeDistance = representativeDistance;
    }
    return Fn(() => {
      const transmittance = float(1).toVar();
      const scattered = vec3(0).toVar();
      // Accumulate a radiance-weighted representative distance from the same six
      // primary taps. This is used only for temporal reprojection; scatter/T stay
      // in their original vec4 transport representation.
      const scatterDistanceWeight = hasMarchState ? float(0).toVar() : null;
      const scatterWeight = hasMarchState ? float(0).toVar() : null;
      // Rotate a stable, high-frequency interleaved-gradient phase by the shared
      // deterministic frame sequence. The target coordinate stays in shader (no
      // noise texture); interleaved gradient noise decorrelates neighboring pixels
      // without introducing a sampled noise asset or a low-frequency smear.
      const framePhase = fract(
        this.currentJitter.x.mul(1.7).add(this.currentJitter.y.mul(2.3)).add(0.5),
      );
      const pixelGradient = fract(pixel.dot(vec2(0.06711056, 0.00583715)));
      const pixelPhase = fract(pixelGradient.mul(52.9829189));
      const jitter = fract(framePhase.add(pixelPhase)).mul(0.84).add(0.08);
      If(validRay.and(horizonMask.greaterThan(0.002)), () => {
        // Cover the complete bounded interval even when the conservative envelope
        // remains occupied for every iteration. A fixed 170 m step exhausted the
        // loop after 3.4 km and visibly cropped long rays into hanging columns.
        const fineStep = marchLength.div(float(steps)).clamp(140, 280);
        const coarseStep = float(480);
        const rayEnd = rayEntry.add(marchLength);
        // Jitter by at most one occupied step. Offsetting by the 480 m empty-space
        // stride made the first hit jump between whole cloud lobes frame-to-frame,
        // exposing the quarter-resolution phase lattice after reconstruction.
        const sampleDistance = rayEntry.add(fineStep.mul(jitter)).toVar();
        const pairedSunTransmittance = float(1).toVar();
        Loop(steps, ({ i }) => {
          If(sampleDistance.greaterThanEqual(rayEnd).or(transmittance.lessThan(0.018)), () => {
            Break();
          });
          const position = cameraOrigin.add(direction.mul(sampleDistance));
          const normalizedHeight = position.y.sub(clouds.z).div(slab).clamp(0, 1);
          const volume = this._cloudVolumeSample(position, time, wind, advectionTime);
          const density = this._cloudDensityFromVolume(volume, normalizedHeight, clouds, true);
          const occupied = density.greaterThan(CLOUD_EMPTY_THRESHOLD);
          // Step finely through the conservative macro envelope, not only samples
          // that already survived detail erosion. A 480 m jump across a thin lobe
          // otherwise produces detached horizontal slices and missing silhouettes.
          const potentialCloud = volume.w.greaterThan(0.055)
            .and(volume.x.greaterThan(0.035));
          If(occupied, () => {
            If(i.mod(2).equal(0), () => {
              const cloudTop = clouds.z.add(slab);
              const sunPath = cloudTop.sub(position.y)
                .div(sunDirection.y.max(0.15)).clamp(240, 1400);
              const sunProbeDistance = sunPath.mul(0.45).min(600);
              const sunProbePosition = position.add(sunDirection.mul(sunProbeDistance));
              const sunProbe = this._cloudVolumeSample(
                sunProbePosition, time, wind, advectionTime,
              );
              const probeHeight = sunProbePosition.y.sub(clouds.z).div(slab).clamp(0, 1);
              const neighborDensity = this._cloudDensityFromVolume(
                sunProbe, probeHeight, clouds, false,
              );
              pairedSunTransmittance.assign(
                exp(neighborDensity.mul(sunPath).mul(SUN_EXTINCTION).negate()),
              );
            });
              const viewDepth = sampleDistance.sub(rayEntry).div(rayLength.max(1)).clamp(0, 1);
              const crown = smoothstep(0.18, 0.78, normalizedHeight);
              const underside = oneMinus(smoothstep(0.10, 0.58, normalizedHeight));
              const ambientOcclusion = oneMinus(
                density.mul(float(0.28).add(underside.mul(0.30))),
              ).clamp(0.62, 1);
              const ambient = cloudAmbient.mul(float(0.38).add(normalizedHeight.mul(0.38)))
                .mul(ambientOcclusion);
              const edgeLight = oneMinus(density).mul(0.75).add(0.55);
              const direct = sunTint.mul(pairedSunTransmittance).mul(phase)
                .mul(float(0.54).add(crown.mul(0.46))).mul(edgeLight).mul(1.90);
              const radiance = ambient.add(direct).mul(float(0.86).add(viewDepth.mul(0.10)));
              const opticalDepth = density.mul(fineStep).mul(CLOUD_EXTINCTION);
              const segmentTransmittance = exp(opticalDepth.negate());
              const segmentAlpha = oneMinus(segmentTransmittance);
              const segmentScatter = transmittance.mul(segmentAlpha).mul(radiance);
              // Equivalent transport form retained for review tooling:
              // scattered.addAssign(transmittance.mul(segmentAlpha).mul(radiance));
              scattered.addAssign(segmentScatter);
              if (hasMarchState) {
                const segmentWeight = segmentScatter
                  .dot(vec3(0.2126, 0.7152, 0.0722)).max(0);
                scatterDistanceWeight.addAssign(segmentWeight.mul(sampleDistance));
                scatterWeight.addAssign(segmentWeight);
              }
              transmittance.mulAssign(segmentTransmittance);
          });
          sampleDistance.addAssign(potentialCloud.select(fineStep, coarseStep));
        });
      });
      // Fade both terms together near the finite horizon gate. Returning the
      // actual layer transmittance (rather than opacity) keeps composition
      // associative with scene color and makes temporal rejection physical.
      const cloudTransmittance = mix(1, transmittance, horizonMask);
      const cloudScatter = scattered.mul(horizonMask);
      if (hasMarchState) {
        const fallbackDistance = rayEntry.add(rayLength.mul(0.5));
        const resolvedRepresentativeDistance = scatterWeight.greaterThan(0.00001)
          .select(scatterDistanceWeight.div(scatterWeight), fallbackDistance)
          .clamp(rayEntry, safeRayExitForMarch);
        representativeDistance.assign(resolvedRepresentativeDistance);
      }
      return vec4(cloudScatter, cloudTransmittance);
    })();
  }

  // Compatibility wrapper for direct sky/background callers.
  radianceForRay(direction, cameraOrigin, pixel = screenCoordinate.xy.floor()) {
    const sky = this.skyRadiance(direction.normalize(), { includeSun: true });
    const transport = this.cloudTransportForRay(direction, cameraOrigin, pixel);
    return vec4(sky.mul(transport.a).add(transport.rgb), oneMinus(transport.a));
  }

  dispose() {
    this._disposed = true;
    // WebGPURenderer's Background module owns a hidden SphereGeometry/NodeMaterial
    // for every Scene that renders one of these root nodes. It subscribes to the
    // root Node's documented `dispose` event to release those resources. Merely
    // dropping our references leaves the renderer-side sky sphere resident across
    // authored environment rebuilds (and PMREM capture scenes), so explicitly end
    // the lifetime of each distinct root before releasing the textures below.
    const backgroundRoots = new Set([
      this.clearBackgroundNode,
      this.iblBackgroundNode,
      this.backgroundNode,
    ]);
    for (const root of backgroundRoots) root?.dispose?.();
    this.clearBackgroundNode = null;
    this.iblBackgroundNode = null;
    this.backgroundNode = null;
    this.outputNode = null;
    this._cloudVolumeInit?.dispose();
    this._cloudVolumeInit = null;
    this._cloudVolume?.dispose();
    this._cloudVolume = null;
    this.skyTexture?.dispose();
    this.skyTexture = null;
    this.skyTextureLoaded = false;
  }
}
