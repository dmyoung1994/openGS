import { YARD_TO_M } from '../util/units.js';
import { normalizeSeed } from '../util/random.js';
import {
  BUILTIN_ENVIRONMENT_ASSETS,
  BUILTIN_ENVIRONMENT_ASSET_IDS,
  ENVIRONMENT_CATALOG_VERSION,
  ENVIRONMENT_OBJECT_BUDGET,
} from '../environment/EnvironmentCatalog.js';
import {
  featureRadius, polygonArea, polygonSelfIntersects, signedDistanceToFeature, smoothClosedOutline,
} from './featureGeometry.js';
import { BIOME_IDS, validateBiomeTransitions } from './BiomeRegistry.js';

// The named internal green contours the engine can bake (see greenContour in
// Range.js). Course authors choose these names — raw heightfields are forbidden.
export const CONTOURS = ['tilt', 'punchbowl', 'spine', 'tier', 'crown', 'saddle'];
export const COURSE_SCHEMA_VERSION = 3;
export const PLACEMENT_ALGORITHM_VERSION = 1;

const ROOT_KEYS = new Set([
  'meta', 'catalogVersion', 'placementAlgorithmVersion', 'biome', 'biomeTransitions', 'environmentSeed',
  'bounds', 'tee', 'corridor', 'fringeW', 'greens', 'bunkers', 'ponds', 'environment',
]);
const BIOMES = new Set(BIOME_IDS.filter((biome) => biome !== 'marine-ocean'));
const SEMANTIC_ASSEMBLIES = new Set(['tree-line', 'forest-cluster', 'woodland-island', 'rock-outcrop', 'habitat-cluster']);
const SEMANTIC_EDGES = new Set(['course-boundary', 'hazard-edge', 'rough-transition']);
const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;

export class CourseSchemaError extends Error {
  constructor(message) {
    super(`Course schema invalid: ${message}`);
    this.name = 'CourseSchemaError';
  }
}

/**
 * Strictly validate and normalize course v3.  This deliberately does not coerce,
 * clamp, default, or filter authoring data: an invalid course must fail before a
 * terrain or environment build begins.  The only derived value is green.z when
 * the authored, legacy-compatible yards field is supplied.
 */
export function normalizeCourse(raw, { catalogAssetIds = BUILTIN_ENVIRONMENT_ASSET_IDS } = {}) {
  const c = object(raw, 'course');
  rejectUnknown(c, ROOT_KEYS, 'course');
  const meta = validateMeta(c.meta);
  exactNumber(c.catalogVersion, 'course.catalogVersion');
  if (c.catalogVersion !== ENVIRONMENT_CATALOG_VERSION) {
    fail(`course.catalogVersion must equal catalog version ${ENVIRONMENT_CATALOG_VERSION}`);
  }
  exactNumber(c.placementAlgorithmVersion, 'course.placementAlgorithmVersion');
  if (c.placementAlgorithmVersion !== PLACEMENT_ALGORITHM_VERSION) {
    fail(`course.placementAlgorithmVersion must be ${PLACEMENT_ALGORITHM_VERSION}`);
  }
  enumValue(c.biome, BIOMES, 'course.biome');
  uint32(c.environmentSeed, 'course.environmentSeed');
  const bounds = validateBounds(c.bounds, 'course.bounds');
  const tee = validateTee(c.tee);
  const corridor = validateCorridor(c.corridor);
  range(c.fringeW, 0, 12, 'course.fringeW');
  const greens = array(c.greens, 'course.greens').map((green, index) => validateGreen(green, index, bounds));
  const bunkers = array(c.bunkers, 'course.bunkers').map((bunker, index) => validateBunker(bunker, index, bounds));
  const ponds = array(c.ponds, 'course.ponds').map((pond, index) => validatePond(pond, index, bounds));
  const biomeTransitions = validateBiomeTransitions(c.biomeTransitions, {
    biome: c.biome, bounds, tee, corridor, greens, bunkers, ponds,
  }, fail);
  const catalog = toAssetMap(catalogAssetIds);
  const environment = validateEnvironment(c.environment, { biome: c.biome, bounds, tee, corridor, greens, bunkers, ponds, catalog });

  return Object.freeze({
    meta: Object.freeze(meta),
    catalogVersion: c.catalogVersion,
    placementAlgorithmVersion: c.placementAlgorithmVersion,
    biome: c.biome,
    biomeTransitions,
    environmentSeed: normalizeSeed(c.environmentSeed),
    bounds: Object.freeze(bounds), tee: Object.freeze(tee), corridor: Object.freeze(corridor), fringeW: c.fringeW,
    greens: Object.freeze(greens), bunkers: Object.freeze(bunkers), ponds: Object.freeze(ponds),
    environment: Object.freeze(environment),
  });
}

