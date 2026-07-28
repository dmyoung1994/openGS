// Unit conversions. Internally the simulation is strictly SI (meters, seconds,
// kilograms, radians). Player-facing metrics use golf's customary units.

export const MPH_TO_MS = 0.44704;
export const MS_TO_MPH = 1 / MPH_TO_MS;
export const YARD_TO_M = 0.9144;
export const M_TO_YARD = 1 / YARD_TO_M;
export const FOOT_TO_M = 0.3048;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const RPM_TO_RADS = (2 * Math.PI) / 60;
export const RADS_TO_RPM = 1 / RPM_TO_RADS;

export const mph = (ms) => ms * MS_TO_MPH;
export const yards = (m) => m * M_TO_YARD;
export const feet = (m) => m / FOOT_TO_M;
