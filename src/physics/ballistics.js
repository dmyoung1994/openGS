import { Vector3, Quaternion } from 'three';
import { BALL, GRAVITY, SPIN_DECAY_COEFFICIENT } from './constants.js';
import {
  AIR_VISCOSITY, MODERN_TOUR_AERO_PROFILE, aeroAcceleration, coefficientSnapshot,
} from './aerodynamics.js';
import { DEG_TO_RAD, MPH_TO_MS, RPM_TO_RADS } from '../util/units.js';
import { FRESH_WATER_DENSITY, validateWaterEntryModel } from './waterInteraction.js';

const UP = new Vector3(0, 1, 0);

function assertFiniteVector(name, value) {
  if (!(value instanceof Vector3) || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new TypeError(`${name} must be a finite Vector3`);
  }
}

function assertState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('state is required');
  assertFiniteVector('state.position', state.position);
  assertFiniteVector('state.velocity', state.velocity);
  assertFiniteVector('state.angularVelocity', state.angularVelocity);
}

// Convert player-facing launch values to an integrator state. `spinAxis` and
// `omega0` are retained as read-only launch-report compatibility fields; flight
// physics uses only `angularVelocity` from this point onward.
export function deriveLaunchState(params = {}) {
  const {
    ballSpeed = 150,
    launchAngle = 12,
    azimuth = 0,
    spinRate = 2700,
    spinAxis = 0,
    position = new Vector3(0, 0, 0),
  } = params;
  for (const [name, value] of Object.entries({ ballSpeed, launchAngle, azimuth, spinRate, spinAxis })) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  }
  if (ballSpeed <= 0 || spinRate < 0) throw new RangeError('ballSpeed must be > 0 and spinRate must be >= 0');
  assertFiniteVector('position', position);

  const speed = ballSpeed * MPH_TO_MS;
  const la = launchAngle * DEG_TO_RAD;
  const az = azimuth * DEG_TO_RAD;
  const horizontal = speed * Math.cos(la);
  const velocity = new Vector3(horizontal * Math.sin(az), speed * Math.sin(la), -horizontal * Math.cos(az));
  const direction = velocity.clone().normalize();
  const backspinAxis = direction.clone().cross(UP).normalize();
  const axis = backspinAxis.applyQuaternion(new Quaternion().setFromAxisAngle(direction, spinAxis * DEG_TO_RAD)).normalize();
  const omega0 = spinRate * RPM_TO_RADS;
  return {
    position: position.clone(),
    velocity,
    angularVelocity: axis.clone().multiplyScalar(omega0),
    spinAxis: axis.clone(),
    omega0,
  };
}

// Wind is a required world query. It must fill `out` and may additionally
// return it. No static env.wind compatibility path exists: a stale sampled wind
// is physically wrong once gusts/vertical shear are present.
export function makeEnv({
  rho = 1.225,
  sampleWind,
  waterEntryModel = null,
  waterDensity = FRESH_WATER_DENSITY,
  viscosity = AIR_VISCOSITY,
  aerodynamicProfile = MODERN_TOUR_AERO_PROFILE,
  groundFirmness = 'medium',
} = {}) {
  if (!Number.isFinite(rho) || rho <= 0) throw new RangeError('rho must be a finite value > 0');
  if (typeof sampleWind !== 'function') throw new TypeError('env.sampleWind(position, time, out) is required');
  if (!Number.isFinite(waterDensity) || waterDensity <= 0) throw new RangeError('waterDensity must be a finite value > 0');
  if (!Number.isFinite(viscosity) || viscosity <= 0) throw new RangeError('viscosity must be a finite value > 0');
  if (!aerodynamicProfile?.id) throw new TypeError('aerodynamicProfile must be a named profile');
  if (!['soft', 'medium', 'firm'].includes(groundFirmness)) throw new RangeError('groundFirmness must be soft, medium, or firm');
  if (waterEntryModel !== null) validateWaterEntryModel(waterEntryModel);
  return Object.freeze({
    rho, sampleWind, gravity: GRAVITY, ball: BALL, waterEntryModel, waterDensity,
    viscosity, aerodynamicProfile, groundFirmness,
  });
}

