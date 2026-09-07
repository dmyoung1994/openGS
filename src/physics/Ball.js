import { Vector3 } from 'three';
import { BALL, GRAVITY } from './constants.js';
import { assertEnvironment, deriveLaunchState, stepRK4 } from './ballistics.js';
import { resolveBounce, surface } from './groundInteraction.js';
import { M_TO_YARD } from '../util/units.js';
import { intersectSegmentWaterPlane, resolveWaterEntry } from './waterInteraction.js';
import { cupCaptureSpeed, intersectCupEntry } from './cupInteraction.js';

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
// 'carry' (first ground contact), 'bounce', 'groundContact' (at most once per
// presented update while rolling), 'waterImpact', 'hazard', 'rest'.
const FIXED_DT = 0.002; // s, physics substep
const ROLLING_GRAVITY = 5 / 7; // Solid sphere: 1 / (1 + I / mr²), matching contact inertia.

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
    this.setEnvironment(env);
    this.position = new Vector3();
    this.velocity = new Vector3();
    // Authoritative flight/contact angular state. `spin` is a derived reporting
    // view retained for UI consumers that historically read axis/omega.
    this.angularVelocity = new Vector3();
    this.spin = { axis: new Vector3(1, 0, 0), omega: 0 };
    this.state = 'rest'; // 'airborne' | 'rolling' | 'rest'
    this.radius = BALL.radius;
    this.cup = null;
    this.holed = false;
    this._cupEntryPosition = new Vector3();
    this._shotAim = new Vector3(0, 0, -1);

    this.time = 0;
    this.start = new Vector3();
    this.apexHeight = 0;
    this.carryYards = 0;
    this.totalYards = 0;
    this.landingSpeedMph = 0;
    this.landingSpinRpm = 0;
    this._apexReported = false;
    this._carryReported = false;
    this._accum = 0;
    this._listeners = new Map();
    this.trail = []; // sampled world positions for the tracer ribbon
    // Exact-contact rewind storage. A water crossing is found from the completed
    // fixed step, then RK4 is replayed only to that contact time before applying
    // the entry impulse and integrating the remainder.
    this._airStepStartPosition = new Vector3();
    this._airStepStartVelocity = new Vector3();
    this._airStepStartAngularVelocity = new Vector3();
    // Fixed-step physics may run dozens of substeps per presented frame. Retain
    // only the latest rolling contact so presentation consumers receive bounded
    // telemetry without changing or slowing the contact solver.
    this._groundContactSample = { surface: 'fairway', speed: 0, slipSpeed: 0, spinSpeed: 0 };
    this._hasGroundContactSample = false;
  }

  setEnvironment(env) {
    this.env = assertEnvironment(env);
    return this;
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

  _syncSpinReport() {
    this.spin.omega = this.angularVelocity.length();
    if (this.spin.omega > 1e-8) this.spin.axis.copy(this.angularVelocity).multiplyScalar(1 / this.spin.omega);
    else this.spin.axis.set(1, 0, 0);
  }

  placeAt(x, z) {
    const y = this.terrain.heightAt(x, z) + this.radius;
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this._syncSpinReport();
    this.state = 'rest';
    this.holed = false;
    this._hasGroundContactSample = false;
  }

  setCup(cup) {
    if (cup && (![cup.x, cup.y, cup.z, cup.radius, cup.depth].every(Number.isFinite)
      || cup.radius <= this.radius || cup.depth <= this.radius * 2)) {
      throw new RangeError('Cup dimensions and position must be finite and fit the ball.');
    }
    this.cup = cup ? Object.freeze({ ...cup }) : null;
  }

  launch(params) {
    if (this.holed) throw new Error('This ball is holed. Start the next hole before launching again.');
    const teeY = this.terrain.heightAt(this.position.x, this.position.z);
    const start = new Vector3(this.position.x, teeY + (params.teeHeight || this.radius), this.position.z);
    const s = deriveLaunchState({ ...params, position: start });
    const aimBearing = (params.aimAzimuth ?? 0) * Math.PI / 180;
    this._shotAim.set(Math.sin(aimBearing), 0, -Math.cos(aimBearing));
    this.position.copy(s.position);
    this.velocity.copy(s.velocity);
    this.angularVelocity.copy(s.angularVelocity);
    this._syncSpinReport();

    this.state = 'airborne';
    this.time = 0;
    this._accum = 0;
    this.start.copy(start);
    this.apexHeight = start.y;
    this.carryYards = 0;
    this.totalYards = 0;
    this.landingSpeedMph = 0;
    this.landingSpinRpm = 0;
    this._apexReported = false;
    this._carryReported = false;
    this._grounded = false;
    this.trail = [this.position.clone()];
    this._hasGroundContactSample = false;
    this._emit('launch', {
      position: start.clone(),
      velocity: this.velocity.clone(),
      ballSpeed: params.ballSpeed,
      clubSpeed: params.clubSpeed,
      launchAngle: params.launchAngle,
      spinRate: params.spinRate,
      club: params.club,
    });
  }

  // Advance the simulation by a frame's worth of wall-clock time.
  update(dt) {
    if (this.state === 'rest') return;
    this._hasGroundContactSample = false;
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
    if (this.state === 'rolling' && this._hasGroundContactSample) {
      this._emit('groundContact', {
        surface: this._groundContactSample.surface,
        speed: this._groundContactSample.speed,
        slipSpeed: this._groundContactSample.slipSpeed,
        spinSpeed: this._groundContactSample.spinSpeed,
        position: this.position.clone(),
      });
    }
  }

  _substep(dt) {
    if (this.state === 'airborne') this._stepAir(dt);
    else if (this.state === 'rolling') this._stepRoll(dt);
    else if (this.state === 'holing') this._stepHole(dt);
  }

  _stepHole(dt) {
    this.time += dt;
    this.velocity.y -= GRAVITY * dt;
    this.position.y += this.velocity.y * dt;
    const bottom = this.cup.y - this.cup.depth + this.radius;
    const progress = Math.min(1, (this.cup.y + this.radius - this.position.y) / this.cup.depth);
    // ponytail: capture-envelope settlement, not detailed liner/flagstick impacts.
    // Replace this short descent with contact dynamics when rim evidence is added.
    this.position.x = this._cupEntryPosition.x + (this.cup.x - this._cupEntryPosition.x) * progress;
    this.position.z = this._cupEntryPosition.z + (this.cup.z - this._cupEntryPosition.z) * progress;
    if (this.position.y > bottom) return;
    this.position.set(this.cup.x, bottom, this.cup.z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this._syncSpinReport();
    this.holed = true;
    this.state = 'rest';
    this._emit('holed', { position: this.position.clone() });
    this._finish();
  }

  _stepAir(dt) {
    const prevY = this.position.y;
    const prev = this._airStepStartPosition.copy(this.position);
    const prevVelocity = this._airStepStartVelocity.copy(this.velocity);
    const prevAngularVelocity = this._airStepStartAngularVelocity.copy(this.angularVelocity);
    const stepStartTime = this.time;
    const st = { position: this.position, velocity: this.velocity, angularVelocity: this.angularVelocity };
    stepRK4(st, dt, stepStartTime, this.env);
    this._syncSpinReport();
    this.time = stepStartTime + dt;

    const waterHeight = this.terrain.waterHeightAt?.(this.position.x, this.position.z);
    if (waterHeight !== null && waterHeight !== undefined && this.velocity.y < 0) {
      const crossing = intersectSegmentWaterPlane(prev, this.position, waterHeight + this.radius);
      if (crossing) {
        if (!this.env.waterEntryModel) {
          throw new Error('Water contact requires a calibrated waterEntryModel; no fallback response exists.');
        }

        // The completed step finds the crossing fraction. Restore the exact start
        // state and replay RK4 to contact so velocity and spin are not sampled late.
        const contactDt = dt * crossing.t;
        this.position.copy(prev);
        this.velocity.copy(prevVelocity);
        this.angularVelocity.copy(prevAngularVelocity);
        if (contactDt > Number.EPSILON) stepRK4(st, contactDt, stepStartTime, this.env);
        this.position.copy(crossing.position);
        this.time = stepStartTime + contactDt;

        const incidentVelocity = this.velocity.clone();
        const incidentAngularVelocity = this.angularVelocity.clone();
        const result = resolveWaterEntry({
          velocity: incidentVelocity,
          angularVelocity: incidentAngularVelocity,
          normal: crossing.normal,
          ball: this.env.ball,
          waterDensity: this.env.waterDensity,
          model: this.env.waterEntryModel,
        });
        const impact = {
          type: 'water',
          kind: result.kind,
          source: result.source,
          position: this.position.clone(),
          impactSpeed: incidentVelocity.length(),
          incidentVelocity,
          incidentAngularVelocity,
          inwardNormalSpeed: result.inwardNormalSpeed,
          tangentialSpeed: result.tangentialSpeed,
          incidentAngleDegrees: result.incidentAngleDegrees,
          effectiveAngleDegrees: result.effectiveAngleDegrees,
          criticalSpeed: result.criticalSpeed,
          spinRatio: result.spinRatio,
        };
        this._reportCarry();
        this._emit('waterImpact', impact);

        if (result.kind === 'skip') {
          this.velocity.copy(result.velocity);
          this.angularVelocity.copy(result.angularVelocity);
          const remainingDt = dt - contactDt;
          if (remainingDt > Number.EPSILON) stepRK4(st, remainingDt, this.time, this.env);
          this.time = stepStartTime + dt;
          this._syncSpinReport();
          return;
        }

        this.velocity.set(0, 0, 0);
        this.angularVelocity.set(0, 0, 0);
        this._syncSpinReport();
        this.state = 'rest';
        this._emit('hazard', impact);
        this._finish();
        return;
      }
    }

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

  _reportCarry() {
    if (!this._carryReported) {
      this._carryReported = true;
      this.carryYards = this._groundDist() * M_TO_YARD;
      // Descent angle of the incoming shot at first contact.
      this.descentDeg = Math.atan2(-this.velocity.y, Math.hypot(this.velocity.x, this.velocity.z)) * 180 / Math.PI;
      this.landingSpeedMph = this.velocity.length() / 0.44704;
      this.landingSpinRpm = this.angularVelocity.length() * 60 / (Math.PI * 2);
      this._emit('carry', {
        yards: this.carryYards,
        descentDeg: this.descentDeg,
        landingSpeedMph: this.landingSpeedMph,
        landingSpinRpm: this.landingSpinRpm,
      });
    }
  }

  _land() {
    this._grounded = true;
    this._reportCarry();
    const name = this.terrain.surfaceAt(this.position.x, this.position.z);
    const surf = surface(name, this.env.groundFirmness);
    const normal = this.terrain.normalAt(this.position.x, this.position.z);

    if (surf.hazard === 'water') {
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this._syncSpinReport();
      this.state = 'rest';
      this._emit('hazard', { type: 'water', position: this.position.clone() });
      this._finish();
      return;
    }

    const incidentVelocity = this.velocity.clone();
    const impactSpeed = incidentVelocity.length();
    const normalSpeed = Math.max(0, -incidentVelocity.dot(normal));
    const incidentSpin = this.angularVelocity.length();
    const { rolling } = resolveBounce(this.velocity, normal, { angularVelocity: this.angularVelocity }, surf);
    this._syncSpinReport();
    this._emit('bounce', {
      surface: name,
      position: this.position.clone(),
      speed: this.velocity.length(),
      impactSpeed,
      normalSpeed,
      outgoingSpeed: this.velocity.length(),
      incidentSpin,
    });
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
    const surf = surface(name, this.env.groundFirmness);
    if (surf.hazard === 'water') {
      this._hasGroundContactSample = false;
      this._land();
      return;
    }
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
    // spin bleeds down to the rolling condition v + omega x r = 0. A zero-spin putt
    // initially skids and acquires topspin before it rolls. This mechanism is what
    // makes approach shots CHECK and high-spin wedges ZIP BACK on a green while
    // a driver (little spin left) just releases.
    const omegaVec = _r2.copy(this.angularVelocity);
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
      this.velocity.addScaledVector(gTangent, dt);
    } else {
      // --- Rolling: constant rolling resistance + speed-squared grass drag,
      // and lock the spin to the rolling state so no spurious slip reappears.
      const speed = this.velocity.length();
      if (speed > 1e-4) {
        const fricDecel = surf.rollResistance * GRAVITY * cosT;
        const dragDecel = (surf.rollDrag || 0) * speed * speed * cosT;
        this.velocity.multiplyScalar(Math.max(0, 1 - (fricDecel + dragDecel) * dt / speed));
      }
      // Static contact friction supplies the torque needed to roll downhill.
      // Apply that acceleration before synchronizing spin, avoiding artificial slip.
      this.velocity.addScaledVector(gTangent, dt * ROLLING_GRAVITY);
      // omega_roll = (n x v)/radius  (topspin consistent with pure rolling).
      omegaVec.copy(n).cross(this.velocity).multiplyScalar(1 / radius);
    }

    const previousPosition = this._airStepStartPosition.copy(this.position);
    this.position.addScaledVector(this.velocity, dt);
    if (this.cup && name === 'green') {
      const entry = intersectCupEntry(previousPosition, this.position, this.cup);
      const speed = this.velocity.length();
      if (entry && speed > 0 && speed < cupCaptureSpeed(entry.offset, this.cup.radius, this.velocity.y / speed)) {
        this.position.lerpVectors(previousPosition, this.position, entry.t);
        this._cupEntryPosition.copy(this.position);
        this.velocity.set(0, 0, 0);
        this.state = 'holing';
        this._hasGroundContactSample = false;
        return;
      }
    }
    this.angularVelocity.copy(omegaVec);
    this._syncSpinReport();

    this._groundContactSample.surface = name;
    this._groundContactSample.speed = this.velocity.length();
    this._groundContactSample.slipSpeed = slipMag;
    this._groundContactSample.spinSpeed = this.spin.omega;
    this._hasGroundContactSample = true;

    // Re-seat on the surface and keep velocity tangent to it.
    this.position.y = this.terrain.heightAt(this.position.x, this.position.z) + this.radius;
    this.velocity.addScaledVector(n, -this.velocity.dot(n));

    // Stop only once it is genuinely crawling AND essentially rolling (not
    // mid-check or mid-zip), and the slope can't keep it going.
    const slopeTan = Math.hypot(n.x, n.z) / Math.max(cosT, 1e-4);
    if (this.velocity.length() < surf.stopSpeed && slipMag < 0.4 && slopeTan * ROLLING_GRAVITY < surf.rollResistance) {
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this._syncSpinReport();
      this.state = 'rest';
      this._finish();
    }
  }

  _finish() {
    this.totalYards = this._groundDist() * M_TO_YARD;
    this._emit('rest', {
      holed: this.holed,
      carryYards: this.carryYards,
      totalYards: this.totalYards,
      apexMeters: this.apexHeight - this.start.y,
      descentDeg: this.descentDeg || 0,
      landingSpeedMph: this.landingSpeedMph,
      landingSpinRpm: this.landingSpinRpm,
      groundFirmness: this.env.groundFirmness,
      offlineYards: ((this.position.x - this.start.x) * -this._shotAim.z
        + (this.position.z - this.start.z) * this._shotAim.x) * M_TO_YARD,
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
