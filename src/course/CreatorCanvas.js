import { polygonArea } from './featureGeometry.js';
import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';

export const CREATOR_SHOWCASE_BOUNDS = Object.freeze({ minX: -18, maxX: 18, minZ: -18, maxZ: 18 });
export const CREATOR_SHOWCASE_FRINGE_WIDTH = 1.8;
export const CREATOR_SHOWCASE_OUTLINE_SAMPLES = 96;

// A strict v3 runtime used only for the Course Creator opening state. It is
// deliberately disposable: proposals still target course.project.json, while this
// seeded green exists only to show what the editor can make before the first prompt.
export function createCreatorCanvasCourse({ atmosphere = null, seed = 246813579, variant = 0 } = {}) {
  if (!Number.isInteger(variant) || variant < 0) throw new TypeError('Creator showcase variant must be a non-negative integer.');
  const showcaseSeed = deriveSeed(normalizeSeed(seed), `creator-showcase:${variant}`);
  const rng = createRng(showcaseSeed);
  const center = { x: (rng() - 0.5) * 1.6, z: (rng() - 0.5) * 1.2 };
  const orientation = rng() * Math.PI * 2;
  const major = 10.9 + rng() * 1.0;
  const minor = 7.1 + rng() * 0.9;
  const lobePhase = rng() * Math.PI * 2;
  const shape = [];
  const controls = 14;
  for (let index = 0; index < controls; index += 1) {
    const theta = index / controls * Math.PI * 2 + (rng() - 0.5) * 0.14;
    const radial = 1
      + Math.cos(theta * 2 + lobePhase) * 0.17
      + Math.cos(theta * 3 - lobePhase * 0.7) * 0.11
      + Math.cos(theta * 5 + lobePhase * 1.3) * 0.055
      + (rng() - 0.5) * 0.12;
    let localX = Math.cos(theta) * major * radial;
    let localZ = Math.sin(theta) * minor * radial;
    // Keep the deliberately aggressive lobes inside the shared shaped-feature
    // envelope for every deterministic reroll without normalising them back into
    // a circle. Only the rare extreme control is clamped radially.
    const localRadius = Math.hypot(localX, localZ);
    const supportedRadius = Math.max(5.0, Math.min(14.2, localRadius));
    localX *= supportedRadius / localRadius;
    localZ *= supportedRadius / localRadius;
    const c = Math.cos(orientation), s = Math.sin(orientation);
    shape.push({
      x: center.x + localX * c - localZ * s,
      z: center.z + localX * s + localZ * c,
    });
  }

  // The cup keeps a compact, playable shelf, but the rest of the green is intentionally
  // severe enough to advertise real 3D authoring: an offset shoulder, cross-green
  // ridge, and opposing swale create distinct tiers rather than one radial mound.
  const drainageDirection = orientation + Math.PI * (0.72 + rng() * 0.22);
  const drainagePoint = (distance) => ({
    x: center.x + Math.cos(drainageDirection) * distance,
    z: center.z + Math.sin(drainageDirection) * distance,
  });
  const orientedPoint = (direction, distance, across = 0) => ({
    x: center.x + Math.cos(direction) * distance - Math.sin(direction) * across,
    z: center.z + Math.sin(direction) * distance + Math.cos(direction) * across,
  });
  const shoulderDirection = orientation + Math.PI * 0.18;
  const ridgeDirection = orientation + Math.PI * 0.73;
  const swaleDirection = orientation + Math.PI * 1.22;

  return {
    meta: {
      name: 'Untitled Course', mode: 'realistic', schema: 3,
      notes: `Disposable seeded creator green, variant ${variant}.`,
    },
    catalogVersion: 2,
    placementAlgorithmVersion: 1,
    biome: 'temperate-maritime',
    biomeTransitions: [],
    environmentSeed: showcaseSeed,
    bounds: { ...CREATOR_SHOWCASE_BOUNDS },
    tee: { x: 0, z: 0, boxHalfX: 2, z0: -2, z1: 2 },
    corridor: { c0: 20, k: 0, rough: 0 },
    fringeW: CREATOR_SHOWCASE_FRINGE_WIDTH,
    greens: [{ yards: 0, x: center.x, z: center.z, r: 10, contour: 'crown', shape }],
    bunkers: [], ponds: [],
    landforms: [
      { kind: 'shelf', points: [{ ...center }], width: 4.4, height: 0.30, falloff: 4.8 },
      { kind: 'shoulder', points: [orientedPoint(shoulderDirection, 6.2)], width: 5.0, height: 0.24, falloff: 3.2 },
      { kind: 'ridge', points: [
        orientedPoint(ridgeDirection, 4.4, -3.4),
        orientedPoint(ridgeDirection, 5.8, 3.6),
      ], width: 5.2, height: 0.20, falloff: 2.8 },
      { kind: 'swale', points: [
        orientedPoint(swaleDirection, 4.0, -2.8),
        orientedPoint(swaleDirection, 6.6, 3.0),
      ], width: 4.8, height: -0.16, falloff: 2.6 },
      { kind: 'drainage-channel', points: [drainagePoint(4.8), drainagePoint(13.4)], width: 4.0, height: -0.09, falloff: 3.6 },
    ],
    ...(atmosphere ? { atmosphere: { ...atmosphere } } : {}),
    environment: {
      objectBudget: 0,
      placements: [], syntheticTrees: [], scatter: [], assembly: [], edgeDressing: [], exclusions: [],
    },
  };
}

