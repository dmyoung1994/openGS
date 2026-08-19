import { EquirectangularReflectionMapping, Vector2 } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
  cameraPosition, exp, float, max, mix, mx_noise_float, mx_worley_noise_float, oneMinus,
  equirectUV, positionWorldDirection, smoothstep, texture as textureNode, uniform, vec2, vec3,
} from 'three/tsl';
import { EnvironmentGpuBindings } from '../environment/EnvironmentGpuBindings.js';

// Analytic daylight atmosphere plus a bounded direct sky-fragment cloud layer.
// The sun, wind and cloud density come from the authoritative environment bridge.
// Clouds are evaluated directly against the existing sky background node: no
// volume target, 3D noise bake, temporal resolve, or extra render pass is needed.
//
// The cloud model follows Schneider & Vos, "The Real-time Volumetric Cloudscapes of
// Horizon: Zero Dawn" (SIGGRAPH 2015 Advances in Real-Time Rendering), reduced from a
// 128-step volume raymarch to a single slab sample plus a short sun march. What is kept
// is the part that decides whether clouds read as cumulus at all:
//   * Perlin-Worley base shape. Inverted Worley noise makes the tightly packed billows;
//     Perlin fBm alone produces wispy cirrus, which is why a pure mx_noise_float layer
//     looks flat no matter how it is graded. Worley dilates Perlin so the result keeps
//     Perlin's connectedness and gains billowy lobes.
//   * A height gradient over the slab, with density reduced at the base so bottoms are
//     wispy, and high-frequency Worley erosion applied inward from the cloud edge.
//   * Lighting = Beer's law x Henyey-Greenstein phase x the "powdered sugar" in-scatter
//     term that produces dark edges facing the light. HG is the same formula the shared
//     atmosphere already uses for Mie phase in EnvironmentGpuBindings.skyRadiance.
// Beer's two-lobe form max(exp(-d), 0.7*exp(-0.25d)) and the dual-g phase (0.6 primary,
// ~0.99 silver-lining lobe) follow the widely reproduced reference implementation of
// that talk.

const MIN_RAY_STEPS = 4;
const MAX_RAY_STEPS = 32;
const MIN_SUN_STEPS = 2;
const MAX_SUN_STEPS = 12;
const MIN_NOISE_OCTAVES = 2;
const MAX_NOISE_OCTAVES = 4;
const MIN_INTERNAL_SCALE = 0.125;
const MAX_INTERNAL_SCALE = 1;

function fail(message) {
  throw new TypeError(`Invalid WeatherSky workload: ${message}`);
}

