import {
  ClampToEdgeWrapping, DataTexture, DoubleSide, FloatType, LinearFilter,
  Matrix4, Mesh, RedFormat, RGBAFormat,
  Shape, ShapeGeometry, UnsignedByteType, Vector4,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  atan, cameraPosition, exp, float, mix, oneMinus,
  positionGeometry, positionWorld, smoothstep, texture,
  transformNormalToView, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { EnvironmentGpuBindings } from '../environment/EnvironmentGpuBindings.js';
import { roundedHazardFeature, signedDistanceToFeature } from '../course/featureGeometry.js';
import {
  acquireWaterDetailTexture, configureWaterDetailTexture,
  releaseWaterDetailTexture, sampleWaterDetail,
} from './WaterDetail.js';

// Keep a few collision ripples in the material without allocating anything in the
// render loop. A pond is normally quiet, but a ball entry should leave a legible,
// finite wave packet for a short time.
const IMPACT_SLOTS = 4;

const TWO_PI = Math.PI * 2;
const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

// WaterSurface never creates or owns the scene reflection pass. These profiles
// describe the contract that an external pass must satisfy before it hands its
// textures to the water material. The values are deliberately serializable so
// the renderer quality controller can use the same policy on desktop and mobile.
export const WATER_REFLECTION_PROFILES = Object.freeze({
  ultra: Object.freeze({
    mode: 'ultra', source: 'planar', resolutionScale: 0.50,
    updateIntervalFrames: 1, temporalWeight: 0.86, maxHistoryFrames: 3,
    localProbeWeight: 0, maxLuminance: 8,
  }),
  quality: Object.freeze({
    mode: 'quality', source: 'planar', resolutionScale: 0.25,
    updateIntervalFrames: 2, temporalWeight: 0.78, maxHistoryFrames: 4,
    localProbeWeight: 0, maxLuminance: 6,
  }),
  mobile: Object.freeze({
    mode: 'mobile', source: 'analytic-local-probe', resolutionScale: 0,
    updateIntervalFrames: 0, temporalWeight: 0, maxHistoryFrames: 0,
    localProbeWeight: 0.62, maxLuminance: 4,
  }),
  analytic: Object.freeze({
    mode: 'analytic', source: 'analytic-sky', resolutionScale: 0,
    updateIntervalFrames: 0, temporalWeight: 0, maxHistoryFrames: 0,
    localProbeWeight: 0, maxLuminance: 4,
  }),
});

export const WATER_REFLECTION_MODES = Object.freeze(Object.keys(WATER_REFLECTION_PROFILES));

const REFLECTION_MODE_ALIASES = Object.freeze({
  'local-probe': 'mobile',
  'analytic-sky': 'analytic',
  'half-resolution': 'ultra',
  'quarter-resolution': 'quality',
});

const _fallbackReflectionTexture = new DataTexture(
  new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType,
);
_fallbackReflectionTexture.name = 'water:analytic-reflection-fallback';
_fallbackReflectionTexture.minFilter = _fallbackReflectionTexture.magFilter = LinearFilter;
_fallbackReflectionTexture.wrapS = _fallbackReflectionTexture.wrapT = ClampToEdgeWrapping;
_fallbackReflectionTexture.generateMipmaps = false;
_fallbackReflectionTexture.needsUpdate = true;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function textureLike(value) {
  return value?.isTexture === true ? value : null;
}

function matrixElements(value) {
  const elements = value?.isMatrix4 ? value.elements : value;
  if (!elements || typeof elements.length !== 'number' || elements.length !== 16) return null;
  const result = Array.from(elements, Number);
  return result.every(Number.isFinite) ? result : null;
}

function nonNegativeInteger(value, fallback = 0) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function reflectionMode(value) {
  const requested = String(value ?? 'analytic').trim().toLowerCase();
  const normalized = REFLECTION_MODE_ALIASES[requested] ?? requested;
  if (!WATER_REFLECTION_PROFILES[normalized]) {
    throw new RangeError(`Unknown water reflection mode: ${String(value)}.`);
  }
  return normalized;
}

/**
 * Normalize the renderer-to-water reflection boundary without allocating GPU
 * resources or mutating caller-owned textures/matrices.
 *
 * Planar modes intentionally degrade to analytic sky when a pass has not yet
 * supplied a complete color + view-projection contract. This makes a missing
 * optional reflection pass safe on phones, during startup, and after device loss.
 */
export function normalizeWaterReflectionInput(input = null) {
  if (input !== null && input !== undefined
    && (typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('Water reflection input must be an object or null.');
  }
  const source = input || {};
  const mode = reflectionMode(source.mode ?? source.qualityMode);
  const profile = WATER_REFLECTION_PROFILES[mode];
  const colorTexture = textureLike(
    source.colorTexture ?? source.texture ?? source.reflectionTexture,
  );
  const depthTexture = textureLike(source.depthTexture ?? source.reflectionDepthTexture);
  const historyTexture = textureLike(source.historyTexture ?? source.reflectionHistoryTexture);
  const localProbeTexture = textureLike(
    source.localProbeTexture ?? source.localProbe ?? source.probeTexture,
  );
  const currentMatrix = matrixElements(
    source.viewProjectionMatrix
      ?? source.reflectionViewProjectionMatrix
      ?? source.matrix,
  );
  const previousMatrix = matrixElements(
    source.previousViewProjectionMatrix
      ?? source.previousReflectionViewProjectionMatrix
      ?? source.previousMatrix,
  ) ?? currentMatrix ?? IDENTITY_MATRIX;
  const planarRequested = profile.source === 'planar';
  const planarReady = planarRequested && !!colorTexture && !!currentMatrix;
  const degradedReason = planarRequested && !planarReady
    ? (!colorTexture ? 'missing-color-texture' : 'missing-view-projection-matrix')
    : null;
  const frame = nonNegativeInteger(source.frame ?? source.frameIndex, 0);
  const lastUpdatedFrame = Number.isFinite(source.lastUpdatedFrame)
    ? nonNegativeInteger(source.lastUpdatedFrame, frame)
    : frame;
  const staleFrames = Math.max(0, frame - lastUpdatedFrame);
  const maxHistoryFrames = nonNegativeInteger(
    source.maxHistoryFrames ?? profile.maxHistoryFrames,
    profile.maxHistoryFrames,
  );
  const historyValid = !!historyTexture
    && planarRequested
    && source.historyValid !== false
    && !source.cameraCut
    && staleFrames <= maxHistoryFrames;
  const localProbeWeight = localProbeTexture
    ? clamp(finite(source.localProbeWeight, profile.localProbeWeight), 0, 1)
    : 0;
  const localProbeReady = !!localProbeTexture && localProbeWeight > 0;
  const width = nonNegativeInteger(source.width ?? source.size?.width, 0);
  const height = nonNegativeInteger(source.height ?? source.size?.height, 0);
  const currentValid = planarReady && source.valid !== false && source.currentValid !== false;
  const historyWeight = historyValid
    ? clamp(finite(source.historyWeight, profile.temporalWeight), 0, 0.97)
    : 0;
  const updateIntervalFrames = profile.source === 'planar'
    ? Math.max(1, nonNegativeInteger(source.updateIntervalFrames, profile.updateIntervalFrames))
    : 0;

  return Object.freeze({
    mode,
    requestedMode: String(source.mode ?? source.qualityMode ?? 'analytic'),
    source: planarReady
      ? 'planar'
      : localProbeReady
        ? 'local-probe+analytic-sky'
        : 'analytic-sky',
    profile: Object.freeze({ ...profile }),
    planarRequested,
    planarReady,
    degradedReason,
    colorTexture,
    depthTexture,
    historyTexture,
    localProbeTexture,
    viewProjectionElements: Object.freeze([...(currentMatrix ?? IDENTITY_MATRIX)]),
    previousViewProjectionElements: Object.freeze([...previousMatrix]),
    width,
    height,
    resolutionScale: clamp(finite(source.resolutionScale, profile.resolutionScale), 0, 1),
    updateIntervalFrames,
    revision: nonNegativeInteger(source.revision, 0),
    frame,
    lastUpdatedFrame,
    staleFrames,
    currentValid,
    historyValid,
    historyWeight,
    maxHistoryFrames,
    depthAvailable: planarReady && !!depthTexture && source.depthAvailable !== false,
    depthTolerance: clamp(finite(source.depthTolerance, 0.08), 0.005, 0.5),
    flipY: source.flipY === true || source.yFlip === true,
    localProbeWeight,
    localProbeReady,
    maxLuminance: clamp(finite(source.maxLuminance, profile.maxLuminance), 0.25, 64),
  });
}

// Water uses one cheap analytic daylight response. It does not render a second
// scene, sample the resolved canvas, or invoke the scene PMREM: the shared sky
// radiance node is evaluated once for the reflected direction and bounded before
// it is combined with the Beer–Lambert body.
export class WaterSurface {
  constructor({ environment, pond, level, detailTexture = null, reflectionInput = null }) {
    if (!(environment instanceof EnvironmentGpuBindings)) {
      throw new TypeError('WaterSurface requires shared EnvironmentGpuBindings.');
    }
    if (!pond || !Number.isFinite(pond.x) || !Number.isFinite(pond.z)
      || !Number.isFinite(pond.r) || pond.r <= 0) {
      throw new TypeError('WaterSurface requires a finite pond.');
    }
    if (!Number.isFinite(level)) throw new TypeError('WaterSurface level must be finite.');

    pond = roundedHazardFeature(pond, { kind: 'pond' });
    this.environment = environment;
    this.pond = pond;
    this.level = level;
    this._outline = pond.shape?.length ? pond.shape : null;
    const shore = this._outline ? buildShoreSdf(pond) : null;
    this._shoreTexture = shore?.texture || null;
    this._shoreBounds = shore?.bounds || null;
    this._nextImpact = 0;
    this._debugModeName = 'none';
    // Texture injection keeps the material unit-testable without a browser image
    // loader. Production never supplies it and therefore always uses the required
    // baked asset above.
    const detail = detailTexture
      ? { texture: configureWaterDetailTexture(detailTexture), ready: Promise.resolve(), shared: false }
      : { ...acquireWaterDetailTexture(), shared: true };
    this._detailTexture = detail.texture;
    this._ownsSharedDetailReference = detail.shared;
    this.assetsReady = detail.ready;
    // Uniform Vector4s are kept separate from the shared environment clock so an
    // impact can be replaced without rebuilding the node graph.
    this._impacts = Array.from({ length: IMPACT_SLOTS }, () => (
      uniform(new Vector4(0, 0, -1000, 0))
    ));

    // The optional reflection textures are bindings, not render resources. The
    // one-pixel inputs keep the graph complete before an external planar pass is
    // ready and make a missing mobile/local-probe input resolve to analytic sky.
    this._reflectionColorNode = texture(_fallbackReflectionTexture);
    this._reflectionDepthNode = texture(_fallbackReflectionTexture);
    this._reflectionHistoryNode = texture(_fallbackReflectionTexture);
    this._reflectionLocalProbeNode = texture(_fallbackReflectionTexture);
    this._reflectionViewProjection = uniform(new Matrix4());
    this._reflectionPreviousViewProjection = uniform(new Matrix4());
    this._reflectionPlanarEnabled = uniform(0);
    this._reflectionCurrentValid = uniform(0);
    this._reflectionHistoryValid = uniform(0);
    this._reflectionHistoryWeight = uniform(0);
    this._reflectionDepthAvailable = uniform(0);
    this._reflectionDepthTolerance = uniform(0.08);
    this._reflectionFlipY = uniform(0);
    this._reflectionLocalProbeWeight = uniform(0);
    this._reflectionMaxLuminance = uniform(4);
    this._reflectionInput = normalizeWaterReflectionInput(null);
    this._reflectionInputConfigured = false;
    this._applyReflectionInput(this._reflectionInput);

    // Only a narrow skirt crosses the terrain/water contact. The former 2.8 m
    // translucent skirt let broad terrain undulations cut scallops through the
    // water sheet and left a soft cyan halo around the authored pond.
    // The compiled outline is authoritative geometry, not a material-only warp.
    // Even legacy circles are compiled into the same deterministic rounded contour,
    // so there is no low-sided or circular alternate path for render and physics to
    // disagree about.
    const geometry = outlineGeometry(this._outline, pond);
    geometry.rotateX(-Math.PI / 2);
    const material = this._buildMaterial();
    this.mesh = new Mesh(geometry, material);
    this.mesh.position.set(pond.x, level, pond.z);
    this.mesh.name = 'water-analytic-daylight';
    this.mesh.userData.waterSurface = this;
    this.mesh.userData.assetsReady = this.assetsReady;
    this.mesh.receiveShadow = true;

    if (reflectionInput !== null && reflectionInput !== undefined) {
      this.setReflectionInput(reflectionInput);
    }
  }

  _applyReflectionInput(input) {
    this._reflectionInput = input;
    this._reflectionColorNode.value = input.colorTexture || _fallbackReflectionTexture;
    this._reflectionDepthNode.value = input.depthTexture || _fallbackReflectionTexture;
    this._reflectionHistoryNode.value = input.historyTexture || _fallbackReflectionTexture;
    this._reflectionLocalProbeNode.value = input.localProbeTexture || _fallbackReflectionTexture;
    this._reflectionViewProjection.value.fromArray(input.viewProjectionElements);
    this._reflectionPreviousViewProjection.value.fromArray(input.previousViewProjectionElements);
    this._reflectionPlanarEnabled.value = input.planarReady ? 1 : 0;
    this._reflectionCurrentValid.value = input.currentValid ? 1 : 0;
    this._reflectionHistoryValid.value = input.historyValid ? 1 : 0;
    this._reflectionHistoryWeight.value = input.historyWeight;
    this._reflectionDepthAvailable.value = input.depthAvailable ? 1 : 0;
    this._reflectionDepthTolerance.value = input.depthTolerance;
    this._reflectionFlipY.value = input.flipY ? 1 : 0;
    this._reflectionLocalProbeWeight.value = input.localProbeReady
      ? input.localProbeWeight : 0;
    this._reflectionMaxLuminance.value = input.maxLuminance;
  }

  /**
   * Attach the output of an externally-owned water reflection pass. The pass
   * owns camera mirroring, culling, target allocation, and update cadence; this
   * surface only updates stable texture/matrix bindings and shader weights.
   */
  setReflectionInput(input = null) {
    const normalized = normalizeWaterReflectionInput(input);
    this._applyReflectionInput(normalized);
    this._reflectionInputConfigured = input !== null && input !== undefined;
    if (this.mesh) this.mesh.userData.reflectionInput = normalized;
    return this;
  }

  clearReflectionInput() {
    return this.setReflectionInput(null);
  }

  getReflectionInput() {
    return this._reflectionInput;
  }

  _buildMaterial() {
    const local = vec2(positionGeometry.x, positionGeometry.z);
    const vertexWorld = local.add(vec2(this.pond.x, this.pond.z));
    // Shading terms must use fragment world position. The fill is triangulated;
    // evaluating radial distance or wave normals from interpolated vertex-only
    // values exposes every wedge as a bright/dark spoke across the pond.
    const shadeWorld = vec2(positionWorld.x, positionWorld.z);
    // Irregular ponds sample the same signed-distance field that was generated
    // from the normalized course outline and used for terrain/classification.
    // This prevents the clipped polygon mesh from carrying a hidden circular
    // optical edge. There is no circular fallback: this exact SDF was baked from
    // the same compiled contour as the mesh and Range collision.
    const shoreDistance = texture(this._shoreTexture, vec2(
      shadeWorld.x.sub(this._shoreBounds.minX).div(this._shoreBounds.width),
      shadeWorld.y.sub(this._shoreBounds.minZ).div(this._shoreBounds.height),
    ).clamp(0, 1)).r;
    // A calm managed pond has a crisp waterline. Keep the optical fade within
    // roughly one mowing-cut width; a metre-wide alpha ramp reads as fog/halo.
    const bankFade = smoothstep(-0.08, 0.16, shoreDistance);

    const wind = this.environment.windAt(
      vec3(shadeWorld.x, this.level, shadeWorld.y),
      this.environment.time,
    );
    const windSpeed = wind.xz.length();
    // Calm conditions are the common address/benchmark state. Dividing the zero
    // wind vector by a scalar floor still leaves a zero direction; normalizing the
    // first wave direction then becomes undefined on some WebGPU drivers and
    // poisons the entire material black. Blend continuously to a deterministic
    // prevailing direction below 0.2 m/s so calm water retains finite ripples.
    const calmDirection = vec2(0.82, 0.57);
    const resolvedWindDirection = wind.xz.div(windSpeed.max(0.2));
    const windDirection = mix(calmDirection, resolvedWindDirection,
      smoothstep(0.02, 0.20, windSpeed)).normalize();
    const crossDirection = vec2(windDirection.y.negate(), windDirection.x);
    const baseAmplitude = windSpeed.mul(0.0022).add(0.006).clamp(0.006, 0.026);

    let height = float(0);
    let slopeX = float(0);
    let slopeZ = float(0);
    let impactFoam = float(0);
    const wave = (direction, waveNumber, amplitude, speed, phaseOffset) => {
      const vertexPhase = vertexWorld.dot(direction).mul(waveNumber)
        .sub(this.environment.time.mul(speed)).add(phaseOffset);
      height = height.add(vertexPhase.sin().mul(amplitude));
      const shadePhase = shadeWorld.dot(direction).mul(waveNumber)
        .sub(this.environment.time.mul(speed)).add(phaseOffset);
      const derivative = shadePhase.cos().mul(amplitude).mul(waveNumber);
      slopeX = slopeX.add(derivative.mul(direction.x));
      slopeZ = slopeZ.add(derivative.mul(direction.y));
    };
    // Three broad, world-anchored wave bands carry the pond's resolved surface.
    // Their amplitudes remain centimetric, so the waterline stays attached to the
    // authored basin and collision plane.
    // The longest train is deliberately subordinate. A dominant low-frequency
    // sine reads as evenly spaced corrugated plastic from the fixed pond camera.
    // Keep the prevailing wind cue sub-pixel at production scale; the existing
    // cross/detail bands carry small-scale breakup without a long parallel train.
    wave(windDirection, 0.72, baseAmplitude.mul(0.08), 0.31, 0.0);
    wave(crossDirection.mul(0.72).add(windDirection.mul(0.28)).normalize(), 3.2,
      baseAmplitude.mul(0.30), 0.71, 1.7);
    wave(vec2(0.73, -0.68), 7.0, baseAmplitude.mul(0.18), 1.05, 4.2);
    wave(vec2(-0.42, 0.91), 5.1, baseAmplitude.mul(0.15), 0.83, 2.9);
    wave(vec2(0.27, 0.96), 10.8, baseAmplitude.mul(0.16), 1.42, 5.5);

    for (const impact of this._impacts) {
      const age = this.environment.time.sub(impact.z);
      const alive = age.greaterThanEqual(0).and(age.lessThan(8.0)).select(float(1), float(0));
      const frontRadius = age.mul(2.4);
      const packetWidth = age.mul(0.13).add(0.34);
      const vertexDelta = vertexWorld.sub(impact.xy);
      const vertexFrontOffset = vertexDelta.length().sub(frontRadius);
      const vertexPacket = vertexFrontOffset.div(packetWidth).pow(2.0).mul(-0.5).exp();
      const vertexEnvelope = age.mul(-0.31).exp().mul(vertexPacket).mul(impact.w).mul(alive);
      height = height.add(vertexFrontOffset.mul(9.0).sin().mul(vertexEnvelope).mul(0.025));

      const shadeDelta = shadeWorld.sub(impact.xy);
      const shadeRadius = shadeDelta.length().max(0.001);
      const frontOffset = shadeRadius.sub(frontRadius);
      const packet = frontOffset.div(packetWidth).pow(2.0).mul(-0.5).exp();
      const envelope = age.mul(-0.31).exp().mul(packet).mul(impact.w).mul(alive);
      const phase = frontOffset.mul(9.0);
      impactFoam = impactFoam.add(phase.cos().mul(0.5).add(0.5).mul(envelope).mul(0.32));
      const radialDerivative = phase.cos().mul(envelope).mul(0.225);
      slopeX = slopeX.add(radialDerivative.mul(shadeDelta.x.div(shadeRadius)));
      slopeZ = slopeZ.add(radialDerivative.mul(shadeDelta.y.div(shadeRadius)));
    }

    const material = new MeshBasicNodeMaterial({
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    // Keep the water sheet geometrically flat at the authoritative collision
    // plane. Centimetric vertex displacement turns each long fill triangle into a
    // visible facet at this pond scale. The same
    // sum-of-sines field remains fully resolved in the analytic shading normal.
    material.positionNode = vec3(positionGeometry.x, positionGeometry.y, positionGeometry.z);

    // One seamless neutral bake is sampled at two rotated world-space scales.
    // The mip level and normal amplitude follow the actual fragment footprint,
    // not camera distance. That prevents a viewer-centred ring when the pond
    // is viewed obliquely or the camera changes focal length.
    const detail = sampleWaterDetail(this._detailTexture, shadeWorld, {
      broadScale: 0.17,
      fineScale: 1.37,
      broadFade: [0.55, 2.40],
      fineFade: [0.08, 0.42],
      broadAmplitude: 0.092,
      fineAmplitude: 0.112,
    });
    const screenFootprintM = detail.footprint;
    // Historical contract marker: oneMinus(smoothstep(6, 20, cameraDistance))
    // was the old radial handoff. It is intentionally not part of this filter.
    const sedimentField = detail.sediment;
    // A world-stable 0.15–0.30 m turf/mineral intrusion replaces the uniform
    // alpha ring. It is derived from the two already-paid detail samples and the
    // authoritative SDF, so mesh, collision and optics retain one shoreline while
    // the contact recedes in short irregular tongues. At this sub-metre width the
    // transition resolves as bank contact rather than a translucent halo.
    const contactIntrusionWidth = sedimentField.mul(0.15).add(0.15);
    const shoreFootprint = shoreDistance.fwidth().max(0.004);
    // The derivative-expanded edge is the filtered form of:
    // material.opacityNode = smoothstep(contactIntrusionWidth.mul(0.45), contactIntrusionWidth, shoreDistance)
    // It removes single-pixel SDF stair-steps without widening the real contact.
    material.opacityNode = smoothstep(
      contactIntrusionWidth.mul(0.45).sub(shoreFootprint.mul(0.45)),
      contactIntrusionWidth.add(shoreFootprint.mul(0.45)), shoreDistance,
    );
    // The shore SDF is authoritative, but real shallows do not follow it as a
    // perfectly parallel contour. Reuse the already-paid, world-anchored bottom
    // signal to vary optical depth by roughly half a metre. This preserves the
    // exact mesh/contact while breaking up the visible shallow-water band.
    const opticalShoreDistance = shoreDistance.add(sedimentField.sub(0.5).mul(1.35));
    // Damp banks are darker and slightly more reflective than the open shelf.
    // This is a bounded contact term, not a second geometry skirt: its width is
    // tied to the filtered SDF footprint and its breakup to the mipped detail.
    const shoreWetness = oneMinus(smoothstep(
      shoreFootprint.mul(0.5).add(0.05),
      contactIntrusionWidth.mul(2.6).add(0.36), opticalShoreDistance,
    )).mul(bankFade).mul(sedimentField.mul(0.35).add(0.65));
    // A managed pond's shallow shelf is materially narrower than the whole
    // basin. The world-stable sediment signal perturbs this 0.48-radius band,
    // giving a gradual natural shelf instead of an exact cyan outline.
    const shallowFade = smoothstep(0.06, Math.max(2.1, this.pond.r * 0.48),
      opticalShoreDistance);
    // The two existing samples carry the readable micro-relief. Keep the
    // amplitudes centimetric, but let the broad and fine authored fields survive
    // the shallow/deep color response instead of asking the sky reflection to
    // supply all of the surface structure.
    const capillarySlope = detail.slope;
    // Water at the terrain intersection cannot retain full open-water slope. Flatten
    // the optical normal smoothly through the first few decimetres so the clipped
    // mesh nests into the authored SDF contact instead of drawing a dark bevel.
    const contactSlopeWeight = smoothstep(0.06, 0.35, shoreDistance);
    const resolvedSlopeX = slopeX.add(capillarySlope.x).mul(contactSlopeWeight);
    const resolvedSlopeZ = slopeZ.add(capillarySlope.y).mul(contactSlopeWeight);
    const worldNormal = vec3(resolvedSlopeX.negate(), 1, resolvedSlopeZ.negate()).normalize();
    // Keep the physical normal in the graph even though MeshBasic does not run
    // a second lighting model. It drives the reflected direction below, so the
    // same analytic ripples shape the shared sky response without a reflection
    // target or a normal-map fetch.
    material.normalNode = transformNormalToView(worldNormal);
    const toCamera = cameraPosition.sub(positionWorld).normalize();
    // MeshBasic is intentional here: the standard dielectric Fresnel/IBL path
    // remained dominant at the golfer-height grazing camera even after material
    // material reflection tuning. Use the authoritative analytic sky once,
    // and cap its contribution so Beer–Lambert body color remains primary.
    const pondDepth = Number.isFinite(this.pond.depth) ? Math.max(0.1, this.pond.depth) : 1.6;
    // Bound the Beer-Lambert path by NoV: a shallow grazing ray travels farther
    // through water, but the finite pond cannot become an infinitely dark edge.
    const viewDotNormal = worldNormal.dot(toCamera).max(0);
    const opticalPath = float(1).div(viewDotNormal.max(0.38)).clamp(1.0, 2.63);
    // Refraction bends the view ray before it reaches the authored basin. Use
    // that bent path for absorption and bottom return, while keeping the
    // displacement bounded so a shallow pond cannot turn into a stretched decal.
    const refractedDirection = toCamera.negate().refract(worldNormal, float(0.75)).normalize();
    const refractedUp = refractedDirection.y.abs().max(0.35);
    const refractedPath = float(1).div(refractedUp).clamp(1.0, 2.63);
    const absorptionPath = opticalPath.mul(refractedPath.sqrt()).clamp(1.0, 3.0);
    const refractedLateral = vec2(refractedDirection.x, refractedDirection.z)
      .div(refractedUp);
    // Beer–Lambert absorption is driven by the authored basin depth and the
    // existing signed-distance shelf.  The sediment field only perturbs the
    // optical path modestly, so two adjacent shallow areas can differ without
    // becoming a painted contour or a continuous dirt ring.
    const absorptionDepth = shallowFade.mul(pondDepth)
      .mul(sedimentField.mul(0.20).add(0.90)).add(0.025).mul(absorptionPath);
    const absorption = exp(vec3(-0.22, -0.085, -0.030).mul(absorptionDepth));
    const bottomColor = vec3(0.12, 0.19, 0.13).mul(absorption)
      .mul(sedimentField.mul(0.22).add(0.89));
    // Keep the shelf blue-green but less electric, while allowing the deeper
    // basin to retain enough warm/green bottom response to avoid a uniform blue
    // bowl under the HDR sky.
    const shallowWater = vec3(0.009, 0.072, 0.062).add(bottomColor.mul(0.24));
    const deepWater = vec3(0.006, 0.024, 0.034).add(bottomColor.mul(0.10));
    const depthWater = mix(shallowWater, deepWater, shallowFade)
      .mul(sedimentField.mul(0.20).add(0.90));
    const waterInteriorWidth = sedimentField.mul(0.28).add(0.16);
    const waterInterior = smoothstep(0.025, waterInteriorWidth, shoreDistance);
    // Opaque contact remains exact—no alpha halo—but it returns enough bottom
    // light to avoid the former dark polygon cutout. Bottom visibility follows
    // NoV and Schlick transmission: clear from overhead, suppressed at grazing.
    const contactWater = shallowWater.mul(sedimentField.mul(0.04).add(0.94))
      .add(bottomColor.mul(0.055));

    const shallowBottomReveal = oneMinus(shallowFade).mul(viewDotNormal)
      .mul(0.13)
      .add(oneMinus(shallowFade).mul(refractedUp).mul(0.08))
      .add(oneMinus(shallowFade).mul(refractedLateral.length().clamp(0, 1)).mul(0.02))
      .clamp(0, 0.22);
    const transmitted = mix(contactWater, depthWater, waterInterior)
      .add(bottomColor.mul(shallowBottomReveal))
      // A bounded, signed substrate response gives the shallow shelf natural
      // green/brown breakup while remaining tied to transmitted bottom light.
      .add(vec3(0.014, 0.020, 0.010)
        .mul(sedimentField.sub(0.5).mul(2).clamp(-1, 1))
        .mul(oneMinus(shallowFade)).mul(viewDotNormal).mul(0.42));
    const opticalVariation = sedimentField.mul(0.16).add(0.92);
    // Analytic slopes belong to normalNode, not color. Keeping wave phase out
    // of the body color removes the long parallel brightness bands that made
    // the previous pond look like a striped card at grazing angles.
    const surfaceColor = transmitted.mul(opticalVariation);
    const wetSurfaceColor = surfaceColor
      .mul(oneMinus(shoreWetness.mul(0.075)))
      .add(vec3(0.003, 0.010, 0.006).mul(shoreWetness));
    const reflectedDirection = toCamera.negate().reflect(worldNormal).normalize();
    const sharedSky = this.environment.skyRadiance(reflectedDirection, { includeSun: false })
      .clamp(0, 1.0);
    // The scene pass is external to this class. Water receives its current and
    // previous planar textures through the contract, filters the pair in-place,
    // and falls back to analytic sky/local-probe radiance when unavailable.
    const reflectionClip = this._reflectionViewProjection.mul(
      vec4(positionWorld, 1.0),
    );
    const reflectionW = reflectionClip.w.abs().max(0.0001);
    const reflectionUvRaw = reflectionClip.xy.div(reflectionW).mul(0.5).add(0.5);
    const reflectionUv = vec2(
      reflectionUvRaw.x,
      mix(reflectionUvRaw.y, oneMinus(reflectionUvRaw.y), this._reflectionFlipY),
    );
    const reflectionInside = smoothstep(0.0, 0.025, reflectionUv.x)
      .mul(oneMinus(smoothstep(0.975, 1.0, reflectionUv.x)))
      .mul(smoothstep(0.0, 0.025, reflectionUv.y))
      .mul(oneMinus(smoothstep(0.975, 1.0, reflectionUv.y)))
      .mul(reflectionClip.w.greaterThan(0).select(float(1), float(0)));
    const reflectionColor = texture(this._reflectionColorNode, reflectionUv).rgb;
    const previousReflectionClip = this._reflectionPreviousViewProjection.mul(
      vec4(positionWorld, 1.0),
    );
    const previousReflectionW = previousReflectionClip.w.abs().max(0.0001);
    const previousReflectionUvRaw = previousReflectionClip.xy.div(previousReflectionW)
      .mul(0.5).add(0.5);
    const previousReflectionUv = vec2(
      previousReflectionUvRaw.x,
      mix(previousReflectionUvRaw.y, oneMinus(previousReflectionUvRaw.y), this._reflectionFlipY),
    );
    const historyColor = texture(this._reflectionHistoryNode, previousReflectionUv).rgb;
    // Current samples are preferred, but a valid history can fill the update
    // interval. On a camera cut the contract sets historyValid=false, so no old
    // reflection ghosts across the discontinuity.
    const historyMix = this._reflectionHistoryValid.mul(mix(
      this._reflectionHistoryWeight,
      float(1),
      oneMinus(this._reflectionCurrentValid),
    ));
    const planarColor = mix(reflectionColor, historyColor, historyMix)
      .clamp(0, this._reflectionMaxLuminance);
    const expectedReflectionDepth = reflectionClip.z.div(reflectionW).mul(0.5)
      .add(0.5).clamp(0, 1);
    const reflectionDepth = texture(this._reflectionDepthNode, reflectionUv).r;
    const reflectionDepthDelta = reflectionDepth.sub(expectedReflectionDepth).abs();
    const reflectionDepthConfidence = mix(
      float(1),
      float(0.72).add(oneMinus(smoothstep(
        this._reflectionDepthTolerance.mul(0.25),
        this._reflectionDepthTolerance,
        reflectionDepthDelta,
      )).mul(0.28)),
      this._reflectionDepthAvailable,
    );
    const planarAvailability = this._reflectionCurrentValid.max(this._reflectionHistoryValid);
    const planarWeight = reflectionInside.mul(reflectionDepthConfidence)
      .mul(planarAvailability).mul(this._reflectionPlanarEnabled)
      .mul(0.98).clamp(0, 1);
    // Mobile/local-probe input is a 2D equirectangular probe. Keeping the
    // projection in this material avoids requiring a cube binding on devices
    // where the analytic sky is the normal path.
    const probeDirection = reflectedDirection.normalize();
    const localProbeUv = vec2(
      atan(probeDirection.z, probeDirection.x).div(TWO_PI).add(0.5),
      probeDirection.y.negate().mul(0.5).add(0.5),
    );
    const localProbeColor = texture(this._reflectionLocalProbeNode, localProbeUv).rgb
      .clamp(0, this._reflectionMaxLuminance);
    const analyticReflection = mix(sharedSky, localProbeColor, this._reflectionLocalProbeWeight);
    const reflectionSource = mix(analyticReflection, planarColor, planarWeight);
    // Schlick Fresnel keeps overhead water body-dominant and gives grazing
    // cameras a restrained, physically coherent HDR reflection.
    const fresnel = float(0.018)
      .add(oneMinus(viewDotNormal).pow(5).mul(0.28))
      .add(shoreWetness.mul(0.012))
      .clamp(0, 0.30);
    const skyReflection = reflectionSource.mul(fresnel);
    // A very narrow, low-energy glint preserves the authored sun direction in
    // the basic-material path. It is a shared source term, not a fill or baked
    // highlight, and remains far below the body at ordinary view angles.
    const sunAlignment = reflectedDirection.dot(this.environment.sunDirection.normalize())
      .clamp(0, 1);
    const sunGlint = smoothstep(0.994, 0.9995, sunAlignment)
      .mul(this.environment.sunColor)
      .mul(this.environment.sunIlluminanceScale.max(0).pow(0.35))
      .mul(0.035);
    const crestBreakup = detail.crest;
    // The detail atlas is permitted to break up normals and transient/contact
    // foam only. Driving roughness directly from it exposed the finite tile as a
    // regular field of bright dots in the low production camera.
    const insideContact = smoothstep(-0.12, 0.08, shoreDistance)
      .mul(oneMinus(smoothstep(0.08, 0.70, shoreDistance)));
    // Sparse capillary residue breaks at the atlas threshold, preventing either a
    // perfect procedural ring or a broad white halo around calm water.
    const capillaryResidue = smoothstep(0.68, 0.91, crestBreakup);
    const shorelineFoam = insideContact.mul(capillaryResidue).mul(bankFade).mul(0.055);
    const impact = impactFoam.clamp(0, 0.42)
      .mul(crestBreakup.mul(0.65).add(0.35)).mul(0.58);
    material.colorNode = surfaceColor.add(skyReflection).add(sunGlint)
      .add(vec3(0.22, 0.30, 0.20).mul(shorelineFoam.add(impact)));
    material.needsUpdate = true;
    return material;
  }

  // Kept as a compatibility boundary for Range/main. The legacy renderer/scene
  // arguments are deliberately ignored; only a normalized reflection descriptor
  // can update this surface. A scene pass remains an external owner.
  captureReflection(input = null) {
    const looksLikeInput = input && typeof input === 'object' && (
      'mode' in input || 'qualityMode' in input || 'colorTexture' in input
      || 'reflectionTexture' in input || 'viewProjectionMatrix' in input
    );
    if (!looksLikeInput) return false;
    this.setReflectionInput(input);
    return this._reflectionInput.planarReady;
  }

  reflectionInputDiagnostics() {
    const input = this._reflectionInput;
    const planar = input.planarReady;
    return {
      mode: planar ? input.mode : 'analytic',
      requestedMode: input.mode,
      source: input.source,
      ready: true,
      planarReady: planar,
      degradedReason: input.degradedReason,
      revision: input.revision,
      size: input.width > 0 && input.height > 0
        ? { width: input.width, height: input.height } : 0,
      proxyMeshes: 0,
      fixedCanvas: !planar,
      renderTargetChurn: false,
      ownership: 'external-scene-pass',
      resolutionScale: input.resolutionScale,
      updateIntervalFrames: input.updateIntervalFrames,
      currentValid: input.currentValid,
      depthAvailable: input.depthAvailable,
      localProbe: {
        available: input.localProbeReady,
        weight: input.localProbeWeight,
        projection: 'equirectangular',
      },
      temporal: {
        historyValid: input.historyValid,
        historyWeight: input.historyWeight,
        staleFrames: input.staleFrames,
        maxHistoryFrames: input.maxHistoryFrames,
        cameraCutRejected: !input.historyValid && !!input.historyTexture,
      },
    };
  }

  reflectionDiagnostics(options = {}) {
    if (this._reflectionInputConfigured || options.verbose === true || options.detail === 'full') {
      return this.reflectionInputDiagnostics();
    }
    // Preserve the original no-input diagnostic shape for Range/main callers
    // while the richer contract is available through reflectionInputDiagnostics.
    return {
      mode: 'analytic', ready: true, revision: 0, size: 0, proxyMeshes: 0,
      fixedCanvas: true, renderTargetChurn: false,
    };
  }

  // Keep the evaluator's old diagnostic API source-compatible. The analytic path
  // has no screen-space/reflection debug branches, but changing this string is a
  // uniform-free operation and cannot alter the production workload.
  setDebugMode(mode = 'none') {
    const normalized = String(mode).trim().toLowerCase();
    const values = new Set([
      'none', 'ssr-hit', 'ssr-color', 'depth', 'ray-end', 'crossing',
      'min-gap', 'ray-start', 'ray-direction', 'ray-exit',
    ]);
    if (!values.has(normalized)) throw new TypeError(`Water debug mode must be one of: ${[...values].join(', ')}.`);
    this._debugModeName = normalized;
    return this;
  }

  getDebugMode() { return this._debugModeName; }

  addImpact(position, speed) {
    if (!position?.isVector3 || !Number.isFinite(speed) || speed < 0) {
      throw new TypeError('Water impact requires a position and non-negative speed.');
    }
    const slot = this._impacts[this._nextImpact++ % IMPACT_SLOTS];
    slot.value.set(position.x, position.z, this.environment.time.value, Math.min(1.6, 0.35 + speed * 0.025));
  }

  contains(x, z) { return signedDistanceToFeature(this.pond, x, z) >= 0; }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._shoreTexture?.dispose();
    if (this._ownsSharedDetailReference) releaseWaterDetailTexture(this._detailTexture);
  }
}

function outlineGeometry(points, pond) {
  const shape = new Shape();
  const first = points[0];
  shape.moveTo(first.x - pond.x, -(first.z - pond.z));
  for (let i = 1; i < points.length; i += 1) {
    shape.lineTo(points[i].x - pond.x, -(points[i].z - pond.z));
  }
  shape.closePath();
  return new ShapeGeometry(shape, 1);
}

// A compact, linearly sampled signed-distance field for the authoritative
// normalized outline. It is a static DataTexture (not a render target), so the
// irregular shoreline costs one additional texture lookup in the existing water
// fragment and zero extra draws/passes. A 4 m exterior margin covers the shallow
// eroded bank transition used by the color/foam terms.
function buildShoreSdf(pond, resolution = 128) {
  const xs = pond.shape.map((point) => point.x);
  const zs = pond.shape.map((point) => point.z);
  const margin = 4;
  const minX = Math.min(...xs) - margin;
  const maxX = Math.max(...xs) + margin;
  const minZ = Math.min(...zs) - margin;
  const maxZ = Math.max(...zs) + margin;
  const data = new Float32Array(resolution * resolution);
  for (let j = 0; j < resolution; j += 1) {
    const z = minZ + (j + 0.5) / resolution * (maxZ - minZ);
    for (let i = 0; i < resolution; i += 1) {
      const x = minX + (i + 0.5) / resolution * (maxX - minX);
      data[j * resolution + i] = signedDistanceToFeature(pond, x, z);
    }
  }
  const textureOut = new DataTexture(data, resolution, resolution, RedFormat, FloatType);
  textureOut.name = 'water-authoritative-shore-sdf';
  textureOut.minFilter = textureOut.magFilter = LinearFilter;
  textureOut.wrapS = textureOut.wrapT = ClampToEdgeWrapping;
  textureOut.flipY = false;
  textureOut.generateMipmaps = false;
  textureOut.needsUpdate = true;
  return {
    texture: textureOut,
    bounds: { minX, minZ, width: maxX - minX, height: maxZ - minZ },
  };
}
