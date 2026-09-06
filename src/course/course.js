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
import { compileRouteCorridor, polylineLength, routeAim, routeCorridorSignedDistance } from './RouteGeometry.js';
import {
  estimateTreeCanopyRadius, normalizeTreeDefinition, normalizeTreePlacement,
} from '../trees/TreeDefinition.js';

// The named internal green contours the engine can bake (see greenContour in
// Range.js). Course authors choose these names — raw heightfields are forbidden.
export const CONTOURS = ['tilt', 'punchbowl', 'spine', 'tier', 'crown', 'saddle'];
export const COURSE_SCHEMA_VERSION = 3;
export const SHARED_SITE_COURSE_SCHEMA_VERSION = 4;
export const PLACEMENT_ALGORITHM_VERSION = 1;
export const SURFACE_MATERIALS_VERSION = 1;
export const DEFAULT_SURFACE_MATERIALS = Object.freeze({
  version: SURFACE_MATERIALS_VERSION,
  turf: Object.freeze({
    parallax: 1,
    detailNormal: 1,
    ao: 0.62,
    selfShadow: 0.55,
    roughnessBase: 0.72,
    roughnessRange: 0.16,
    specular: 0.58,
    grazingRoughness: 0.4,
    saturation: 1,
    value: 1,
  }),
  forestFloor: Object.freeze({
    reliefDepthMeters: 0.028,
    normalStrength: 0.72,
    sourceColorStrength: 1,
    macroVariation: 0.20,
    canopyAffinity: 0,
    crownCoreGrassDensity: 0,
    crownFeatherMeters: 0.45,
  }),
});

const ROOT_KEYS = new Set([
  'meta', 'catalogVersion', 'placementAlgorithmVersion', 'biome', 'groundCover', 'surfaceMaterials', 'biomeTransitions', 'environmentSeed',
  'bounds', 'tee', 'corridor', 'fringeW', 'greens', 'bunkers', 'ponds', 'forestFloorAreas', 'landforms', 'atmosphere', 'environment',
  'routing',
]);
const BIOMES = new Set(BIOME_IDS.filter((biome) => biome !== 'marine-ocean'));
const SEMANTIC_ASSEMBLIES = new Set([
  'tree-line', 'forest-cluster', 'forest-understory', 'woodland-island', 'rock-outcrop', 'habitat-cluster',
]);
const SEMANTIC_EDGES = new Set(['course-boundary', 'hazard-edge', 'rough-transition']);
const LAND_FORM_KINDS = new Set(['ridge', 'bowl', 'shelf', 'saddle', 'shoulder', 'drainage-channel', 'plateau', 'swale']);
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
  const groundCover = c.groundCover ?? 'turf';
  enumValue(groundCover, new Set(['turf', 'pine-needle-litter', 'native-grasslands']), 'course.groundCover');
  const surfaceMaterials = normalizeSurfaceMaterials(c.surfaceMaterials);
  uint32(c.environmentSeed, 'course.environmentSeed');
  const bounds = validateBounds(c.bounds, 'course.bounds');
  const tee = validateTee(c.tee);
  const corridor = validateCorridor(c.corridor);
  range(c.fringeW, 0, 12, 'course.fringeW');
  const greens = array(c.greens, 'course.greens').map((green, index) => validateGreen(green, index, bounds));
  const bunkers = array(c.bunkers, 'course.bunkers').map((bunker, index) => validateBunker(bunker, index, bounds));
  const ponds = array(c.ponds, 'course.ponds').map((pond, index) => validatePond(pond, index, bounds));
  const forestFloorAreas = array(c.forestFloorAreas ?? [], 'course.forestFloorAreas')
    .map((area, index) => validateForestFloorArea(area, index, bounds));
  if (new Set(forestFloorAreas.map(({ id }) => id)).size !== forestFloorAreas.length) {
    fail('course.forestFloorAreas must use unique IDs');
  }
  const landforms = array(c.landforms ?? [], 'course.landforms').map((landform, index) => validateLandform(landform, index, bounds));
  const routing = c.routing === undefined ? null : validateRouting(c.routing, { bounds, greens, bunkers, ponds, landforms });
  if (meta.schema === SHARED_SITE_COURSE_SCHEMA_VERSION && !routing) fail('course.routing is required for schema 4');
  if (meta.schema === COURSE_SCHEMA_VERSION && routing) fail('course.routing requires schema 4');
  const biomeTransitions = validateBiomeTransitions(c.biomeTransitions, {
    biome: c.biome, bounds, tee, corridor, greens, bunkers, ponds,
  }, fail);
  const atmosphere = c.atmosphere === undefined ? undefined : validateAtmosphere(c.atmosphere);
  const catalog = toAssetMap(catalogAssetIds);
  const environment = validateEnvironment(c.environment, { biome: c.biome, bounds, tee, corridor, greens, bunkers, ponds, routing, catalog });

  return Object.freeze({
    meta: Object.freeze(meta),
    catalogVersion: c.catalogVersion,
    placementAlgorithmVersion: c.placementAlgorithmVersion,
    biome: c.biome,
    groundCover,
    surfaceMaterials,
    biomeTransitions,
    environmentSeed: normalizeSeed(c.environmentSeed),
    bounds: Object.freeze(bounds), tee: Object.freeze(tee), corridor: Object.freeze(corridor), fringeW: c.fringeW,
    greens: Object.freeze(greens), bunkers: Object.freeze(bunkers), ponds: Object.freeze(ponds),
    forestFloorAreas: Object.freeze(forestFloorAreas), landforms: Object.freeze(landforms),
    ...(routing ? { routing } : {}),
    ...(atmosphere ? { atmosphere: Object.freeze(atmosphere) } : {}),
    environment: Object.freeze(environment),
  });
}

