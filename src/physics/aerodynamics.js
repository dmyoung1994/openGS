// Aerodynamics for a contemporary urethane golf ball.
//
// Provenance (not a hand tuned carry fit): USGA/R&A, "Determination of the
// Aerodynamic Behaviour of Golf Balls for Iron Trajectories", Appendix C of
// the 2006 Second Report on Spin Generation, equations (7) and (8), pp. 6-7:
// https://www.jga.or.jp/jga/html/rules/image/info_groove_second_report_spin_generation_en.pdf
// The report derives C_L/C_D from 50 Hz outdoor trajectories and cites
// Bearman & Harvey (1976), Golf Ball Aerodynamics, Aeronautical Quarterly
// 27(2), 112-122, doi:10.1017/S0001925900007617.  Its Reynolds term is in
// units of 1e5.  The entries below are direct evaluations of equation (7)/(8),
// rounded to six decimals; negative values of the fitted C_L were constrained
// to the physical lower bound of zero.  They are *not* fabricated measurements.
//
// Validated source envelope: Re 0.2e5..2.0e5 and spin ratio Θ 0..1.8.  The
// simulation deliberately rejects evaluations beyond that envelope instead of
// inventing an extrapolation.  Θ=0 is the analytic zero-lift limit of (7), and
// C_D is the Q ln(Q) -> 0 limit of (8).

export const AERO_SOURCE = Object.freeze({
  id: 'usga-randa-spin-generation-2006-appendix-c',
  doi: '10.1017/S0001925900007617',
  reynolds: [20_000, 40_000, 70_000, 100_000, 150_000, 200_000],
  spinRatio: [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 1.8],
});

// Rows are Θ; C_L columns are Re. C_D is equation (8), which has no Re term.
export const AERO_COEFFICIENT_TABLE = Object.freeze([
  Object.freeze({ spinRatio: 0, cl: Object.freeze([0, 0, 0, 0, 0, 0]), cd: 0.066390 }),
  Object.freeze({ spinRatio: 0.05, cl: Object.freeze([0, 0, 0.067034, 0.082402, 0.062542, 0.024363]), cd: 0.161926 }),
  Object.freeze({ spinRatio: 0.1, cl: Object.freeze([0, 0.059667, 0.145721, 0.161089, 0.141229, 0.103050]), cd: 0.215692 }),
  Object.freeze({ spinRatio: 0.2, cl: Object.freeze([0, 0.138744, 0.224799, 0.240167, 0.220307, 0.182128]), cd: 0.285417 }),
  Object.freeze({ spinRatio: 0.4, cl: Object.freeze([0.008549, 0.220034, 0.306088, 0.321456, 0.301596, 0.263417]), cd: 0.361143 }),
  Object.freeze({ spinRatio: 0.8, cl: Object.freeze([0.102349, 0.313834, 0.399889, 0.415256, 0.395397, 0.357218]), cd: 0.432701 }),
  Object.freeze({ spinRatio: 1.2, cl: Object.freeze([0.180741, 0.392225, 0.478280, 0.493648, 0.473788, 0.435609]), cd: 0.498964 }),
  Object.freeze({ spinRatio: 1.8, cl: Object.freeze([0.316036, 0.527521, 0.613575, 0.628943, 0.609083, 0.570904]), cd: 0.682582 }),
]);

export const AIR_VISCOSITY = 1.7894e-5; // kg/(m*s), 15 °C reference