function validateMeta(raw) {
  const meta = object(raw, 'course.meta');
  rejectUnknown(meta, new Set(['name', 'mode', 'schema', 'notes']), 'course.meta');
  nonEmpty(meta.name, 'course.meta.name');
  if (meta.mode !== 'realistic') fail('course.meta.mode must be realistic');
  exactNumber(meta.schema, 'course.meta.schema');
  if (meta.schema !== COURSE_SCHEMA_VERSION) {
    if (Number.isInteger(meta.schema) && meta.schema < COURSE_SCHEMA_VERSION) {
      fail(`course.meta.schema ${meta.schema} requires explicit migration to ${COURSE_SCHEMA_VERSION}; add biomeTransitions (use [] to preserve current behavior)`);
    }
    fail(`course.meta.schema must be ${COURSE_SCHEMA_VERSION}`);
  }
  if (meta.notes !== undefined) nonEmpty(meta.notes, 'course.meta.notes');
  return { ...meta };
}

function validateBounds(raw, path) {
  const bounds = object(raw, path);
  rejectUnknown(bounds, new Set(['minX', 'maxX', 'minZ', 'maxZ']), path);
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) exactNumber(bounds[key], `${path}.${key}`);
  if (!(bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ)) fail(`${path} must have positive area`);
  return { ...bounds };
}

function validateTee(raw) {
  const tee = object(raw, 'course.tee');
  rejectUnknown(tee, new Set(['x', 'z', 'boxHalfX', 'z0', 'z1']), 'course.tee');
  for (const key of ['x', 'z', 'boxHalfX', 'z0', 'z1']) exactNumber(tee[key], `course.tee.${key}`);
  if (!(tee.boxHalfX > 0 && tee.z0 < tee.z1)) fail('course.tee must have positive area');
  return { ...tee };
}

function validateCorridor(raw) {
  const corridor = object(raw, 'course.corridor');
  rejectUnknown(corridor, new Set(['c0', 'k', 'rough']), 'course.corridor');
  for (const key of ['c0', 'k', 'rough']) exactNumber(corridor[key], `course.corridor.${key}`);
  if (!(corridor.c0 > 0 && corridor.k >= 0 && corridor.rough >= 0)) fail('course.corridor values must describe a non-negative corridor');
  return { ...corridor };
}

function validateGreen(raw, index, bounds) {
  const path = `course.greens[${index}]`;
  const green = object(raw, path);
  rejectUnknown(green, new Set(['yards', 'x', 'z', 'r', 'contour', 'shape']), path);
  exactNumber(green.yards, `${path}.yards`);
  exactNumber(green.x, `${path}.x`);
  if (green.z !== undefined) exactNumber(green.z, `${path}.z`);
  range(green.r, 3, 40, `${path}.r`);
  enumValue(green.contour, new Set(CONTOURS), `${path}.contour`);
  const z = green.z ?? -green.yards * YARD_TO_M;
  if (!Number.isFinite(z)) fail(`${path}.z resolves to a non-finite value`);
  const shape = validateShape(green.shape, { x: green.x, z, r: green.r }, bounds, `${path}.shape`);
  return Object.freeze({ yards: green.yards, x: green.x, z, r: green.r, contour: green.contour, ...(shape ? { shape } : {}) });
}