function validateForestFloorArea(raw, index, bounds) {
  const path = `course.forestFloorAreas[${index}]`;
  const value = object(raw, path);
  rejectUnknown(value, new Set(['id', 'shape']), path);
  identifier(value.id, `${path}.id`);
  const shape = array(value.shape, `${path}.shape`)
    .map((point, pointIndex) => validateRoutingPoint(point, `${path}.shape[${pointIndex}]`, bounds));
  if (shape.length < 4 || shape.length > 32) fail(`${path}.shape must contain 4..32 control points`);
  if (polygonSelfIntersects(shape)) fail(`${path}.shape must not self-intersect`);
  if (Math.abs(polygonArea(shape)) < 20) fail(`${path}.shape must enclose at least 20 square metres`);
  return Object.freeze({ id: value.id, shape: smoothClosedOutline(shape, 4) });
}

export function normalizeSurfaceMaterials(raw = DEFAULT_SURFACE_MATERIALS, { path = 'course.surfaceMaterials' } = {}) {
  const value = object(raw, path);
  rejectUnknown(value, new Set(['version', 'turf', 'forestFloor']), path);
  if (value.version !== SURFACE_MATERIALS_VERSION) fail(`${path}.version must be ${SURFACE_MATERIALS_VERSION}`);
  const turfPath = `${path}.turf`;
  const turf = object(value.turf, turfPath);
  rejectUnknown(turf, new Set([
    'parallax', 'detailNormal', 'ao', 'selfShadow', 'roughnessBase', 'roughnessRange',
    'specular', 'grazingRoughness', 'saturation', 'value',
  ]), turfPath);
  const turfBounds = {
    parallax: [0, 3], detailNormal: [0, 4], ao: [0, 1], selfShadow: [0, 1],
    roughnessBase: [0.1, 1], roughnessRange: [0, 0.6], specular: [0, 1],
    grazingRoughness: [0, 1], saturation: [0, 2], value: [0.2, 2],
  };
  for (const [key, [min, max]] of Object.entries(turfBounds)) range(turf[key], min, max, `${turfPath}.${key}`);

  const forestPath = `${path}.forestFloor`;
  const forestFloor = object(value.forestFloor, forestPath);
  rejectUnknown(forestFloor, new Set([
    'reliefDepthMeters', 'normalStrength', 'sourceColorStrength', 'macroVariation',
    'canopyAffinity', 'crownCoreGrassDensity', 'crownFeatherMeters',
  ]), forestPath);
  const forestBounds = {
    reliefDepthMeters: [0, 0.05], normalStrength: [0, 2], sourceColorStrength: [0, 2],
    macroVariation: [0, 0.5], canopyAffinity: [0, 1], crownCoreGrassDensity: [0, 0],
    crownFeatherMeters: [0.25, 12],
  };
  for (const [key, [min, max]] of Object.entries(forestBounds)) range(forestFloor[key], min, max, `${forestPath}.${key}`);
  return Object.freeze({
    version: SURFACE_MATERIALS_VERSION,
    turf: Object.freeze({ ...turf }),
    forestFloor: Object.freeze({ ...forestFloor }),
  });
}

