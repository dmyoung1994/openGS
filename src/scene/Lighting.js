import { DirectionalLight, HemisphereLight, Vector3 } from 'three';
import { StorageTexture } from 'three/webgpu';
import { Fn, If, float, positionWorld, texture, uniform } from 'three/tsl';
import { CameraShadows } from './CameraShadows.js';

export const CLOUD_SHADOW_SIZE = 512;
export const CLOUD_SHADOW_SPAN_M = 12000;

// Renderer-relative calibration at the authored 85 klux reference state. The
// key remains intentionally dominant: open-sky colour comes from the analytic
// sky/PMREM, while this small hemispherical return keeps occluded bark and turf
// chromatic without becoming a second directional light.
const KEY_INTENSITY_AT_REFERENCE = 3.35;
const HEMISPHERE_INTENSITY_AT_REFERENCE = 0.40;
const DEFAULT_SHADOW_EXTENT = 150;
const DEFAULT_SHADOW_NEAR = 5;
const DEFAULT_SHADOW_FAR = 700;
const DEFAULT_LIGHT_DISTANCE = 140;
const DEFAULT_FOCUS_THRESHOLD_METERS = 6;
const DEFAULT_SUN_ANGLE_THRESHOLD_RADIANS = 0.0025;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 100;
const DEFAULT_MAX_SUN_UPDATE_INTERVAL_MS = 500;
const DEFAULT_INVALIDATION_COALESCE_MS = 100;
const DEFAULT_COURSE_COVERAGE_PADDING_METERS = 18;
const DEFAULT_COURSE_COVERAGE_HEIGHT_METERS = 45;
const EPSILON = 1e-8;

const _worldUp = new Vector3(0, 1, 0);

const finitePositive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

const finiteNonNegative = (value, fallback) => (
  Number.isFinite(value) && value >= 0 ? value : fallback
);

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const nowMs = (value) => {
  if (Number.isFinite(value)) return value;
  return globalThis.performance?.now?.() ?? Date.now();
};

const numberOrNull = (value) => Number.isFinite(value) ? value : null;

function shadowQualitySource(environmentTier, overrides = {}) {
  const tierQuality = environmentTier.shadow ?? environmentTier.shadowQuality ?? {};
  const overrideQuality = overrides.shadow ?? overrides.shadowQuality ?? overrides;
  return { ...tierQuality, ...overrideQuality };
}

function frustumSource(environmentTier, quality) {
  if (quality.frustum !== undefined) return quality.frustum;
  if (quality.shadowFrustum !== undefined) return quality.shadowFrustum;
  if (environmentTier.shadowFrustum !== undefined) return environmentTier.shadowFrustum;
  if (Number.isFinite(quality.extent)) return { extent: quality.extent };
  return {};
}

function qualityNumber(quality, names, fallback) {
  for (const name of names) {
    if (Number.isFinite(quality[name])) return quality[name];
  }
  return fallback;
}

/**
 * Resolve the directional shadow workload without requiring a new device-tier
 * shape. Existing tiers only need `shadowMapSize`; a tier may optionally add a
 * `shadow` or `shadowQuality` object, and callers may pass the same object as
 * the constructor's fourth argument for a local override.
 *
 * The returned values are deliberately plain data. That makes the exact shadow
 * budget visible to capture/benchmark tooling without coupling those tools to
 * Three's mutable camera objects.
 */
