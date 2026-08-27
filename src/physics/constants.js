// Physical constants for the ball and its environment.
//
// The ball is a standard R&A / USGA regulation ball:
//   mass  >= 45.93 g,  diameter >= 42.67 mm.
// We use those minimums, which is what tour balls are built to.

export const BALL = {
  mass: 0.04593,          // kg
  diameter: 0.04267,      // m
  get radius() { return this.diameter / 2; },              // m
  get area() { return Math.PI * this.radius * this.radius; }, // m^2 (cross-section)
  // Uniform-sphere approximation used by the aerodynamic spin-moment ODE.
  get momentOfInertia() { return (2 / 5) * this.mass * this.radius * this.radius; }, // kg*m^2
};

export const GRAVITY = 9.80665; // m/s^2

// Standard atmosphere at sea level, 15 C, dry air.
export const STANDARD_AIR_DENSITY = 1.225; // kg/m^3

// Dynamic viscosity from Sutherland's law. Reynolds number depends on viscosity as
// well as density; holding this at its 15 C value made hot/cold air only half-real.
// Reference: dry air, mu0 = 1.716e-5 Pa*s at 273.15 K, S = 111 K.
export function airViscosity(temperatureC = 15) {
  if (!Number.isFinite(temperatureC)) throw new TypeError('temperatureC must be finite');
  const temperatureK = Math.max(180, temperatureC + 273.15);
  const referenceK = 273.15;
  const referenceViscosity = 1.716e-5;
  const sutherland = 111;
  return referenceViscosity
    * Math.pow(temperatureK / referenceK, 1.5)
    * (referenceK + sutherland) / (temperatureK + sutherland);
}

// USGA/R&A Second Report on Spin Generation (2006), Appendix C eq. (5):
// dω/dt = -Cw |u|/r ω. The report states Cw=2e-5 is consistent with the
// Overall Distance Standard. The integrator applies this as a vector torque.
export const SPIN_DECAY_COEFFICIENT = 2e-5;

// Air density from altitude and temperature, so "playing at altitude" and
// hot/cold days actually change carry the way they do in reality.
// altitude in meters, temperature in Celsius.
export function airDensity({ altitude = 0, temperatureC = 15, humidity = 0 } = {}) {
  // Barometric pressure via the standard atmosphere lapse.
  const T0 = 288.15;               // K, sea-level standard temperature
  const L = 0.0065;                // K/m lapse rate
  const p0 = 101325;               // Pa
  const g = GRAVITY;
  const M = 0.0289644;             // kg/mol, molar mass of dry air
  const R = 8.31447;               // J/(mol K)
  const T = Math.max(233, T0 - L * altitude);
  const p = p0 * Math.pow(1 - (L * altitude) / T0, (g * M) / (R * L));
  const Tactual = temperatureC + 273.15;
  // Dry-air density at the ambient temperature.
  let rho = (p * M) / (R * Tactual);
  // Humid air is slightly *less* dense (water vapor is lighter than air).
  if (humidity > 0) {
    const psat = 610.94 * Math.exp((17.625 * temperatureC) / (temperatureC + 243.04));
    const pv = humidity * psat;
    const pd = p - pv;
    rho = (pd * 0.0289644 + pv * 0.018016) / (R * Tactual);
  }
  return rho;
}
