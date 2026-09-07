import { signedDistanceToFeature } from './featureGeometry.js';

// Editable v4 landforms compile into smooth signed height contributions on top of
// the engine-owned geologic base. Render and collision sample this same function.
export function semanticLandformHeight(landforms, x, z) {
  let height = 0;
  for (const landform of landforms || []) {
    const distance = distanceToPolyline(x, z, landform.points);
    const core = Math.max(0.5, landform.width * 0.5);
    if (distance >= core + landform.falloff) continue;
    const shoulder = 1 - smoothstep(core, core + landform.falloff, distance);
    const rounded = 1 - smoothstep(0, core, distance);
    const profile = ['ridge', 'saddle', 'drainage-channel', 'swale'].includes(landform.kind)
      ? rounded
      : shoulder;
    height += landform.height * profile;
  }
  return height;
}

function distanceToPolyline(x, z, points) {
  if (points.length === 1) return Math.hypot(x - points[0].x, z - points[0].z);
  let nearest = Infinity;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index], b = points[index + 1]; const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
    nearest = Math.min(nearest, Math.hypot(x - (a.x + dx * amount), z - (a.z + dz * amount)));
  }
  return nearest;
}

function smoothstep(edge0, edge1, value) {
  const amount = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-9, edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}

// An explicitly authored base plane, tied to the site's centre elevation. The
// actual green outline owns its C1-continuous blend through the surrounds.
export function greenGradeHeight(green, datum, baseHeight, x, z) {
  const { slopeX, slopeZ, blend } = green.grade;
  const weight = smoothstep(-blend, 0, signedDistanceToFeature(green, x, z));
  const plane = datum + slopeX * (x - green.x) + slopeZ * (z - green.z);
  return baseHeight + (plane - baseHeight) * weight;
}