export function resolveShadowQuality(environmentTier, overrides = {}) {
  const quality = shadowQualitySource(environmentTier, overrides);
  const mapSize = qualityNumber(
    quality,
    ['mapSize', 'shadowMapSize'],
    environmentTier.shadowMapSize,
  );
  if (!Number.isFinite(mapSize) || mapSize <= 0) {
    throw new Error('Lighting requires a positive directional shadow map size.');
  }

  const rawFrustum = frustumSource(environmentTier, quality);
  const frustum = typeof rawFrustum === 'number'
    ? { extent: rawFrustum }
    : (rawFrustum && typeof rawFrustum === 'object' ? rawFrustum : {});
  const extent = finitePositive(
    frustum.extent ?? quality.frustumExtent ?? quality.nearCourseExtent,
    DEFAULT_SHADOW_EXTENT,
  );
  const left = -finitePositive(Math.abs(frustum.left), extent);
  const right = finitePositive(Math.abs(frustum.right), extent);
  const top = finitePositive(Math.abs(frustum.top), extent);
  const bottom = -finitePositive(Math.abs(frustum.bottom), extent);
  const near = finitePositive(frustum.near ?? quality.near, DEFAULT_SHADOW_NEAR);
  const far = finitePositive(frustum.far ?? quality.far, DEFAULT_SHADOW_FAR);
  if (far <= near) throw new RangeError('Lighting shadow far plane must be greater than near plane.');

  const texelWidth = (right - left) / mapSize;
  const texelHeight = (top - bottom) / mapSize;
  const derivedFocusThreshold = Math.max(
    0.75,
    Math.min(DEFAULT_FOCUS_THRESHOLD_METERS, Math.max(texelWidth, texelHeight) * 40),
  );
  const focusThresholdMeters = finitePositive(
    qualityNumber(quality, [
      'focusThresholdMeters', 'shadowFocusThresholdMeters',
      'shadowFocusThreshold', 'focusThreshold',
    ], derivedFocusThreshold),
    DEFAULT_FOCUS_THRESHOLD_METERS,
  );

  const focusSnap = quality.focusSnap ?? quality.texelSnap
    // A bare `{ shadowMapSize }` tier is used by compatibility callers and the
    // existing unit suite. Real resolved tiers have an id and opt into texel
    // snapping by default without changing those callers' exact target values.
    ?? Boolean(environmentTier.id);

  const sunAngleThresholdRadians = finiteNonNegative(
    qualityNumber(quality, [
      'sunAngleThresholdRadians', 'shadowSunAngleThresholdRadians',
      'sunAngleThreshold', 'shadowAngleThreshold',
    ], DEFAULT_SUN_ANGLE_THRESHOLD_RADIANS),
    DEFAULT_SUN_ANGLE_THRESHOLD_RADIANS,
  );
  const minUpdateIntervalMs = finiteNonNegative(
    qualityNumber(quality, ['minUpdateIntervalMs', 'shadowUpdateIntervalMs'], DEFAULT_MIN_UPDATE_INTERVAL_MS),
    DEFAULT_MIN_UPDATE_INTERVAL_MS,
  );
  const maxSunUpdateIntervalMs = finitePositive(
    qualityNumber(quality, ['maxSunUpdateIntervalMs', 'sunMaxUpdateIntervalMs'], DEFAULT_MAX_SUN_UPDATE_INTERVAL_MS),
    DEFAULT_MAX_SUN_UPDATE_INTERVAL_MS,
  );
  const invalidationCoalesceMs = finiteNonNegative(
    qualityNumber(quality, ['invalidationCoalesceMs', 'focusCoalesceMs'], DEFAULT_INVALIDATION_COALESCE_MS),
    DEFAULT_INVALIDATION_COALESCE_MS,
  );

  return Object.freeze({
    mapSize,
    frustum: Object.freeze({ left, right, top, bottom, near, far }),
    texelWidth,
    texelHeight,
    focusThresholdMeters,
    focusSnap: Boolean(focusSnap),
    sunAngleThresholdRadians,
    minUpdateIntervalMs,
    maxSunUpdateIntervalMs,
    invalidationCoalesceMs,
    lightDistance: finitePositive(
      qualityNumber(quality, ['lightDistance', 'shadowLightDistance'], DEFAULT_LIGHT_DISTANCE),
      DEFAULT_LIGHT_DISTANCE,
    ),
  });
}

