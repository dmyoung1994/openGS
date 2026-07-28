import { Vector3, Quaternion } from 'three';
import { BALL, GRAVITY, SPIN_DECAY_TAU } from './constants.js';
import { aeroAcceleration } from './aerodynamics.js';
import { DEG_TO_RAD, MPH_TO_MS, RPM_TO_RADS } from '../util/units.js';

// World frame (Three.js, Y-up):
//   -Z  = down range (toward the target / default camera forward)
//   +X  = to the player's right
//   +Y  = up
const UP = new Vector3(0, 1, 0);

// Convert player-facing launch metrics into an initial physics state.
//
// params:
//   ballSpeed   mph
//   launchAngle deg above horizontal (vertical launch angle)
//   azimuth     deg, aim direction: 0 = straight, + = right of target line
//   spinRate    rpm, TOTAL spin magnitude
//   spinAxis    deg, tilt of the spin axis from horizontal.
//               + tilts toward a fade (ball curves right for a RH player),
//               - toward a draw. 0 = pure backspin.
//   position    optional Vector3 start (defaults to origin, teed at y=0)
export function deriveLaunchState(params) {
  const {
    ballSpeed = 150,
    launchAngle = 12,
    azimuth = 0,
    spinRate = 2700,
    spinAxis = 0,
    position = new Vector3(0, 0, 0),
  } = params;

  const v = ballSpeed * MPH_TO_MS;
  const la = launchAngle * DEG_TO_RAD;
  const az = azimuth * DEG_TO_RAD;

  const vh = v * Math.cos(la);
  const velocity = new Vector3(
    vh * Math.sin(az),   // x: right component from aim
    v * Math.sin(la),    // y: up
    -vh * Math.cos(az),  // z: down range (-Z)
  );

  // Pure-backspin axis: perpendicular to velocity, horizontal, pointing right,
  // so that (omega x v) points up and produces lift.
  const vdir = velocity.clone().normalize();
  const backspinAxis = vdir.clone().cross(UP).normalize();

  // Tilt the spin axis about the velocity vector to introduce side spin.
  const tilt = spinAxis * DEG_TO_RAD;
  const axis = backspinAxis.clone().applyQuaternion(
    new Quaternion().setFromAxisAngle(vdir, tilt),
  ).normalize();

  return {
    position: position.clone(),
    velocity,
    spinAxis: axis,
    omega0: spinRate * RPM_TO_RADS, // rad/s at launch
  };
}

// Default environment. `wind` is the reference wind vector measured at
// WIND_REF_HEIGHT (10 m); rho is set by the caller from air-density conditions.
export const WIND_REF_HEIGHT = 10; // m
export function makeEnv({ rho = 1.225, wind = new Vector3(0, 0, 0) } = {}) {
  return { rho, wind, gravity: GRAVITY, ball: BALL, _wind: new Vector3() };
}

// Wind speed grows with height (atmospheric boundary layer). Power-law profile
// from Justus & Mikhail (1976), as used by Baek & Kim (2013):
//   v(z) = v_ref * (z / z_ref)^n,   n = 0.37 - 0.0881 * ln(v_ref)
// So a towering shot fights more wind than a stinger. Fills env._wind.
const _windDir = new Vector3();
export function windAtHeight(env, y) {
  const ref = env.wind;
  const mag = ref.length();
  if (mag < 1e-4) return env._wind.set(0, 0, 0);
  const n = 0.37 - 0.0881 * Math.log(mag);
  const z = Math.max(y, 0.5);
  const factor = Math.pow(z / WIND_REF_HEIGHT, n);
  _windDir.copy(ref).multiplyScalar(1 / mag);
  return env._wind.copy(_windDir).multiplyScalar(mag * factor);
}

const _rel = new Vector3();
const _aero = new Vector3();

// Total acceleration at a given velocity and spin. Fills `out`.
// Uses env._wind (the height-adjusted wind computed once per step).
function accelerationAt(out, velocity, omega, spinAxis, env) {
  // Airspeed is velocity relative to the moving air mass (wind).
  _rel.copy(velocity).sub(env._wind);
  aeroAcceleration(_aero, _rel, spinAxis, omega, env.rho, env.ball);
  out.copy(_aero);
  out.y -= env.gravity;
  return out;
}

function omegaAt(omega0, t) {
  return omega0 * Math.exp(-t / SPIN_DECAY_TAU);
}

