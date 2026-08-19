// Shared plan-view geometry for authored course features. Positive signed distance
// means inside. Physics, terrain carving, the GPU zone bake, clearances, and minimap
// all call this module so an irregular outline cannot drift between subsystems.

export function signedDistanceToFeature(feature, x, z) {
  if (!feature?.shape?.length) return feature.r - Math.hypot(x - feature.x, z - feature.z);
  let minDistanceSq = Infinity;
  let inside = false;
  const points = feature.shape;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[j];
    const b = points[i];
    minDistanceSq = Math.min(minDistanceSq, segmentDistanceSq(x, z, a.x, a.z, b.x, b.z));
    const crosses = ((a.z > z) !== (b.z > z))
      && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x;
    if (crosses) inside = !inside;
  }
  const distance = Math.sqrt(minDistanceSq);
  return inside ? distance : -distance;
}

// Convert a sparse authored control polygon into a rounded, closed quadratic
// B-spline outline. Golf features are graded/maintained curves, not straight
// chords between survey stakes. Sampling the same normalized outline everywhere
// keeps terrain carving, physics, placement clearances, the minimap, and the GPU
// SDF in exact agreement. The quadratic segments remain inside the neighbouring
// control-point hull, avoiding the overshoot and self-intersections possible with
// an unconstrained Catmull-Rom spline.
export function smoothClosedOutline(points, samplesPerControl = 3) {
  if (!Array.isArray(points) || points.length < 3) return points;
  const samples = [];
  const midpoint = (a, b) => ({ x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 });
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[(i + points.length - 1) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const start = midpoint(previous, current);
    const end = midpoint(current, next);
    for (let sample = 0; sample < samplesPerControl; sample += 1) {
      const t = sample / samplesPerControl;
      const u = 1 - t;
      samples.push(Object.freeze({
        x: u * u * start.x + 2 * u * t * current.x + t * t * end.x,
        z: u * u * start.z + 2 * u * t * current.z + t * t * end.z,
      }));
    }
  }
  return Object.freeze(samples);
}

// Runtime hazard geometry is deliberately compiled once, before Range bakes either
// height or surface data.  The course schema keeps a compact editable control shape;
// this representation is the rounded, perception-safe contour shared by collision,
// terrain, minimap, bank SDF, and the actual water mesh.  Recompiling an already
// prepared feature is a no-op so WaterSurface can defensively call this boundary
// without subtly shrinking the contour a second time.
export const HAZARD_GEOMETRY_VERSION = 1;
// A regular bunker keeps a readable turf face between its grade-flush outer rim
// and the maintained sand. The radial offset is varied by +/-10 cm when the
// inner contour is compiled, so this is a construction width rather than a
// bright, constant-width pigment ring.
export const BUNKER_SAND_INSET_M = 0.40;
export const BUNKER_SAND_INSET_VARIATION_M = 0.10;

export function roundedHazardFeature(feature, { kind, index = 0 } = {}) {
  if (kind !== 'pond' && kind !== 'bunker') {
    throw new TypeError('roundedHazardFeature kind must be pond or bunker.');
  }
  if (feature?._hazardGeometryVersion === HAZARD_GEOMETRY_VERSION
    && feature?._hazardKind === kind) return feature;

  const minimumSamples = kind === 'pond' ? 96 : 54;
  const samplesPerControl = feature?.shape?.length
    ? Math.max(kind === 'pond' ? 4 : 3, Math.ceil(minimumSamples / feature.shape.length))
    : 1;
  let outline = feature?.shape?.length >= 3
    ? smoothClosedOutline(feature.shape, samplesPerControl)
    : lobedHazardOutline(feature, kind, index);
  // Bunkers need stronger architectural intent than a softened control circle.
  // Compile one area-preserving major axis, three unequal noses and a quiet back
  // edge. The same result owns carving, ball lies, render masks and the minimap.
  const bunkerShape = kind === 'bunker'
    ? shapeBunkerOutline(outline, feature, index)
    : null;
  if (bunkerShape) outline = bunkerShape.outline;
  if (polygonSelfIntersects(outline)) {
    throw new TypeError(`${kind} rounded outline self-intersects.`);
  }
  if (signedDistanceToFeature({ ...feature, shape: outline }, feature.x, feature.z) <= 0) {
    throw new TypeError(`${kind} rounded outline must contain its authored center.`);
  }
  return Object.freeze({
    ...feature,
    shape: outline,
    ...(bunkerShape ? {
      _sandShape: insetBunkerSandOutline(outline, feature, index),
      _bunkerMajorAxis: bunkerShape.majorAxis,
      _bunkerAspect: bunkerShape.aspect,
    } : {}),
    _hazardKind: kind,
    _hazardGeometryVersion: HAZARD_GEOMETRY_VERSION,
  });
}

