import {
  Box3,
  DepthTexture,
  Frustum,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  NoColorSpace,
  Plane,
  PerspectiveCamera,
  Quaternion,
  RenderTarget,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three';
import { WATER_REFLECTION_PROFILES } from './WaterSurface.js';

const PLANAR_MODES = new Set(['ultra', 'quality']);
const KNOWN_MODES = new Set(['ultra', 'quality', 'mobile', 'analytic', 'balanced', 'battery']);
const CAMERA_POSITION_CUT_METERS = 8;
const CAMERA_ROTATION_CUT_RADIANS = Math.PI * 25 / 180;
const CAMERA_PROJECTION_CUT_EPSILON = 1e-3;
const REFLECTION_MATERIAL_REFERENCE_PROPERTIES = Object.freeze([
  'treeEnvironment',
  'terrainEnvironment',
  'environment',
]);

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function modeValue(contract) {
  if (typeof contract === 'string') return contract;
  if (!contract || typeof contract !== 'object') return null;
  return contract.activeMode ?? contract.mode ?? contract.waterReflectionMode ?? null;
}

function normalizeMode(contract, fallback = 'analytic') {
  const raw = modeValue(contract);
  const value = String(raw ?? fallback).trim().toLowerCase();
  if (value === 'auto') return normalizeMode(fallback, 'analytic');
  if (value === 'balanced' || value === 'battery') return 'analytic';
  if (KNOWN_MODES.has(value)) return value;
  return 'analytic';
}

function requestedMode(contract, fallback = 'analytic') {
  const raw = modeValue(contract);
  return String(raw ?? fallback).trim().toLowerCase() || fallback;
}

function contractRenderScale(contract) {
  if (!contract || typeof contract !== 'object') return 1;
  return Math.min(1, Math.max(0.5, finite(contract.renderScale, 1)));
}

export function isWaterHandheldDevice(navigatorLike = globalThis.navigator) {
  const userAgent = String(navigatorLike?.userAgent ?? '');
  const platform = String(navigatorLike?.platform ?? '');
  if (/Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(userAgent)) return true;
  // iPadOS can report itself as Macintosh while retaining touch points.
  return /MacIntel/i.test(platform) && finite(navigatorLike?.maxTouchPoints) > 1;
}

export function inferInitialWaterQualityMode(environmentTier, navigatorLike = globalThis.navigator) {
  const explicit = environmentTier?.waterReflectionMode ?? environmentTier?.visualQualityMode;
  if (explicit !== undefined && explicit !== null) return normalizeMode(explicit);
  if (isWaterHandheldDevice(navigatorLike)) return 'mobile';

  const tierId = typeof environmentTier === 'string' ? environmentTier : environmentTier?.id;
  const cores = finite(navigatorLike?.hardwareConcurrency);
  const memoryGiB = finite(navigatorLike?.deviceMemory);
  if (tierId === 'high' && cores >= 12 && memoryGiB >= 8) return 'ultra';
  if (tierId === 'high') return 'quality';
  return 'analytic';
}

function strictWebGPU(renderer) {
  return renderer?.isWebGPURenderer === true
    && renderer?.backend?.isWebGPUBackend === true
    && renderer?.backend?.isWebGLBackend !== true
    && renderer?.backend?.isFallbackAdapter !== true;
}

function errorRecord(code, message, extra = {}) {
  return Object.freeze({ code, message, ...extra });
}

function createFallbackDepthTexture() {
  const texture = new DepthTexture(1, 1, UnsignedIntType);
  texture.name = 'water:analytic-depth-fallback';
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Replace the camera near plane with a view-space water plane.
 *
 * This is the Lengyel oblique-frustum construction used by Three r185's
 * ReflectorNode. The third-row write differs for WebGPU because its clip-space
 * depth interval is [0, 1], while WebGL uses [-1, 1]. Reversed depth is kept
 * fail-closed because this adapter deliberately does not guess at a second
 * projection convention.
 */
export function applyObliqueClipProjection(
  projectionMatrix,
  clipPlaneView,
  {
    coordinateSystem = WebGPUCoordinateSystem,
    clipBias = 0,
    reversedDepth = false,
  } = {},
) {
  if (reversedDepth === true) {
    throw errorRecord(
      'oblique-clip-unsupported-reversed-depth',
      'Planar water reflection requires the non-reversed Three projection convention for oblique clipping.',
    );
  }
  if (!projectionMatrix?.elements || !clipPlaneView) {
    throw errorRecord(
      'oblique-clip-invalid-input',
      'Planar water reflection oblique clipping requires a projection matrix and a view-space plane.',
    );
  }

  const clipPlane = clipPlaneView.isPlane === true
    ? new Vector4(
      clipPlaneView.normal.x,
      clipPlaneView.normal.y,
      clipPlaneView.normal.z,
      clipPlaneView.constant,
    )
    : new Vector4(clipPlaneView.x, clipPlaneView.y, clipPlaneView.z, clipPlaneView.w);
  const q = new Vector4();
  const elements = projectionMatrix.elements;
  q.x = (Math.sign(clipPlane.x) + elements[8]) / elements[0];
  q.y = (Math.sign(clipPlane.y) + elements[9]) / elements[5];
  // This is the r185 ReflectorNode construction. WebGPU's [0, 1] depth
  // interval is accounted for in the replacement row below.
  q.z = -1;
  q.w = (1 + elements[10]) / elements[14];
  const denominator = clipPlane.dot(q);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-7) {
    throw errorRecord(
      'oblique-clip-degenerate',
      'Planar water reflection oblique clipping produced a degenerate clip-plane scale.',
    );
  }
  clipPlane.multiplyScalar(1 / denominator);

  elements[2] = clipPlane.x;
  elements[6] = clipPlane.y;
  elements[10] = coordinateSystem === WebGPUCoordinateSystem
    ? clipPlane.z - clipBias
    : clipPlane.z + 1 - clipBias;
  elements[14] = clipPlane.w;
  return projectionMatrix;
}

function surfaceLevel(surface) {
  const level = surface?.level;
  return Number.isFinite(level) ? level : null;
}

function surfaceLabel(surface, index) {
  return surface?.mesh?.name || `water-surface-${index}`;
}

/**
 * Owns the optional scene-side planar water pass. WaterSurface deliberately owns
 * only shader bindings; this class owns mirrored-camera rendering, target memory,
 * cadence, visibility, history, and failure diagnostics.
 *
 * The pass is lazy. Constructing this class never allocates a render target. A
 * target pair is created only after the live quality contract requests ultra or
 * quality and a pond is visible to the gameplay camera.
 */
export class PlanarWaterReflection {
  constructor({
    renderer,
    scene,
    camera,
    surfaces = [],
    qualityMode = null,
    qualityContract = null,
    environmentTier = null,
    navigatorLike = globalThis.navigator,
    forceAnalyticOnHandheld = false,
    clipBias = 0.04,
  } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this._navigator = navigatorLike;
    this._qualityContract = typeof qualityContract === 'function' ? qualityContract : null;
    this._forceAnalyticOnHandheld = forceAnalyticOnHandheld === true;
    this._startupMode = normalizeMode(
      qualityMode ?? inferInitialWaterQualityMode(environmentTier, navigatorLike),
    );
    this._clipBias = Math.max(0.005, finite(clipBias, 0.04));
    this._mode = this._startupMode;
    this._requestedMode = this._startupMode;
    this._contractSynced = false;
    this._contractReason = null;
    this._frame = 0;
    this._revision = 0;
    this._lastCameraCut = false;
    this._lastVisibleSurfaces = 0;
    this._lastRenderedSurfaces = 0;
    this._lastError = null;
    this._disabled = false;
    this._disposed = false;
    this._cameraState = {
      valid: false,
      position: new Vector3(),
      quaternion: camera?.quaternion?.clone() ?? new Quaternion(),
      projection: new Matrix4(),
    };
    this._mirrorCamera = new PerspectiveCamera();
    this._sourceViewProjection = new Matrix4();
    this._mirrorViewProjection = new Matrix4();
    this._currentMirrorDirection = new Vector3();
    this._sourceWorldPosition = new Vector3();
    this._sourceWorldQuaternion = new Quaternion();
    this._sourceWorldUp = new Vector3();
    this._mirrorTarget = new Vector3();
    this._waterNormal = new Vector3(0, 1, 0);
    // Plane.applyMatrix4 transforms its owned normal in place. Keep that
    // transformed view-space normal separate from the immutable world-up source
    // so preparing the same mirrored camera twice is deterministic.
    this._waterPlane = new Plane(new Vector3(0, 1, 0), 0);
    this._mirrorPlaneDistance = 0;
    this._frustum = new Frustum();
    this._bounds = new Box3();
    this._drawingBufferSize = new Vector2();
    this._surfaceStates = new Map();
    this._reflectionMaterialVariants = new WeakMap();
    this._reflectionMaterialVariantEntries = new Set();
    this._setSurfaces(surfaces);
    this._fallbackDepthTexture = createFallbackDepthTexture();
    // Establish a depth-typed binding before the first renderer frame. The
    // analytic contract still reports depthAvailable=false, but the node slot
    // never has to change from WaterSurface's color fallback to a depth view.
    for (const state of this._surfaceStates.values()) {
      this._bindAnalyticOrPending(state, this._mode);
    }

    // Target allocation is intentionally deferred until the first update after
    // renderer initialization. This keeps analytic/mobile bootstrap zero-target.
    this.assetsReady = Promise.resolve();
  }

  _setSurfaces(surfaces) {
    for (const surface of surfaces || []) {
      if (!surface || this._surfaceStates.has(surface)) continue;
      this._surfaceStates.set(surface, {
        surface,
        label: surfaceLabel(surface, this._surfaceStates.size),
        targets: [],
        targetWidth: 0,
        targetHeight: 0,
        resolutionScale: 0,
        writeIndex: 0,
        currentTarget: null,
        historyTarget: null,
        currentMatrix: new Matrix4(),
        historyMatrix: new Matrix4(),
        hasCurrentMatrix: false,
        lastUpdatedFrame: -1,
        renderCount: 0,
        skippedCount: 0,
        visible: false,
        clipDistance: 0,
        lastSkipReason: null,
        allocationError: null,
      });
    }
  }

  _readQualityContract() {
    let contract = null;
    if (this._qualityContract) {
      try {
        contract = this._qualityContract();
      } catch (error) {
        this._contractReason = errorRecord(
          'quality-contract-error',
          `Water quality contract failed: ${error?.message || error}`,
        );
      }
    }

    const raw = requestedMode(contract, this._startupMode);
    let mode = normalizeMode(contract, this._startupMode);
    if (this._forceAnalyticOnHandheld && isWaterHandheldDevice(this._navigator)) {
      mode = 'mobile';
      this._contractReason = 'handheld-analytic-contract';
    } else if (!KNOWN_MODES.has(raw) && raw !== 'auto') {
      this._contractReason = `unsupported-quality-mode:${raw}`;
    } else if (!this._contractReason || typeof this._contractReason === 'string') {
      this._contractReason = null;
    }
    return {
      mode,
      requestedMode: mode === 'mobile' && raw !== 'mobile' ? 'mobile' : raw,
      renderScale: contractRenderScale(contract),
    };
  }

  _setMode(mode, requested) {
    const changed = this._mode !== mode;
    this._mode = mode;
    this._requestedMode = requested;
    if (!changed && this._contractSynced) return;

    this._disabled = false;
    this._lastError = null;
    if (changed) this._releaseTargets();
    for (const state of this._surfaceStates.values()) {
      this._bindAnalyticOrPending(state, mode);
    }
    this._contractSynced = true;
  }

  _bindAnalyticOrPending(state, mode) {
    const surfaceMode = mode === 'mobile' ? 'mobile' : mode;
    try {
      state.surface.setReflectionInput({
        mode: surfaceMode,
        depthTexture: this._fallbackDepthTexture,
        depthAvailable: false,
        currentValid: false,
        valid: false,
        revision: this._revision,
        frame: this._frame,
        cameraCut: true,
      });
    } catch (error) {
      state.lastSkipReason = `surface-input-error:${error?.message || error}`;
    }
  }

  _releaseStateTargets(state) {
    for (const target of state.targets) target?.dispose?.();
    state.targets = [];
    state.targetWidth = 0;
    state.targetHeight = 0;
    state.resolutionScale = 0;
    state.writeIndex = 0;
    state.currentTarget = null;
    state.historyTarget = null;
    state.hasCurrentMatrix = false;
    state.lastUpdatedFrame = -1;
    state.allocationError = null;
  }

  _releaseTargets() {
    for (const state of this._surfaceStates.values()) this._releaseStateTargets(state);
  }

  _strictAvailability() {
    if (!strictWebGPU(this.renderer)) {
      return errorRecord(
        'strict-webgpu-required',
        'Planar water reflection requires the initialized strict WebGPU renderer; no fallback pass is permitted.',
      );
    }
    if (this.renderer.initialized === false) {
      return errorRecord(
        'renderer-not-initialized',
        'Planar water reflection deferred until the strict WebGPU renderer is initialized.',
      );
    }
    if (typeof this.renderer.getDrawingBufferSize !== 'function'
      || typeof this.renderer.initRenderTarget !== 'function'
      || typeof this.renderer.setRenderTarget !== 'function'
      || typeof this.renderer.render !== 'function') {
      return errorRecord(
        'renderer-contract-incomplete',
        'Three r185 does not expose the render-target initialization and render methods required by the planar pass.',
      );
    }
    if (!this.scene?.isScene || !this.camera?.isPerspectiveCamera) {
      return errorRecord(
        'scene-camera-contract-incomplete',
        'Planar water reflection requires a THREE.Scene and PerspectiveCamera.',
      );
    }
    return null;
  }

  _targetSize(mode, renderScale = 1) {
    const profile = WATER_REFLECTION_PROFILES[mode];
    if (!profile || profile.source !== 'planar') return null;
    this.renderer.getDrawingBufferSize(this._drawingBufferSize);
    const width = Math.floor(finite(this._drawingBufferSize.x));
    const height = Math.floor(finite(this._drawingBufferSize.y));
    if (width < 1 || height < 1) {
      throw new Error('The WebGPU drawing buffer has no positive dimensions.');
    }
    // Keep the reflected second scene proportional to the production scene source.
    // Native Ultra retains its authored half-resolution target; under dynamic
    // pressure the reflection cannot contribute detail above the main source scale.
    const resolutionScale = profile.resolutionScale
      * Math.min(1, Math.max(0.5, finite(renderScale, 1)));
    return {
      width: Math.max(1, Math.floor(width * resolutionScale)),
      height: Math.max(1, Math.floor(height * resolutionScale)),
      resolutionScale,
    };
  }

  _makeTarget(width, height, label) {
    const depthTexture = new DepthTexture(width, height, UnsignedIntType);
    depthTexture.name = `${label}:depth`;
    depthTexture.magFilter = NearestFilter;
    depthTexture.minFilter = NearestFilter;
    depthTexture.flipY = false;
    const target = new RenderTarget(width, height, {
      type: HalfFloatType,
      colorSpace: NoColorSpace,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      depthTexture,
      samples: 0,
    });
    target.texture.name = `${label}:color`;
    target.texture.flipY = false;
    return target;
  }

  _ensureTargets(state, size) {
    const sameSize = state.targets.length === 2
      && state.targetWidth === size.width && state.targetHeight === size.height;
    if (sameSize) {
      state.resolutionScale = size.resolutionScale;
      return true;
    }
    this._releaseStateTargets(state);
    let targets = [];
    try {
      targets = [
        this._makeTarget(size.width, size.height, `${state.label}:a`),
        this._makeTarget(size.width, size.height, `${state.label}:b`),
      ];
      for (const target of targets) this.renderer.initRenderTarget(target);
      state.targets = targets;
      state.targetWidth = size.width;
      state.targetHeight = size.height;
      state.resolutionScale = size.resolutionScale;
      state.allocationError = null;
      return true;
    } catch (error) {
      for (const target of state.targets) target?.dispose?.();
      state.targets = [];
      state.targetWidth = 0;
      state.targetHeight = 0;
      state.resolutionScale = 0;
      state.allocationError = errorRecord(
        'target-allocation-failed',
        `Planar water reflection target allocation failed: ${error?.message || error}`,
      );
      this._lastError = state.allocationError;
      for (const target of targets) target?.dispose?.();
      this._disabled = true;
      return false;
    }
  }

  _updateCameraCut() {
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldPosition(this._sourceWorldPosition);
    this.camera.getWorldQuaternion(this._sourceWorldQuaternion);
    const projection = this.camera.projectionMatrix;
    let cut = false;
    if (this._cameraState.valid) {
      cut = this._cameraState.position.distanceTo(this._sourceWorldPosition)
        > CAMERA_POSITION_CUT_METERS
        || this._cameraState.quaternion.angleTo(this._sourceWorldQuaternion)
        > CAMERA_ROTATION_CUT_RADIANS;
      const before = this._cameraState.projection.elements;
      const after = projection.elements;
      for (let i = 0; i < 16 && !cut; i += 1) {
        if (Math.abs(before[i] - after[i]) > CAMERA_PROJECTION_CUT_EPSILON) cut = true;
      }
    }
    if (cut) this._revision += 1;
    this._cameraState.position.copy(this._sourceWorldPosition);
    this._cameraState.quaternion.copy(this._sourceWorldQuaternion);
    this._cameraState.projection.copy(projection);
    this._cameraState.valid = true;
    this._lastCameraCut = cut;
    this._sourceViewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    return cut;
  }

  _isVisible(state) {
    const surface = state.surface;
    const level = surfaceLevel(surface);
    const mesh = surface?.mesh;
    if (!mesh?.visible || !mesh.parent || level === null) {
      state.lastSkipReason = 'surface-hidden-or-invalid';
      return false;
    }
    if (this._sourceWorldPosition.y <= level + this._clipBias) {
      state.lastSkipReason = 'camera-not-above-water';
      return false;
    }
    mesh.updateWorldMatrix(true, false);
    this._bounds.setFromObject(mesh);
    if (this._bounds.isEmpty()) {
      state.lastSkipReason = 'empty-water-bounds';
      return false;
    }
    const coordinateSystem = this.camera.coordinateSystem;
    if (coordinateSystem === undefined) this._frustum.setFromProjectionMatrix(this._sourceViewProjection);
    else this._frustum.setFromProjectionMatrix(this._sourceViewProjection, coordinateSystem);
    if (!this._frustum.intersectsBox(this._bounds)) {
      state.lastSkipReason = 'outside-camera-frustum';
      return false;
    }
    state.lastSkipReason = null;
    return true;
  }

  _prepareMirrorCamera(level) {
    const source = this.camera;
    this._mirrorCamera.copy(source);
    this._mirrorCamera.coordinateSystem = source.coordinateSystem;
    this._mirrorCamera.position.copy(this._sourceWorldPosition);
    this._mirrorCamera.position.y = level * 2 - this._mirrorCamera.position.y;

    source.getWorldQuaternion(this._sourceWorldQuaternion);
    this._currentMirrorDirection.set(0, 0, -1)
      .applyQuaternion(this._sourceWorldQuaternion)
      .normalize();
    this._sourceWorldUp.set(0, 1, 0)
      .applyQuaternion(this._sourceWorldQuaternion)
      .normalize();
    this._currentMirrorDirection.y *= -1;
    this._sourceWorldUp.y *= -1;
    this._mirrorCamera.up.copy(this._sourceWorldUp);
    this._mirrorTarget.copy(this._mirrorCamera.position).add(this._currentMirrorDirection);
    this._mirrorCamera.lookAt(this._mirrorTarget);

    // The reflected camera sits below the plane and looks upward. This distance
    // check is only a visibility/conditioning guard; it is not the clip itself.
    // The actual below-water exclusion is the oblique projection plane below.
    const directionY = this._currentMirrorDirection.y;
    const planeDistance = directionY > 1e-5
      ? (level - this._mirrorCamera.position.y) / directionY
      : 0;
    if (!Number.isFinite(planeDistance) || planeDistance <= 0) {
      throw errorRecord(
        'reflection-clip-guard-rejected',
        'Mirrored camera could not establish a positive water-plane clip distance.',
      );
    }
    if (planeDistance <= source.near || planeDistance >= source.far) {
      throw errorRecord(
        'reflection-clip-guard-out-of-range',
        'Mirrored camera water-plane clip distance falls outside the source camera range.',
      );
    }
    this._mirrorCamera.near = source.near;
    this._mirrorCamera.far = source.far;
    this._mirrorCamera.updateProjectionMatrix();
    this._mirrorCamera.updateMatrixWorld(true);

    const coordinateSystem = source.coordinateSystem ?? this.renderer.coordinateSystem;
    if (this.renderer.reversedDepthBuffer === true || this._mirrorCamera.reversedDepth === true) {
      throw errorRecord(
        'oblique-clip-unsupported-reversed-depth',
        'Planar water reflection is disabled because the active Three renderer uses reversed depth, which this adapter does not emulate.',
      );
    }
    this._waterPlane.set(this._waterNormal, -(level + this._clipBias));
    this._waterPlane.applyMatrix4(this._mirrorCamera.matrixWorldInverse);
    applyObliqueClipProjection(this._mirrorCamera.projectionMatrix, this._waterPlane, {
      coordinateSystem,
      clipBias: 0,
    });
    // Direct renderer.render consumes projectionMatrix, while other Three
    // systems may inspect projectionMatrixInverse during the same pass.
    this._mirrorCamera.projectionMatrixInverse.copy(this._mirrorCamera.projectionMatrix).invert();
    this._mirrorViewProjection.multiplyMatrices(
      this._mirrorCamera.projectionMatrix,
      this._mirrorCamera.matrixWorldInverse,
    );
    this._mirrorPlaneDistance = planeDistance;
  }

  _hideReflectionExcludedMeshes() {
    const visibility = [];
    this.scene.traverse((object) => {
      if (object?.userData?.planarReflectionDetail !== 'terrain-substrate' || !object.visible) return;
      visibility.push([object, true]);
      object.visible = false;
    });
    for (const state of this._surfaceStates.values()) {
      const mesh = state.surface?.mesh;
      if (!mesh || visibility.some(([object]) => object === mesh)) continue;
      visibility.push([mesh, mesh.visible]);
      mesh.visible = false;
    }
    return visibility;
  }

  _restoreVisibility(visibility) {
    for (const [mesh, visible] of visibility) mesh.visible = visible;
  }

  _reflectionMaterialVariant(material) {
    let variant = this._reflectionMaterialVariants.get(material);
    if (variant) return variant;
    if (typeof material.clone !== 'function') {
      throw errorRecord(
        'reflection-material-clone-failed',
        `Visible MRT material ${material.name || material.type || 'unnamed'} cannot provide a cached reflection clone.`,
      );
    }
    try {
      variant = material.clone();
      for (const property of REFLECTION_MATERIAL_REFERENCE_PROPERTIES) {
        if (property in material) variant[property] = material[property];
      }
      variant.mrtNode = null;
      this._reflectionMaterialVariants.set(material, variant);
      this._reflectionMaterialVariantEntries.add({ material, variant });
      return variant;
    } catch (error) {
      throw errorRecord(
        'reflection-material-clone-failed',
        `Visible MRT material ${material.name || material.type || 'unnamed'} could not be cloned for reflection: ${error?.message || error}`,
      );
    }
  }

  _swapVisibleReflectionMaterials() {
    const changed = [];
    const restore = () => {
      for (let i = changed.length - 1; i >= 0; i -= 1) {
        changed[i].object.material = changed[i].material;
      }
    };
    try {
      this.scene.traverseVisible((object) => {
        if (!object.material) return;
        if (Array.isArray(object.material)) {
          let replacement = null;
          for (let i = 0; i < object.material.length; i += 1) {
            const material = object.material[i];
            if (material?.mrtNode == null) continue;
            replacement ??= object.material.slice();
            replacement[i] = this._reflectionMaterialVariant(material);
          }
          if (replacement) {
            changed.push({ object, material: object.material });
            object.material = replacement;
          }
          return;
        }
        if (object.material.mrtNode == null) return;
        changed.push({ object, material: object.material });
        object.material = this._reflectionMaterialVariant(object.material);
      });
      return { restore };
    } catch (error) {
      restore();
      throw error;
    }
  }

  _renderState(state, cameraCut) {
    const target = state.targets[state.writeIndex];
    if (!target) throw new Error('Planar water reflection target pair is incomplete.');
    const previousTarget = state.currentTarget;
    const previousMatrix = state.currentMatrix.clone();
    const oldTarget = this.renderer.getRenderTarget?.() ?? null;
    const visibility = this._hideReflectionExcludedMeshes();
    let materialVariants = null;
    try {
      materialVariants = this._swapVisibleReflectionMaterials();
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this._mirrorCamera);
    } finally {
      try {
        this.renderer.setRenderTarget(oldTarget);
      } finally {
        try {
          materialVariants?.restore();
        } finally {
          this._restoreVisibility(visibility);
        }
      }
    }

    state.currentTarget = target;
    state.historyTarget = cameraCut ? null : previousTarget;
    if (state.historyTarget) state.historyMatrix.copy(previousMatrix);
    else state.historyMatrix.copy(this._mirrorViewProjection);
    state.currentMatrix.copy(this._mirrorViewProjection);
    state.hasCurrentMatrix = true;
    state.lastUpdatedFrame = this._frame;
    state.renderCount += 1;
    state.writeIndex = (state.writeIndex + 1) % state.targets.length;
  }

  _bindState(state, { cameraCut = false, currentValid = true } = {}) {
    const profile = WATER_REFLECTION_PROFILES[this._mode];
    const current = state.currentTarget;
    const history = state.historyTarget;
    const currentMatrix = state.hasCurrentMatrix ? state.currentMatrix : this._mirrorViewProjection;
    const previousMatrix = history ? state.historyMatrix : currentMatrix;
    const staleFrames = state.lastUpdatedFrame >= 0
      ? Math.max(0, this._frame - state.lastUpdatedFrame) : 0;
    const historyValid = !!history && !cameraCut
      && staleFrames <= (profile?.maxHistoryFrames ?? 0);
    try {
      state.surface.setReflectionInput({
        mode: this._mode,
        colorTexture: current?.texture ?? null,
        depthTexture: current?.depthTexture ?? this._fallbackDepthTexture,
        historyTexture: history?.texture ?? null,
        viewProjectionMatrix: currentMatrix,
        previousViewProjectionMatrix: previousMatrix,
        width: state.targetWidth,
        height: state.targetHeight,
        resolutionScale: state.resolutionScale || profile?.resolutionScale || 0,
        revision: this._revision,
        frame: this._frame,
        lastUpdatedFrame: state.lastUpdatedFrame >= 0 ? state.lastUpdatedFrame : this._frame,
        updateIntervalFrames: profile?.updateIntervalFrames ?? 1,
        historyValid,
        historyWeight: profile?.temporalWeight ?? 0,
        maxHistoryFrames: profile?.maxHistoryFrames ?? 0,
        currentValid: !!current && currentValid,
        valid: !!current && currentValid,
        depthAvailable: !!current?.depthTexture,
        cameraCut,
        flipY: false,
      });
    } catch (error) {
      state.lastSkipReason = `surface-input-error:${error?.message || error}`;
      this._lastError = errorRecord('surface-input-failed', state.lastSkipReason);
    }
  }

  update(options = {}) {
    if (this._disposed) return 0;
    this._frame += 1;
    const force = options === true || options?.force === true;
    const contract = this._readQualityContract();
    this._setMode(contract.mode, contract.requestedMode);

    if (!PLANAR_MODES.has(this._mode)) {
      this._lastVisibleSurfaces = 0;
      this._lastRenderedSurfaces = 0;
      return 0;
    }

    if (this._disabled) {
      for (const state of this._surfaceStates.values()) {
      this._bindState(state, { cameraCut: true, currentValid: false });
      }
      return 0;
    }

    const availability = this._strictAvailability();
    if (availability) {
      this._lastError = availability;
      this._disabled = availability.code !== 'renderer-not-initialized';
      for (const state of this._surfaceStates.values()) this._bindState(state, { currentValid: false, cameraCut: true });
      return 0;
    }

    let cameraCut;
    try {
      cameraCut = this._updateCameraCut();
    } catch (error) {
      this._lastError = errorRecord(
        'camera-contract-failed',
        `Planar water reflection camera update failed: ${error?.message || error}`,
      );
      return 0;
    }

    let size;
    try {
      size = this._targetSize(this._mode, contract.renderScale);
    } catch (error) {
      this._lastError = errorRecord(
        'drawing-buffer-size-failed',
        `Planar water reflection could not resolve its target size: ${error?.message || error}`,
      );
      return 0;
    }

    let visibleCount = 0;
    let renderedCount = 0;
    for (const state of this._surfaceStates.values()) {
      const visible = this._isVisible(state);
      state.visible = visible;
      if (!visible) {
        if (cameraCut) state.historyTarget = null;
        if (state.currentTarget) this._bindState(state, { cameraCut, currentValid: !cameraCut });
        continue;
      }
      visibleCount += 1;
      if (!this._ensureTargets(state, size)) {
        this._bindState(state, { cameraCut: true, currentValid: false });
        continue;
      }

      try {
        this._prepareMirrorCamera(surfaceLevel(state.surface));
        state.clipDistance = this._mirrorPlaneDistance;
      } catch (error) {
        const record = error.code ? error : errorRecord(
          'reflection-camera-failed',
          `Mirrored water camera failed: ${error?.message || error}`,
        );
        state.lastSkipReason = record.code;
        this._lastError = record;
        this._bindState(state, { cameraCut: true, currentValid: false });
        continue;
      }

      const profile = WATER_REFLECTION_PROFILES[this._mode];
      const due = force || cameraCut || !state.currentTarget
        || this._frame - state.lastUpdatedFrame >= profile.updateIntervalFrames;
      if (!due) {
        state.skippedCount += 1;
        this._bindState(state, { cameraCut: false, currentValid: true });
        continue;
      }

      try {
        this._renderState(state, cameraCut);
        this._bindState(state, { cameraCut, currentValid: true });
        renderedCount += 1;
      } catch (error) {
        const record = errorRecord(
          'reflection-render-failed',
          `Planar water reflection render failed: ${error?.message || error}`,
          { frame: this._frame, surface: state.label },
        );
        state.lastSkipReason = record.code;
        this._lastError = record;
        this._disabled = true;
        this._bindState(state, { cameraCut: true, currentValid: false });
      }
    }
    this._lastVisibleSurfaces = visibleCount;
    this._lastRenderedSurfaces = renderedCount;
    return renderedCount;
  }

  capture(options = {}) {
    return this.update({ ...options, force: true });
  }

  surfaceDiagnostics(surface) {
    const state = this._surfaceStates.get(surface);
    const profile = WATER_REFLECTION_PROFILES[this._mode];
    return {
      version: 1,
      mode: this._mode,
      requestedMode: this._requestedMode,
      planarRequested: PLANAR_MODES.has(this._mode),
      strictWebGPU: strictWebGPU(this.renderer),
      ready: !PLANAR_MODES.has(this._mode) || !!state?.currentTarget,
      allocatedTargets: state?.targets.length ?? 0,
      size: state && state.targetWidth > 0 && state.targetHeight > 0
        ? { width: state.targetWidth, height: state.targetHeight } : 0,
      resolutionScale: state?.resolutionScale || profile?.resolutionScale || 0,
      updateIntervalFrames: profile?.updateIntervalFrames ?? 0,
      frame: this._frame,
      lastUpdatedFrame: state?.lastUpdatedFrame ?? -1,
      staleFrames: state?.lastUpdatedFrame >= 0
        ? Math.max(0, this._frame - state.lastUpdatedFrame) : 0,
      renderCount: state?.renderCount ?? 0,
      skippedCount: state?.skippedCount ?? 0,
      visible: state?.visible ?? false,
      revision: this._revision,
      cameraCut: this._lastCameraCut,
      clipGuard: {
        strategy: 'oblique-projection-plane',
        coordinateSystem: this.camera?.coordinateSystem ?? this.renderer?.coordinateSystem ?? null,
        belowWaterGeometryClipped: true,
        bias: this._clipBias,
        planeDistance: state?.clipDistance ?? this._mirrorPlaneDistance,
      },
      visibilityGuard: {
        waterMeshesHiddenDuringCapture: true,
        sourceCameraBladeListsExcluded: true,
        roughReflectionSource: 'authoritative-terrain-substrate',
        visibleSurfaceCount: this._lastVisibleSurfaces,
        lastSkipReason: state?.lastSkipReason ?? null,
      },
      error: state?.allocationError ?? this._lastError,
      contractReason: this._contractReason,
    };
  }

  diagnostics() {
    return {
      version: 1,
      mode: this._mode,
      requestedMode: this._requestedMode,
      source: PLANAR_MODES.has(this._mode) && this._lastRenderedSurfaces > 0
        ? 'planar' : 'analytic-sky',
      strictWebGPU: strictWebGPU(this.renderer),
      disabled: this._disabled,
      frame: this._frame,
      revision: this._revision,
      cameraCut: this._lastCameraCut,
      visibleSurfaceCount: this._lastVisibleSurfaces,
      renderedSurfaceCount: this._lastRenderedSurfaces,
      error: this._lastError,
      surfaces: [...this._surfaceStates.keys()].map((surface) => this.surfaceDiagnostics(surface)),
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._releaseTargets();
    for (const { variant } of this._reflectionMaterialVariantEntries) variant.dispose?.();
    this._reflectionMaterialVariantEntries.clear();
    this._reflectionMaterialVariants = new WeakMap();
    this._fallbackDepthTexture?.dispose?.();
    this._fallbackDepthTexture = null;
    this._surfaceStates.clear();
  }
}