// The generated outline is deliberately star-convex around its green centre. A
// miter-limited normal offset therefore produces a close approximation of a true
// constant-width collar without the variable thickness of radial scaling.
export function createCreatorCanvasOutline(course, samples = CREATOR_SHOWCASE_OUTLINE_SAMPLES) {
  const green = course?.greens?.[0];
  if (!green?.shape?.length) throw new TypeError('Creator showcase requires one shaped green.');
  const expanded = offsetClosedOutline(green.shape, course.fringeW, green);
  return Object.freeze(resampleClosedOutline(expanded, samples));
}

export function creatorCanvasCameraPose(course, heightAt = () => 0) {
  const outline = createCreatorCanvasOutline(course);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of outline) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  const x = (minX + maxX) * 0.5;
  const z = (minZ + maxZ) * 0.5;
  const y = heightAt(x, z);
  const span = Math.max(maxX - minX, maxZ - minZ);
  return Object.freeze({
    position: Object.freeze([x + span * 1.3, y + span, z + span * 1.3]),
    // Aim below the turf datum so the maquette sits above the bottom composer while
    // retaining the same three-quarter inspection angle and undistorted long lens.
    lookAt: Object.freeze([x, y - 2.4, z]),
    fov: 24,
  });
}

export function offsetClosedOutline(points, distance, center = null) {
  if (!Array.isArray(points) || points.length < 3 || !(distance > 0)) {
    throw new TypeError('Closed outline offset requires at least three points and a positive distance.');
  }
  const orientation = polygonArea(points) >= 0 ? 1 : -1;
  const edgeNormal = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: orientation * dz / length, z: orientation * -dx / length };
  };
  return points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const before = edgeNormal(previous, point);
    const after = edgeNormal(point, next);
    let nx = before.x + after.x, nz = before.z + after.z;
    const normalLength = Math.hypot(nx, nz) || 1;
    nx /= normalLength; nz /= normalLength;
    const projection = Math.max(0.7, nx * after.x + nz * after.z);
    const reach = Math.min(distance * 1.35, distance / projection);
    const candidate = { x: point.x + nx * reach, z: point.z + nz * reach };
    if (!center) return Object.freeze(candidate);
    const beforeRadius = Math.hypot(point.x - center.x, point.z - center.z);
    const afterRadius = Math.hypot(candidate.x - center.x, candidate.z - center.z);
    if (afterRadius >= beforeRadius) return Object.freeze(candidate);
    const dx = (point.x - center.x) / Math.max(1e-6, beforeRadius);
    const dz = (point.z - center.z) / Math.max(1e-6, beforeRadius);
    return Object.freeze({ x: point.x + dx * distance, z: point.z + dz * distance });
  });
}

export function resampleClosedOutline(points, count) {
  if (!Number.isInteger(count) || count < 3) throw new TypeError('Closed outline sample count must be at least three.');
  const lengths = [];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    const length = Math.hypot(next.x - points[index].x, next.z - points[index].z);
    lengths.push(length); total += length;
  }
  const output = [];
  let edge = 0, traversed = 0;
  for (let sample = 0; sample < count; sample += 1) {
    const target = sample / count * total;
    while (edge < lengths.length - 1 && traversed + lengths[edge] < target) {
      traversed += lengths[edge]; edge += 1;
    }
    const a = points[edge], b = points[(edge + 1) % points.length];
    const amount = lengths[edge] > 0 ? (target - traversed) / lengths[edge] : 0;
    output.push(Object.freeze({ x: a.x + (b.x - a.x) * amount, z: a.z + (b.z - a.z) * amount }));
  }
  return output;
}
