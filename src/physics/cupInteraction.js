// Penner, The physics of putting (2002), equations 23 and 30:
// https://doi.org/10.1139/p01-137
// This fitted capture envelope describes regulation balls/holes on gentle
// slopes. It is not a rim-collision or flagstick-contact solver.
export function cupCaptureSpeed(offset, radius, uphillFraction = 0) {
  if (![offset, radius, uphillFraction].every(Number.isFinite) || radius <= 0 || Math.abs(uphillFraction) >= 1) {
    throw new RangeError('Cup geometry and approach slope must be finite and valid.');
  }
  return 1.63 * Math.max(0, 1 - (offset / radius) ** 2) / Math.sqrt(1 - uphillFraction);
}

// Test the swept entry into the opening, so capture is independent of frame
// rate and cannot pull a nearby miss toward the hole.
export function intersectCupEntry(from, to, cup) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const x = from.x - cup.x, z = from.z - cup.z;
  const a = dx * dx + dz * dz;
  const c = x * x + z * z - cup.radius * cup.radius;
  if (a < 1e-20 || c < 0) return null;
  const b = x * dx + z * dz;
  const determinant = b * b - a * c;
  if (determinant < 0) return null;
  const t = (-b - Math.sqrt(determinant)) / a;
  if (t < 0 || t > 1) return null;
  return { t, offset: Math.abs(x * dz - z * dx) / Math.sqrt(a) };
}