export function classifyCourseRuntimeChange(current, next) {
  if (!current || !next) return 'rebuild';
  const currentMaterials = normalizeSurfaceMaterials(current.surfaceMaterials);
  const nextMaterials = normalizeSurfaceMaterials(next.surfaceMaterials);
  const currentBase = { ...current }; delete currentBase.surfaceMaterials;
  const nextBase = { ...next }; delete nextBase.surfaceMaterials;
  const baseEqual = JSON.stringify(currentBase) === JSON.stringify(nextBase);
  const materialsEqual = JSON.stringify(currentMaterials) === JSON.stringify(nextMaterials);
  if (baseEqual && materialsEqual) return 'unchanged';
  return baseEqual ? 'surface-materials-only' : 'rebuild';
}

export function isSurfaceMaterialOnlyCourseChange(current, next) {
  return classifyCourseRuntimeChange(current, next) === 'surface-materials-only';
}

function validateAtmosphere(raw) {
  const path = 'course.atmosphere';
  const value = object(raw, path);
  rejectUnknown(value, new Set(['climate', 'season', 'localTime', 'weather', 'cloudCoverage', 'windSpeedMph', 'windDirectionDegrees']), path);
  nonEmpty(value.climate, `${path}.climate`);
  enumValue(value.season, new Set(['spring', 'summer', 'autumn', 'winter']), `${path}.season`);
  if (typeof value.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)) fail(`${path}.localTime must be HH:MM`);
  enumValue(value.weather, new Set(['clear', 'partly-cloudy', 'overcast', 'mist', 'light-rain']), `${path}.weather`);
  range(value.cloudCoverage, 0, 1, `${path}.cloudCoverage`);
  range(value.windSpeedMph, 0, 60, `${path}.windSpeedMph`);
  range(value.windDirectionDegrees, 0, 360, `${path}.windDirectionDegrees`);
  return { ...value };
}

function validateLandform(raw, index, bounds) {
  const path = `course.landforms[${index}]`;
  const value = object(raw, path);
  rejectUnknown(value, new Set(['kind', 'points', 'width', 'height', 'falloff']), path);
  enumValue(value.kind, LAND_FORM_KINDS, `${path}.kind`);
  const points = array(value.points, `${path}.points`).map((point, pointIndex) => {
    const pointPath = `${path}.points[${pointIndex}]`; const result = object(point, pointPath);
    rejectUnknown(result, new Set(['x', 'z']), pointPath); exactNumber(result.x, `${pointPath}.x`); exactNumber(result.z, `${pointPath}.z`);
    if (!insideBounds(result, bounds)) fail(`${pointPath} must remain inside course.bounds`);
    return Object.freeze({ x: result.x, z: result.z });
  });
  if (!points.length || points.length > 24) fail(`${path}.points must contain 1..24 points`);
  range(value.width, 1, 160, `${path}.width`); range(value.height, -20, 20, `${path}.height`); range(value.falloff, 1, 200, `${path}.falloff`);
  return Object.freeze({ kind: value.kind, points: Object.freeze(points), width: value.width, height: value.height, falloff: value.falloff });
}