function validateBunker(raw, index, bounds) {
  const path = `course.bunkers[${index}]`;
  const bunker = object(raw, path);
  rejectUnknown(bunker, new Set(['x', 'z', 'r', 'depth', 'pot', 'shape']), path);
  for (const key of ['x', 'z', 'r', 'depth']) exactNumber(bunker[key], `${path}.${key}`);
  range(bunker.r, 1.5, 30, `${path}.r`);
  range(bunker.depth, 0.3, 4, `${path}.depth`);
  if (typeof bunker.pot !== 'boolean') fail(`${path}.pot must be boolean`);
  const shape = validateShape(bunker.shape, bunker, bounds, `${path}.shape`);
  return Object.freeze({ ...bunker, ...(shape ? { shape } : {}) });
}

function validateShape(raw, feature, bounds, path) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length < 6 || raw.length > 24) fail(`${path} must contain 6..24 world-space points`);
  const points = raw.map((value, index) => {
    const point = object(value, `${path}[${index}]`);
    rejectUnknown(point, new Set(['x', 'z']), `${path}[${index}]`);
    exactNumber(point.x, `${path}[${index}].x`);
    exactNumber(point.z, `${path}[${index}].z`);
    if (!insideBounds(point, bounds)) fail(`${path}[${index}] is outside course.bounds`);
    const radial = Math.hypot(point.x - feature.x, point.z - feature.z);
    if (radial < feature.r * 0.48 || radial > feature.r * 1.45) fail(`${path}[${index}] is outside the supported shape envelope`);
    return Object.freeze({ x: point.x, z: point.z });
  });
  if (Math.abs(polygonArea(points)) < feature.r * feature.r * 0.8) fail(`${path} has insufficient area`);
  if (polygonSelfIntersects(points)) fail(`${path} must not self-intersect`);
  if (signedDistanceToFeature({ ...feature, shape: points }, feature.x, feature.z) <= 0) fail(`${path} must contain the feature center`);
  const outline = smoothClosedOutline(points);
  if (polygonSelfIntersects(outline)) fail(`${path} smoothing produces a self-intersection`);
  if (signedDistanceToFeature({ ...feature, shape: outline }, feature.x, feature.z) <= 0) fail(`${path} smoothed outline must contain the feature center`);
  return outline;
}

function validatePond(raw, index, bounds) {
  const path = `course.ponds[${index}]`;
  const pond = object(raw, path);
  rejectUnknown(pond, new Set(['x', 'z', 'r', 'depth', 'shape']), path);
  for (const key of ['x', 'z', 'r', 'depth']) exactNumber(pond[key], `${path}.${key}`);
  range(pond.r, 2, 80, `${path}.r`);
  range(pond.depth, 0.3, 6, `${path}.depth`);
  const shape = validateShape(pond.shape, pond, bounds, `${path}.shape`);
  return Object.freeze({ ...pond, ...(shape ? { shape } : {}) });
}

