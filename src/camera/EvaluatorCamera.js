import { Quaternion, Vector3 } from 'three';

/**
 * Programmatic camera control for deterministic capture/evaluation harnesses.
 *
 * This controller deliberately owns only the live camera and the simulation
 * freeze flag. It does not replace CameraDirector or FreeCamera: main.js gives
 * it update priority while `active`, then restores the previous owner on exit.
 */
export const EVALUATOR_CAMERA_API_VERSION = '1.0';

const EPSILON = 1e-7;

function vector(value, name) {
  if (value instanceof Vector3) return value.clone();
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => !Number.isFinite(n))) {
    throw new TypeError(`${name} must be a finite [x, y, z] array or THREE.Vector3.`);
  }
  return new Vector3(value[0], value[1], value[2]);
}

function quaternion(value, name) {
  if (value instanceof Quaternion) return value.clone();
  if (!Array.isArray(value) || value.length !== 4 || value.some((n) => !Number.isFinite(n))) {
    throw new TypeError(`${name} must be a finite [x, y, z, w] array or THREE.Quaternion.`);
  }
  return new Quaternion(value[0], value[1], value[2], value[3]).normalize();
}

function plainVector(value) { return [value.x, value.y, value.z]; }
function plainQuaternion(value) { return [value.x, value.y, value.z, value.w]; }

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite.`);
  return value;
}

function copyVector(target, value) { target.copy(value); return target; }

/**
 * @param {object} options
 * @param {import('three').PerspectiveCamera} options.camera
 * @param {object} options.sceneManager SceneManager-like temporal/freeze hooks
 * @param {object} [options.director] CameraDirector-like state to preserve
 * @param {object} [options.freeCamera] FreeCamera-like owner to suspend/restore
 */
export class EvaluatorCamera {
  constructor({ camera, sceneManager, director = null, freeCamera = null } = {}) {
    if (!camera) throw new TypeError('EvaluatorCamera requires a camera.');
    if (!sceneManager) throw new TypeError('EvaluatorCamera requires a sceneManager.');
    this.camera = camera;
    this.sceneManager = sceneManager;
    this.director = director;
    this.freeCamera = freeCamera;
    this.version = EVALUATOR_CAMERA_API_VERSION;
    this.apiVersion = EVALUATOR_CAMERA_API_VERSION;
    this.namespace = 'evaluatorCamera';
    this.active = false;

    this._saved = null;
    this._frame = 0;
    this._frameSequence = 0;
    this._continuousMotionUntilSequence = 0;
    this._waiters = [];
    this._lookAt = this._lookAtFromCamera(camera.position);
    this._pose = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
      lookAt: this._lookAtFromCamera(camera.position),
    };
  }

  get owned() { return this.active; }
  get simulationFrozen() { return !!this.sceneManager.freezeSimulation; }
  // Keep adaptive renderer workloads fixed while a live editor/evaluator dolly
  // is producing frames. Two presented frames of quiet terminate the motion
  // window; this is long enough to cover a move submitted between animation
  // ticks without turning evaluator ownership into a permanent quality lock.
  get continuousMotionActive() {
    return this.active && this._frameSequence < this._continuousMotionUntilSequence;
  }

  // Kept as an explicit hook so the main loop can give evaluator ownership a
  // stable update slot. The pose is intentionally not damped or re-resolved.
  update() { return this.getState(); }

  /** Claim camera ownership. Calling enter twice is idempotent. */
  enter() {
    if (this.active) return this.getState();
    this._saved = {
      camera: this._captureCamera(),
      director: this._captureDirector(),
      freeCamera: this.freeCamera ? {
        active: !!this.freeCamera.active,
        yaw: this.freeCamera.yaw,
        pitch: this.freeCamera.pitch,
        groundClearance: this.freeCamera.groundClearance,
      } : null,
      freezeSimulation: !!this.sceneManager.freezeSimulation,
    };
    this._lookAt = this._saved.camera.lookAt.clone();
    // A keyboard free camera must not continue mutating the same camera while
    // the evaluator owns it. Its prior active state is restored in exit().
    if (this.freeCamera?.active) this.freeCamera.exit();
    this.active = true;
    this._continuousMotionUntilSequence = this._frameSequence;
    return this.getState();
  }

  /**
   * Relinquish ownership and restore the exact camera/director/free-camera
   * state that existed at enter(). Restoration itself is a temporal cut: the
   * renderer must reject frames rendered from the evaluator viewpoint.
   */
  exit({ restore = true } = {}) {
    if (!this.active) return this.getState();
    const saved = this._saved;
    this.active = false;
    if (restore && saved) {
      this._applyCamera(saved.camera, false);
      this._restoreDirector(saved.director);
      this.sceneManager.freezeSimulation = saved.freezeSimulation;
      if (saved.freeCamera?.active && this.freeCamera) {
        this.freeCamera.enter();
        if (Number.isFinite(saved.freeCamera.yaw)) this.freeCamera.yaw = saved.freeCamera.yaw;
        if (Number.isFinite(saved.freeCamera.pitch)) this.freeCamera.pitch = saved.freeCamera.pitch;
        if (Number.isFinite(saved.freeCamera.groundClearance)) {
          this.freeCamera.groundClearance = saved.freeCamera.groundClearance;
        }
      }
    }
    this._saved = null;
    this._continuousMotionUntilSequence = this._frameSequence;
    this._invalidate('evaluator camera restore');
    return this.getState();
  }

  takeOwnership() { return this.enter(); }
  releaseOwnership(options) { return this.exit(options); }
  restore() { return this.exit(); }

  /** Set an exact pose, or a position plus a lookAt target. */
  setPose({ position, lookAt, quaternion: q, fov } = {}) {
    this._requireOwnership();
    if (position === undefined) throw new TypeError('setPose requires position.');
    const nextPosition = vector(position, 'position');
    if (lookAt !== undefined && q !== undefined) {
      throw new TypeError('setPose accepts either lookAt or quaternion, not both.');
    }
    const nextLookAt = lookAt === undefined ? null : vector(lookAt, 'lookAt');
    const nextQuaternion = q !== undefined
      ? quaternion(q, 'quaternion')
      : this._quaternionLookingAt(nextPosition, nextLookAt ?? this._lookAtFromCamera(nextPosition));
    const nextFov = fov === undefined ? this.camera.fov : finiteNumber(fov, 'fov');
    if (nextFov <= 0 || nextFov >= 180) throw new RangeError('fov must be greater than 0 and less than 180 degrees.');
    const changed = this._cameraChanged(nextPosition, nextQuaternion, nextFov);
    this._applyCamera({
      position: nextPosition,
      quaternion: nextQuaternion,
      fov: nextFov,
      lookAt: nextLookAt ?? this._lookAtFromQuaternion(nextPosition, nextQuaternion),
    }, changed);
    return this.getState();
  }

  /**
   * Move an owned evaluator camera without declaring a temporal cut.
   *
   * Use this for continuous dollies, walkthroughs, and authoring-camera paths.
   * `setPose()` remains the deterministic cut API for jumping between review
   * viewpoints. Renderers can therefore preserve motion/temporal history while
   * the course editor moves the same camera over successive live frames.
   */
  movePose({ position, lookAt, quaternion: q, fov } = {}) {
    this._requireOwnership();
    if (position === undefined) throw new TypeError('movePose requires position.');
    const nextPosition = vector(position, 'position');
    if (lookAt !== undefined && q !== undefined) {
      throw new TypeError('movePose accepts either lookAt or quaternion, not both.');
    }
    const nextLookAt = lookAt === undefined ? null : vector(lookAt, 'lookAt');
    const nextQuaternion = q !== undefined
      ? quaternion(q, 'quaternion')
      : this._quaternionLookingAt(nextPosition, nextLookAt ?? this._lookAtFromCamera(nextPosition));
    const nextFov = fov === undefined ? this.camera.fov : finiteNumber(fov, 'fov');
    if (nextFov <= 0 || nextFov >= 180) throw new RangeError('fov must be greater than 0 and less than 180 degrees.');
    this._applyCamera({
      position: nextPosition,
      quaternion: nextQuaternion,
      fov: nextFov,
      lookAt: nextLookAt ?? this._lookAtFromQuaternion(nextPosition, nextQuaternion),
    }, false);
    this._continuousMotionUntilSequence = this._frameSequence + 2;
    return this.getState();
  }

  setPosition(position, options = {}) {
    return this.setPose({ ...options, position });
  }

  setFov(fov) {
    this._requireOwnership();
    const nextFov = finiteNumber(fov, 'fov');
    if (nextFov <= 0 || nextFov >= 180) throw new RangeError('fov must be greater than 0 and less than 180 degrees.');
    const changed = Math.abs(this.camera.fov - nextFov) > EPSILON;
    this._applyCamera({
      position: this.camera.position,
      quaternion: this.camera.quaternion,
      fov: nextFov,
      lookAt: this._lookAt,
    }, changed);
    return this.getState();
  }

  /**
   * Place the camera on a sphere around target. Angles are radians: azimuth is
   * measured from +Z toward +X, elevation is measured above the horizontal.
   * `azimuthRadians`/`elevationRadians` are accepted as explicit aliases.
   */
  orbit({ target, radius, distance, azimuth, elevation, azimuthRadians, elevationRadians, fov } = {}) {
    this._requireOwnership();
    const nextTarget = vector(target, 'target');
    const currentOffset = this.camera.position.clone().sub(nextTarget);
    const requestedRadius = radius ?? distance;
    const nextRadius = requestedRadius === undefined
      ? currentOffset.length()
      : finiteNumber(requestedRadius, radius === undefined ? 'distance' : 'radius');
    if (nextRadius <= 0) throw new RangeError('radius must be greater than zero.');
    const nextAzimuth = azimuthRadians ?? azimuth ?? Math.atan2(currentOffset.x, currentOffset.z);
    const nextElevation = elevationRadians ?? elevation
      ?? Math.atan2(currentOffset.y, Math.hypot(currentOffset.x, currentOffset.z));
    finiteNumber(nextAzimuth, 'azimuth');
    finiteNumber(nextElevation, 'elevation');
    if (nextElevation <= -Math.PI / 2 || nextElevation >= Math.PI / 2) {
      throw new RangeError('elevation must be between -PI/2 and PI/2.');
    }
    const horizontal = nextRadius * Math.cos(nextElevation);
    const position = new Vector3(
      nextTarget.x + horizontal * Math.sin(nextAzimuth),
      nextTarget.y + nextRadius * Math.sin(nextElevation),
      nextTarget.z + horizontal * Math.cos(nextAzimuth),
    );
    return this.setPose({ position, lookAt: nextTarget, fov });
  }

  /** Freeze/unfreeze physics/environment simulation while rendering continues. */
  setSimulationFrozen(frozen = true) {
    this._requireOwnership();
    this.sceneManager.freezeSimulation = !!frozen;
    return this.getState();
  }

  freeze() { return this.setSimulationFrozen(true); }
  unfreeze() { return this.setSimulationFrozen(false); }

  /**
   * Resolve after the requested number of distinct live render frames. main.js
   * calls notifyFrame() once per update; this avoids timer/RAF races in harnesses.
   */
  waitForFrames(count = 1) {
    if (!Number.isInteger(count) || count < 1) throw new TypeError('count must be a positive integer.');
    const target = this._frameSequence + count;
    return new Promise((resolve) => {
      this._waiters.push({ target, resolve });
    });
  }

  settle(frames = 2) { return this.waitForFrames(frames); }

  /** Deterministic frame hook used by the live loop; public for custom harnesses. */
  notifyFrame(frameId) {
    if (Number.isFinite(frameId)) {
      if (frameId <= this._frame) return this._frame;
      this._frame = frameId;
    } else this._frame++;
    this._frameSequence++;
    const ready = this._waiters.filter((waiter) => waiter.target <= this._frameSequence);
    this._waiters = this._waiters.filter((waiter) => waiter.target > this._frameSequence);
    for (const waiter of ready) waiter.resolve(this.getState());
    return this._frame;
  }

  getState() {
    return {
      version: this.version,
      namespace: this.namespace,
      owned: this.active,
      frozen: this.simulationFrozen,
      continuousMotionActive: this.continuousMotionActive,
      position: plainVector(this.camera.position),
      quaternion: plainQuaternion(this.camera.quaternion),
      lookAt: plainVector(this._lookAt),
      fov: this.camera.fov,
      frame: this._frame,
    };
  }

  _requireOwnership() {
    if (!this.active) throw new Error('Evaluator camera is not active; call golf.evaluatorCamera.enter() first.');
  }

  _captureCamera() {
    return {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      up: this.camera.up.clone(),
      fov: this.camera.fov,
      lookAt: this._lookAtFromCamera(this.camera.position),
    };
  }

  _captureDirector() {
    if (!this.director) return null;
    const state = {};
    for (const key of ['phase', '_resultAngle', '_launchY', '_apexY']) {
      if (this.director[key] !== undefined) state[key] = this.director[key];
    }
    for (const key of ['pos', 'look', '_look', '_viewLook', 'aim', '_launchDir']) {
      if (this.director[key]?.clone) state[key] = this.director[key].clone();
    }
    return state;
  }

  _restoreDirector(state) {
    if (!this.director || !state) return;
    for (const [key, value] of Object.entries(state)) {
      if (value?.isVector3 && this.director[key]?.copy) this.director[key].copy(value);
      else this.director[key] = value;
    }
  }

  _lookAtFromCamera(position) {
    const direction = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    return position.clone().add(direction);
  }

  _lookAtFromQuaternion(position, q) {
    return position.clone().add(new Vector3(0, 0, -1).applyQuaternion(q).normalize());
  }

  _quaternionLookingAt(position, target) {
    const previous = this.camera.position.clone();
    this.camera.position.copy(position);
    this.camera.lookAt(target);
    const result = this.camera.quaternion.clone();
    this.camera.position.copy(previous);
    return result;
  }

  _cameraChanged(position, q, fov) {
    return this.camera.position.distanceToSquared(position) > EPSILON
      || 1 - Math.abs(this.camera.quaternion.dot(q)) > EPSILON
      || Math.abs(this.camera.fov - fov) > EPSILON;
  }

  _applyCamera(state, invalidate) {
    copyVector(this.camera.position, state.position);
    this.camera.quaternion.copy(state.quaternion);
    this.camera.fov = state.fov;
    if (state.up) this.camera.up.copy(state.up);
    else this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this._pose.position.copy(this.camera.position);
    this._pose.quaternion.copy(this.camera.quaternion);
    this._pose.fov = this.camera.fov;
    this._lookAt = state.lookAt?.clone?.() ?? this._lookAtFromQuaternion(this.camera.position, this.camera.quaternion);
    if (invalidate) this._invalidate('evaluator camera cut');
  }

  _invalidate(reason) {
    this.sceneManager.invalidateTemporalHistory?.(reason);
  }
}