function validateMeta(raw) {
  const meta = object(raw, 'course.meta');
  rejectUnknown(meta, new Set(['name', 'mode', 'schema', 'notes']), 'course.meta');
  nonEmpty(meta.name, 'course.meta.name');
  if (meta.mode !== 'realistic') fail('course.meta.mode must be realistic');
  exactNumber(meta.schema, 'course.meta.schema');
  if (meta.schema !== COURSE_SCHEMA_VERSION && meta.schema !== SHARED_SITE_COURSE_SCHEMA_VERSION) {
    if (Number.isInteger(meta.schema) && meta.schema < COURSE_SCHEMA_VERSION) {
      fail(`course.meta.schema ${meta.schema} requires explicit migration to ${COURSE_SCHEMA_VERSION}; add biomeTransitions (use [] to preserve current behavior)`);
    }
    fail(`course.meta.schema must be ${COURSE_SCHEMA_VERSION} or ${SHARED_SITE_COURSE_SCHEMA_VERSION}`);
  }
  if (meta.notes !== undefined) nonEmpty(meta.notes, 'course.meta.notes');
  return { ...meta };
}

function validateRouting(raw, context) {
  const path = 'course.routing';
  const routing = object(raw, path);
  rejectUnknown(routing, new Set(['activeHoleId', 'clubhouse', 'holes', 'transitions']), path);
  identifier(routing.activeHoleId, `${path}.activeHoleId`);
  const clubhouse = validateRoutingPoint(routing.clubhouse, `${path}.clubhouse`, context.bounds);
  const holeIds = new Set();
  const numbers = new Set();
  const holes = array(routing.holes, `${path}.holes`).map((rawHole, index) => {
    const holePath = `${path}.holes[${index}]`;
    const hole = object(rawHole, holePath);
    rejectUnknown(hole, new Set([
      'holeId', 'name', 'number', 'par', 'route', 'tees',
      'greenStart', 'greenCount', 'bunkerStart', 'bunkerCount', 'pondStart', 'pondCount',
      'landformStart', 'landformCount', 'fringeWidth',
    ]), holePath);
    identifier(hole.holeId, `${holePath}.holeId`);
    if (holeIds.has(hole.holeId)) fail(`${holePath}.holeId must be unique`);
    holeIds.add(hole.holeId);
    nonEmpty(hole.name, `${holePath}.name`);
    if (!Number.isInteger(hole.number) || hole.number < 1 || hole.number > 18 || numbers.has(hole.number)) fail(`${holePath}.number must be unique in [1, 18]`);
    numbers.add(hole.number);
    if (!Number.isInteger(hole.par) || hole.par < 3 || hole.par > 6) fail(`${holePath}.par must be an integer in [3, 6]`);
    const route = validateRuntimeRoute(hole.route, `${holePath}.route`, context.bounds);
    const tees = array(hole.tees, `${holePath}.tees`).map((tee, teeIndex) => validateRoutingTee(tee, `${holePath}.tees[${teeIndex}]`, context.bounds, hole.holeId));
    if (!tees.length) fail(`${holePath}.tees must not be empty`);
    for (const [key, length] of [['green', context.greens.length], ['bunker', context.bunkers.length], ['pond', context.ponds.length], ['landform', context.landforms.length]]) {
      const startKey = `${key}Start`, countKey = `${key}Count`;
      if (!Number.isInteger(hole[startKey]) || !Number.isInteger(hole[countKey]) || hole[startKey] < 0 || hole[countKey] < 0 || hole[startKey] + hole[countKey] > length) fail(`${holePath}.${startKey}/${countKey} is outside the compiled ${key} array`);
    }
    range(hole.fringeWidth, 0, 12, `${holePath}.fringeWidth`);
    if (hole.greenCount < 1) fail(`${holePath}.greenCount must be positive`);
    const primaryGreen = context.greens[hole.greenStart];
    if (Math.hypot(route.points.at(-1).x - primaryGreen.x, route.points.at(-1).z - primaryGreen.z) > 35) fail(`${holePath}.route must end within 35 m of its primary green`);
    if (Math.hypot(route.points[0].x - tees[0].x, route.points[0].z - tees[0].z) > 12) fail(`${holePath}.route must begin within 12 m of its primary tee`);
    return Object.freeze({ ...hole, route, tees: Object.freeze(tees), aim: Object.freeze(routeAim(route)) });
  });
  if (!holes.length || !holes.some((hole) => hole.holeId === routing.activeHoleId)) fail(`${path}.activeHoleId must reference a compiled hole`);
  const orderedNumbers = [...numbers].sort((a, b) => a - b);
  if (orderedNumbers.some((number, index) => number !== index + 1)) fail(`${path}.holes must use contiguous numbers beginning at 1`);
  const transitions = array(routing.transitions, `${path}.transitions`).map((rawTransition, index) => {
    const transitionPath = `${path}.transitions[${index}]`;
    const transition = object(rawTransition, transitionPath);
    rejectUnknown(transition, new Set(['id', 'fromHoleId', 'toHoleId', 'points', 'width']), transitionPath);
    identifier(transition.id, `${transitionPath}.id`);
    identifier(transition.fromHoleId, `${transitionPath}.fromHoleId`);
    identifier(transition.toHoleId, `${transitionPath}.toHoleId`);
    if (!holeIds.has(transition.fromHoleId) || !holeIds.has(transition.toHoleId)) fail(`${transitionPath} references an unknown hole`);
    range(transition.width, 1, 8, `${transitionPath}.width`);
    const points = array(transition.points, `${transitionPath}.points`).map((point, pointIndex) => validateRoutingPoint(point, `${transitionPath}.points[${pointIndex}]`, context.bounds));
    if (points.length < 2 || points.length > 16 || polylineLength(points) > 240) fail(`${transitionPath}.points must describe a bounded 2..16 point transition`);
    return Object.freeze({ ...transition, points: Object.freeze(points) });
  });
  return Object.freeze({ activeHoleId: routing.activeHoleId, clubhouse: Object.freeze(clubhouse), holes: Object.freeze(holes), transitions: Object.freeze(transitions) });
}

