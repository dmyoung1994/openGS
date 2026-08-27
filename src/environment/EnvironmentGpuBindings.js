import { Vector3, Vector4 } from 'three';
import {
  exp, float, mix, oneMinus, smoothstep, uniform, vec3,
} from 'three/tsl';
import { ENVIRONMENT_GPU_UNIFORM_FLOATS } from './EnvironmentFrameState.js';

// Typed bridge from the authoritative EnvironmentFrameState snapshot to TSL.
// Rendering never invents its own wind clock or gust phase: current and previous
// uniforms are copied from the same fixed-tick state used by ball physics.
export class EnvironmentGpuBindings {
  constructor(state) {
    if (!state?.currentGpuUniforms || state.currentGpuUniforms.data.length !== ENVIRONMENT_GPU_UNIFORM_FLOATS) {
      throw new Error('EnvironmentGpuBindings requires a valid EnvironmentFrameState.');
    }
    this.time = uniform(0);
    this.previousTime = uniform(0);
    this.sunDirection = uniform(new Vector3());
    this.sunIntensity = uniform(0);
    this.sunIlluminanceScale = uniform(1);
    this.sunColor = uniform(new Vector3(1, 1, 1));
    this.atmosphereExposure = uniform(1);
    this.horizonColor = uniform(new Vector3(0.58, 0.72, 0.92));
    this.zenithColor = uniform(new Vector3(0.10, 0.32, 0.72));
    this.baseWind = uniform(new Vector3());
    this.windProfile = uniform(new Vector4());
    this.coefficientA = uniform(new Vector4());
    this.coefficientB = uniform(new Vector4());
    this.coefficientC = uniform(new Vector4());
    this.coefficientD = uniform(new Vector4());
    this.clouds = uniform(new Vector4());
    this.cloudAdvectionScale = uniform(0);
    this.atmosphere = uniform(new Vector4());
    this._gustSpatialUniform = uniform(state.config.wind.gustSpatialFrequency);
    this._gustTemporalUniform = uniform(state.config.wind.gustTemporalFrequency);
    this._changeListeners = new Set();
    this.daylightRevision = 0;
    this._daylightSignature = '';
    this._frameState = state;
    this.update(state);
  }

  update(state) {
    this._frameState = state;
    const snapshots = state.gpuUniformSnapshots();
    const current = snapshots.current.data;
    const previous = snapshots.previous.data;
    this.time.value = snapshots.current.time;
    this.previousTime.value = snapshots.previous.time;
    this.sunDirection.value.set(current[4], current[5], current[6]).normalize();
    this.sunIntensity.value = current[7];
    // Three's directional-light intensity is renderer-relative while the authored
    // state records physical outdoor illuminance. Keep the conversion explicit and
    // shared so sun, sky, water, and relit impostors all respond to the same source.
    this.sunIlluminanceScale.value = current[7] / 85000;
    this.sunColor.value.set(current[8], current[9], current[10]);
    this.atmosphereExposure.value = current[11];
    this.baseWind.value.set(current[21], 0, current[22]);
    this.windProfile.value.set(current[24], current[25], current[26], current[27]);
    this.coefficientA.value.fromArray(current, 32);
    this.coefficientB.value.fromArray(current, 36);
    this.coefficientC.value.fromArray(current, 40);
    this.coefficientD.value.fromArray(current, 44);
    this.clouds.value.set(current[16], current[17], current[18], current[19]);
    this.cloudAdvectionScale.value = current[20];
    this.atmosphere.value.set(current[12], current[13], current[14], current[15]);
    this._updateDaylightPalette(current);
    this._gustSpatialUniform.value = state.config.wind.gustSpatialFrequency;
    this._gustTemporalUniform.value = state.config.wind.gustTemporalFrequency;
    const signature = Array.from(current.slice(4, 16)).join(':');
    if (signature !== this._daylightSignature) {
      this._daylightSignature = signature;
      this.daylightRevision += 1;
    }
    for (const listener of this._changeListeners) listener(this);
    return this;
  }

  sampleWindCpu(position, time = this.time.value, out = { x: 0, y: 0, z: 0 }) {
    return this._frameState.sampleWind(position, time, out);
  }

