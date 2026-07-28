import { Vector3 } from 'three';
import { BALL, GRAVITY } from './constants.js';
import { deriveLaunchState, stepRK4 } from './ballistics.js';
import { resolveBounce, surface } from './groundInteraction.js';
import { M_TO_YARD } from '../util/units.js';

// A stateful ball the game loop advances every frame. It owns the full life of
// a shot: flight -> bounce(s) -> roll -> rest, querying the terrain for the
// ground height, surface normal, and surface type at each contact.
//
// The `terrain` dependency must implement:
//   heightAt(x, z)  -> number      ground elevation (m)
//   normalAt(x, z)  -> Vector3     unit surface normal
//   surfaceAt(x, z) -> string      key into SURFACES
//
// Emitted lifecycle events (via ball.on(name, cb)): 'launch', 'apex',
// 'carry' (first ground contact), 'bounce', 'hazard', 'rest'.
const FIXED_DT = 0.002; // s, physics substep

export class Ball {
  constructor(terrain, env) {
    this.terrain = terrain;
    this.env = env;
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.spin = { axis: new Vector3(1, 0, 0), omega: 0 };
    this.state = 'rest'; // 'airborne' | 'rolling' | 'rest'
    this.radius = BALL.radius;

    this.time = 0;
    this.start = new Vector3();
    this.apexHeight = 0;
    this.carryYards = 0;
    this.totalYards = 0;
    this._apexReported = false;
    this._carryReported = false;
    this._accum = 0;
    this._listeners = new Map();
    this.trail = []; // sampled world positions for the tracer ribbon
  }

