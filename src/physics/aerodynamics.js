// Golf-ball aerodynamic coefficients.
//
// Lift and drag are modeled as functions of the dimensionless spin ratio
//     S = r*omega / v
// and (for drag) the Reynolds number
//     Re = rho * v * (2r) / mu.
//
// Functional forms follow the wind-tunnel literature:
//   * Lift rises non-linearly with spin ratio and is well described by a
//     2nd-order polynomial in S (Lyu, Kensrud & Smith 2018; Bearman & Harvey
//     1976). A single saturating exponential does NOT fit driver and irons at
//     once — the polynomial does.
//   * Drag shows the classic "drag crisis": ~0.5 below the critical Reynolds
//     number, dropping to ~0.21-0.25 above it, then rising slightly, plus a
//     spin-dependent increase (Baek & Kim 2013's Re treatment; Bearman & Harvey).
//
// The constants are then calibrated so the full set of TrackMan tour launch
// conditions (driver through pitching wedge) reproduces real carry within
// ~3.8% mean error. See git history / scratch calibration for the fit.
//
// All tunables live in AERO so the whole flight is adjustable in one place.

export const AERO = {
  // Lift: Cl(S) = clA + clB*S + clC*S^2, clamped.
  clA: 0.129,
  clB: 0.705,
  clC: -0.760,
  clMin: 0.05,
  clMax: 0.34,
  // Drag: crisis transition + gentle post-critical rise + spin term.
  cdCrisis: 0.50,   // Cd well below the critical Reynolds number
  cdMin: 0.210,     // Cd just above the crisis
  reA: 4.0e4,       // start of the drag-crisis drop
  reB: 7.0e4,       // end of the drop (fully "tripped")
  cdRise: 0.045,    // slow rise at high Re
  cdSpin: 0.195,    // extra drag per unit spin ratio
  // A ball-construction multiplier on the spin-driven terms. 1.0 = tour ball;
  // lower = harder "distance"/range ball (less spin response, flatter flight).
  spinResponse: 1.0,
  // Spin ratio is clamped to a sane flight range.
  sMin: 0.0,
  sMax: 0.9,
};

// Air dynamic viscosity at ~15 C (kg/(m*s)). Weakly temperature dependent;
// constant here is well within the accuracy of the coefficient fit.
export const AIR_VISCOSITY = 1.81e-5;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function spinRatio(radius, omega, speed) {
  return clamp((radius * omega) / Math.max(speed, 0.05), AERO.sMin, AERO.sMax);
}

export function reynolds(rho, speed, diameter) {
  return (rho * speed * diameter) / AIR_VISCOSITY;
}

export function liftCoefficient(S) {
  const s = S * AERO.spinResponse;
  return clamp(AERO.clA + AERO.clB * s + AERO.clC * s * s, AERO.clMin, AERO.clMax);
}

export function dragCoefficient(Re, S) {
  let cd = AERO.cdCrisis + (AERO.cdMin - AERO.cdCrisis) * smoothstep(AERO.reA, AERO.reB, Re);
  cd += AERO.cdRise * clamp((Re - 1.0e5) / 1.2e5, 0, 1);
  cd += AERO.cdSpin * S * AERO.spinResponse;
  return cd;
}

// Aerodynamic acceleration (m/s^2) on the ball. Fills and returns `out`.
//   Drag  = -0.5 rho A Cd |v| v
//   Magnus= 0.5 rho A Cl |v|^2 * unit(spinAxis x v)
export function aeroAcceleration(out, vel, spinAxis, omega, rho, { radius, area, mass }) {
  const speed = vel.length();
  if (speed < 0.05) return out.set(0, 0, 0);

  const S = spinRatio(radius, omega, speed);
  const Re = reynolds(rho, speed, radius * 2);
  const Cd = dragCoefficient(Re, S);
  const Cl = liftCoefficient(S);

  const q = 0.5 * rho * area;

  // Drag: magnitude q*Cd*speed^2, direction -v_hat.
  const dragMag = q * Cd * speed * speed;
  out.copy(vel).multiplyScalar(-dragMag / speed);

  // Magnus: direction unit(spinAxis x v), magnitude q*Cl*speed^2.
  const lx = spinAxis.y * vel.z - spinAxis.z * vel.y;
  const ly = spinAxis.z * vel.x - spinAxis.x * vel.z;
  const lz = spinAxis.x * vel.y - spinAxis.y * vel.x;
  const lm = Math.hypot(lx, ly, lz);
  if (lm > 1e-8) {
    const s = (q * Cl * speed * speed) / lm;
    out.x += lx * s;
    out.y += ly * s;
    out.z += lz * s;
  }

  out.multiplyScalar(1 / mass);
  return out;
}