// Sun (directional, shadow-casting) plus a sky/ground hemisphere fill. The
// analytic atmosphere and this rig share one authored solar direction; the
// hemisphere supplies diffuse skylight wrap while the key defines form and
// ground shadows.
//
// Shadow updates are explicit. A ball/camera focus move or a meaningful change
// in the continuous sun direction requests a new map; tiny motion keeps the
// completed map resident. Resolved tiers can tighten the orthographic window and
// enable texel snapping so the map spends its resolution on the playable course.
export class Lighting {
  constructor(
    scene,
    sunDir = new Vector3(-0.5, 0.85, 0.3).normalize(),
    environmentTier,
    options = {},
  ) {
    if (!environmentTier?.shadowMapSize) throw new Error('Lighting requires the resolved environment device tier.');
    this.shadowQuality = resolveShadowQuality(environmentTier, options);

    // Bootstrap values last only until SceneManager installs the authoritative
    // EnvironmentGpuBindings. From that point the authored illuminance,
    // chromaticity, and direction drive this actual shadow-casting key.
    this.sun = new DirectionalLight(0xffffff, 3.25);
    this._sunDirection = sunDir.clone().normalize();
    this.cloudShadowTexture = new StorageTexture(CLOUD_SHADOW_SIZE, CLOUD_SHADOW_SIZE);
    this.cloudShadowTexture.name = 'celestial-cloud-transmittance';
    this.cloudShadowEnabled = uniform(0);
    this.cloudShadowDirection = uniform(this._sunDirection);
    this._keyRadiance = uniform(this.sun.color.clone().multiplyScalar(this.sun.intensity));
    const cloudMap = texture(this.cloudShadowTexture);
    this.sun.colorNode = Fn(() => {
      const transmission = float(1).toVar();
      If(this.cloudShadowEnabled.greaterThan(0.5), () => {
        // Project each receiver down the same celestial ray to the map's y=0
        // reference plane; elevated crowns and terrain retain the correct shade.
        const direction = this.cloudShadowDirection;
        const plane = positionWorld.xz.sub(direction.xz.mul(positionWorld.y.div(direction.y.max(0.04))));
        const mapUv = plane.div(CLOUD_SHADOW_SPAN_M).add(0.5);
        If(mapUv.greaterThanEqual(0).all().and(mapUv.lessThanEqual(1).all()), () => {
          transmission.assign(cloudMap.sample(mapUv).r);
        });
      });
      return this._keyRadiance.mul(transmission);
    })();
    this._shadowSunDirection = this._sunDirection.clone();
    this._shadowSunDirectionValid = this._sunDirection.lengthSq() > EPSILON;
    this._focus = new Vector3(0, 0, 0);
    this._shadowFocus = new Vector3(0, 0, 0);
    this._lastShadowFocus = new Vector3(0, 0, 0);
    this._nextFocus = new Vector3();
    this._snappedFocus = new Vector3();
    this._shadowFocusValid = false;
    this._lastFollowAt = -Infinity;
    this._lastShadowRequestAt = -Infinity;
    this._lastShadowRenderAt = -Infinity;
    this._lastShadowReason = 'initial';
    this._shadowUpdateRequests = 0;
    this._shadowRenderCount = 0;
    this._suppressedShadowUpdates = 0;
    this._pendingShadowReasons = new Set(['initial']);
    this._shadowRequestPending = true;
    this._courseShadowCoverage = null;
    this._shadowUpdateListeners = new Set();
    this._shadowRenderListeners = new Set();
    this._offset = this._sunDirection.clone().multiplyScalar(this.shadowQuality.lightDistance);
    this._lightForward = new Vector3();
    this._lightRight = new Vector3();
    this._lightUp = new Vector3();

    this.sun.position.copy(this._offset);
    this.sun.castShadow = true;
    // The sun and world casters are static between explicit simulation/course
    // changes. Keep the completed map resident instead of rebuilding it on
    // every beauty frame. All mutation sites call invalidateShadow(), follow(),
    // or setSunDirection().
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.sun.shadow.mapSize.set(this.shadowQuality.mapSize, this.shadowQuality.mapSize);
    this.sun.shadow.camera.near = this.shadowQuality.frustum.near;
    this.sun.shadow.camera.far = this.shadowQuality.frustum.far;
    this.sun.shadow.camera.left = this.shadowQuality.frustum.left;
    this.sun.shadow.camera.right = this.shadowQuality.frustum.right;
    this.sun.shadow.camera.top = this.shadowQuality.frustum.top;
    this.sun.shadow.camera.bottom = this.shadowQuality.frustum.bottom;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.012;
    this.sun.shadow.radius = 1;         // keep compact props present in the camera-focused map
    this.sun.shadow.intensity = 0.9;    // retain readable authored branch/crown shadows on the forest floor
    // Layer 1 is reserved for GPU-only shadow proxies. ShadowNode preserves this
    // explicit 0|1 mask instead of copying the beauty camera's layer mask, while
    // ordinary world casters on layer 0 continue to render into the same map.
    this.sun.shadow.camera.layers.enable(1);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // The prefiltered analytic sky supplies the real PBR fill. A restrained
    // hemisphere term remains for diffuse and thin/translucent materials: the
    // previous 0.09 left the underside of tree crowns and trunks at crushed
    // black once the key was occluded. Keep this well below the directional key
    // so it restores open-sky colour without flattening the raking shadows.
    this.hemi = new HemisphereLight(0xb9d3e8, 0x566047, 0.10);
    scene.add(this.hemi);
    this._environmentUnsubscribe = null;
    this._daylightRevision = -1;
    this.scene = scene;
    scene.userData.environmentLighting = this;

    if (typeof options.onShadowUpdate === 'function') this.onShadowUpdate(options.onShadowUpdate);
    if (typeof options.onShadowRendered === 'function') this.onShadowRendered(options.onShadowRendered);
  }

  enableCameraShadows(camera, renderer) {
    if (!this.cameraShadows) {
      this.cameraShadows = new CameraShadows(this.sun, camera, renderer);
      this.sun.shadow.shadowNode = this.cameraShadows;
    }
    return this.cameraShadows;
  }