function validateRuntimeRoute(raw, path, bounds) {
  const route = object(raw, path);
  rejectUnknown(route, new Set(['points', 'c0', 'k', 'rough', 'fairwayStartMeters']), path);
  const points = array(route.points, `${path}.points`).map((point, index) => validateRoutingPoint(point, `${path}.points[${index}]`, bounds));
  if (points.length < 2 || points.length > 24) fail(`${path}.points must contain 2..24 points`);
  for (let index = 1; index < points.length; index += 1) if (Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z) < 1) fail(`${path}.points contains a degenerate segment`);
  range(route.c0, 4, 100, `${path}.c0`); range(route.k, 0, 1, `${path}.k`); range(route.rough, 0, 100, `${path}.rough`);
  if (route.fairwayStartMeters !== undefined) range(route.fairwayStartMeters, 0, polylineLength(points), `${path}.fairwayStartMeters`);
  return compileRouteCorridor({ points: Object.freeze(points), c0: route.c0, k: route.k, rough: route.rough,
    ...(route.fairwayStartMeters === undefined ? {} : {fairwayStartMeters: route.fairwayStartMeters}),
  });
}

function validateRoutingTee(raw, path, bounds, holeId) {
  const tee = object(raw, path);
  rejectUnknown(tee, new Set(['holeId', 'x', 'z', 'boxHalfX', 'z0', 'z1', 'shape']), path);
  if (tee.holeId !== holeId) fail(`${path}.holeId must match its owner`);
  for (const key of ['x', 'z', 'boxHalfX', 'z0', 'z1']) exactNumber(tee[key], `${path}.${key}`);
  const shape = array(tee.shape, `${path}.shape`).map((point, index) => validateRoutingPoint(point, `${path}.shape[${index}]`, bounds));
  if (shape.length !== 4) fail(`${path}.shape must contain four oriented corners`);
  return Object.freeze({ ...tee, shape: Object.freeze(shape) });
}

