// Shared controls for the editor, CLI and generator. Distances are metres;
// normalized profiles are ordered [position, value] pairs.
export const PLANT_CONTROLS = Object.freeze({
  structure: {
    leanX: [0, -1, 1], leanZ: [0, -1, 1], crownX: [1, 0.1, 3], crownZ: [1, 0.1, 3],
    droop: [0, 0, 2], collar: [0.2, 0, 1], buttress: [0, 0, 2], buttressCount: [5, 3, 12],
    // Surface roots, all as multiples of the trunk's base radius so a sapling and a
    // mature tree flare in proportion. rootCount 0 keeps existing definitions
    // byte-identical, so this is opt-in per species. The default spread is the
    // measured "zone of rapid taper" for pine: roots originating within about
    // 2.2 x DBH of the stem, which is 4.4 trunk radii (Danjon et al.).
    rootCount: [0, 0, 8], rootSpread: [4.4, 0, 9], rootDepth: [0.5, 0, 3], rootRise: [0.45, 0, 0.9],
    // How far a root's cross section flattens against the ground: 1 is a round
    // runner, higher spreads wider and domes lower. A surface root is a broad mass
    // hugging the soil, not a blade standing on edge - reading the reported I-beam
    // sections as depth is what produced knife silhouettes. A palm is a monocot with
    // no secondary thickening at all (rootCount 0).
    rootFlatten: [1.7, 1, 3],
  },
  foliage: {
    density: [1, 0, 2], variation: [0.2, 0, 0.8], spread: [0.15, 0, 1],
    roll: [1, 0, 1], leaflets: [9, 3, 24], attachmentStart: [0.35, 0, 0.95], colorVariation: [0.2, 0, 0.8],
  },
  life: { age: [1, 0, 1], health: [1, 0, 1], season: [0, 0, 1], flowering: [1, 0, 1], deciduous: [1, 0, 1] },
  wind: { strength: [0.3, 0, 2], stiffness: [0.6, 0.05, 1], flutter: [0.12, 0, 1] },
  bark: { ridgeDepth: [0.04, 0, 0.2], ridgeFrequency: [18, 2, 64], variation: [0.2, 0, 0.6] },
  envelope: { shape: ['none', 'box', 'ellipsoid'], width: [4, 0.1, 80], depth: [4, 0.1, 80], height: [4, 0.1, 80], baseHeight: [0, 0, 40] },
  quality: { radialSegments: [9, 3, 16], nearPixels: [300, 80, 1000], farPixels: [90, 10, 250] },
});
export const PLANT_PROFILES = Object.freeze({ crown: [[0, 0.3], [0.5, 1], [1, 0.2]], length: [[0, 1], [1, 1]], density: [[0, 0.5], [1, 1]] });
export function normalizePlantControls(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('plant must be an object');
  const result = {};
  for (const key of Object.keys(raw)) if (!Object.hasOwn(PLANT_CONTROLS, key) && key !== 'profiles') throw new TypeError(`Unknown plant control ${key}`);
  for (const [group, fields] of Object.entries(PLANT_CONTROLS)) {
    const input = raw[group] ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`plant.${group} must be an object`);
    for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) throw new TypeError(`Unknown plant.${group}.${key}`);
    result[group] = {};
    for (const [key, [fallback, min, max]] of Object.entries(fields)) {
      const value = input[key] ?? fallback;
      if (typeof fallback === 'string') {
        if (!fields[key].includes(value)) throw new TypeError(`Invalid plant.${group}.${key}`);
        result[group][key] = value; continue;
      }
      if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`plant.${group}.${key} must be in [${min}, ${max}]`);
      result[group][key] = value;
    }
  }
  if (result.quality.farPixels >= result.quality.nearPixels) throw new RangeError('farPixels must be below nearPixels');
  result.profiles = structuredClone(PLANT_PROFILES);
  for (const [key, points] of Object.entries(raw.profiles ?? {})) {
    if (!Object.hasOwn(PLANT_PROFILES, key) || !Array.isArray(points) || points.length < 2 || points.length > 16) throw new TypeError(`Invalid plant profile ${key}`);
    let last = -1;
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] <= last || point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 3) throw new TypeError(`Invalid ${key} profile point`);
      last = point[0];
    }
    if (points[0][0] !== 0 || points.at(-1)[0] !== 1) throw new TypeError('Profiles must span 0 to 1');
    result.profiles[key] = structuredClone(points);
  }
  return result;
}
export function samplePlantProfile(points, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < points.length; i++) if (t <= points[i][0]) {
    const [x, y] = points[i - 1], [nx, ny] = points[i];
    return y + (ny - y) * (t - x) / (nx - x);
  }
  return points.at(-1)[1];
}