// Pure collision-authoritative bunker grade used by Range and direct tests.
// Positive signed distance is inside the one rounded plan-view contour shared by
// surface IDs and rendering. The carve is exactly zero at the boundary, and its
// bounded drainage bias can deepen only to (never beyond) the authored depth.
export function bunkerGradeAt({ bunker, signedDistance, baseHeight, x, z }) {
  if (signedDistance <= 0) return baseHeight;
  const dx = x - bunker.x;
  const dz = z - bunker.z;
  const radialLength = Math.hypot(dx, dz);
  const drainageX = Number.isFinite(bunker._drainageX) ? bunker._drainageX : 0;
  const drainageZ = Number.isFinite(bunker._drainageZ) ? bunker._drainageZ : -1;
  const faceDirection = radialLength > 1e-6
    ? Math.max(-1, Math.min(1, (dx * drainageX + dz * drainageZ) / radialLength))
    : 0;
  const nominalWall = bunker.r * (bunker.pot ? 0.28 : 0.54);
  // The uphill/back wall carries the broader flashed face while the drainage exit
  // is tighter and feeds a shifted low floor. This avoids a radially symmetric
  // bowl without changing the exact grade-flush boundary or authored max depth.
  const wallWidth = nominalWall * (bunker.pot ? 1 : 1 - faceDirection * 0.24);
  let carve = smoothstepScalar(0, wallWidth, signedDistance);
  if (bunker.pot) carve *= 2 - carve;

  const floorGate = smoothstepScalar(wallWidth * 0.78, wallWidth * 1.08, signedDistance);
  const drainageProjection = (dx * drainageX + dz * drainageZ) / Math.max(0.1, bunker.r);
  const drainageBias = smoothstepScalar(-0.48, 0.46, drainageProjection);
  const floorDepthScale = bunker.pot
    ? 0.97 + drainageBias * floorGate * 0.03
    : 0.84 + drainageBias * floorGate * 0.16;
  return baseHeight - bunker.depth * carve * floorDepthScale;
}

// A legacy circle has no authored directional character. Give it a restrained
// two/three-lobe outline derived only from its stable authored identity. The radius
// remains the controlling scale and the centre always remains inside; no random
// state or camera value can alter the result.
function lobedHazardOutline(feature, kind, index) {
  if (!feature || !Number.isFinite(feature.x) || !Number.isFinite(feature.z)
    || !Number.isFinite(feature.r) || feature.r <= 0) {
    throw new TypeError('Hazard fallback outline requires finite x, z, and positive r.');
  }
  const sampleCount = kind === 'pond' ? 96 : 72;
  const phase = featurePhase(feature, index, kind === 'pond' ? 0x706f6e64 : 0x73616e64);
  const secondaryPhase = featurePhase(feature, index, kind === 'pond' ? 0x73686f72 : 0x6c6f6265);
  const aspect = kind === 'pond' ? 1.035 : 1.075;
  const twoLobe = kind === 'pond' ? 0.055 : 0.085;
  const threeLobe = kind === 'pond' ? 0.032 : 0.058;
  const orientation = phase * Math.PI * 2;
  const c = Math.cos(orientation), s = Math.sin(orientation);
  const points = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const theta = i / sampleCount * Math.PI * 2;
    const radius = feature.r * (
      1
      + Math.cos(theta * 2 + orientation) * twoLobe
      + Math.cos(theta * 3 - secondaryPhase * Math.PI * 2) * threeLobe
    );
    const localX = Math.cos(theta) * radius * aspect;
    const localZ = Math.sin(theta) * radius / aspect;
    points.push(Object.freeze({
      x: feature.x + localX * c - localZ * s,
      z: feature.z + localX * s + localZ * c,
    }));
  }
  return Object.freeze(points);
}