function validateRoutingPoint(raw, path, bounds) {
  const point = object(raw, path);
  rejectUnknown(point, new Set(['x', 'z']), path);
  exactNumber(point.x, `${path}.x`); exactNumber(point.z, `${path}.z`);
  if (!insideBounds(point, bounds)) fail(`${path} must remain inside course.bounds`);
  return { x: point.x, z: point.z };
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
  rejectUnknown(green, new Set(['yards', 'x', 'z', 'r', 'contour', 'shape', 'pin']), path);
  exactNumber(green.yards, `${path}.yards`);
  exactNumber(green.x, `${path}.x`);
  if (green.z !== undefined) exactNumber(green.z, `${path}.z`);
  range(green.r, 3, 40, `${path}.r`);
  enumValue(green.contour, new Set(CONTOURS), `${path}.contour`);
  const z = green.z ?? -green.yards * YARD_TO_M;
  if (!Number.isFinite(z)) fail(`${path}.z resolves to a non-finite value`);
  const shape = validateShape(green.shape, { x: green.x, z, r: green.r }, bounds, `${path}.shape`);
  const result = { yards: green.yards, x: green.x, z, r: green.r, contour: green.contour, ...(shape ? { shape } : {}) };
  if (green.pin !== undefined) {
    const pin = object(green.pin, `${path}.pin`);
    rejectUnknown(pin, new Set(['x', 'z']), `${path}.pin`);
    exactNumber(pin.x, `${path}.pin.x`); exactNumber(pin.z, `${path}.pin.z`);
    // The complete 108 mm cup opening must fit inside the authored green.
    if (!insideBounds(pin, bounds) || signedDistanceToFeature(result, pin.x, pin.z) < 0.054) fail(`${path}.pin must fit inside the green`);
    result.pin = Object.freeze({ x: pin.x, z: pin.z });
  }
  return Object.freeze(result);
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
  rejectUnknown(environment, new Set(['objectBudget', 'placements', 'scatter', 'assembly', 'edgeDressing', 'exclusions', 'proceduralTreeDefinitions', 'proceduralTrees']), 'course.environment');
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
  const proceduralTreeDefinitions = array(environment.proceduralTreeDefinitions ?? [], 'course.environment.proceduralTreeDefinitions').map((record, index) => {
    let result;
    try { result = normalizeTreeDefinition(record, `course.environment.proceduralTreeDefinitions[${index}]`); }
    catch (error) { fail(String(error.message).replace(/^Procedural tree schema invalid:\s*/, '')); }
    uniqueRecordId(ids, result.id, `course.environment.proceduralTreeDefinitions[${index}]`); return result;
  });
  const definitionIds = new Set(proceduralTreeDefinitions.map((definition) => definition.id));
  const definitionById = new Map(proceduralTreeDefinitions.map((definition) => [definition.id, definition]));
  const proceduralTrees = array(environment.proceduralTrees ?? [], 'course.environment.proceduralTrees').map((record, index) => {
    const path = `course.environment.proceduralTrees[${index}]`;
    let result;
    try { result = normalizeTreePlacement(record, definitionIds, context.bounds, path); }
    catch (error) { fail(String(error.message).replace(/^Procedural tree schema invalid:\s*/, '')); }
    uniqueRecordId(ids, result.id, `${path}.id`);
    validateProceduralTreeClearance(result, definitionById.get(result.definitionId), clearanceContext, path);
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
  const total = placements.length + proceduralTrees.length + sumCount(scatter) + sumCount(assembly) + sumCount(edgeDressing);
  if (total > environment.objectBudget || total > ENVIRONMENT_OBJECT_BUDGET) {
    fail(`course.environment declares ${total} objects, exceeding its hard budget of ${environment.objectBudget}`);
  }
  return {
    objectBudget: environment.objectBudget,
    placements: Object.freeze(placements), proceduralTreeDefinitions: Object.freeze(proceduralTreeDefinitions), proceduralTrees: Object.freeze(proceduralTrees), scatter: Object.freeze(scatter), assembly: Object.freeze(assembly),
    edgeDressing: Object.freeze(edgeDressing), exclusions: Object.freeze(exclusions), objectCount: total,
  };
}

export function validateProceduralTreeClearance(record, definition, context, path = 'procedural tree') {
  const radius = estimateTreeCanopyRadius(definition) * record.scale;
  if (insideAnyTee(record, context, radius + 12)) fail(`${path} violates tee clearance`);
  for (const feature of context.greens) if (signedDistanceToFeature(feature, record.x, record.z) > -(radius + 14)) fail(`${path} violates green clearance`);
  for (const feature of context.bunkers) if (signedDistanceToFeature(feature, record.x, record.z) > -(radius + 2)) fail(`${path} violates bunker clearance`);
  for (const feature of context.ponds) if (signedDistanceToFeature(feature, record.x, record.z) > -(radius + 2)) fail(`${path} violates water clearance`);
  if (insideAnyFairway(record, context, radius + 4)) fail(`${path} violates fairway clearance`);
  for (const exclusion of context.exclusions) if (distance(record, exclusion) < radius + exclusion.r) fail(`${path} violates exclusion "${exclusion.id}"`);
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
  const allowed = new Set(['id', 'assetIds', 'seed', 'count', 'region', 'minSpacing', 'semantic', 'habitatMassId']);
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
  // A forest room may be authored as one continuous strip between adjacent
  // fairways. Its rectangular authoring envelope can overlap the conservative
  // catalog fairway buffer even when every resolved crown remains in separator
  // rough. Runtime placement performs the exact per-crown maintained-surface
  // check; all other semantics retain the fail-closed whole-region rule.
  const forestLayer = kind === 'assembly'
    && (record.semantic === 'forest-cluster' || record.semantic === 'forest-understory');
  const allowForestFairwayEnvelope = forestLayer;
  for (const asset of assets) {
    if (record.minSpacing < asset.placement.minSpacing) fail(`${path}.minSpacing is below ${asset.id}'s catalog minimum`);
    ensureRegionClear(region, asset, context, path, { allowForestFairwayEnvelope });
  }
  if (kind === 'scatter') {
    if (record.semantic !== undefined) fail(`${path}.semantic is not allowed for scatter`);
  } else if (kind === 'assembly') {
    enumValue(record.semantic, SEMANTIC_ASSEMBLIES, `${path}.semantic`);
    if (record.semantic === 'forest-understory'
      && assets.some((asset) => asset.category !== undefined && asset.category !== 'tree')) {
      fail(`${path}.forest-understory accepts only catalog tree assets`);
    }
  } else {
    enumValue(record.semantic, SEMANTIC_EDGES, `${path}.semantic`);
  }
  if (record.habitatMassId !== undefined) {
    if (!forestLayer) {
      fail(`${path}.habitatMassId is allowed only for forest-layer assembly records`);
    }
    identifier(record.habitatMassId, `${path}.habitatMassId`);
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
  if (insideAnyTee(point, context, radius + clearance.tee)) fail(`${path} violates tee clearance`);
  for (const feature of context.greens) if (signedDistanceToFeature(feature, point.x, point.z) > -(radius + clearance.green)) fail(`${path} violates green clearance`);
  for (const feature of context.bunkers) if (signedDistanceToFeature(feature, point.x, point.z) > -(radius + clearance.bunker)) fail(`${path} violates bunker clearance`);
  for (const feature of context.ponds) if (signedDistanceToFeature(feature, point.x, point.z) > -(radius + clearance.water)) fail(`${path} violates water clearance`);
  if (insideAnyFairway(point, context, radius + clearance.fairway)) fail(`${path} violates fairway clearance`);
  for (const exclusion of context.exclusions) if (distance(point, exclusion) < radius + exclusion.r) fail(`${path} violates exclusion "${exclusion.id}"`);
}

// A rectangular procedural region is safe only when its entire footprint is
// outside protected areas. This intentionally rejects ambiguous random placement
// rather than gambling on a future scatter implementation doing the right thing.
function ensureRegionClear(region, asset, context, path, { allowForestFairwayEnvelope = false } = {}) {
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
  const margin = assetRadius + clearance.tee;
  for (const tee of allTees(context)) {
    if (tee.shape) {
      if (regionIntersectsFeature(region, { x: tee.x, z: tee.z, r: 0, shape: tee.shape }, margin)) fail(`${path}.region intersects tee clearance`);
    } else {
      const teeRect = { minX: tee.x - tee.boxHalfX - margin, maxX: tee.x + tee.boxHalfX + margin, minZ: tee.z0 - margin, maxZ: tee.z1 + margin };
      if (rectIntersects(region, teeRect)) fail(`${path}.region intersects tee clearance`);
    }
  }
  if (allowForestFairwayEnvelope) return;
  const fairwayMargin = clearance.fairway + assetRadius;
  if (context.routing) {
    for (const route of allRoutes(context)) if (routeIntersectsRegion(route, region, fairwayMargin)) fail(`${path}.region intersects fairway clearance`);
  } else {
    for (const z of [region.minZ, region.maxZ]) {
      const fairwayHalf = context.corridor.c0 + (-z) * context.corridor.k + fairwayMargin;
      if (region.minX < fairwayHalf && region.maxX > -fairwayHalf) fail(`${path}.region intersects fairway clearance`);
    }
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
function allTees(context) { return context.routing ? context.routing.holes.flatMap((hole) => hole.tees) : [context.tee]; }
function allRoutes(context) {
  if (!context.routing) return [];
  return [
    ...context.routing.holes.map((hole) => hole.route),
    ...context.routing.transitions.map((transition) => compileRouteCorridor({ points: transition.points, c0: transition.width, k: 0, rough: transition.width * 0.75 })),
  ];
}
function insideAnyTee(point, context, clearance) {
  return allTees(context).some((tee) => tee.shape
    ? signedDistanceToFeature({ x: tee.x, z: tee.z, r: 0, shape: tee.shape }, point.x, point.z) > -clearance
    : insideTee(point, tee, clearance));
}
function insideAnyFairway(point, context, clearance) {
  if (!context.routing) return insideFairway(point, context.corridor, clearance);
  return allRoutes(context).some((route) => routeCorridorSignedDistance(route, point.x, point.z) > -clearance);
}
function rectDistance(rect, circle) { return Math.hypot(Math.max(rect.minX - circle.x, 0, circle.x - rect.maxX), Math.max(rect.minZ - circle.z, 0, circle.z - rect.maxZ)); }
function rectIntersects(a, b) { return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ; }

function routeIntersectsRegion(rawRoute, region, margin) {
  const route = compileRouteCorridor(rawRoute);
  for (const segment of route.surfaceSegments ?? route.segments) {
    const widest = route.c0 + (segment.start + segment.length) * route.k + margin;
    if (segmentRectDistance(segment.a, segment.b, region) <= widest) return true;
  }
  return false;
}

function segmentRectDistance(a, b, region) {
  if (segmentIntersectsRect(a, b, region)) return 0;
  const corners = [
    { x: region.minX, z: region.minZ }, { x: region.maxX, z: region.minZ },
    { x: region.maxX, z: region.maxZ }, { x: region.minX, z: region.maxZ },
  ];
  return Math.min(rectDistance(region, { ...a, r: 0 }), rectDistance(region, { ...b, r: 0 }),
    ...corners.map((point) => pointSegmentDistance(point, a, b)));
}

function segmentIntersectsRect(a, b, region) {
  if (insideBounds(a, region) || insideBounds(b, region)) return true;
  const corners = [
    { x: region.minX, z: region.minZ }, { x: region.maxX, z: region.minZ },
    { x: region.maxX, z: region.maxZ }, { x: region.minX, z: region.maxZ },
  ];
  return corners.some((corner, index) => segmentsCrossOrTouch(a, b, corner, corners[(index + 1) % corners.length]));
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq)) : 0;
  return Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t);
}

function segmentsCrossOrTouch(a, b, c, d) {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
      || Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) return false;
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

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