  _updateDaylightPalette(current) {
    const elevation = Math.max(0, Math.min(1, current[5]));
    const turbidity = Math.max(0, Math.min(1, (current[12] - 1) / 9));
    // Keep the authored sun chromaticity in the atmosphere, but only let a
    // bounded fraction tint the shared sky/IBL palette. Feeding the full warm
    // source colour into horizon radiance made the PMREM bounce cyan-green on
    // foliage and drove bark toward pale mint under the production exposure.
    const lowSunWarmth = ((1 - elevation) * 0.16 + turbidity * 0.10) * 0.62;
    const sr = current[8], sg = current[9], sb = current[10];
    const horizon = this.horizonColor.value;
    // Keep a real atmospheric value hierarchy: the low sky is brighter and less
    // saturated than the zenith, but it must not collapse into the same pale blue
    // after tone mapping. The stronger red/green floor is deliberate horizon scattering;
    // the blue channel remains below the highlight headroom used by the shared PMREM.
    // BACKDROP_PLAN Phase 1 vibe pass: a broadcast-range sky, not a flat
    // overcast sheet. The horizon keeps a real blue channel so the shared fog
    // (coloured from the same uniform) reads as aerial perspective rather
    // than grey wash, and the zenith deepens enough to retain hue at the
    // shared Neutral 1.20 reference exposure without entering its shoulder.
    horizon.set(
      0.29 * (1 - lowSunWarmth) + sr * lowSunWarmth,
      0.48 * (1 - lowSunWarmth) + sg * lowSunWarmth,
      0.78 * (1 - lowSunWarmth) + sb * lowSunWarmth,
    );
    const zenith = this.zenithColor.value;
    const zenithWarmth = lowSunWarmth * 0.18;
    zenith.set(
      0.004 * (1 - zenithWarmth) + sr * zenithWarmth,
      0.052 * (1 - zenithWarmth) + sg * zenithWarmth,
      0.62 * (1 - zenithWarmth) + sb * zenithWarmth,
    );
  }

  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('EnvironmentGpuBindings.onChange requires a function.');
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  // One analytic clear-sky model shared by the visible atmosphere, PMREM capture,
  // reflective water, and runtime-relit distant assets. The returned node is HDR
  // linear radiance; exposure and output transforms remain renderer responsibilities.
  // `distance` is optional and lets callers apply the same horizon-aware aerial
  // perspective to a distant sample without inventing a second fog colour.
  skyRadiance(direction, { includeSun = true, distance = 0 } = {}) {
    const view = direction.normalize();
    const upward = view.y.max(0);
    const cosine = view.dot(this.sunDirection.normalize()).clamp(-1, 1);
    const rayleighPhase = cosine.mul(cosine).add(1).mul(0.0596831);
    const g = this.atmosphere.w;
    const mieDenominator = float(1).add(g.mul(g)).sub(g.mul(cosine).mul(2)).max(0.001).pow(1.5);
    const miePhase = oneMinus(g.mul(g)).div(mieDenominator).mul(0.0795775);
    // A spherical atmosphere has a much longer optical path near the horizon
    // than at the zenith. This bounded Chapman-style approximation keeps the
    // horizon from becoming a flat painted strip while avoiding a per-pixel
    // ray/sphere intersection. The clamp is intentional: grazing rays should
    // not overflow the HDR sky or turn into a black band at the screen edge.
    const horizonPath = float(1).div(view.y.abs().add(0.065)).clamp(1, 9).sqrt();
    const viewLength = oneMinus(upward.pow(0.35))
      .mul(this.atmosphere.x.mul(2.2).add(0.35)).mul(horizonPath).add(0.12);
    const rayleighExtinction = exp(vec3(5.802, 13.558, 33.1).mul(this.atmosphere.y).mul(viewLength).mul(-0.012));
    const mieExtinction = exp(vec3(1).mul(this.atmosphere.z).mul(viewLength).mul(-16));
    const transmittance = rayleighExtinction.mul(mieExtinction);
    const daylight = this.sunIlluminanceScale.max(0).pow(0.35);
    // Rayleigh scattering is strongly wavelength weighted.  The old artistic
    // 0.35/0.62/1.0 mix over-returned red and green into the same PMREM that
    // shades the course, so the previous filmic curve compressed the whole clear sky toward a flat
    // gray-blue and removed the value separation between zenith and horizon.
    // Keep the normalized 440/550/680 nm relationship explicit here: the same
    // source radiance feeds the visible sky and the PMREM capture, with no
    // second colour grade or counter-fill.
    const rayleighScatter = vec3(0.175, 0.410, 1.0)
      .mul(this.sunColor).mul(rayleighPhase).mul(this.atmosphere.y).mul(0.72);
    // Aerosol/Mie scattering is spectrally broad, so an over-energetic return
    // becomes a neutral veil over both the sky and the PMREM. Keep the authored
    // turbidity response, but calibrate the reference coefficient to the same
    // 85 klux daylight scale used by the directional key.
    const mieScatter = this.sunColor.mul(miePhase).mul(this.atmosphere.z.mul(90));
    const horizonWarmth = oneMinus(upward.pow(0.45));
    // BACKDROP_PLAN Phase 1: golfer-height cameras see at most ~20 degrees of
    // elevation, so the gradient must reach a saturated blue well below the
    // zenith or every fixed camera photographs only the pale horizon band.
    // The transmittance term darkens instead of replacing the base gradient,
    // which is what left the former 0.72/0.28 mix reading as flat grey wash.
    const clearDay = mix(this.horizonColor, this.zenithColor, upward.pow(0.42));
    let sky = clearDay.mul(transmittance.mul(0.50).add(0.50));
    // Keep the upper sky saturated enough to frame the green course while
    // leaving highlight headroom for the solar disc and cloud silver lining.
    // Preserve the authored atmospheric scattering shape while keeping the
    // clear-day response below the tone-map shoulder. This is the same radiance
    // consumed by the visible sky and by the PMREM capture below.
    // Scattering is still analytic and shared with the PMREM, but it is a lift
    // over the base gradient rather than the whole visible sky.  The prior
    // coefficients overwhelmed the authored zenith/horizon separation under
    // the previous filmic curve and returned a uniformly pale fill to matte turf.
    sky = sky.add(rayleighScatter.mul(1.70)).add(mieScatter.mul(0.90));
    sky = sky.add(this.horizonColor.mul(horizonWarmth).mul(this.atmosphere.x.mul(0.025)));
    sky = sky.mul(daylight);
    if (includeSun) {
      const sunDisc = smoothstep(0.99988, 0.99996, cosine).mul(450);
      // The aureole is forward-scattered sunlight from the last few hundred metres
      // of air, so it must decay within a couple of degrees of the disc. A single
      // wide lobe at 5.5x sky radiance clipped everything inside ~10 degrees of the
      // sun to flat white: a hard-edged painted orb roughly half the vertical
      // frame, which erased the disc, the gradient, and any cloud/ridge silhouette
      // that crossed it. Split it into a tight bright core plus a broad skirt that
      // stays below the tone-map shoulder, so glare reads as atmosphere, not a decal.
      const sunAureole = smoothstep(0.9985, 0.99993, cosine).pow(3).mul(2.6);
      const sunGlare = smoothstep(0.955, 0.9985, cosine).pow(3).mul(0.30);
      sky = sky.add(this.sunColor.mul(sunDisc.add(sunAureole).add(sunGlare))
        .mul(transmittance).mul(this.sunIlluminanceScale));
    }
    const path = typeof distance === 'number' ? float(Math.max(0, distance)) : distance;
    if (path?.isNode) {
      // Distance fog is deliberately chromatic and horizon-weighted. It is an
      // aerial perspective term, not a post-process grey veil: preserve the
      // authored sky chromaticity as the path approaches the horizon.
      const distanceDensity = path.max(0).mul(this.atmosphere.x.mul(0.00006).add(0.000008));
      const distanceTransmittance = exp(distanceDensity.negate());
      return sky.mul(distanceTransmittance)
        .add(this.horizonColor.mul(oneMinus(distanceTransmittance)));
    }
    return sky;
  }