  _syncShadowRenderState(timestamp = nowMs()) {
    if (this._shadowRequestPending && !this.sun.shadow.needsUpdate) {
      this._recordShadowRendered(timestamp);
    }
  }

  _recordShadowRendered(timestamp) {
    this._shadowRequestPending = false;
    this._lastShadowRenderAt = timestamp;
    this._shadowRenderCount += 1;
    this._shadowSunDirection.copy(this._sunDirection);
    this._shadowSunDirectionValid = this._sunDirection.lengthSq() > EPSILON;
    this._lastShadowFocus.copy(this._shadowFocus);
    this._pendingShadowReasons.clear();
    const event = Object.freeze({
      type: 'shadow-rendered',
      at: timestamp,
      diagnostics: this._readDiagnostics(),
    });
    for (const listener of this._shadowRenderListeners) listener(event);
  }

  _readDiagnostics() {
    const angle = this._shadowSunDirectionValid && this._sunDirection.lengthSq() > EPSILON
      ? Math.acos(Math.min(1, Math.max(-1, this._shadowSunDirection.dot(this._sunDirection))))
      : null;
    const focusDistance = this._focus.distanceTo(this._shadowFocus);
    const timestamp = nowMs();
    const elapsed = Number.isFinite(this._lastShadowRequestAt)
      ? Math.max(0, timestamp - this._lastShadowRequestAt)
      : null;
    return {
      mode: this.cameraShadows ? 'camera-cascades' : 'single-map',
      cascades: this.cameraShadows ? {
        cameraId: this.cameraShadows.camera.uuid,
        maxDistanceMeters: this.cameraShadows.maxFar,
        fade: this.cameraShadows.fade,
        breaks: [...this.cameraShadows.breaks],
        maps: this.cameraShadows.lights.map(({ shadow }) => ({
          size: shadow.mapSize.toArray(),
          featherRadiusTexels: shadow.radius,
          extent: [shadow.camera.left, shadow.camera.right, shadow.camera.bottom, shadow.camera.top],
          depth: [shadow.camera.near, shadow.camera.far],
          casterLayers: shadow.camera.layers.mask,
        })),
      } : null,
      // These compatibility fields describe the single-map configuration only;
      // mode/cascades above are authoritative when camera cascades are active.
      mapSize: { width: this.sun.shadow.mapSize.x, height: this.sun.shadow.mapSize.y },
      frustum: {
        left: this.sun.shadow.camera.left,
        right: this.sun.shadow.camera.right,
        top: this.sun.shadow.camera.top,
        bottom: this.sun.shadow.camera.bottom,
        near: this.sun.shadow.camera.near,
        far: this.sun.shadow.camera.far,
      },
      texelSizeMeters: {
        x: (this.sun.shadow.camera.right - this.sun.shadow.camera.left) / this.sun.shadow.mapSize.x,
        y: (this.sun.shadow.camera.top - this.sun.shadow.camera.bottom) / this.sun.shadow.mapSize.y,
      },
      focus: { x: this._focus.x, y: this._focus.y, z: this._focus.z },
      shadowFocus: { x: this._shadowFocus.x, y: this._shadowFocus.y, z: this._shadowFocus.z },
      focusDistanceMeters: focusDistance,
      focusThresholdMeters: this.shadowQuality.focusThresholdMeters,
      focusSnap: this.shadowQuality.focusSnap,
      courseCoverage: this._courseShadowCoverage ? {
        bounds: { ...this._courseShadowCoverage.bounds },
        anchor: { ...this._courseShadowCoverage.anchor },
        paddingMeters: this._courseShadowCoverage.paddingMeters,
        casterHeightMeters: this._courseShadowCoverage.casterHeightMeters,
      } : null,
      sunDirection: this._sunDirection.toArray(),
      shadowSunDirection: this._shadowSunDirection.toArray(),
      sunAngleSinceShadowRadians: angle,
      sunAngleThresholdRadians: this.shadowQuality.sunAngleThresholdRadians,
      shadowNeedsUpdate: Boolean(this.sun.shadow.needsUpdate),
      shadowAutoUpdate: Boolean(this.sun.shadow.autoUpdate),
      shadowUpdatePending: this._shadowRequestPending,
      pendingReasons: [...this._pendingShadowReasons],
      lastShadowReason: this._lastShadowReason,
      lastShadowRequestAt: numberOrNull(this._lastShadowRequestAt),
      lastShadowRenderAt: numberOrNull(this._lastShadowRenderAt),
      shadowUpdateRequests: this._shadowUpdateRequests,
      shadowRenderCount: this._shadowRenderCount,
      suppressedShadowUpdates: this._suppressedShadowUpdates,
      minUpdateIntervalMs: this.shadowQuality.minUpdateIntervalMs,
      maxSunUpdateIntervalMs: this.shadowQuality.maxSunUpdateIntervalMs,
      millisecondsSinceShadowRequest: elapsed,
      layerMask: this.sun.shadow.camera.layers.mask,
    };
  }

