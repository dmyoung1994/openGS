import {
  ClampToEdgeWrapping, DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat,
} from 'three';
import { Noise } from '../util/noise.js';

export const BIOME_DEFINITIONS = Object.freeze({
  'temperate-maritime': Object.freeze({ id: 'temperate-maritime', habitat: 'managed-coastal-parkland', backdrop: 'maritime' }),
  'temperate-alpine': Object.freeze({ id: 'temperate-alpine', habitat: 'montane-forest', backdrop: 'alpine' }),
  'marine-ocean': Object.freeze({ id: 'marine-ocean', habitat: 'marine-shelf', backdrop: 'marine' }),
});

const coastBands = (centers, inlandWidth) => Object.freeze({
  waterProducing: true,
  inlandWidth,
  waterStartsAt: 0,
  channels: Object.freeze(['primary', 'strandGrass', 'dune', 'drySand', 'wetSand', 'shallowShelf', 'deepOcean']),
  centers: Object.freeze(centers),
});

export const BIOME_TRANSITION_PROFILES = Object.freeze({
  'natural-resort-beach': Object.freeze({
    id: 'natural-resort-beach', pairs: Object.freeze([['temperate-maritime', 'marine-ocean']]),
    ...coastBands([-22, -12, -2, 15, 34, 78, 170], 22),
  }),
  'narrow-wild-shore': Object.freeze({
    id: 'narrow-wild-shore', pairs: Object.freeze([['temperate-maritime', 'marine-ocean']]),
    ...coastBands([-12, -7, -1, 8, 18, 44, 105], 12),
  }),
  'broad-pristine-beach': Object.freeze({
    id: 'broad-pristine-beach', pairs: Object.freeze([['temperate-maritime', 'marine-ocean']]),
    ...coastBands([-36, -22, -5, 28, 58, 130, 280], 36),
  }),
  'maritime-alpine-ecotone': Object.freeze({
    id: 'maritime-alpine-ecotone',
    pairs: Object.freeze([
      ['temperate-maritime', 'temperate-alpine'],
      ['temperate-alpine', 'temperate-maritime'],
    ]),
    waterProducing: false,
    inlandWidth: 48,
    channels: Object.freeze(['primary', 'strandGrass', 'dune', 'drySand', 'wetSand', 'shallowShelf', 'deepOcean', 'alpine']),
    centers: Object.freeze([-72, -35, 18, 72]),
  }),
});

export const BIOME_IDS = Object.freeze(Object.keys(BIOME_DEFINITIONS));
export const BIOME_TRANSITION_PROFILE_IDS = Object.freeze(Object.keys(BIOME_TRANSITION_PROFILES));
export const COURSE_EDGE_SIDES = Object.freeze(['min-x', 'max-x', 'min-z', 'max-z']);
export const TRANSITION_WEIGHT_NAMES = Object.freeze([
  'primary', 'strandGrass', 'dune', 'drySand', 'wetSand', 'shallowShelf', 'deepOcean', 'alpine',
]);

export function getBiomeDefinition(id) { return BIOME_DEFINITIONS[id] || null; }
export function getBiomeTransitionProfile(id) { return BIOME_TRANSITION_PROFILES[id] || null; }