// Ferguson (2023), University of Waterloo, section 3.4, equation (3.15):
// https://hdl.handle.net/10012/19337
//
// These coefficients were identified from 1,040 outdoor shots made with 2021
// Titleist Pro V1 balls. GCQuad measured each complete launch state, FlightScope
// X3 tracked the resulting flight, wind stayed below 1.3 m/s, and the shots span
// lob wedge through driver (spin ratios 0.02..0.75). The held-out 20% validation
// set produced 2.74 yd carry, 1.68 yd offline, and 1.28 yd apex mean absolute
// errors. This replaces the old driver-corner correction with one function of
// ball state. Club identity is neither accepted nor inspected by this profile.
export const CONTEMPORARY_URETHANE_AERO_PROFILE = Object.freeze({
  id: 'ferguson-2021-pro-v1-universal-v1',
  source: 'https://hdl.handle.net/10012/19337',
  observedSpinRatio: Object.freeze([0.02, 0.75]),
  // A zero-spin continuation is well behaved. Above the observed envelope we
  // hold the boundary value instead of extrapolating a quadratic indefinitely.
  integrationSpinRatio: Object.freeze([0, 0.75]),
  drag: Object.freeze([0.1304, 0.9287, -0.8259]),
  lift: Object.freeze([0.0504, 1.2031, -1.1490]),
  spinMomentSlope: 0.01,
});

export const AERO_PROFILES = Object.freeze({
  contemporaryUrethane: CONTEMPORARY_URETHANE_AERO_PROFILE,
});

function finite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function interval(axis, value, name) {
  finite(name, value);
  if (value < axis[0] || value > axis[axis.length - 1]) {
    throw new RangeError(`${name}=${value} outside source-backed domain [${axis[0]}, ${axis[axis.length - 1]}]`);
  }
  for (let i = 0; i < axis.length - 1; i += 1) {
    if (value <= axis[i + 1]) {
      const width = axis[i + 1] - axis[i];
      return { index: i, t: width === 0 ? 0 : (value - axis[i]) / width };
    }
  }
  return { index: axis.length - 2, t: 1 };
}

export function reynolds(rho, speed, diameter, viscosity = AIR_VISCOSITY) {
  finite('rho', rho); finite('speed', speed); finite('diameter', diameter); finite('viscosity', viscosity);
  if (rho <= 0 || speed < 0 || diameter <= 0 || viscosity <= 0) throw new RangeError('rho, diameter and viscosity must be > 0 and speed must be >= 0');
  return (rho * speed * diameter) / viscosity;
}

export function spinRatio(radius, angularSpeed, speed) {
  finite('radius', radius); finite('angularSpeed', angularSpeed); finite('speed', speed);
  if (radius <= 0 || angularSpeed < 0 || speed <= 0) throw new RangeError('radius and speed must be > 0 and angularSpeed must be >= 0');
  return (radius * angularSpeed) / speed;
}

// Bilinear C_L / linear C_D interpolation over the published-fit sample table.
// `out` avoids a per-RK-stage object allocation.
export function aerodynamicCoefficients(out, Re, theta) {
  const re = interval(AERO_SOURCE.reynolds, Re, 'Reynolds number');
  const q = interval(AERO_SOURCE.spinRatio, theta, 'spin ratio');
  const low = AERO_COEFFICIENT_TABLE[q.index];
  const high = AERO_COEFFICIENT_TABLE[q.index + 1];
  const clLow = low.cl[re.index] + (low.cl[re.index + 1] - low.cl[re.index]) * re.t;
  const clHigh = high.cl[re.index] + (high.cl[re.index + 1] - high.cl[re.index]) * re.t;
  out.cl = clLow + (clHigh - clLow) * q.t;
  out.cd = low.cd + (high.cd - low.cd) * q.t;
  return out;
}