  // Apply the same aerial-perspective response to a linear HDR material sample.
  // Keeping this helper next to skyRadiance prevents water, distant props, and
  // the sky from drifting into separate art-directed haze models.
  aerialPerspective(radiance, direction, distance) {
    if (!radiance?.isNode || !direction?.isNode || !Number.isFinite(distance) && !distance?.isNode) {
      throw new TypeError('EnvironmentGpuBindings.aerialPerspective requires TSL radiance, direction, and distance.');
    }
    const view = direction.normalize();
    const horizon = oneMinus(view.y.abs().clamp(0, 1)).pow(0.6);
    const density = (typeof distance === 'number' ? float(Math.max(0, distance)) : distance.max(0))
      .mul(this.atmosphere.x.mul(0.00006).add(0.000008)).mul(horizon.mul(0.75).add(0.25));
    const transmittance = exp(density.negate());
    return radiance.mul(transmittance).add(this.horizonColor.mul(oneMinus(transmittance)));
  }

  // TSL equivalent of EnvironmentFrameState.sampleWind(). Coefficients and
  // parameter layout are shared byte-for-byte through the uniform snapshot.
  windAt(position, time = this.time) {
    const profile = this.windProfile;
    const temporal = this._gustTemporalUniform;
    const spatialUniform = this._gustSpatialUniform;
    const phase = (coefficient, spatialScale, temporalScale) => position.dot(coefficient.xyz)
      .mul(spatialUniform.mul(spatialScale)).add(time.mul(temporal.mul(temporalScale))).add(coefficient.w);
    const pa = phase(this.coefficientA, 1.0, 1.0);
    const pb = phase(this.coefficientB, 1.73, -0.61);
    const pc = phase(this.coefficientC, 2.41, 1.37);
    const gust = pa.sin().add(pb.sin().mul(0.5)).add(pc.sin().mul(0.25)).div(1.75);
    const shear = position.y.max(0.1).div(profile.x).pow(profile.y);
    const baseScale = shear.mul(float(1.0).add(profile.z.mul(gust)));
    const d = this.coefficientD;
    const turbulence = vec3(
      pb.add(d.w).sin().mul(d.x).add(pc.cos().mul(this.coefficientC.x).mul(0.5)),
      pc.add(this.coefficientA.w).sin().mul(d.y).add(pa.cos().mul(this.coefficientB.y).mul(0.5)).mul(0.25),
      pa.add(this.coefficientB.w).sin().mul(d.z).add(pb.cos().mul(this.coefficientA.z).mul(0.5)),
    ).mul(profile.w);
    return this.baseWind.mul(baseScale).add(turbulence);
  }

}
