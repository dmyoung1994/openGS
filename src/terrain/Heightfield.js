// Shared collision sampling for Terrain and worker-side production-physics putts.
export function sampleHeightfield(field, x, z) {
  const { minX, minZ, maxX, maxZ } = field.bounds;
  const fx = (Math.min(Math.max(x, minX), maxX) - minX) / field.spacing;
  const fz = (Math.min(Math.max(z, minZ), maxZ) - minZ) / field.spacing;
  const i = Math.min(Math.floor(fx), field.nx - 2);
  const j = Math.min(Math.floor(fz), field.nz - 2);
  const tx = fx - i, tz = fz - j;
  const h00 = field.heights[j * field.nx + i];
  const h10 = field.heights[j * field.nx + i + 1];
  const h01 = field.heights[(j + 1) * field.nx + i];
  const h11 = field.heights[(j + 1) * field.nx + i + 1];
  const a = h00 * (1 - tx) + h10 * tx;
  const b = h01 * (1 - tx) + h11 * tx;
  return a * (1 - tz) + b * tz;
}

export function sampleHeightfieldNormal(field, x, z, out) {
  const e = field.spacing;
  const hL = field.heightAt(x - e, z), hR = field.heightAt(x + e, z);
  const hD = field.heightAt(x, z - e), hU = field.heightAt(x, z + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}
