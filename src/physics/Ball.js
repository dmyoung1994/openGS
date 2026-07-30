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

// Scratch vectors reused by the rolling solver (avoids per-substep allocation).
const _r0 = new Vector3();
const _r1 = new Vector3();
const _r2 = new Vector3();
const _r3 = new Vector3();
const _r4 = new Vector3();
const _r5 = new Vector3();
const _r6 = new Vector3();
const _r7 = new Vector3();

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
    this._grounded = false;
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
    // Pre-contact: spin follows the calibrated launch decay exactly (flight
    // aero must not change). During post-contact hops the spin has already been
    // reshaped by the bounce impulse, so just let it decay from its current
    // value rather than resetting it back to the launch curve.
    if (!this._grounded) {
      this.spin.omega = this._omega0 * Math.exp(-this.time / 24);
    } else {
      this.spin.omega *= Math.exp(-dt / 24);
    }
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
    this._grounded = true;
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
    const radius = this.radius;

    // Gravity split into slope-tangent (drives downhill) and normal parts.
    const gVec = _r0.set(0, -GRAVITY, 0);
    const gN = gVec.dot(n);
    const gTangent = _r1.copy(gVec).addScaledVector(n, -gN); // downhill accel vector
    const cosT = Math.abs(n.y);

    // Keep the linear velocity tangent to the surface before we reason about it.
    this.velocity.addScaledVector(n, -this.velocity.dot(n));

    // Contact-point slip = linear velocity + spin surface velocity (omega x r),
    // r = -n * radius. A ball that just checked still carries BACKSPIN, whose
    // contact point slips forward, so it is not really rolling yet - it skids,
    // and kinetic friction keeps scrubbing (and can even reverse) it until the
    // spin bleeds down to the rolling condition v = omega x r. A pure putt has
    // no spin, so it rolls freely from the start. This single mechanism is what
    // makes approach shots CHECK and high-spin wedges ZIP BACK on a green while
    // a driver (little spin left) just releases.
    const omegaVec = _r2.copy(this.spin.axis).multiplyScalar(this.spin.omega);
    const rVec = _r3.copy(n).multiplyScalar(-radius);
    const vSpin = _r4.copy(omegaVec).cross(rVec);
    vSpin.addScaledVector(n, -vSpin.dot(n));           // tangential part only
    const slip = _r5.copy(this.velocity).add(vSpin);
    const slipMag = slip.length();

    const SLIP_EPS = 0.06; // m/s below which the contact is effectively rolling

    if (slipMag > SLIP_EPS) {
      // --- Skidding: Coulomb kinetic friction opposes the slip ------------
      const slipHat = _r6.copy(slip).multiplyScalar(1 / slipMag);
      const fricA = surf.friction * GRAVITY * cosT;
      // Impulse (per mass) this step, capped so it cannot overshoot rolling
      // (the linear+angular response nulls a slip of s with impulse 2/7 s).
      let jFric = fricA * dt;
      const jCap = (2 / 7) * slipMag;
      if (jFric > jCap) jFric = jCap;
      // Linear: friction decelerates (opposes slip direction).
      this.velocity.addScaledVector(slipHat, -jFric);
      // Angular: torque bleeds the spin toward the rolling state.
      const dOmega = _r7.copy(n).cross(slipHat).multiplyScalar((5 * jFric) / (2 * radius));
      omegaVec.add(dOmega);
      this.spin.omega = omegaVec.length();
      if (this.spin.omega > 1e-4) this.spin.axis.copy(omegaVec).multiplyScalar(1 / this.spin.omega);
    } else {
      // --- Rolling: constant rolling resistance + speed-squared grass drag,
      // and lock the spin to the rolling state so no spurious slip reappears.
      const speed = this.velocity.length();
      if (speed > 1e-4) {
        const fricDecel = surf.rollResistance * GRAVITY * cosT;
        const dragDecel = (surf.rollDrag || 0) * speed * speed * cosT;
        this.velocity.addScaledVector(this.velocity, -(fricDecel + dragDecel) * dt / speed);
      }
      // omega_roll = (n x v)/radius  (topspin consistent with pure rolling).
      omegaVec.copy(n).cross(this.velocity).multiplyScalar(1 / radius);
      this.spin.omega = omegaVec.length();
      if (this.spin.omega > 1e-4) this.spin.axis.copy(omegaVec).multiplyScalar(1 / this.spin.omega);
    }

    // Slope drive applies in both regimes.
    this.velocity.addScaledVector(gTangent, dt);

    this.position.addScaledVector(this.velocity, dt);

    // Re-seat on the surface and keep velocity tangent to it.
    this.position.y = this.terrain.heightAt(this.position.x, this.position.z) + this.radius;
    this.velocity.addScaledVector(n, -this.velocity.dot(n));

    // Stop only once it is genuinely crawling AND essentially rolling (not
    // mid-check or mid-zip), and the slope can't keep it going.
    const slopeTan = Math.hypot(n.x, n.z) / Math.max(cosT, 1e-4);
    if (this.velocity.length() < surf.stopSpeed && slipMag < 0.4 && slopeTan < surf.rollResistance) {
      this.velocity.set(0, 0, 0);
      this.spin.omega = 0;
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