export function validateBiomeTransitions(raw, context, fail) {
  if (!Array.isArray(raw)) fail('course.biomeTransitions must be an array');
  const ids = new Set();
  const transitions = raw.map((value, index) => {
    const path = `course.biomeTransitions[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
    rejectUnknown(value, new Set(['id', 'from', 'to', 'boundary', 'profile', 'seed', 'widthScale', 'priority']), path, fail);
    if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(value.id)) fail(`${path}.id must be a kebab-case identifier`);
    if (ids.has(value.id)) fail(`${path}.id must be unique`);
    ids.add(value.id);
    if (!getBiomeDefinition(value.from)) fail(`${path}.from is not a registered biome`);
    if (!getBiomeDefinition(value.to)) fail(`${path}.to is not a registered biome`);
    if (value.from !== context.biome) fail(`${path}.from must equal primary course.biome`);
    const profile = getBiomeTransitionProfile(value.profile);
    if (!profile) fail(`${path}.profile is not registered`);
    if (!profile.pairs.some(([from, to]) => from === value.from && to === value.to)) {
      fail(`${path}.profile is incompatible with ${value.from} -> ${value.to}`);
    }
    if (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) fail(`${path}.seed must be a uint32`);
    if (!Number.isFinite(value.widthScale) || value.widthScale < 0.5 || value.widthScale > 2) fail(`${path}.widthScale must be in [0.5, 2]`);
    if (!Number.isInteger(value.priority)) fail(`${path}.priority must be an integer`);
    const boundary = validateBoundary(value.boundary, path, context.bounds, profile, fail);
    return Object.freeze({ ...value, boundary: Object.freeze(boundary) });
  });
  validatePriorityOwnership(transitions, context.bounds, fail);
  return Object.freeze(transitions);
}

function validateBoundary(raw, path, bounds, profile, fail) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${path}.boundary must be an object`);
  if (raw.kind === 'course-edge') {
    rejectUnknown(raw, new Set(['kind', 'sides']), `${path}.boundary`, fail);
    if (!Array.isArray(raw.sides) || raw.sides.length === 0) fail(`${path}.boundary.sides must be non-empty`);
    const sides = raw.sides.map((side, index) => {
      if (!COURSE_EDGE_SIDES.includes(side)) fail(`${path}.boundary.sides[${index}] is invalid`);
      return side;
    });
    if (new Set(sides).size !== sides.length) fail(`${path}.boundary.sides must not contain duplicates`);
    return { kind: 'course-edge', sides: Object.freeze(sides) };
  }
  if (raw.kind === 'polygon-region') {
    rejectUnknown(raw, new Set(['kind', 'points']), `${path}.boundary`, fail);
    if (profile.waterProducing) fail(`${path} water-producing profiles require a course-edge boundary`);
    if (!Array.isArray(raw.points) || raw.points.length < 3 || raw.points.length > 64) fail(`${path}.boundary.points must contain 3..64 points`);
    const points = raw.points.map((point, index) => {
      if (!point || typeof point !== 'object' || Array.isArray(point)) fail(`${path}.boundary.points[${index}] must be an object`);
      rejectUnknown(point, new Set(['x', 'z']), `${path}.boundary.points[${index}]`, fail);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) fail(`${path}.boundary.points[${index}] must be finite`);
      if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) fail(`${path}.boundary.points[${index}] is outside course.bounds`);
      return Object.freeze({ x: point.x, z: point.z });
    });
    if (Math.abs(polygonArea(points)) < 4) fail(`${path}.boundary polygon has insufficient area`);
    if (polygonSelfIntersects(points)) fail(`${path}.boundary polygon must not self-intersect`);
    return { kind: 'polygon-region', points: Object.freeze(points) };
  }
  fail(`${path}.boundary.kind must be course-edge or polygon-region`);
}

function validatePriorityOwnership(transitions, bounds, fail) {
  for (let i = 0; i < transitions.length; i++) {
    for (let j = i + 1; j < transitions.length; j++) {
      const a = transitions[i], b = transitions[j];
      if (a.priority !== b.priority) continue;
      if (boundaryBoundsOverlap(transitionBounds(a, bounds), transitionBounds(b, bounds))) {
        fail(`equal-priority biome transitions "${a.id}" and "${b.id}" overlap; assign deterministic priorities`);
      }
    }
  }
}

function transitionBounds(transition, bounds) {
  if (transition.boundary.kind === 'polygon-region') {
    const xs = transition.boundary.points.map((p) => p.x);
    const zs = transition.boundary.points.map((p) => p.z);
    const width = getBiomeTransitionProfile(transition.profile).inlandWidth * transition.widthScale;
    return { minX: Math.min(...xs) - width, maxX: Math.max(...xs) + width, minZ: Math.min(...zs) - width, maxZ: Math.max(...zs) + width };
  }
  const profile = getBiomeTransitionProfile(transition.profile);
  const outward = profile.centers.at(-1) * transition.widthScale;
  const inward = profile.inlandWidth * transition.widthScale;
  const boxes = transition.boundary.sides.map((side) => sideBox(side, bounds, outward, inward));
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) }));
}

function sideBox(side, bounds, outward, inward) {
  if (side === 'min-x') return { minX: bounds.minX - outward, maxX: bounds.minX + inward, minZ: bounds.minZ - outward, maxZ: bounds.maxZ + outward };
  if (side === 'max-x') return { minX: bounds.maxX - inward, maxX: bounds.maxX + outward, minZ: bounds.minZ - outward, maxZ: bounds.maxZ + outward };
  if (side === 'min-z') return { minX: bounds.minX - outward, maxX: bounds.maxX + outward, minZ: bounds.minZ - outward, maxZ: bounds.minZ + inward };
  return { minX: bounds.minX - outward, maxX: bounds.maxX + outward, minZ: bounds.maxZ - inward, maxZ: bounds.maxZ + outward };
}

function boundaryBoundsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function classifyBiomeAt(courseOrField, x, z) {
  const course = courseOrField.course || courseOrField;
  const candidates = [];
  for (const transition of course.biomeTransitions || []) {
    const distance = boundaryDistance(transition.boundary, course.bounds, x, z);
    if (distance === null) continue;
    const profile = getBiomeTransitionProfile(transition.profile);
    const inwardReach = profile.inlandWidth * transition.widthScale;
    if (distance < -inwardReach) continue;
    candidates.push({ transition, profile, distance });
  }
  candidates.sort((a, b) => b.transition.priority - a.transition.priority || a.transition.id.localeCompare(b.transition.id));
  if (!candidates.length) return baseClassification(course.biome);
  const owner = candidates[0];
  const weights = weightsFor(owner.profile, owner.distance / owner.transition.widthScale, owner.transition.seed, x, z);
  return Object.freeze({
    primaryBiome: course.biome,
    transitionId: owner.transition.id,
    profile: owner.profile.id,
    from: owner.transition.from,
    to: owner.transition.to,
    distance: owner.distance,
    habitat: dominantHabitat(weights),
    weights: Object.freeze(weights),
  });
}

function baseClassification(primaryBiome) {
  return Object.freeze({ primaryBiome, transitionId: null, profile: null, from: primaryBiome, to: primaryBiome, distance: -Infinity, habitat: getBiomeDefinition(primaryBiome).habitat, weights: Object.freeze({ primary: 1, strandGrass: 0, dune: 0, drySand: 0, wetSand: 0, shallowShelf: 0, deepOcean: 0, alpine: primaryBiome === 'temperate-alpine' ? 1 : 0 }) });
}

function weightsFor(profile, distance, seed, x, z) {
  const result = Object.fromEntries(TRANSITION_WEIGHT_NAMES.map((name) => [name, 0]));
  const noise = transitionNoise(seed);
  // A coast is not a sequence of perfectly parallel paint stripes. Use one
  // oblique, multi-scale signed-distance warp for the broad shoreline, then a
  // smaller channel-specific offset so adjacent habitats feather through one
  // another without losing their physical order. These frequencies are in
  // world space and deterministic for the authored transition seed.
  const qx = x * 0.0097 + z * 0.0041;
  const qz = z * 0.0089 - x * 0.0037;
  const seawardWarp = profile.waterProducing ? smoothstep(-4, 70, distance) : 0;
  const seedPhase = (seed % 4096) * 0.001534;
  const coastMeander = profile.waterProducing
    ? (Math.sin(x * 0.031 + z * 0.009 + seedPhase) * 7.5
      + Math.sin(x * 0.077 - z * 0.043 - seedPhase * 0.71) * 3.25)
      * (1 + seawardWarp * 0.5)
    : 0;
  const warped = distance
    + noise.fbm(qx, qz, { octaves: 4, lacunarity: 1.93, gain: 0.52 })
      * (8.5 + seawardWarp * 12.5)
    + noise.fbm(qx * 2.71 + 19.4, qz * 2.37 - 11.8, {
      octaves: 2, lacunarity: 2.11, gain: 0.45,
    }) * (2.0 + seawardWarp * 2.0)
    + noise.fbm(
      x * 0.024 + z * 0.007,
      z * 0.021 - x * 0.013,
      { octaves: 2, lacunarity: 1.87, gain: 0.46 },
    ) * 2.8
    + coastMeander;
  if (profile.id === 'maritime-alpine-ecotone') {
    const t = smoothstep(profile.centers[0], profile.centers.at(-1), warped);
    result.primary = 1 - t;
    result.alpine = t;
    result.strandGrass = Math.sin(Math.PI * t) * 0.42;
    return normalizeWeights(result);
  }
  const names = profile.channels;
  const centers = profile.centers;
  let total = 0;
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index < centers.length; index++) {
    const center = centers[index];
    const leftGap = index > 0 ? center - centers[index - 1] : centers[1] - center;
    const rightGap = index < centers.length - 1
      ? centers[index + 1] - center
      : center - centers[index - 1];
    const localGap = Math.min(leftGap, rightGap);
    const centerOffset = noise.fbm(
      qx * 0.73 + index * 13.71,
      qz * 0.69 - index * 9.17,
      { octaves: 2, lacunarity: 2.03, gain: 0.5 },
    ) * Math.min(4, localGap * 0.18);
    const channelDistance = warped - center - centerOffset;
    const absoluteDistance = Math.abs(channelDistance);
    if (absoluteDistance < nearestDistance) {
      nearestDistance = absoluteDistance;
      nearestIndex = index;
    }
    const sigma = Math.max(2, localGap * 0.72);
    const normalizedDistance = channelDistance / sigma;
    if (Math.abs(normalizedDistance) >= 2.4) continue;
    // A compact Gaussian kernel gives two or three neighboring habitats shared
    // ownership through the ecotone. The former pairwise lerp reached 100% at
    // every band center and exposed the registry as a set of broad colour bars.
    const compact = 1 - (normalizedDistance / 2.4) ** 2;
    const weight = Math.exp(-0.5 * normalizedDistance ** 2) * compact * compact;
    result[names[index]] = weight;
    total += weight;
  }
  if (total <= 1e-9) result[names[nearestIndex]] = 1;
  return normalizeWeights(result);
}