function shapeBunkerOutline(points, feature, index) {
  const phase = featurePhase(feature, index, 0x62756e6b);
  const secondary = featurePhase(feature, index, 0x66616365);
  const majorAxis = phase * Math.PI * 2;
  const targetAspect = 1.29 + secondary * 0.12; // deterministic 1.29–1.41

  // Three broad, unequal noses with intervening bays. A raised-cosine support
  // gives each lobe finite influence and leaves the back edge deliberately quiet.
  const shaped = points.map((point) => {
    const dx = point.x - feature.x;
    const dz = point.z - feature.z;
    const angle = Math.atan2(dz, dx);
    const quietBack = directionalBump(angle, majorAxis + Math.PI, 0.72);
    const noses = directionalBump(angle, majorAxis + 0.12, 0.70) * 0.17
      + directionalBump(angle, majorAxis + 2.04, 0.62) * 0.125
      + directionalBump(angle, majorAxis - 1.63, 0.54) * 0.085;
    const bays = directionalBump(angle, majorAxis + 1.08, 0.52) * 0.075
      + directionalBump(angle, majorAxis - 0.82, 0.48) * 0.060;
    const radialScale = 1 + (noses - bays) * (1 - quietBack * 0.88);
    return {
      x: feature.x + dx * radialScale,
      z: feature.z + dz * radialScale,
    };
  });

  // Enforce a decisive but realistic major/minor span while preserving area.
  // Correcting the actual projected spans handles authored outlines that were
  // already slightly oval instead of compounding an arbitrary ellipse.
  const c = Math.cos(majorAxis), s = Math.sin(majorAxis);
  const spanU = projectedSpan(shaped, feature, c, s);
  const spanV = projectedSpan(shaped, feature, -s, c);
  const currentAspect = spanU / Math.max(1e-6, spanV);
  const majorScale = Math.sqrt(targetAspect / currentAspect);
  const minorScale = 1 / majorScale;
  const anisotropic = shaped.map((point) => {
    const dx = point.x - feature.x;
    const dz = point.z - feature.z;
    const u = (dx * c + dz * s) * majorScale;
    const v = (-dx * s + dz * c) * minorScale;
    return {
      x: feature.x + u * c - v * s,
      z: feature.z + u * s + v * c,
    };
  });

  const sourceArea = Math.abs(polygonArea(points));
  const shapedArea = Math.max(1e-9, Math.abs(polygonArea(anisotropic)));
  const areaScale = Math.sqrt(sourceArea / shapedArea);
  return {
    outline: Object.freeze(anisotropic.map((point) => Object.freeze({
      x: feature.x + (point.x - feature.x) * areaScale,
      z: feature.z + (point.z - feature.z) * areaScale,
    }))),
    majorAxis,
    aspect: targetAspect,
  };
}

function insetBunkerSandOutline(points, feature, index) {
  const phase = featurePhase(feature, index, 0x696e7365) * Math.PI * 2;
  return Object.freeze(points.map((point) => {
    const dx = point.x - feature.x;
    const dz = point.z - feature.z;
    const radius = Math.hypot(dx, dz);
    const angle = Math.atan2(dz, dx);
    const inset = BUNKER_SAND_INSET_M
      + Math.cos(angle * 2.0 + phase) * BUNKER_SAND_INSET_VARIATION_M * 0.56
      + Math.cos(angle * 3.0 - phase * 0.73) * BUNKER_SAND_INSET_VARIATION_M * 0.44;
    const scale = Math.max(0.1, (radius - inset) / Math.max(1e-6, radius));
    return Object.freeze({ x: feature.x + dx * scale, z: feature.z + dz * scale });
  }));
}

function directionalBump(angle, center, halfWidth) {
  let delta = angle - center;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  const t = Math.min(1, Math.abs(delta) / halfWidth);
  return t >= 1 ? 0 : 0.5 + Math.cos(t * Math.PI) * 0.5;
}

function projectedSpan(points, feature, axisX, axisZ) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const projection = (point.x - feature.x) * axisX + (point.z - feature.z) * axisZ;
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  return max - min;
}

function featurePhase(feature, index, salt) {
  let value = Math.imul(Math.round(feature.x * 1000), 0x1f123bb5);
  value ^= Math.imul(Math.round(feature.z * 1000), 0x5f356495);
  value ^= Math.imul(Math.round(feature.r * 1000), 0x2c1b3c6d);
  value ^= Math.imul(index + 1, 0x27d4eb2d) ^ salt;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function smoothstepScalar(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function featureRadius(feature) {
  if (!feature?.shape?.length) return feature.r;
  let radius = feature.r;
  for (const point of feature.shape) radius = Math.max(radius, Math.hypot(point.x - feature.x, point.z - feature.z));
  return radius;
}

export function polygonArea(points) {
  let twiceArea = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    twiceArea += points[j].x * points[i].z - points[i].x * points[j].z;
  }
  return twiceArea * 0.5;
}

export function polygonSelfIntersects(points) {
  for (let a = 0; a < points.length; a += 1) {
    const a2 = (a + 1) % points.length;
    for (let b = a + 1; b < points.length; b += 1) {
      const b2 = (b + 1) % points.length;
      if (a === b || a2 === b || b2 === a) continue;
      if (segmentsIntersect(points[a], points[a2], points[b], points[b2])) return true;
    }
  }
  return false;
}

function segmentDistanceSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const denominator = dx * dx + dz * dz;
  const t = denominator > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / denominator)) : 0;
  const qx = ax + dx * t;
  const qz = az + dz * t;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}