  // Synchronous by design: capture tooling can inspect the exact scheduling
  // decision without a GPU readback or a renderer-specific diagnostic path.
  readDiagnostics() {
    this._syncShadowRenderState();
    return this._readDiagnostics();
  }

  diagnostics() {
    return this.readDiagnostics();
  }

  onShadowUpdate(listener) {
    if (typeof listener !== 'function') throw new TypeError('Lighting.onShadowUpdate requires a function.');
    this._shadowUpdateListeners.add(listener);
    return () => this._shadowUpdateListeners.delete(listener);
  }

  onShadowRendered(listener) {
    if (typeof listener !== 'function') throw new TypeError('Lighting.onShadowRendered requires a function.');
    this._shadowRenderListeners.add(listener);
    return () => this._shadowRenderListeners.delete(listener);
  }

  // The renderer normally clears LightShadow.needsUpdate itself. This hook is
  // useful for profilers that know the shadow pass completed and want to mark the
  // exact completion time without forcing a readback or changing the render path.
  markShadowRendered(timestamp = nowMs()) {
    this._recordShadowRendered(timestamp);
    return this;
  }

  _emitShadowUpdate(reason, timestamp, forced) {
    const event = Object.freeze({
      type: 'shadow-update-requested',
      reason,
      forced: Boolean(forced),
      at: timestamp,
      diagnostics: this._readDiagnostics(),
    });
    for (const listener of this._shadowUpdateListeners) listener(event);
  }

  _canRequestShadowUpdate(timestamp, forced = false) {
    if (forced || this.sun.shadow.needsUpdate) return true;
    return !Number.isFinite(this._lastShadowRequestAt)
      || timestamp - this._lastShadowRequestAt >= this.shadowQuality.minUpdateIntervalMs;
  }

  _requestShadowUpdate(reason, timestamp, forced = false) {
    this._pendingShadowReasons.add(reason);
    if (!this._canRequestShadowUpdate(timestamp, forced)) {
      this._suppressedShadowUpdates += 1;
      return false;
    }
    if (this.sun.shadow.needsUpdate) {
      // The map is already scheduled for this frame. Keep the reason visible to
      // diagnostics, but do not manufacture another dispatch or callback.
      return false;
    }
    this.sun.shadow.needsUpdate = true;
    this._shadowRequestPending = true;
    this._lastShadowRequestAt = timestamp;
    this._lastShadowReason = reason;
    this._shadowUpdateRequests += 1;
    this._pendingShadowReasons.clear();
    this._emitShadowUpdate(reason, timestamp, forced);
    return true;
  }

  _setLightTransform(anchor) {
    this.sun.position.set(
      anchor.x + this._offset.x,
      anchor.y + this._offset.y,
      anchor.z + this._offset.z,
    );
    this.sun.target.position.copy(anchor);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
  }

  _updateLightBasis() {
    // The shadow camera looks from the light toward the target. Build the same
    // stable orthonormal frame in world space so focus snapping is performed in
    // shadow-map texels rather than arbitrary world X/Z cells.
    const forward = this._lightForward.copy(this._sunDirection).negate().normalize();
    const upReference = Math.abs(forward.y) > 0.98
      ? new Vector3(0, 0, 1)
      : _worldUp;
    this._lightRight.crossVectors(forward, upReference).normalize();
    this._lightUp.crossVectors(this._lightRight, forward).normalize();
  }