// Classification runs for every transition-field texel and for placement probes.
// A Noise instance is immutable, so retain one per authored transition seed rather
// than rebuilding its permutation table for every point.
const transitionNoises = new Map();
function transitionNoise(seed) {
  let noise = transitionNoises.get(seed);
  if (!noise) {
    noise = new Noise(seed);
    transitionNoises.set(seed, noise);
  }
  return noise;
}

function normalizeWeights(weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(weights)) weights[key] /= sum;
  return weights;
}

function dominantHabitat(weights) {
  const [name] = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
  return ({ primary: 'managed-course', strandGrass: 'strand-grass', dune: 'coastal-dune', drySand: 'dry-beach', wetSand: 'intertidal', shallowShelf: 'marine-shelf', deepOcean: 'deep-ocean', alpine: 'montane-forest' })[name];
}

function boundaryDistance(boundary, bounds, x, z) {
  if (boundary.kind === 'polygon-region') return signedDistancePolygon(boundary.points, x, z);
  const distances = [];
  for (const side of boundary.sides) {
    const distance = side === 'min-x' ? bounds.minX - x
      : side === 'max-x' ? x - bounds.maxX
        : side === 'min-z' ? bounds.minZ - z
          : z - bounds.maxZ;
    distances.push(distance);
  }
  const outside = distances.filter((distance) => distance > 0);
  // Outside two declared sides, Euclidean distance rounds the course corner
  // naturally. max(distance) produced square, parallel habitat terraces that
  // were especially obvious from the flight camera.
  if (outside.length > 1) return Math.hypot(...outside);
  return Math.max(...distances);
}

export function compileBiomeTransitionField(course, { texelsPerM = 1 } = {}) {
  const { bounds } = course;
  const hasTransitions = course.biomeTransitions.length > 0;
  // No boundary means every sample has the same weights. A single clamped texel
  // represents that constant exactly, without rasterizing or uploading the course.
  const width = hasTransitions ? Math.max(2, Math.round((bounds.maxX - bounds.minX) * texelsPerM)) : 1;
  const height = hasTransitions ? Math.max(2, Math.round((bounds.maxZ - bounds.minZ) * texelsPerM)) : 1;
  const weights = new Float32Array(width * height * TRANSITION_WEIGHT_NAMES.length);
  const landData = new Uint16Array(width * height * 4);
  const waterData = new Uint16Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const z = bounds.minZ + (j + 0.5) / texelsPerM;
    for (let i = 0; i < width; i++) {
      const x = bounds.minX + (i + 0.5) / texelsPerM;
      const classification = classifyBiomeAt(course, x, z);
      const base = (j * width + i) * TRANSITION_WEIGHT_NAMES.length;
      TRANSITION_WEIGHT_NAMES.forEach((name, channel) => { weights[base + channel] = classification.weights[name]; });
      const k = (j * width + i) * 4;
      for (let channel = 0; channel < 4; channel++) landData[k + channel] = DataUtils.toHalfFloat(weights[base + channel]);
      for (let channel = 0; channel < 4; channel++) waterData[k + channel] = DataUtils.toHalfFloat(weights[base + 4 + channel]);
    }
  }
  const makeTexture = (data, name) => {
    const result = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
    result.name = name;
    result.minFilter = result.magFilter = LinearFilter;
    result.wrapS = result.wrapT = ClampToEdgeWrapping;
    result.generateMipmaps = false;
    result.needsUpdate = true;
    return result;
  };
  return Object.freeze({
    course, bounds, width, height, texelsPerM, weights,
    hasTransitions,
    landTexture: makeTexture(landData, 'biome-transition-land-rgba16f'),
    waterTexture: makeTexture(waterData, 'biome-transition-water-rgba16f'),
    sample: (x, z) => classifyBiomeAt(course, x, z),
    dispose() { this.landTexture.dispose(); this.waterTexture.dispose(); },
  });
}

function rejectUnknown(value, allowed, path, fail) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

function polygonSelfIntersects(points) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || j === (i + 1) % points.length || (j + 1) % points.length === i) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function signedDistancePolygon(points, x, z) {
  let inside = false;
  let minSq = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    minSq = Math.min(minSq, (x - (a.x + dx * t)) ** 2 + (z - (a.z + dz * t)) ** 2);
    if (((a.z > z) !== (b.z > z)) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
