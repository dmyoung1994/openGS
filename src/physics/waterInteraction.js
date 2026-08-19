import { Vector3 } from 'three';

// Water-entry mechanics interface. Runtime calibration is deliberately explicit:
// missing data fails at the first water contact instead of silently reverting to a
// generic bounce. The shipped golf-ball record is based on:
//
// - Lyu, Yun & Wei (2021), DOI 10.1007/s11804-021-00236-9: high-speed-camera
//   experiments fitted the sphere bounce boundary v[m/s] = 17.5 theta[deg] - 45.5.
// - Kiter, Abbood & Hassoon (2023), DOI 10.31436/iiumej.v24i1.2448: at peripheral
//   speed ratio 0.3, backspin increased critical angle 10.43 -> 12.5 degrees.
// - Shlien (1994), Experiments in Fluids 17:267-271: non-spinning,
//   non-cavitating sphere drag is approximately 0.45 and impact-splash energy loss
//   is small relative to the submerged trajectory.
// - Classical potential flow: a sphere's added-mass coefficient is 0.5.

const WATER_SOURCES = Object.freeze([
  'doi:10.1007/s11804-021-00236-9',
  'doi:10.31436/iiumej.v24i1.2448',
  'Shlien-ExperimentsInFluids-17-267-271-1994',
  'sphere-added-mass-potential-flow-Ca=0.5',
]);

// Fresh water at ordinary course conditions. Kept beside the entry model so the
// authoritative runtime and its tests do not grow independent density constants.
export const FRESH_WATER_DENSITY = 997;

export const GOLF_BALL_WATER_ENTRY_MODEL = Object.freeze({
  source: WATER_SOURCES.join(';'),
  criticalVelocityPerDegree: 17.5,
  criticalVelocityOffset: -45.5,
  spinCriticalAngleGainPerRatio: ((12.5 / 10.43) - 1) / 0.3,
  maxCalibratedSpinRatio: 0.3,
  dragCoefficient: 0.45,
  addedMassCoefficient: 0.5,
});

function finite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function vector(name, value) {
  if (!(value instanceof Vector3) || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new TypeError(`${name} must be a finite Vector3`);
  }
  return value;
}

export function validateWaterEntryModel(model) {
  if (!model || typeof model !== 'object' || typeof model.source !== 'string' || model.source.length === 0) {
    throw new TypeError('water entry model requires a non-empty source identifier');
  }
  const positive = [
    'criticalVelocityPerDegree', 'spinCriticalAngleGainPerRatio',
    'maxCalibratedSpinRatio', 'dragCoefficient', 'addedMassCoefficient',
  ];
  for (const name of positive) {
    finite(`water entry model.${name}`, model[name]);
    if (model[name] < 0) throw new RangeError(`water entry model.${name} must be >= 0`);
  }
  finite('water entry model.criticalVelocityOffset', model.criticalVelocityOffset);
  if (model.criticalVelocityPerDegree <= 0 || model.maxCalibratedSpinRatio <= 0) {
    throw new RangeError('water entry critical slope and calibrated spin ratio must be > 0');
  }
  return model;
}

// Exact segment crossing against the horizontal, time-varying water plane.
// Returns null for no crossing; t is in [0, 1] and position is a fresh vector
// so the caller can retain it for a deterministic splash/ripple event.
export function intersectSegmentWaterPlane(start, end, waterHeight) {
  vector('start', start); vector('end', end); finite('waterHeight', waterHeight);
  const a = start.y - waterHeight;
  const b = end.y - waterHeight;
  if ((a > 0 && b > 0) || (a < 0 && b < 0) || (a === 0 && b === 0)) return null;
  const t = a / (a - b);
  if (t < 0 || t > 1) return null;
  return {
    t,
    position: new Vector3().lerpVectors(start, end, t),
    normal: new Vector3(0, 1, 0),
  };
}