export function assertEnvironment(env) {
  if (!env || typeof env !== 'object' || !Number.isFinite(env.rho) || env.rho <= 0 || typeof env.sampleWind !== 'function') {
    throw new TypeError('environment requires finite rho and sampleWind(position, time, out)');
  }
  if (!Number.isFinite(env.gravity) || env.gravity <= 0 || !env.ball) throw new TypeError('environment has invalid gravity or ball');
  if (!Number.isFinite(env.waterDensity) || env.waterDensity <= 0) throw new TypeError('environment has invalid waterDensity');
  if (!Number.isFinite(env.viscosity) || env.viscosity <= 0 || !env.aerodynamicProfile?.id) throw new TypeError('environment has invalid aerodynamic state');
  if (!['soft', 'medium', 'firm'].includes(env.groundFirmness)) throw new TypeError('environment has invalid ground firmness');
  if (env.waterEntryModel !== null) validateWaterEntryModel(env.waterEntryModel);
  return env;
}

function sampledWind(out, position, time, env) {
  const result = env.sampleWind(position, time, out);
  if (result !== undefined && result !== out) {
    if (!(result instanceof Vector3)) throw new TypeError('env.sampleWind must fill out or return a Vector3');
    out.copy(result);
  }
  assertFiniteVector('env.sampleWind result', out);
  return out;
}

const _relativeVelocity = new Vector3();
const _aero = new Vector3();

function derivatives(acceleration, angularAcceleration, velocity, angularVelocity, position, time, env, wind) {
  sampledWind(wind, position, time, env);
  _relativeVelocity.copy(velocity).sub(wind);
  aeroAcceleration(_aero, _relativeVelocity, angularVelocity, env.rho, env.ball, {
    viscosity: env.viscosity,
    profile: env.aerodynamicProfile,
  });
  acceleration.copy(_aero);
  acceleration.y -= env.gravity;

  // USGA/R&A Appendix C equation (5): dω/dt = -Cw |u|/r ω, using
  // Cw=2e-5 (the report states this is consistent with Overall Distance
  // Standard). This is a dissipative aerodynamic torque and therefore acts on
  // the full vector, not a scalar spin magnitude / immutable axis.
  const damping = SPIN_DECAY_COEFFICIENT * _relativeVelocity.length() / env.ball.radius;
  angularAcceleration.copy(angularVelocity).multiplyScalar(-damping);
}

const _kPosition = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _kVelocity = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _kAngularVelocity = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _stagePosition = new Vector3();
const _stageVelocity = new Vector3();
const _stageAngularVelocity = new Vector3();
const _stageWind = new Vector3();

// Classical RK4 over x, v, and angular velocity. Every derivative samples the
// wind at that stage's position/time, which is essential for gust coherence.
export function stepRK4(state, dt, time, env) {
  assertState(state);
  assertEnvironment(env);
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(time)) throw new RangeError('dt must be > 0 and time must be finite');
  const { position, velocity, angularVelocity } = state;
  const half = dt * 0.5;

  _kPosition[0].copy(velocity);
  derivatives(_kVelocity[0], _kAngularVelocity[0], velocity, angularVelocity, position, time, env, _stageWind);

  _stagePosition.copy(position).addScaledVector(_kPosition[0], half);
  _stageVelocity.copy(velocity).addScaledVector(_kVelocity[0], half);
  _stageAngularVelocity.copy(angularVelocity).addScaledVector(_kAngularVelocity[0], half);
  _kPosition[1].copy(_stageVelocity);
  derivatives(_kVelocity[1], _kAngularVelocity[1], _stageVelocity, _stageAngularVelocity, _stagePosition, time + half, env, _stageWind);

  _stagePosition.copy(position).addScaledVector(_kPosition[1], half);
  _stageVelocity.copy(velocity).addScaledVector(_kVelocity[1], half);
  _stageAngularVelocity.copy(angularVelocity).addScaledVector(_kAngularVelocity[1], half);
  _kPosition[2].copy(_stageVelocity);
  derivatives(_kVelocity[2], _kAngularVelocity[2], _stageVelocity, _stageAngularVelocity, _stagePosition, time + half, env, _stageWind);

  _stagePosition.copy(position).addScaledVector(_kPosition[2], dt);
  _stageVelocity.copy(velocity).addScaledVector(_kVelocity[2], dt);
  _stageAngularVelocity.copy(angularVelocity).addScaledVector(_kAngularVelocity[2], dt);
  _kPosition[3].copy(_stageVelocity);
  derivatives(_kVelocity[3], _kAngularVelocity[3], _stageVelocity, _stageAngularVelocity, _stagePosition, time + dt, env, _stageWind);

  const scale = dt / 6;
  position.addScaledVector(_kPosition[0], scale).addScaledVector(_kPosition[1], 2 * scale).addScaledVector(_kPosition[2], 2 * scale).addScaledVector(_kPosition[3], scale);
  velocity.addScaledVector(_kVelocity[0], scale).addScaledVector(_kVelocity[1], 2 * scale).addScaledVector(_kVelocity[2], 2 * scale).addScaledVector(_kVelocity[3], scale);
  angularVelocity.addScaledVector(_kAngularVelocity[0], scale).addScaledVector(_kAngularVelocity[1], 2 * scale).addScaledVector(_kAngularVelocity[2], 2 * scale).addScaledVector(_kAngularVelocity[3], scale);
  assertState(state);
  return state;
}