// The published coefficient fit has a finite measured envelope, while an actual
// shot necessarily crosses its lower Reynolds boundary shortly before contact.
// Throwing there makes the final airborne RK4 stage impossible to complete.  The
// live-flight policy therefore holds the nearest measured coefficient at every
// edge of the source domain.  This is deliberately separate from the strict
// `aerodynamicCoefficients()` API above: validation callers can still detect an
// unsupported query, while integration remains total and bounded.  Because the
// aerodynamic force is proportional to speed squared, its absolute contribution
// still tends smoothly to zero during the terminal low-speed continuation.
export function flightAerodynamicCoefficients(out, Re, theta, profile = CONTEMPORARY_URETHANE_AERO_PROFILE) {
  finite('Reynolds number', Re);
  finite('spin ratio', theta);
  if (Re < 0 || theta < 0) throw new RangeError('Reynolds number and spin ratio must be >= 0');
  if (profile?.id === CONTEMPORARY_URETHANE_AERO_PROFILE.id) {
    const [minimum, maximum] = profile.integrationSpinRatio;
    const boundedTheta = Math.min(maximum, Math.max(minimum, theta));
    const thetaSquared = boundedTheta * boundedTheta;
    out.cd = profile.drag[0] + profile.drag[1] * boundedTheta + profile.drag[2] * thetaSquared;
    out.cl = profile.lift[0] + profile.lift[1] * boundedTheta + profile.lift[2] * thetaSquared;
    return out;
  }

  const reAxis = AERO_SOURCE.reynolds;
  const spinAxis = AERO_SOURCE.spinRatio;
  const boundedRe = Math.min(reAxis[reAxis.length - 1], Math.max(reAxis[0], Re));
  const boundedTheta = Math.min(spinAxis[spinAxis.length - 1], Math.max(spinAxis[0], theta));
  aerodynamicCoefficients(out, boundedRe, boundedTheta);
  if (profile == null || profile === AERO_SOURCE || profile.id === AERO_SOURCE.id) return out;
  throw new RangeError(`unsupported aerodynamic profile "${profile?.id}"`);
}

export function liftCoefficient(Re, theta) {
  return aerodynamicCoefficients({ cl: 0, cd: 0 }, Re, theta).cl;
}

export function dragCoefficient(Re, theta) {
  return aerodynamicCoefficients({ cl: 0, cd: 0 }, Re, theta).cd;
}

const _coefficients = { cl: 0, cd: 0 };

// Aerodynamic acceleration. `angularVelocity` is a physical vector in rad/s;
// ω × v gives the signed Magnus direction without a separate fixed spin axis.
export function coefficientSnapshot(out, relativeVelocity, angularVelocity, rho, { radius }, {
  viscosity = AIR_VISCOSITY,
  profile = CONTEMPORARY_URETHANE_AERO_PROFILE,
} = {}) {
  const speed = relativeVelocity.length();
  if (speed < 1e-6) return Object.assign(out, { speed, reynolds: 0, spinRatio: 0, cl: 0, cd: 0 });
  const theta = spinRatio(radius, angularVelocity.length(), speed);
  const Re = reynolds(rho, speed, radius * 2, viscosity);
  flightAerodynamicCoefficients(out, Re, theta, profile);
  out.speed = speed;
  out.reynolds = Re;
  out.spinRatio = theta;
  return out;
}

export function aeroAcceleration(out, relativeVelocity, angularVelocity, rho, { radius, area, mass }, options = {}) {
  const speed = relativeVelocity.length();
  if (speed < 1e-6) return out.set(0, 0, 0);
  if (!Number.isFinite(rho) || rho <= 0 || !Number.isFinite(mass) || mass <= 0) {
    throw new RangeError('aerodynamic state has invalid density or ball mass');
  }
  const coefficients = coefficientSnapshot(_coefficients, relativeVelocity, angularVelocity, rho, { radius }, options);
  const q = 0.5 * rho * area;
  const dragMagnitude = q * coefficients.cd * speed * speed;
  out.copy(relativeVelocity).multiplyScalar(-dragMagnitude / speed);

  const lx = angularVelocity.y * relativeVelocity.z - angularVelocity.z * relativeVelocity.y;
  const ly = angularVelocity.z * relativeVelocity.x - angularVelocity.x * relativeVelocity.z;
  const lz = angularVelocity.x * relativeVelocity.y - angularVelocity.y * relativeVelocity.x;
  const liftMagnitude = Math.hypot(lx, ly, lz);
  if (liftMagnitude > 1e-10 && coefficients.cl > 0) {
    const scale = (q * coefficients.cl * speed * speed) / liftMagnitude;
    out.x += lx * scale;
    out.y += ly * scale;
    out.z += lz * scale;
  }
  return out.multiplyScalar(1 / mass);
}
