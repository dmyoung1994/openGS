import { Vector3, Euler, Quaternion } from 'three';

// Debug / spectator free-fly camera. A toggle mode that DETACHES the camera from
// the cinematic CameraDirector and hands control to the keyboard + mouse:
//   WASD   - move (fly where you look)
//   Space  - rise      Ctrl - fall   (always world-vertical)
//   Shift  - speed boost (hold)
//   drag   - click-drag the canvas to look around (yaw + pitch, level horizon)
//
// It owns its own input listeners, all of which early-return while inactive, so it
// never interferes with normal play. main.js flips it on/off and, while active,
// calls update(dt) instead of director.update() and re-purposes Space to "rise".
export class FreeCamera {
  constructor(camera, domElement, terrain, { onDragEnd = null } = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.terrain = terrain;
    this.onDragEnd = typeof onDragEnd === 'function' ? onDragEnd : null;
    this.groundClearance = 0.5;  // stay this far above the turf — don't clip through
    this.active = false;
    this.dragging = false;
    this.keys = new Set();

    // Look angles (radians). Rebuilt from the live camera on enter() so toggling
    // in never jumps the view.
    this.yaw = 0;
    this.pitch = 0;

    // Tunables.
    this.baseSpeed = 12;         // m/s
    this.boost = 4;              // Shift multiplier
    this.sensitivity = 0.0025;   // rad per pixel of drag
    this.pitchLimit = Math.PI / 2 - 0.02;   // ~89deg, avoid gimbal flip at straight up/down

    // Scratch to avoid per-frame allocation.
    this._euler = new Euler(0, 0, 0, 'YXZ');
    this._quat = new Quaternion();
    this._fwd = new Vector3();
    this._right = new Vector3();
    this._move = new Vector3();
    this._worldUp = new Vector3(0, 1, 0);

    // Bind so add/removeEventListener share one reference.
    this._onKeyDown = (e) => { if (this.active) this.keys.add(e.code); };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onMouseDown = (e) => {
      if (!this.active || e.button !== 0) return;
      this.dragging = true;
      this.dom.style.cursor = 'grabbing';
      e.preventDefault();
    };
    this._onMouseMove = (e) => {
      if (!this.dragging) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-this.pitchLimit, Math.min(this.pitchLimit, this.pitch));
    };
    this._onMouseUp = () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.active) this.dom.style.cursor = 'grab';
      // A long mouse look intentionally feeds motion vectors into TRAA while the
      // camera moves. Once it stops, that history no longer represents the final
      // view and can smear high-contrast branches across the trunk for several
      // frames. Invalidate exactly once at the interaction boundary.
      this.onDragEnd?.();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.dom.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
  }

  toggle() { this.active ? this.exit() : this.enter(); }

  enter() {
    this.active = true;
    // Seed yaw/pitch from the camera's current forward so there's no snap. For the
    // YXZ euler we use, forward = (-sinYaw cosPitch, sinPitch, -cosYaw cosPitch).
    const dir = this.camera.getWorldDirection(this._fwd);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.camera.up.set(0, 1, 0);
    this.dom.style.cursor = 'grab';
  }

  exit() {
    this.active = false;
    this.dragging = false;
    this.keys.clear();
    this.dom.style.cursor = '';
  }

  update(dt) {
    if (!this.active) return;

    // Orientation straight from the look angles (level horizon: roll is always 0).
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);

    // Basis: forward is the full look direction (fly where you aim); right is its
    // horizontal perpendicular; vertical is always world up so you can climb/descend
    // no matter where you're looking.
    this.camera.getWorldDirection(this._fwd);
    this._right.crossVectors(this._fwd, this._worldUp).normalize();

    const k = this.keys;
    this._move.set(0, 0, 0);
    if (k.has('KeyW')) this._move.add(this._fwd);
    if (k.has('KeyS')) this._move.sub(this._fwd);
    if (k.has('KeyD')) this._move.add(this._right);
    if (k.has('KeyA')) this._move.sub(this._right);
    if (k.has('Space')) this._move.add(this._worldUp);
    // Ctrl descends, Shift boosts. Swapped from the original (Shift descended) because
    // Shift is held by every OS screenshot shortcut — framing a shot used to drop the
    // camera through the turf the moment you reached for Cmd-Shift-4.
    if (k.has('ControlLeft') || k.has('ControlRight')) this._move.sub(this._worldUp);

    if (this._move.lengthSq() > 0) {
      const boosted = (k.has('ShiftLeft') || k.has('ShiftRight')) ? this.boost : 1;
      this._move.normalize().multiplyScalar(this.baseSpeed * boosted * dt);
      this.camera.position.add(this._move);
    }

    // Terrain collision: never let the camera drop below the turf. heightAt clamps
    // to the play-area bounds, so this holds even out past the course edge.
    if (this.terrain) {
      const floor = this.terrain.heightAt(this.camera.position.x, this.camera.position.z) + this.groundClearance;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.dom.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
  }
}
