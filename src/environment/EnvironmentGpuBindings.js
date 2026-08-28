import {
  ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader,
  Vector3, Vector4,
} from 'three';
import {
  exp, float, mix, oneMinus, smoothstep, texture, uniform, vec2, vec3,
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
    this.moonDirection = uniform(new Vector3(0, -1, 0));
    this.moonIlluminanceScale = uniform(0);
    this.moonColor = uniform(new Vector3(0.78, 0.84, 1));
    this.moonIlluminatedFraction = uniform(0);
    this.moonAngularRadius = uniform(0.0045);
    this.moonAlbedoMap = new Texture();
    this.moonTextureReady = Promise.resolve(this.moonAlbedoMap);
    if (typeof document !== 'undefined') {
      this.moonTextureReady = new Promise((resolve, reject) => {
        this.moonAlbedoMap = new TextureLoader().load(
          '/assets/textures/moon_lroc_color_2k.jpg',
          resolve,
          undefined,
          (error) => reject(new Error(`NASA LRO Moon texture failed to load: ${error?.message ?? error}`)),
        );
      });
    }
    this.moonAlbedoMap.name = 'NASA LRO WAC lunar albedo 2K';
    this.moonAlbedoMap.colorSpace = SRGBColorSpace;
    this.moonAlbedoMap.wrapS = RepeatWrapping;
    this.moonAlbedoMap.wrapT = ClampToEdgeWrapping;
    this.celestialExposure = uniform(1);
    this.keyDirection = uniform(new Vector3(0, 1, 0));
    this.keyIlluminanceScale = uniform(1);
    this.keyColor = uniform(new Vector3(1, 1, 1));
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
    this.moonDirection.value.set(current[48], current[49], current[50]).normalize();
    this.moonIlluminanceScale.value = current[51] / 0.25;
    this.moonColor.value.set(current[52], current[53], current[54]);
    this.moonIlluminatedFraction.value = current[55];
    this.moonAngularRadius.value = current[56];
    const solarStrength = Math.max(0, this.sunIlluminanceScale.value);
    const lunarStrength = Math.max(0, this.moonIlluminanceScale.value) * 0.18;
    if (lunarStrength > solarStrength) {
      this.keyDirection.value.copy(this.moonDirection.value);
      this.keyColor.value.copy(this.moonColor.value);
      this.keyIlluminanceScale.value = lunarStrength;
    } else {
      this.keyDirection.value.copy(this.sunDirection.value);
      this.keyColor.value.copy(this.sunColor.value);
      this.keyIlluminanceScale.value = solarStrength;
    }
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
    const signature = [
      ...current.slice(4, 16),
      ...current.slice(48, 58),
      this.celestialExposure.value,
    ].join(':');
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
    const elevation = Math.max(-1, Math.min(1, current[5]));
    const moonlight = Math.max(0, Math.min(1, current[51] / 0.25));
    const turbidity = Math.max(0, Math.min(1, (current[12] - 1) / 9));
    // Keep the authored sun chromaticity in the atmosphere, but only let a
    // bounded fraction tint the shared sky/IBL palette. Feeding the full warm
    // source colour into horizon radiance made the PMREM bounce cyan-green on
    // foliage and drove bark toward pale mint under the production exposure.
    const twilight = Math.max(0, Math.min(1, (elevation + 0.18) / 0.24));
    const lowSunWarmth = ((1 - Math.max(0, elevation)) * 0.16 + turbidity * 0.10) * 0.62 * twilight;
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
    const nightHorizon = { x: 0.004 + moonlight * 0.012, y: 0.008 + moonlight * 0.018, z: 0.024 + moonlight * 0.042 };
    const dayHorizon = {
      x: 0.29 * (1 - lowSunWarmth) + sr * lowSunWarmth,
      y: 0.48 * (1 - lowSunWarmth) + sg * lowSunWarmth,
      z: 0.78 * (1 - lowSunWarmth) + sb * lowSunWarmth,
    };
    horizon.set(
      nightHorizon.x + (dayHorizon.x - nightHorizon.x) * twilight,
      nightHorizon.y + (dayHorizon.y - nightHorizon.y) * twilight,
      nightHorizon.z + (dayHorizon.z - nightHorizon.z) * twilight,
    );
    const zenith = this.zenithColor.value;
    const zenithWarmth = lowSunWarmth * 0.18;
    const dayZenith = {
      x: 0.004 * (1 - zenithWarmth) + sr * zenithWarmth,
      y: 0.052 * (1 - zenithWarmth) + sg * zenithWarmth,
      z: 0.62 * (1 - zenithWarmth) + sb * zenithWarmth,
    };
    zenith.set(
      0.0010 + moonlight * 0.003 + (dayZenith.x - 0.0010 - moonlight * 0.003) * twilight,
      0.002 + moonlight * 0.005 + (dayZenith.y - 0.002 - moonlight * 0.005) * twilight,
      0.009 + moonlight * 0.024 + (dayZenith.z - 0.009 - moonlight * 0.024) * twilight,
    );
    // Bounded eye adaptation starts after the solar disc has cleared the horizon.
    // A separate, narrow golden-hour window lifts the playable foreground just
    // enough to retain turf/cloud detail without carrying that lift into daytime
    // or bleaching the warm horizon. Astronomical night still adapts independently.
    const adaptationT = Math.max(0, Math.min(1, (elevation + 0.18) / 0.16));
    const daylightAdaptation = adaptationT * adaptationT * (3 - 2 * adaptationT);
    const smoothWindow = (edge0, edge1, value) => {
      const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    const sunsetLift = smoothWindow(-0.05, 0.015, elevation)
      * (1 - smoothWindow(0.14, 0.30, elevation));
    this.celestialExposure.value = 1 + sunsetLift * 0.42
      + (1 - daylightAdaptation) * (3.2 + moonlight * 1.8);
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
    const moonlight = this.moonIlluminanceScale.max(0).pow(0.35);
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
    // Twilight persists after direct solar illuminance reaches zero. Below
    // astronomical twilight the moon and a restrained airglow floor own the sky.
    const twilight = smoothstep(-0.31, 0.035, this.sunDirection.y);
    sky = sky.mul(daylight.max(twilight.mul(0.12)));
    const moonCosine = view.dot(this.moonDirection.normalize()).clamp(-1, 1);
    const moonRayleighPhase = moonCosine.mul(moonCosine).add(1).mul(0.0596831);
    const moonMieDenominator = float(1).add(g.mul(g)).sub(g.mul(moonCosine).mul(2)).max(0.001).pow(1.5);
    const moonMiePhase = oneMinus(g.mul(g)).div(moonMieDenominator).mul(0.0795775);
    const lunarScatter = vec3(0.13, 0.27, 0.78).mul(this.moonColor)
      .mul(moonRayleighPhase.mul(this.atmosphere.y).mul(0.10)
        .add(moonMiePhase.mul(this.atmosphere.z.mul(5.2))))
      .mul(moonlight).mul(oneMinus(twilight));
    sky = sky.add(lunarScatter).add(vec3(0.0004, 0.0008, 0.0022).mul(oneMinus(twilight)));
    // Stable sidereal-looking stars are evaluated in world direction, require no
    // texture/pass, and contribute negligible IBL energy. Haze, horizon air mass,
    // daylight, and lunar glare all suppress visibility.
    const starCell = view.mul(220).floor();
    const starHash = starCell.dot(vec3(12.9898, 78.233, 37.719)).sin().mul(43758.5453).fract();
    const starLocal = view.mul(220).fract().sub(0.5);
    const starPoint = oneMinus(smoothstep(0.006, 0.030, starLocal.dot(starLocal)));
    const starCore = smoothstep(0.9905, 0.99985, starHash).pow(4).mul(starPoint);
    const starTemperature = mix(
      vec3(0.62, 0.72, 1.0),
      vec3(1.0, 0.82, 0.62),
      starHash.mul(137.31).fract(),
    );
    const starVisibility = oneMinus(smoothstep(-0.20, -0.04, this.sunDirection.y))
      .mul(smoothstep(0.02, 0.24, view.y))
      .mul(oneMinus(smoothstep(0.92, 0.999, moonCosine)).mul(0.85).add(0.15))
      .mul(oneMinus(this.atmosphere.x.sub(1).div(9).clamp(0, 1).mul(0.65)));
    sky = sky.add(starTemperature.mul(0.58).mul(starCore).mul(starVisibility));
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
      // The physical Moon is only about half a degree wide and becomes a handful
      // of pixels at the gameplay FOV. Preserve its true direction and phase while
      // granting the visible disc a modest minimum radius so limb and surface detail
      // survive tone mapping and temporal reconstruction.
      const moonRadius = this.moonAngularRadius.max(0.0120);
      const moonDisc = smoothstep(moonRadius.mul(1.08).cos(), moonRadius.mul(0.94).cos(), moonCosine);
      const moonReference = this.moonDirection.y.abs().lessThan(0.92)
        .select(vec3(0, 1, 0), vec3(1, 0, 0));
      const moonRight = moonReference.cross(this.moonDirection).normalize();
      const moonUp = this.moonDirection.cross(moonRight).normalize();
      const moonDelta = view.sub(this.moonDirection);
      const moonX = moonDelta.dot(moonRight).div(moonRadius);
      const moonY = moonDelta.dot(moonUp).div(moonRadius);
      const moonRadiusSquared = moonX.mul(moonX).add(moonY.mul(moonY));
      const lunarLimb = oneMinus(moonRadiusSquared).max(0).sqrt().mul(0.45).add(0.55);
      // Sample the Earth-facing hemisphere of NASA's LRO WAC mosaic. Longitude
      // zero sits at disc centre and the map wraps around the analytic sphere.
      const moonUv = vec2(
        moonX.atan(lunarLimb).mul(1 / (Math.PI * 2)).add(0.5),
        moonY.clamp(-1, 1).asin().mul(1 / Math.PI).add(0.5),
      );
      const lunarAlbedo = texture(this.moonAlbedoMap, moonUv).rgb;
      // Reconstruct the visible sphere normal and light it from the same solar
      // direction used by the atmosphere. This produces the real curved terminator
      // for every phase instead of cutting a flat shape from the disc.
      const moonSurfaceNormal = moonRight.mul(moonX).add(moonUp.mul(moonY))
        .sub(this.moonDirection.mul(oneMinus(moonRadiusSquared).max(0).sqrt())).normalize();
      const lunarIncidence = moonSurfaceNormal.dot(this.sunDirection.normalize());
      const litPhase = smoothstep(-0.018, 0.025, lunarIncidence);
      const moonSurface = litPhase.mul(0.985).add(0.015)
        .mul(lunarAlbedo.mul(1.08)).mul(lunarLimb);
      const moonHorizon = smoothstep(-0.01, 0.06, this.moonDirection.y);
      const moonHalo = smoothstep(moonRadius.mul(3).cos(), moonRadius.mul(1.12).cos(), moonCosine)
        .mul(oneMinus(moonDisc)).mul(0.035).mul(this.moonIlluminatedFraction.sqrt());
      sky = sky.add(this.moonColor.mul(moonDisc.mul(moonSurface).mul(0.62).add(moonHalo))
        .mul(moonHorizon));
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