  _snapFocus(x, z) {
    if (!this.shadowQuality.focusSnap) return this._snappedFocus.set(x, 0, z);
    if (this._sunDirection.lengthSq() <= EPSILON) return this._snappedFocus.set(x, 0, z);

    this._updateLightBasis();
    const texelX = (this.sun.shadow.camera.right - this.sun.shadow.camera.left)
      / this.sun.shadow.mapSize.x;
    const texelY = (this.sun.shadow.camera.top - this.sun.shadow.camera.bottom)
      / this.sun.shadow.mapSize.y;
    const lightX = x * this._lightRight.x + z * this._lightRight.z;
    const lightY = x * this._lightUp.x + z * this._lightUp.z;
    const snappedX = Math.round(lightX / texelX) * texelX;
    const snappedY = Math.round(lightY / texelY) * texelY;
    const determinant = this._lightRight.x * this._lightUp.z
      - this._lightRight.z * this._lightUp.x;
    if (Math.abs(determinant) <= EPSILON) return this._snappedFocus.set(x, 0, z);
    this._snappedFocus.set(
      (snappedX * this._lightUp.z - this._lightRight.z * snappedY) / determinant,
      0,
      (this._lightRight.x * snappedY - snappedX * this._lightUp.x) / determinant,
    );
    if (!Number.isFinite(this._snappedFocus.x) || !Number.isFinite(this._snappedFocus.z)) {
      return this._snappedFocus.set(x, 0, z);
    }
    return this._snappedFocus;
  }

  _recenterShadowFocus(x, z) {
    this._shadowFocus.copy(this._snapFocus(x, z));
    this._lastShadowFocus.copy(this._shadowFocus);
    this._shadowFocusValid = true;
    this._setLightTransform(this._shadowFocus);
  }