  on(name, cb) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(cb);
    return this;
  }
  _emit(name, payload) {
    const set = this._listeners.get(name);
    if (set) for (const cb of set) cb(payload, this);
  }

  placeAt(x, z) {
    const y = this.terrain.heightAt(x, z) + this.radius;
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.spin.omega = 0;
    this.state = 'rest';
  }

  launch(params) {
    const teeY = this.terrain.heightAt(this.position.x, this.position.z);
    const start = new Vector3(this.position.x, teeY + (params.teeHeight || this.radius), this.position.z);
    const s = deriveLaunchState({ ...params, position: start });
    this.position.copy(s.position);
    this.velocity.copy(s.velocity);
    this.spin.axis.copy(s.spinAxis);
    this.spin.omega = s.omega0;
    this._omega0 = s.omega0;

    this.state = 'airborne';
    this.time = 0;
    this._accum = 0;
    this.start.copy(start);
    this.apexHeight = start.y;
    this.carryYards = 0;
    this.totalYards = 0;
    this._apexReported = false;
    this._carryReported = false;
    this.trail = [this.position.clone()];
    this._emit('launch', { position: start.clone(), velocity: this.velocity.clone() });
  }

  // Advance the simulation by a frame's worth of wall-clock time.
  update(dt) {
    if (this.state === 'rest') return;
    this._accum += Math.min(dt, 0.05); // clamp huge frame gaps
    let moved = false;
    while (this._accum >= FIXED_DT) {
      this._substep(FIXED_DT);
      this._accum -= FIXED_DT;
      moved = true;
      if (this.state === 'rest') break;
    }
    if (moved) {
      const last = this.trail[this.trail.length - 1];
      if (!last || last.distanceToSquared(this.position) > 0.04) {
        this.trail.push(this.position.clone());
      }
    }
  }

  _substep(dt) {
    if (this.state === 'airborne') this._stepAir(dt);
    else if (this.state === 'rolling') this._stepRoll(dt);
  }

  _stepAir(dt) {
    const prevY = this.position.y;
    const prev = this.position.clone();
    const st = { position: this.position, velocity: this.velocity };
    stepRK4(st, dt, this.time, this._omega0, this.spin.axis, this.env);
    this.spin.omega = this._omega0 * Math.exp(-this.time / 24);
    this.time += dt;

    if (this.position.y > this.apexHeight) this.apexHeight = this.position.y;
    else if (!this._apexReported && this.velocity.y < 0) {
      this._apexReported = true;
      this._emit('apex', { height: this.apexHeight - this.start.y });
    }

    const ground = this.terrain.heightAt(this.position.x, this.position.z) + this.radius;
    if (this.position.y <= ground && this.velocity.y < 0) {
      // Interpolate to the exact contact for a clean landing.
      const gPrev = this.terrain.heightAt(prev.x, prev.z) + this.radius;
      const denom = (prevY - gPrev) - (this.position.y - ground) || 1;
      const f = (prevY - gPrev) / denom;
      this.position.lerpVectors(prev, this.position, Math.max(0, Math.min(1, f)));
      this.position.y = this.terrain.heightAt(this.position.x, this.position.z) + this.radius;
      this._land();
    }
  }

  _land() {
    if (!this._carryReported) {
      this._carryReported = true;
      this.carryYards = this._groundDist() * M_TO_YARD;
      // Descent angle of the incoming shot at first contact.
      this.descentDeg = Math.atan2(-this.velocity.y, Math.hypot(this.velocity.x, this.velocity.z)) * 180 / Math.PI;
      this._emit('carry', { yards: this.carryYards, descentDeg: this.descentDeg });
    }
    const name = this.terrain.surfaceAt(this.position.x, this.position.z);
    const surf = surface(name);
    const normal = this.terrain.normalAt(this.position.x, this.position.z);

    if (surf.hazard === 'water') {
      this.velocity.set(0, 0, 0);
      this.state = 'rest';
      this._finish();
      this._emit('hazard', { type: 'water', position: this.position.clone() });
      return;
    }

    const { rolling } = resolveBounce(this.velocity, normal, this.spin, surf);
    this._emit('bounce', { surface: name, position: this.position.clone(), speed: this.velocity.length() });
    if (rolling) {
      // Project velocity onto the tangent plane and start rolling.
      const vn = this.velocity.dot(normal);
      this.velocity.addScaledVector(normal, -vn);
      this.state = 'rolling';
    }
  }

  _stepRoll(dt) {
    const n = this.terrain.normalAt(this.position.x, this.position.z);
    const name = this.terrain.surfaceAt(this.position.x, this.position.z);
    const surf = surface(name);

    // Gravity split into slope-tangent (drives downhill) and normal parts.
    const gVec = new Vector3(0, -GRAVITY, 0);
    const gN = gVec.dot(n);
    const gTangent = gVec.clone().addScaledVector(n, -gN); // downhill accel vector
    const cosT = Math.abs(n.y);

    const speed = this.velocity.length();
    const accel = gTangent.clone();
    if (speed > 1e-4) {
      // Rolling resistance opposes motion, scaled by the normal load.
      const fric = surf.rollResistance * GRAVITY * cosT;
      accel.addScaledVector(this.velocity, -fric / speed);
    }
    this.velocity.addScaledVector(accel, dt);
    this.position.addScaledVector(this.velocity, dt);

    // Re-seat on the surface and keep velocity tangent to it.
    this.position.y = this.terrain.heightAt(this.position.x, this.position.z) + this.radius;
    const vn = this.velocity.dot(n);
    this.velocity.addScaledVector(n, -vn);

    // Stop when slow and the slope can't sustain rolling against resistance.
    const slopeTan = Math.hypot(n.x, n.z) / Math.max(cosT, 1e-4);
    if (this.velocity.length() < surf.stopSpeed && slopeTan < surf.rollResistance) {
      this.velocity.set(0, 0, 0);
      this.state = 'rest';
      this._finish();
    }
  }

  _finish() {
    this.totalYards = this._groundDist() * M_TO_YARD;
    this._emit('rest', {
      carryYards: this.carryYards,
      totalYards: this.totalYards,
      apexMeters: this.apexHeight - this.start.y,
      descentDeg: this.descentDeg || 0,
      offlineYards: (this.position.x - this.start.x) * M_TO_YARD,
      position: this.position.clone(),
      surface: this.terrain.surfaceAt(this.position.x, this.position.z),
    });
  }

  _groundDist() {
    const dx = this.position.x - this.start.x;
    const dz = this.position.z - this.start.z;
    return Math.hypot(dx, dz);
  }
}
