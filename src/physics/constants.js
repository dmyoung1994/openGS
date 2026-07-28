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
};

export const GRAVITY = 9.80665; // m/s^2

// Standard atmosphere at sea level, 15 C, dry air.
export const STANDARD_AIR_DENSITY = 1.225; // kg/m^3

// Spin decays roughly exponentially in flight from surface friction with the
// air. Tour-measured decay is small over a single shot; tau ~ 20-30 s.
export const SPIN_DECAY_TAU = 24; // s

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