// One classical RK4 step. Mutates `state` {position, velocity}.
// Spin magnitude is a known function of absolute time, so we sample it at the
// substep times rather than integrating it.
const _k = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _kv = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _tmpV = new Vector3();
export function stepRK4(state, dt, t, omega0, spinAxis, env) {
  const { position: p, velocity: v } = state;

  // Height-adjusted wind for this step (boundary-layer shear).
  windAtHeight(env, p.y);

  // k1
  _kv[0].copy(v);
  accelerationAt(_k[0], v, omegaAt(omega0, t), spinAxis, env);
  // k2
  _tmpV.copy(v).addScaledVector(_k[0], dt / 2);
  _kv[1].copy(_tmpV);
  accelerationAt(_k[1], _tmpV, omegaAt(omega0, t + dt / 2), spinAxis, env);
  // k3
  _tmpV.copy(v).addScaledVector(_k[1], dt / 2);
  _kv[2].copy(_tmpV);
  accelerationAt(_k[2], _tmpV, omegaAt(omega0, t + dt / 2), spinAxis, env);
  // k4
  _tmpV.copy(v).addScaledVector(_k[2], dt);
  _kv[3].copy(_tmpV);
  accelerationAt(_k[3], _tmpV, omegaAt(omega0, t + dt), spinAxis, env);

  const s = dt / 6;
  p.x += s * (_kv[0].x + 2 * _kv[1].x + 2 * _kv[2].x + _kv[3].x);
  p.y += s * (_kv[0].y + 2 * _kv[1].y + 2 * _kv[2].y + _kv[3].y);
  p.z += s * (_kv[0].z + 2 * _kv[1].z + 2 * _kv[2].z + _kv[3].z);
  v.x += s * (_k[0].x + 2 * _k[1].x + 2 * _k[2].x + _k[3].x);
  v.y += s * (_k[0].y + 2 * _k[1].y + 2 * _k[2].y + _k[3].y);
  v.z += s * (_k[0].z + 2 * _k[1].z + 2 * _k[2].z + _k[3].z);
  return state;
}

// Integrate a full flight to first ground contact. Pure and allocation-light;
// used by tests and by the ball tracer. Returns rich shot statistics.
//
// groundHeight(x, z) -> terrain height; defaults to a flat plane at y = 0.
export function simulateFlight(params, env, opts = {}) {
  const { dt = 0.002, maxTime = 15, groundHeight = () => 0 } = opts;
  const { position, velocity, spinAxis, omega0 } = deriveLaunchState(params);

  const state = { position: position.clone(), velocity: velocity.clone() };
  const samples = [{ t: 0, pos: state.position.clone(), vel: state.velocity.clone() }];

  let t = 0;
  let apex = { height: state.position.y, t: 0, pos: state.position.clone() };
  const start = position.clone();

  while (t < maxTime) {
    const prevY = state.position.y;
    const prevPos = state.position.clone();
    stepRK4(state, dt, t, omega0, spinAxis, env);
    t += dt;

    if (state.position.y > apex.height) {
      apex = { height: state.position.y, t, pos: state.position.clone() };
    }
    samples.push({ t, pos: state.position.clone(), vel: state.velocity.clone() });

    const ground = groundHeight(state.position.x, state.position.z);
    if (state.position.y <= ground && state.velocity.y < 0) {
      // Linearly interpolate the exact crossing for a clean landing point.
      const gPrev = groundHeight(prevPos.x, prevPos.z);
      const f = (prevY - gPrev) / ((prevY - gPrev) - (state.position.y - ground) || 1);
      state.position.lerpVectors(prevPos, state.position, f);
      break;
    }
  }

  const landing = { pos: state.position.clone(), vel: state.velocity.clone(), t };
  const flat = new Vector3(landing.pos.x - start.x, 0, landing.pos.z - start.z);
  const carry = flat.length();
  const descentAngle = Math.atan2(-landing.vel.y, Math.hypot(landing.vel.x, landing.vel.z));
  const lateral = signedLateral(start, landing.pos, params.azimuth || 0);

  return {
    samples,
    landing,
    apexHeight: apex.height,
    apexTime: apex.t,
    carry,               // meters, straight-line ground distance
    lateral,             // meters, + right of the intended target line
    flightTime: t,
    descentAngle,        // radians
    landingSpin: omegaAt(omega0, t),
    spinAxis,
    launch: { position: start, velocity, omega0 },
  };
}

// Lateral offset of the landing point from the intended target line.
function signedLateral(start, land, azimuthDeg) {
  // Intended line: straight down range from start along -Z (azimuth aims it,
  // but "target" here means the 0-azimuth line so slice/hook shows up).
  const dx = land.x - start.x;
  const dz = land.z - start.z;
  // Distance to the right of the straight -Z line is simply dx.
  void dz; void azimuthDeg;
  return dx;
}