// Computes an immediate skip/penetration result and the force terms a fixed
// substep integrator must apply after penetration. This module deliberately
// does not decide gameplay hazards or emit renderer effects.
export function resolveWaterEntry({
  velocity,
  angularVelocity = new Vector3(),
  normal = new Vector3(0, 1, 0),
  ball,
  waterDensity = FRESH_WATER_DENSITY,
  model,
}) {
  vector('velocity', velocity); vector('normal', normal);
  vector('angularVelocity', angularVelocity);
  if (!ball || !Number.isFinite(ball.mass) || !Number.isFinite(ball.radius) || ball.mass <= 0 || ball.radius <= 0) throw new TypeError('ball requires finite positive mass and radius');
  finite('waterDensity', waterDensity);
  if (waterDensity <= 0) throw new RangeError('waterDensity must be > 0');
  validateWaterEntryModel(model);
  const n = normal.clone().normalize();
  const normalVelocity = velocity.dot(n);
  const inwardNormalSpeed = Math.max(0, -normalVelocity);
  const tangent = velocity.clone().addScaledVector(n, -normalVelocity);
  const tangentialSpeed = tangent.length();
  const speed = velocity.length();
  const incidentAngleDegrees = Math.atan2(inwardNormalSpeed, Math.max(tangentialSpeed, 1e-9)) * 180 / Math.PI;

  // Positive spin about tangent x normal is backspin. The published spinning-sphere
  // result supplies one calibrated ratio, so clamp there rather than extrapolating.
  const tangentDirection = tangentialSpeed > 1e-9 ? tangent.clone().multiplyScalar(1 / tangentialSpeed) : new Vector3(1, 0, 0);
  const backspinAxis = tangentDirection.clone().cross(n).normalize();
  const spinRatio = Math.max(0, angularVelocity.dot(backspinAxis) * ball.radius / Math.max(speed, 1e-9));
  const calibratedSpinRatio = Math.min(spinRatio, model.maxCalibratedSpinRatio);
  const spinAngleScale = 1 + model.spinCriticalAngleGainPerRatio * calibratedSpinRatio;
  const effectiveAngleDegrees = incidentAngleDegrees / spinAngleScale;
  const criticalSpeed = Math.max(0,
    model.criticalVelocityPerDegree * effectiveAngleDegrees + model.criticalVelocityOffset);
  const skips = inwardNormalSpeed > 0 && tangentialSpeed > 0 && speed >= criticalSpeed;

  const volume = (4 / 3) * Math.PI * ball.radius ** 3;
  const displacedMass = waterDensity * volume;
  const addedMass = displacedMass * model.addedMassCoefficient;
  const dragCoefficient = 0.5 * waterDensity * Math.PI * ball.radius ** 2 * model.dragCoefficient;
  if (skips) {
    // Integrating m_eff dv/dt = -k |v|v over one sphere diameter gives this
    // dimensionless retention exactly: v_out/v_in = exp(-k L / m_eff). It replaces
    // the old hand-authored restitution and tangential-retention constants.
    const effectiveMass = ball.mass + addedMass;
    const retention = Math.exp(-dragCoefficient * (2 * ball.radius) / effectiveMass);
    const reflected = velocity.clone().addScaledVector(n, inwardNormalSpeed * 2).multiplyScalar(retention);
    return {
      kind: 'skip',
      source: model.source,
      inwardNormalSpeed,
      tangentialSpeed,
      incidentAngleDegrees,
      effectiveAngleDegrees,
      criticalSpeed,
      spinRatio,
      retention,
      velocity: reflected,
      angularVelocity: angularVelocity.clone().multiplyScalar(retention),
    };
  }
  const ballDensity = ball.mass / volume;
  return {
    kind: 'penetration',
    source: model.source,
    inwardNormalSpeed,
    tangentialSpeed,
    incidentAngleDegrees,
    effectiveAngleDegrees,
    criticalSpeed,
    spinRatio,
    // Per-unit-velocity quadratic drag coefficient: F = -k |v| v.
    dragCoefficient,
    addedMass,
    buoyancy: displacedMass * 9.80665,
    ballDensity,
    sinks: ballDensity > waterDensity,
  };
}