function finite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function positiveInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}].`);
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

  // Every tier compiles the same atmosphere/cloud features.  These are workload
  // constants only: ray/sample count and internal-resolution policy may differ,
  // but never select another renderer, background type, asset, or shader path.
  return Object.freeze({
    id: workload.id,
    internalScale: finite(workload.internalScale, 'internalScale', MIN_INTERNAL_SCALE, MAX_INTERNAL_SCALE),
    raySteps: positiveInteger(workload.raySteps, 'raySteps', MIN_RAY_STEPS, MAX_RAY_STEPS),
    sunTransmittanceSteps: positiveInteger(workload.sunTransmittanceSteps, 'sunTransmittanceSteps', MIN_SUN_STEPS, MAX_SUN_STEPS),
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

// The Perlin-Worley dilation produces a signal concentrated in a narrow band rather
// than spanning 0..1. These bounds expand that working band so authored coverage maps
// onto the field's real distribution; they are properties of the noise construction
// above, not art direction, and must be rechecked if the octave counts change.
// Measured by thresholding the field on the GPU and counting the white fraction (the
// only readable measurement, since ACES makes raw greyscale values meaningless): the
// dilated signal sits at ~0.688 with a standard deviation of only ~0.024. Averaging a
// handful of fBm octaves concentrates hard around the mean, so the raw field spans a
// band roughly 0.12 wide - nothing like 0..1. These bounds are +/-2.5 sigma about that
// measured mean. Re-measure them if the octave counts or the dilation change.
const WORKING_BAND_MIN = 0.628;
const WORKING_BAND_MAX = 0.748;

// Schneider's remap: rebase a signal from one range onto another. Used both to dilate
// Perlin by Worley and to apply coverage/erosion as range compressions rather than
// multiplications, which is what keeps cloud edges from turning into hard cutouts.
function remap(value, oldMin, oldMax, newMin, newMax) {
  const lo = float(oldMin);
  return float(newMin).add(
    value.sub(lo).div(float(oldMax).sub(lo)).mul(float(newMax).sub(float(newMin))),
  );
}

// Henyey-Greenstein phase, p(t) = (1 - g^2) / (4pi * (1 + g^2 - 2g*cos(t))^1.5).
// Identical in form to the Mie phase already used by the shared atmosphere; clouds
// simply run it at a much stronger forward eccentricity.
function henyeyGreenstein(cosine, g) {
  const gg = g * g;
  return float(1 - gg).div(float(1 + gg).sub(cosine.mul(2 * g)).max(0.0001).pow(1.5)).mul(0.0795775);
}

// One predicate for "is there authored weather in the sky". SceneManager uses it to
// decide whether a coverage change needs a new node graph; WeatherSky uses it to decide
// whether to compile the cloud grade at all. Keeping them on the same function is what
// makes an in-range coverage drag provably free of a rebuild.
export function cloudsAreEnabled(clouds) {
  return clouds.x > 0.0001 && clouds.y > 0.0001;
}

// Values are deliberately fixed, exported workload policies rather than quality
// toggles. Integration assigns internalScale only when authored cloud coverage is
// present; clear weather uses the shared verified sky directly.
export const WEATHER_SKY_WORKLOADS = Object.freeze({
  // The volume is quarter-resolution on the high tier. Four midpoint samples
  // and one sunward sample preserve broad billows and a coherent silver lining;
  // cloud shadowing is optional at this scale, so a second shadow sample would
  // spend the saved budget without changing the authored silhouette.
  high: Object.freeze({ id: 'high', internalScale: 0.14, raySteps: 5, sunTransmittanceSteps: 2, noiseOctaves: 3, jitterPeriod: 32 }),
  balanced: Object.freeze({ id: 'balanced', internalScale: 0.22, raySteps: 6, sunTransmittanceSteps: 3, noiseOctaves: 2, jitterPeriod: 32 }),
  conservative: Object.freeze({ id: 'conservative', internalScale: 0.18, raySteps: 5, sunTransmittanceSteps: 2, noiseOctaves: 2, jitterPeriod: 32 }),
});

/**
 * Strict WebGPU/TSL sky node.  Assign `sky.backgroundNode` to `scene.backgroundNode`.
 * `setTemporalFrame()` must be called once for every presented frame before the
 * scene pass.  It supplies stable current/previous low-discrepancy phases for
 * future cloud temporal resolve without creating a second simulation clock.
 */
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
    // Coverage is authored in the immutable environment frame. Clear weather
    // keeps the exact shared sky-radiance node; covered weather adds the direct
    // cloud grade to that same node without allocating a target or compute job.
    this.cloudsEnabled = cloudsAreEnabled(environment.clouds.value);
    this.usesVolumetricClouds = false;
    this.usesAnalyticClouds = this.cloudsEnabled;
    this.currentJitter = uniform(new Vector2(0, 0));
    this.previousJitter = uniform(new Vector2(0, 0));
    this.temporalFrame = 0;
    this.setTemporalFrame(0);

    this.noiseVolume = null;
    this._noiseInitCompute = null;
    this._noiseDiagnostics = Object.freeze({ enabled: false, sampleCount: 0, minimum: 0,
      maximum: 0, mean: 0, nonZeroFraction: 0 });
    // A stable cloud-free capture source for the scene PMREM. Visible clouds, when
    // authored, do not force an expensive environment recapture or bake temporal
    // noise into every PBR reflection.
    this.skyTexture = null;
    this.skyTextureLoaded = false;
    this._disposed = false;
    this.skyTextureReady = this._loadSkyTexture();
    this.ready = Promise.all([this.skyTextureReady, Promise.resolve(this._noiseDiagnostics)])
      .then(([, diagnostics]) => diagnostics);
    // IBL deliberately omits the measured solar disc. The authoritative
    // DirectionalLight owns direct sun/shadows; keeping the HDR disc in the
    // PMREM would add a second unshadowed key (the 1K source concentrates much
    // of its energy in only a few pixels). The visible background replaces it
    // with the single authoritative analytic sun contribution.
    this.iblBackgroundNode = this._buildSkyRadianceNode({ includeSun: false });
    this.backgroundNode = this._buildBackgroundNode();
    // Alias makes the intended Scene.backgroundNode integration explicit.
    this.outputNode = this.backgroundNode;
  }

  _loadSkyTexture() {
    if (!this.skyManifest) return Promise.resolve(null);
    const loader = new HDRLoader();
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.skyTexture = loader.load(this.skyManifest.url, (loadedTexture) => {
      // Use the callback handle, not this.skyTexture: dispose() intentionally
      // clears the owner before an in-flight decode can finish. This also makes
      // a stale callback harmless if a weather reconfigure replaced the sky.
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

  // Public direction-parametric source for reflective materials. With a verified
  // manifest this is the exact yaw-correct HDR lookup used by the visible sky and
  // PMREM; without one it fails over only to the shared analytic environment.
  // Keeping this on WeatherSky prevents water/materials from inventing a second
  // atmosphere or sampling a stale render target.
  skyRadiance(direction, { includeSun = false } = {}) {
    if (!direction?.isNode) throw new TypeError('WeatherSky.skyRadiance requires a TSL direction node.');
    const normalized = direction.normalize();
    if (!this.skyManifest || !this.skyTexture) {
      return this.environment.skyRadiance(normalized, { includeSun });
    }
    const angle = this.skyManifest.rotationRadians;
    const c = Math.cos(angle); const s = Math.sin(angle);
    // The world-to-source inverse matches the manifest's source->world yaw
    // convention; keeping this sign pair identical is the visible/IBL yaw
    // contract rather than an arbitrary texture UV rotation.
    const rotated = vec3(
      normalized.x.mul(c).add(normalized.z.mul(s)),
      normalized.y,
      normalized.z.mul(c).sub(normalized.x.mul(s)),
    );
    const hdr = textureNode(this.skyTexture, equirectUV(rotated));
    // Suppress the measured source-space solar disc before PMREM/water sampling.
    // Its elevation differs from the authoritative sun, so a world-space mask
    // would leave the six-pixel high-energy core unshadowed after yaw rotation.
    const sourceSun = vec3(...this.skyManifest.sourceSunDirection);
    const sourceAlignment = rotated.dot(sourceSun).clamp(-1, 1);
    const directMask = smoothstep(Math.cos(5 * Math.PI / 180), Math.cos(1 * Math.PI / 180), sourceAlignment);
    const clearSky = this.environment.skyRadiance(normalized, { includeSun: false });
    const skyWithoutMeasuredSun = mix(hdr, clearSky, directMask);
    if (!includeSun) return skyWithoutMeasuredSun;
    // The visible background receives only the authoritative analytic sun delta;
    // DirectionalLight remains the sole shadow-casting direct-light source.
    return skyWithoutMeasuredSun.add(this.environment.skyRadiance(normalized, { includeSun: true }).sub(clearSky));
  }

  async readDiagnostics() {
    await this.ready;
    return this._noiseDiagnostics;
  }

  setTemporalFrame(frame) {
    const current = jitterForFrame(frame, this.workload.jitterPeriod);
    const previous = jitterForFrame(frame === 0 ? 0 : frame - 1, this.workload.jitterPeriod);
    this.currentJitter.value.set(current.x, current.y);
    this.previousJitter.value.set(previous.x, previous.y);
    this.temporalFrame = frame;
    return this;
  }

  // Explicit hook for a renderer that owns a global temporal sequence.  Both
  // values are validated and copied; callers cannot mutate our temporal state.
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

  _fbm2(position, octaves = this.workload.noiseOctaves) {
    const warp = mx_noise_float(vec3(position, 19.7)).sub(0.5).mul(0.20);
    const warpedPosition = position.add(vec2(warp, warp.mul(0.73)));
    let frequency = 1;
    let amplitude = 0.5;
    let sum = float(0);
    let normalizer = 0;
    for (let octave = 0; octave < octaves; octave++) {
      const p = warpedPosition.mul(frequency);
      const n = mx_noise_float(vec3(
        p.x.add(p.y.mul(0.17)), p.y.sub(p.x.mul(0.11)), 31.0 + octave * 17.3,
      )).mul(0.5).add(0.5);
      sum = sum.add(n.mul(amplitude));
      normalizer += amplitude;
      frequency *= 2.04;
      amplitude *= 0.5;
    }
    return sum.div(normalizer);
  }

  // The wind field itself advects the layer. It is sampled at the cloud point, so
  // grass, tree, cloud, water, and ball motion share gust direction and phase
  // instead of five unrelated "wind" animations.
  _cloudCoordinates(worldPosition, time, wind = null, advectionTime = null) {
    // The view ray samples the authoritative wind field once. Sun-light samples share
    // that local gust vector: light transport is through the same cloud parcel, and
    // re-evaluating the three-phase gust field at every shadow sample only adds
    // trigonometry without changing the visible cloud shape. Direct callers still get
    // the full environment wind evaluation.
    const localWind = wind ?? this.environment.windAt(worldPosition, time);
    const localAdvectionTime = advectionTime ?? time.mul(this.environment.cloudAdvectionScale);
    const advected = worldPosition.sub(localWind.mul(localAdvectionTime));
    return vec2(advected.x.mul(0.00072), advected.z.mul(0.00072));
  }

  // Inverted Worley fBm. Inversion is the whole point: Worley's distance field peaks at
  // cell centres, so 1 - worley gives the tightly packed rounded lobes that read as
  // cumulus. This is the term Perlin fBm cannot produce.
  _billowFbm(coordinates, octaves) {
    let frequency = 1;
    let amplitude = 0.625;
    let sum = float(0);
    let normalizer = 0;
    for (let octave = 0; octave < octaves; octave++) {
      // three's mx_worley_noise_float wrapper hardcodes metric = 1, which is the branch
      // that skips the sqrt: it returns SQUARED distance. Squared cell distances are
      // small, so inverting them directly yields a washed field pinned near 0.9 with
      // almost no range. Take the root first to recover true distance before inverting.
      const cell = mx_worley_noise_float(coordinates.mul(frequency), 1).max(0).sqrt();
      sum = sum.add(oneMinus(cell).mul(amplitude));
      normalizer += amplitude;
      frequency *= 2.9;
      amplitude *= 0.5;
    }
    return sum.div(normalizer).clamp(0, 1);
  }

  // The broad 0..1 mass signal, before coverage thresholding or slab confinement.
  // Shared by the visible density and by the slab-relief displacement, so the top
  // surface undulates in step with the masses that sit on it rather than independently.
  _cloudShapeSignal(coordinates, octaves = this.workload.noiseOctaves) {
    const perlin = this._fbm2(coordinates, octaves);
    const billow = this._billowFbm(coordinates, 2);
    // Perlin-Worley: dilate Perlin by the inverted-Worley fBm. Remapping Perlin's range
    // from [billow - 1, 1] up to [0, 1] lifts its low end wherever a billow sits, so the
    // field keeps Perlin's connected masses but acquires Worley's rounded lobes.
    const perlinWorley = remap(perlin, billow.sub(1), 1, 0, 1).clamp(0, 1);
    // The dilation leaves a signal centred near 0.63 in a narrow band, not a clean 0..1.
    // Coverage below is a range compression against a [0,1] field, so without this
    // renormalisation the coverage threshold sits outside the signal entirely and the
    // layer collapses to nothing. Expanding the working band is what makes the authored
    // coverage number mean "fraction of sky covered".
    return remap(perlinWorley, WORKING_BAND_MIN, WORKING_BAND_MAX, 0, 1).clamp(0, 1);
  }

  // A cumulus height gradient over the slab: density builds quickly off the base, holds
  // through the body, and rounds off at the top. Schneider additionally reduces density
  // at the bottoms so undersides stay wispy rather than ending on a flat cut.
  _heightGradient(normalizedHeight) {
    const h = normalizedHeight.clamp(0, 1);
    const base = smoothstep(0.0, 0.22, h);
    const top = oneMinus(smoothstep(0.55, 1.0, h));
    return base.mul(top).mul(remap(h, 0, 0.35, 0.62, 1).clamp(0.62, 1));
  }

  _cloudDensity(worldPosition, time, wind = null, advectionTime = null, octaves = this.workload.noiseOctaves, detail = true) {
    const clouds = this.environment.clouds;
    const coordinates = this._cloudCoordinates(worldPosition, time, wind, advectionTime);
    const normalizedHeight = worldPosition.y.sub(clouds.z).div(clouds.w.max(1));
    // Base shape = Perlin-Worley confined by the height gradient.
    const shape = this._cloudShapeSignal(coordinates, octaves).mul(this._heightGradient(normalizedHeight));
    // Coverage as a range compression rather than a threshold. remap(shape, 1-coverage,
    // 1, 0, 1) * coverage is Schneider's formulation: raising coverage both admits more
    // of the field and thickens what is already there, instead of only moving a cutoff.
    const coverage = clouds.x.clamp(0, 1);
    const covered = remap(shape, oneMinus(coverage), 1, 0, 1).clamp(0, 1).mul(coverage);
    if (!detail) return covered.mul(clouds.y);
    // High-frequency Worley erosion applied inward from the edge. Subtracting detail at
    // the boundary is what turns smooth blobs into cauliflower lobes; applying it as a
    // remap keeps interiors solid instead of drilling holes through the mass.
    const erosion = this._billowFbm(coordinates.mul(9.0), 2);
    return remap(covered, erosion.mul(0.38), 1, 0, 1).clamp(0, 1).mul(clouds.y);
  }

  _buildBackgroundNode() {
    const direction = positionWorldDirection.normalize();
    // Clear weather uses one analytic sky node directly in the main scene. This
    // keeps atmosphere and PMREM on the same source while removing a full-screen
    // cloud target and its resolve from the frame graph.
    if (!this.cloudsEnabled) return this._buildSkyRadianceNode({ includeSun: true });

    const sunDirection = this.environment.sunDirection.normalize();
    const clouds = this.environment.clouds;
    // The clear-air portion is not independently authored here. It is the same
    // linear-HDR function used to bake the PBR environment and shade water/assets.
    const sky = this._buildSkyRadianceNode({ includeSun: true });

    const time = this.environment.time;
    const slabThickness = clouds.w.max(1);
    const meanY = clouds.z.add(slabThickness.mul(0.48));
    // The `.max(0.10)` is a singularity guard, not a look: below it every ray lands at
    // the same slab distance, so the noise field is sampled along one degenerate line
    // and smears horizontally. `horizonMask` below reaches zero exactly where it engages.
    const intersectSlab = (planeY) => cameraPosition
      .add(direction.mul(planeY.sub(cameraPosition.y).div(direction.y.max(0.10))));

    // A single flat plane is what made this layer read as a painted decal: with a fixed
    // `meanY`, the intersection resolves to `cloudPosition.y === meanY` for *every* ray
    // above the clamp, so cloud altitude was the compile-time constant 0.48 and every
    // altitude-driven term below silently evaluated to the same number everywhere.
    // Displacing the top surface by the same mass signal that forms the clouds gives the
    // layer a real, varying height, which is what the shading terms need to bite on.
    const relief = this._cloudShapeSignal(this._cloudCoordinates(intersectSlab(meanY), time))
      .sub(0.5);
    const cloudPosition = intersectSlab(meanY.add(relief.mul(slabThickness.mul(0.9))));

    // One wind/advection evaluation is shared by the view sample and every sun-march
    // sample: light transports through the same parcel, so re-running the three-phase
    // gust field per shadow tap would only add trigonometry.
    const localWind = this.environment.windAt(cloudPosition, time);
    const advectionTime = time.mul(this.environment.cloudAdvectionScale);
    const cloudDensity = this._cloudDensity(cloudPosition, time, localWind, advectionTime);

    // Optical depth toward the sun. Marching through the slab and attenuating is what
    // produces a bright crown over a shadowed base; a projected noise plane has no
    // interior, so without this it stays flat under any colour grade. The march reaches
    // roughly two slab thicknesses so it crosses into neighbouring masses rather than
    // resampling the same parcel, and its taps drop detail because occlusion needs the
    // broad mass, not the erosion. `sunTransmittanceSteps` is the tier's existing budget.
    const shadowSteps = this.workload.sunTransmittanceSteps;
    const shadowStep = sunDirection.mul(slabThickness.mul(2.2 / shadowSteps));
    let opticalDepth = float(0);
    for (let step = 0; step < shadowSteps; step++) {
      opticalDepth = opticalDepth.add(this._cloudDensity(
        cloudPosition.add(shadowStep.mul(step + 0.5)), time, localWind, advectionTime,
        MIN_NOISE_OCTAVES, false,
      ));
    }
    opticalDepth = opticalDepth.mul(4.2 / shadowSteps);

    const sunAlignment = direction.dot(sunDirection).clamp(-1, 1);
    const cloudAltitude = cloudPosition.y.sub(clouds.z).div(slabThickness).clamp(0, 1);

    // Beer's law, in the two-lobe form: the second lobe keeps a floor under deep cores
    // so they read as dense grey rather than collapsing to black.
    const beer = max(exp(opticalDepth.negate()), exp(opticalDepth.mul(-0.25)).mul(0.7));
    // Dual-lobe Henyey-Greenstein: a broad forward lobe for general brightening toward
    // the sun, and a tight one for the silver lining on edges crossing the disc.
    const phase = max(henyeyGreenstein(sunAlignment, 0.6), henyeyGreenstein(sunAlignment, 0.94).mul(0.7))
      .mul(4.2).clamp(0.35, 2.4);
    // The powdered-sugar term: crevices and thick interiors collect more in-scattered
    // light than edges facing the light, so edges read dark. It is view dependent -
    // only visible looking away from the sun - hence the sunAlignment blend.
    const powder = oneMinus(exp(cloudDensity.mul(-9.0)));
    const powderView = mix(powder, float(1), sunAlignment.mul(0.5).add(0.5));

    const sunlight = beer.mul(phase).mul(powderView);
    // Ambient is sky radiance from straight up, so the shadowed side is lit by the same
    // atmosphere as everything else rather than by an invented fill colour. Height
    // weighting keeps undersides darker than crowns.
    const ambient = this.environment.skyRadiance(vec3(0, 1, 0), { includeSun: false })
      .mul(cloudAltitude.mul(0.55).add(0.45)).mul(0.55);
    const cloudLight = this.environment.sunColor.mul(sunlight)
      .mul(this.environment.sunIlluminanceScale.max(0).pow(0.35))
      .add(ambient);

    // Clouds exist only above the degenerate projection band: zero below ~5.7 degrees
    // of elevation, full by ~17. This is what keeps the skyline clean instead of banded.
    const horizonMask = smoothstep(0.10, 0.30, direction.y)
      .mul(direction.y.max(0).sqrt().mul(0.48).add(0.52));
    // A straight linear density read flat-tops into opaque white islands. The exponent
    // keeps thin edges thin; the cap is higher than the old 0.56 because the shaded
    // base now carries the form, so opacity no longer has to be suppressed to hide it.
    const cloudAlpha = cloudDensity.pow(1.25).mul(horizonMask).mul(0.94).clamp(0, 0.82);
    return mix(sky, cloudLight, cloudAlpha);
  }

  dispose() {
    this._disposed = true;
    this.skyTexture?.dispose();
    this.skyTexture = null;
    this.skyTextureLoaded = false;
  }
}