export function simulateFlight(params, env, opts = {}) {
  assertEnvironment(env);
  const {
    dt = 0.002, maxTime = 15, groundHeight = () => 0,
    diagnostics = false, diagnosticInterval = 0.05,
  } = opts;
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(maxTime) || maxTime <= 0 || typeof groundHeight !== 'function') throw new TypeError('invalid simulation options');
  if (diagnostics && (!Number.isFinite(diagnosticInterval) || diagnosticInterval <= 0)) throw new TypeError('diagnosticInterval must be > 0');
  const launch = deriveLaunchState(params);
  const state = { position: launch.position.clone(), velocity: launch.velocity.clone(), angularVelocity: launch.angularVelocity.clone() };
  const samples = [{ t: 0, pos: state.position.clone(), vel: state.velocity.clone(), angularVelocity: state.angularVelocity.clone() }];
  const coefficientSamples = [];
  let nextDiagnostic = 0;
  let time = 0;
  let apex = { height: state.position.y, t: 0, pos: state.position.clone() };
  const start = launch.position.clone();
  while (time < maxTime) {
    const prev = state.position.clone();
    const previousY = prev.y;
    stepRK4(state, dt, time, env);
    time += dt;
    if (diagnostics && time + 1e-12 >= nextDiagnostic) {
      sampledWind(_stageWind, state.position, time, env);
      _relativeVelocity.copy(state.velocity).sub(_stageWind);
      const snapshot = coefficientSnapshot({}, _relativeVelocity, state.angularVelocity, env.rho, env.ball, {
        viscosity: env.viscosity,
        profile: env.aerodynamicProfile,
      });
      coefficientSamples.push({ t: time, ...snapshot });
      nextDiagnostic += diagnosticInterval;
    }
    if (state.position.y > apex.height) apex = { height: state.position.y, t: time, pos: state.position.clone() };
    samples.push({ t: time, pos: state.position.clone(), vel: state.velocity.clone(), angularVelocity: state.angularVelocity.clone() });
    const ground = groundHeight(state.position.x, state.position.z);
    if (!Number.isFinite(ground)) throw new TypeError('groundHeight must return a finite number');
    if (state.position.y <= ground && state.velocity.y < 0) {
      const previousGround = groundHeight(prev.x, prev.z);
      const denominator = (previousY - previousGround) - (state.position.y - ground);
      const fraction = denominator === 0 ? 0 : Math.min(1, Math.max(0, (previousY - previousGround) / denominator));
      state.position.lerpVectors(prev, state.position, fraction);
      break;
    }
  }
  const landing = { pos: state.position.clone(), vel: state.velocity.clone(), t: time };
  const flat = new Vector3(landing.pos.x - start.x, 0, landing.pos.z - start.z);
  return {
    samples,
    landing,
    apexHeight: apex.height,
    apexTime: apex.t,
    carry: flat.length(),
    lateral: landing.pos.x - start.x,
    flightTime: time,
    descentAngle: Math.atan2(-landing.vel.y, Math.hypot(landing.vel.x, landing.vel.z)),
    landingSpin: state.angularVelocity.length(),
    angularVelocity: state.angularVelocity.clone(),
    spinAxis: state.angularVelocity.lengthSq() > 0 ? state.angularVelocity.clone().normalize() : new Vector3(),
    launch: { position: start, velocity: launch.velocity.clone(), omega0: launch.omega0, angularVelocity: launch.angularVelocity.clone() },
    diagnostics: diagnostics ? Object.freeze({
      aerodynamicProfile: env.aerodynamicProfile.id,
      coefficientSamples: Object.freeze(coefficientSamples),
      landingSpeed: landing.vel.length(),
      landingSpin: state.angularVelocity.length(),
    }) : null,
  };
}