function validateEnvironment(raw, context) {
  const environment = object(raw, 'course.environment');
  rejectUnknown(environment, new Set(['foliageAlias', 'foliageAliases', 'objectBudget', 'placements', 'scatter', 'assembly', 'edgeDressing', 'exclusions']), 'course.environment');
  const foliageAliasPattern = /^(builtin|local)\.[a-z0-9]+(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/;
  const foliageAlias = environment.foliageAlias;
  if (foliageAlias !== undefined && (typeof foliageAlias !== 'string'
    || !foliageAliasPattern.test(foliageAlias))) {
    fail('course.environment.foliageAlias must be a versioned builtin.* or local.* alias');
  }
  const foliageAliases = environment.foliageAliases;
  if (foliageAliases !== undefined) {
    if (!Array.isArray(foliageAliases) || foliageAliases.length < 1 || foliageAliases.length > 3
      || foliageAliases.some((alias) => typeof alias !== 'string' || !foliageAliasPattern.test(alias))) {
      fail('course.environment.foliageAliases must contain 1..3 versioned builtin.* or local.* aliases');
    }
    if (new Set(foliageAliases).size !== foliageAliases.length) {
      fail('course.environment.foliageAliases must not contain duplicates');
    }
    if (foliageAlias !== undefined) {
      fail('course.environment must declare foliageAlias or foliageAliases, not both');
    }
  }
  if (!Number.isInteger(environment.objectBudget) || environment.objectBudget < 0 || environment.objectBudget > ENVIRONMENT_OBJECT_BUDGET) {
    fail(`course.environment.objectBudget must be an integer in [0, ${ENVIRONMENT_OBJECT_BUDGET}]`);
  }
  const exclusions = array(environment.exclusions, 'course.environment.exclusions').map(validateExclusion);
  const clearanceContext = { ...context, exclusions };
  const ids = new Set();
  const placements = array(environment.placements, 'course.environment.placements').map((record, index) => {
    const result = validatePlacement(record, index, clearanceContext);
    uniqueRecordId(ids, result.id, `course.environment.placements[${index}]`);
    return result;
  });
  const scatter = array(environment.scatter, 'course.environment.scatter').map((record, index) => {
    const result = validateDistributedRecord(record, index, 'scatter', clearanceContext);
    uniqueRecordId(ids, result.id, `course.environment.scatter[${index}]`);
    return result;
  });
  const assembly = array(environment.assembly, 'course.environment.assembly').map((record, index) => {
    const result = validateDistributedRecord(record, index, 'assembly', clearanceContext);
    uniqueRecordId(ids, result.id, `course.environment.assembly[${index}]`);
    return result;
  });
  const edgeDressing = array(environment.edgeDressing, 'course.environment.edgeDressing').map((record, index) => {
    const result = validateDistributedRecord(record, index, 'edgeDressing', clearanceContext);
    uniqueRecordId(ids, result.id, `course.environment.edgeDressing[${index}]`);
    return result;
  });
  const total = placements.length + sumCount(scatter) + sumCount(assembly) + sumCount(edgeDressing);
  if (total > environment.objectBudget || total > ENVIRONMENT_OBJECT_BUDGET) {
    fail(`course.environment declares ${total} objects, exceeding its hard budget of ${environment.objectBudget}`);
  }
  return {
    ...(foliageAlias ? { foliageAlias } : {}),
    ...(foliageAliases ? { foliageAliases: Object.freeze([...foliageAliases]) } : {}),
    objectBudget: environment.objectBudget,
    placements: Object.freeze(placements), scatter: Object.freeze(scatter), assembly: Object.freeze(assembly),
    edgeDressing: Object.freeze(edgeDressing), exclusions: Object.freeze(exclusions), objectCount: total,
  };
}

function validatePlacement(raw, index, context) {
  const path = `course.environment.placements[${index}]`;
  const record = object(raw, path);
  rejectUnknown(record, new Set(['id', 'assetId', 'x', 'z', 'rotationY', 'scale']), path);
  identifier(record.id, `${path}.id`);
  const asset = knownAsset(record.assetId, context.catalog, `${path}.assetId`);
  if (asset.biomes && !asset.biomes.includes(context.biome)) fail(`${path}.assetId is not compatible with ${context.biome}`);
  for (const key of ['x', 'z', 'rotationY', 'scale']) exactNumber(record[key], `${path}.${key}`);
  if (record.scale <= 0 || record.scale > 8) fail(`${path}.scale must be in (0, 8]`);
  if (!insideBounds(record, context.bounds)) fail(`${path} is outside course.bounds`);
  ensurePointClear(record, asset, context, path);
  return Object.freeze({ ...record });
}

function validateDistributedRecord(raw, index, kind, context) {
  const path = `course.environment.${kind}[${index}]`;
  const record = object(raw, path);
  const allowed = new Set(['id', 'assetIds', 'seed', 'count', 'region', 'minSpacing', 'semantic']);
  rejectUnknown(record, allowed, path);
  identifier(record.id, `${path}.id`);
  if (!Array.isArray(record.assetIds) || record.assetIds.length === 0) fail(`${path}.assetIds must be a non-empty array`);
  const assets = record.assetIds.map((assetId, i) => knownAsset(assetId, context.catalog, `${path}.assetIds[${i}]`));
  for (const asset of assets) if (asset.biomes && !asset.biomes.includes(context.biome)) fail(`${path}.assetIds is not compatible with ${context.biome}`);
  if (new Set(record.assetIds).size !== record.assetIds.length) fail(`${path}.assetIds must not contain duplicates`);
  uint32(record.seed, `${path}.seed`);
  if (!Number.isInteger(record.count) || record.count < 0) fail(`${path}.count must be a non-negative integer`);
  const region = validateRegion(record.region, `${path}.region`, context.bounds);
  positive(record.minSpacing, `${path}.minSpacing`);
  for (const asset of assets) {
    if (record.minSpacing < asset.placement.minSpacing) fail(`${path}.minSpacing is below ${asset.id}'s catalog minimum`);
    ensureRegionClear(region, asset, context, path);
  }
  if (kind === 'scatter') {
    if (record.semantic !== undefined) fail(`${path}.semantic is not allowed for scatter`);
  } else if (kind === 'assembly') {
    enumValue(record.semantic, SEMANTIC_ASSEMBLIES, `${path}.semantic`);
  } else {
    enumValue(record.semantic, SEMANTIC_EDGES, `${path}.semantic`);
  }
  return Object.freeze({ ...record, assetIds: Object.freeze([...record.assetIds]), region: Object.freeze(region) });
}

function validateRegion(raw, path, courseBounds) {
  const region = object(raw, path);
  rejectUnknown(region, new Set(['kind', 'minX', 'maxX', 'minZ', 'maxZ']), path);
  if (region.kind !== 'bounds') fail(`${path}.kind must be bounds`);
  const bounds = { minX: region.minX, maxX: region.maxX, minZ: region.minZ, maxZ: region.maxZ };
  validateBounds(bounds, path);
  if (bounds.minX < courseBounds.minX || bounds.maxX > courseBounds.maxX || bounds.minZ < courseBounds.minZ || bounds.maxZ > courseBounds.maxZ) {
    fail(`${path} must remain inside course.bounds`);
  }
  return bounds;
}

function validateExclusion(raw, index) {
  const path = `course.environment.exclusions[${index}]`;
  const exclusion = object(raw, path);
  rejectUnknown(exclusion, new Set(['id', 'kind', 'x', 'z', 'r', 'reason']), path);
  identifier(exclusion.id, `${path}.id`);
  if (exclusion.kind !== 'circle') fail(`${path}.kind must be circle`);
  for (const key of ['x', 'z', 'r']) exactNumber(exclusion[key], `${path}.${key}`);
  if (exclusion.r <= 0) fail(`${path}.r must be > 0`);
  nonEmpty(exclusion.reason, `${path}.reason`);
  return Object.freeze({ ...exclusion });
}

function ensurePointClear(point, asset, context, path) {
  const radius = asset.bounds.radius * point.scale;
  const { clearance } = asset.placement;
  if (insideTee(point, context.tee, radius + clearance.tee)) fail(`${path} violates tee clearance`);
  for (const feature of context.greens) if (signedDistanceToFeature(feature, point.x, point.z) > -(radius + clearance.green)) fail(`${path} violates green clearance`);
  for (const feature of context.bunkers) if (signedDistanceToFeature(feature, point.x, point.z) > -(radius + clearance.bunker)) fail(`${path} violates bunker clearance`);
  for (const feature of context.ponds) if (signedDistanceToFeature(feature, point.x, point.z) > -(radius + clearance.water)) fail(`${path} violates water clearance`);
  if (insideFairway(point, context.corridor, radius + clearance.fairway)) fail(`${path} violates fairway clearance`);
  for (const exclusion of context.exclusions) if (distance(point, exclusion) < radius + exclusion.r) fail(`${path} violates exclusion "${exclusion.id}"`);
}

// A rectangular procedural region is safe only when its entire footprint is
// outside protected areas. This intentionally rejects ambiguous random placement
// rather than gambling on a future scatter implementation doing the right thing.
function ensureRegionClear(region, asset, context, path) {
  const assetRadius = asset.bounds.radius;
  const clearance = asset.placement.clearance;
  for (const feature of context.greens) {
    if (regionIntersectsFeature(region, feature, assetRadius + clearance.green)) fail(`${path}.region intersects protected clearance`);
  }
  for (const feature of context.bunkers) {
    if (regionIntersectsFeature(region, feature, assetRadius + clearance.bunker)) fail(`${path}.region intersects protected clearance`);
  }
  for (const feature of context.ponds) {
    if (regionIntersectsFeature(region, feature, assetRadius + clearance.water)) fail(`${path}.region intersects protected clearance`);
  }
  // Explicit author exclusions are circles and intentionally have no category-
  // specific clearance field of their own.
  for (const exclusion of context.exclusions) {
    if (rectDistance(region, { ...exclusion, r: exclusion.r + assetRadius }) < exclusion.r + assetRadius) {
      fail(`${path}.region intersects protected clearance`);
    }
  }
  const teeRadius = assetRadius + clearance.tee;
  const teeRect = { minX: context.tee.x - context.tee.boxHalfX - teeRadius, maxX: context.tee.x + context.tee.boxHalfX + teeRadius, minZ: context.tee.z0 - teeRadius, maxZ: context.tee.z1 + teeRadius };
  if (rectIntersects(region, teeRect)) fail(`${path}.region intersects tee clearance`);
  // Fairway width changes with z. Sampling all rectangle corners plus the z at
  // which the largest lateral overlap occurs is exact for this linear corridor.
  const samples = [region.minZ, region.maxZ];
  for (const z of samples) {
    const fairwayHalf = context.corridor.c0 + (-z) * context.corridor.k + clearance.fairway + assetRadius;
    if (region.minX < fairwayHalf && region.maxX > -fairwayHalf) fail(`${path}.region intersects fairway clearance`);
  }
}

function knownAsset(assetId, catalog, path) {
  if (typeof assetId !== 'string' || !catalog.has(assetId)) fail(`${path} references unknown catalog asset "${assetId}"`);
  return catalog.get(assetId);
}

function toAssetMap(catalogAssetIds) {
  const ids = catalogAssetIds instanceof Map ? catalogAssetIds : new Map([...catalogAssetIds].map((id) => [id, builtInAsset(id)]));
  if (!ids.size) fail('catalog asset ID set must not be empty');
  return ids;
}

function builtInAsset(id) {
  // Course validation needs placement constraints synchronously. The canonical
  // manifest verifies matching IDs and binary hashes at renderer startup.
  const asset = BUILTIN_ENVIRONMENT_ASSETS[id];
  if (!asset) fail(`unknown built-in catalog asset "${id}"`);
  return { id, biomes: asset.biomes, bounds: asset.bounds, placement: asset.placement };
}

function sumCount(records) { return records.reduce((sum, record) => sum + record.count, 0); }
function uniqueRecordId(ids, id, path) { if (ids.has(id)) fail(`${path}.id duplicates environment record "${id}"`); ids.add(id); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function insideBounds(point, bounds) { return point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ; }
function insideTee(point, tee, clearance) { return point.x >= tee.x - tee.boxHalfX - clearance && point.x <= tee.x + tee.boxHalfX + clearance && point.z >= tee.z0 - clearance && point.z <= tee.z1 + clearance; }
function insideFairway(point, corridor, clearance) { return Math.abs(point.x) < corridor.c0 + (-point.z) * corridor.k + clearance; }
function rectDistance(rect, circle) { return Math.hypot(Math.max(rect.minX - circle.x, 0, circle.x - rect.maxX), Math.max(rect.minZ - circle.z, 0, circle.z - rect.maxZ)); }
function rectIntersects(a, b) { return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ; }

// Test an authored rectangular scatter footprint against the actual protected
// outline.  Bounding-circle rejection is safe but makes irregular shorelines
// unusable: a boulder beside a concave bank can be rejected by a distant lobe.
// Expanding the rectangle by the asset clearance and testing polygon vertices,
// corners, and edge crossings keeps the result conservative while honoring the
// same normalized outline used by terrain and water.
function regionIntersectsFeature(region, feature, margin) {
  if (!feature.shape?.length) return rectDistance(region, feature) < feature.r + margin;
  const expanded = {
    minX: region.minX - margin, maxX: region.maxX + margin,
    minZ: region.minZ - margin, maxZ: region.maxZ + margin,
  };
  const corners = [
    { x: expanded.minX, z: expanded.minZ }, { x: expanded.maxX, z: expanded.minZ },
    { x: expanded.maxX, z: expanded.maxZ }, { x: expanded.minX, z: expanded.maxZ },
  ];
  if (signedDistanceToFeature(feature, (expanded.minX + expanded.maxX) * 0.5, (expanded.minZ + expanded.maxZ) * 0.5) >= 0) return true;
  if (corners.some((point) => signedDistanceToFeature(feature, point.x, point.z) >= 0)) return true;
  if (feature.shape.some((point) => point.x >= expanded.minX && point.x <= expanded.maxX && point.z >= expanded.minZ && point.z <= expanded.maxZ)) return true;
  const edges = corners.map((point, index) => [point, corners[(index + 1) % corners.length]]);
  for (let i = 0; i < feature.shape.length; i += 1) {
    const a = feature.shape[i], b = feature.shape[(i + 1) % feature.shape.length];
    if (edges.some(([c, d]) => segmentIntersects(a, b, c, d))) return true;
  }
  return false;
}

function segmentIntersects(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const on = (p, q, r) => Math.abs(orient(p, q, r)) < 1e-9
    && r.x >= Math.min(p.x, q.x) - 1e-9 && r.x <= Math.max(p.x, q.x) + 1e-9
    && r.z >= Math.min(p.z, q.z) - 1e-9 && r.z <= Math.max(p.z, q.z) + 1e-9;
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
    || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`); return value; }
function array(value, path) { if (!Array.isArray(value)) fail(`${path} must be an array`); return value; }
function rejectUnknown(value, allowed, path) { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed`); }
function exactNumber(value, path) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`); }
function range(value, min, max, path) { exactNumber(value, path); if (value < min || value > max) fail(`${path} must be in [${min}, ${max}]`); }
function positive(value, path) { exactNumber(value, path); if (value <= 0) fail(`${path} must be > 0`); }
function uint32(value, path) { if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail(`${path} must be an unsigned 32-bit integer`); }
function nonEmpty(value, path) { if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`); }
function identifier(value, path) { if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${path} must be a stable kebab-case identifier`); }
function enumValue(value, values, path) { if (!values.has(value)) fail(`${path} has unsupported value "${value}"`); }
function fail(message) { throw new CourseSchemaError(message); }

// Fetch + validate the live course (cache-busted so an explicit new authoring
// revision reloads). Invalid data blocks the rebuild; it never creates an empty
// or partially normalized course.
export async function loadCourse(url = '/course.json', options = {}) {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Course load failed: ${res.status} ${res.statusText}`);
  let raw;
  try {
    raw = await res.json();
  } catch (error) {
    throw new Error(`Course load failed: ${url} is not valid JSON`, { cause: error });
  }
  return normalizeCourse(raw, options);
}