  _applyCourseShadowFrustum() {
    const coverage = this._courseShadowCoverage;
    if (!coverage) return;
    this._updateLightBasis();
    const { bounds, anchor, paddingMeters, casterHeightMeters } = coverage;
    let projectedX = 0;
    let projectedY = 0;
    for (const x of [bounds.minX, bounds.maxX]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        const dx = x - anchor.x;
        const dz = z - anchor.z;
        projectedX = Math.max(projectedX, Math.abs(dx * this._lightRight.x + dz * this._lightRight.z));
        projectedY = Math.max(projectedY, Math.abs(dx * this._lightUp.x + dz * this._lightUp.z));
      }
    }
    // Trees and flight furniture rise above the ground-plane bounds. Their
    // vertical projection belongs in the light-space Y budget; the horizontal
    // padding also protects authored edge vegetation and penumbrae.
    projectedX += paddingMeters;
    projectedY += paddingMeters + Math.abs(this._lightUp.y) * casterHeightMeters;
    const baseX = Math.max(Math.abs(this.shadowQuality.frustum.left), Math.abs(this.shadowQuality.frustum.right));
    const baseY = Math.max(Math.abs(this.shadowQuality.frustum.top), Math.abs(this.shadowQuality.frustum.bottom));
    const extentX = Math.max(baseX, projectedX);
    const extentY = Math.max(baseY, projectedY);
    const camera = this.sun.shadow.camera;
    camera.left = -extentX;
    camera.right = extentX;
    camera.top = extentY;
    camera.bottom = -extentY;
    camera.updateProjectionMatrix();
  }

  // Pin the retained directional map to the authored course rather than moving
  // its projection in visible steps behind a flying ball. The complete bounds
  // are projected into the current light basis so one cached map covers the tee,
  // landing areas, tree line, and cinematic camera path.
  setCourseShadowCoverage(bounds, {
    paddingMeters = DEFAULT_COURSE_COVERAGE_PADDING_METERS,
    casterHeightMeters = DEFAULT_COURSE_COVERAGE_HEIGHT_METERS,
    now,
  } = {}) {
    if (!bounds || !['minX', 'maxX', 'minZ', 'maxZ'].every((key) => Number.isFinite(bounds[key]))
      || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) {
      throw new TypeError('Lighting.setCourseShadowCoverage requires finite positive-area X/Z bounds.');
    }
    if (!Number.isFinite(paddingMeters) || paddingMeters < 0
      || !Number.isFinite(casterHeightMeters) || casterHeightMeters < 0) {
      throw new RangeError('Course shadow padding and caster height must be finite non-negative values.');
    }
    const timestamp = nowMs(now);
    const anchor = {
      x: (bounds.minX + bounds.maxX) * 0.5,
      z: (bounds.minZ + bounds.maxZ) * 0.5,
    };
    this._courseShadowCoverage = Object.freeze({
      bounds: Object.freeze({
        minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ,
      }),
      anchor: Object.freeze(anchor),
      paddingMeters,
      casterHeightMeters,
    });
    this._applyCourseShadowFrustum();
    this._recenterShadowFocus(anchor.x, anchor.z);
    this._requestShadowUpdate('course-coverage', timestamp, true);
    return this.readDiagnostics();
  }

  configureEnvironment(environment) {
    if (!environment?.sunDirection?.value || !environment?.sunColor?.value
      || !environment?.sunIlluminanceScale || !environment?.moonDirection?.value
      || !environment?.moonIlluminanceScale || !environment?.moonColor?.value
      || !environment?.horizonColor?.value || !environment?.daylightSkyEnvelope?.value) {
      throw new TypeError('Lighting requires shared celestial EnvironmentGpuBindings.');
    }
    this._environmentUnsubscribe?.();
    const apply = () => {
      if (this._daylightRevision === environment.daylightRevision) return;
      const firstEnvironmentApply = this._daylightRevision < 0;
      this._daylightRevision = environment.daylightRevision;
      const solarStrength = Math.max(0, environment.sunIlluminanceScale.value);
      // Moon illuminance is normalized to a clear full moon in the bindings.
      // Renderer calibration and bounded eye adaptation keep it subordinate to
      // daylight while still producing readable form and shadows at night.
      const lunarStrength = Math.max(0, environment.moonIlluminanceScale.value) * 0.18;
      const moonOwnsKey = lunarStrength > solarStrength;
      const keyColor = moonOwnsKey ? environment.moonColor.value : environment.sunColor.value;
      const keyDirection = moonOwnsKey ? environment.moonDirection.value : environment.sunDirection.value;
      const keyStrength = moonOwnsKey ? lunarStrength : solarStrength;
      this._activeCelestialSource = moonOwnsKey ? 'moon' : 'sun';
      this.sun.color.setRGB(keyColor.x, keyColor.y, keyColor.z);
      // Keep the key decisively ahead of sky bounce so terrain relief and real
      // caster shadows survive the tone-map shoulder. The authored illuminance
      // still scales the complete rig; this is only the renderer-relative
      // conversion.
      this.sun.intensity = KEY_INTENSITY_AT_REFERENCE
        * keyStrength;
      this._keyRadiance.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
      const horizon = environment.horizonColor.value;
      const zenith = environment.zenithColor.value;
      this.hemi.color.setRGB(
        horizon.x * 0.34 + zenith.x * 0.66,
        horizon.y * 0.34 + zenith.y * 0.66,
        horizon.z * 0.34 + zenith.z * 0.66,
      );
      // Ground bounce follows the same horizon chromaticity, with a small
      // neutral lift so bark and turf do not turn blue/green-black in shadow.
      this.hemi.groundColor.setRGB(
        horizon.x * 0.34 + 0.018,
        horizon.y * 0.34 + 0.022,
        horizon.z * 0.29 + 0.016,
      );
      // Open-sky diffuse is a material part of outdoor illumination, not a tiny
      // cosmetic fill. Keep it decisively below the key, but high enough that a
      // north-facing rock face or trunk retains chromatic detail instead of
      // collapsing to charcoal.
      this.hemi.intensity = HEMISPHERE_INTENSITY_AT_REFERENCE
        * Math.max(environment.daylightSkyEnvelope.value.x, Math.sqrt(lunarStrength) * 0.62);

      this.setSunDirection(keyDirection, {
        force: firstEnvironmentApply,
        reason: `environment-${this._activeCelestialSource}`,
      });
    };
    apply();
    this._environmentUnsubscribe = environment.onChange(apply);
    return this;
  }

  // Update the actual directional key every time the authored sun moves, but
  // only schedule a shadow-map render once the accumulated angular difference is
  // visible or a bounded refresh interval has elapsed. The direct/sky materials
  // can therefore follow a continuous sun while the expensive depth map remains
  // temporally stable between meaningful updates.
  setSunDirection(direction, { now, force = false, reason = 'sun-direction' } = {}) {
    if (!direction || !Number.isFinite(direction.x) || !Number.isFinite(direction.y)
      || !Number.isFinite(direction.z) || direction.lengthSq?.() <= EPSILON) {
      throw new TypeError('Lighting.setSunDirection requires a non-zero finite direction.');
    }
    const timestamp = nowMs(now);
    this._syncShadowRenderState(timestamp);
    const next = direction.clone().normalize();
    this._sunDirection.copy(next);
    this._offset.copy(next).multiplyScalar(this.shadowQuality.lightDistance);

    const angle = this._shadowSunDirectionValid
      ? Math.acos(Math.min(1, Math.max(-1, this._shadowSunDirection.dot(next))))
      : Infinity;
    const hasMeaningfulAngle = angle > EPSILON;
    const maxIntervalElapsed = hasMeaningfulAngle
      && Number.isFinite(this._lastShadowRequestAt)
      && timestamp - this._lastShadowRequestAt >= this.shadowQuality.maxSunUpdateIntervalMs;
    const thresholdReached = angle >= this.shadowQuality.sunAngleThresholdRadians;
    const shouldRefresh = force || !this._shadowFocusValid || thresholdReached || maxIntervalElapsed;

    let requested = false;
    if (shouldRefresh) {
      const canRequest = this._canRequestShadowUpdate(timestamp, force);
      if (canRequest || this.sun.shadow.needsUpdate) {
        // Re-centre only when the shadow map can actually be paired with the new
        // transform. If a stagger interval suppresses this request, retain the
        // old map's focus and avoid sampling it through a new projection.
        if (this._courseShadowCoverage) this._applyCourseShadowFrustum();
        const anchor = this._courseShadowCoverage?.anchor ?? this._focus;
        this._recenterShadowFocus(anchor.x, anchor.z);
        requested = this._requestShadowUpdate(reason, timestamp, force || thresholdReached);
      } else {
        this._pendingShadowReasons.add(reason);
        this._suppressedShadowUpdates += 1;
      }
    }
    if (!requested && !this.sun.shadow.needsUpdate) {
      this._setLightTransform(this._shadowFocusValid ? this._shadowFocus : this._focus);
    }
    return requested;
  }

  updateSunDirection(direction, options = {}) {
    return this.setSunDirection(direction, options);
  }

  // The active camera owns visible shadow coverage. The two-number fallback is
  // retained for isolated scenes without a camera, never blended with gameplay.
  follow(x, z, options = {}) {
    const followOptions = options?.isCamera ? { camera: options } : (options || {});
    const camera = followOptions.camera ?? followOptions.cameraPosition;
    const cameraX = camera?.position?.x ?? camera?.x;
    const cameraZ = camera?.position?.z ?? camera?.z;
    const hasCameraFocus = Number.isFinite(cameraX) && Number.isFinite(cameraZ);
    const desiredX = hasCameraFocus ? cameraX : x;
    const desiredZ = hasCameraFocus ? cameraZ : z;
    if (!Number.isFinite(desiredX) || !Number.isFinite(desiredZ)) {
      throw new TypeError('Lighting.follow requires finite X/Z focus coordinates.');
    }

    const timestamp = nowMs(followOptions.now);
    this._syncShadowRenderState(timestamp);
    this._nextFocus.set(desiredX, 0, desiredZ);
    this._focus.copy(this._nextFocus);
    if (this._courseShadowCoverage) {
      // The complete playable footprint is already resident. Moving this camera
      // would reproject every cached tree/terrain shadow and was the source of the
      // conspicuous flight-time popping this coverage mode is designed to avoid.
      this._lastFollowAt = timestamp;
      return false;
    }
    const moved = !this._shadowFocusValid
      // Compare with the last shadow anchor, not merely the previous ball
      // sample. A ball can move less than the hysteresis distance every frame
      // while still traversing many shadow texels over a flight.
      || this._shadowFocus.distanceToSquared(this._nextFocus)
        > this.shadowQuality.focusThresholdMeters ** 2;
    if (moved) {
      // Focus movement already has a world-space hysteresis gate. Once that
      // gate trips, update immediately so the ball never outruns its cached
      // shadow footprint; the stagger interval is reserved for continuous sun
      // motion and caster invalidation bursts.
      this._recenterShadowFocus(this._focus.x, this._focus.z);
      this._requestShadowUpdate('focus', timestamp, true);
    }
    this._lastFollowAt = timestamp;
    return moved;
  }

  // The single authoritative invalidation entry point for caster/course changes.
  // Three clears this bit only after the next directional shadow render completes.
  invalidateShadow(force = false, options = {}) {
    let forced = force;
    let invalidationOptions = options;
    if (force && typeof force === 'object') {
      invalidationOptions = force;
      forced = Boolean(force.force);
    }
    const timestamp = nowMs(invalidationOptions?.now);
    this._syncShadowRenderState(timestamp);
    const reason = invalidationOptions?.reason ?? 'caster';
    // During a moving-ball frame, syncBallMesh() calls this immediately before
    // follow(). The follow call owns the recenter decision; suppressing this
    // duplicate avoids two competing shadow-map invalidations in one flight.
    if (!forced && timestamp - this._lastFollowAt < this.shadowQuality.invalidationCoalesceMs) {
      this._pendingShadowReasons.add(reason);
      this._suppressedShadowUpdates += 1;
      return false;
    }
    return this._requestShadowUpdate(reason, timestamp, Boolean(forced));
  }

  dispose() {
    this.cloudShadowTexture.dispose();
    this.cameraShadows?.dispose();
    this._environmentUnsubscribe?.();
    this._shadowUpdateListeners.clear();
    this._shadowRenderListeners.clear();
    if (this.scene.userData.environmentLighting === this) delete this.scene.userData.environmentLighting;
    this.scene.remove(this.sun, this.sun.target, this.hemi);
  }
}
