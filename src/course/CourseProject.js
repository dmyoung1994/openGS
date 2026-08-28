import { normalizeCourse } from './course.js';

export const COURSE_PROJECT_SCHEMA_VERSION = 4;
export const COURSE_PROJECT_MODES = Object.freeze(['realistic', 'spectacle', 'hybrid']);
export const COURSE_PROJECT_KINDS = Object.freeze(['hole', 'practice']);
export const LAND_FORM_KINDS = Object.freeze([
  'ridge', 'bowl', 'shelf', 'saddle', 'shoulder', 'drainage-channel', 'plateau', 'swale',
]);
export const SYNTHETIC_TREE_ARCHETYPES = Object.freeze(['broadleaf-oak', 'live-oak', 'maple', 'monterey-cypress', 'douglas-fir', 'loblolly-pine']);

const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const ENTITY_ARRAYS = Object.freeze({
  hole: ['holes'],
  tee: ['holes', 'tees'],
  green: ['holes', 'greens'],
  bunker: ['holes', 'bunkers'],
  pond: ['holes', 'ponds'],
  landform: ['holes', 'landforms'],
  'synthetic-tree': ['site', 'environment', 'syntheticTrees'],
});

export class CourseProjectSchemaError extends Error {
  constructor(message) {
    super(`Course project schema invalid: ${message}`);
    this.name = 'CourseProjectSchemaError';
  }
}

export function migrateCourseV3(rawCourse, { projectId = 'local-course-project' } = {}) {
  const runtime = normalizeCourse(rawCourse);
  const name = runtime.meta.name;
  const holeId = runtime.greens.length > 1 ? 'practice-range' : 'hole-1';
  const farthest = runtime.greens.reduce((best, green) => (green.yards > best.yards ? green : best), runtime.greens[0]);
  const end = farthest ? { x: farthest.x, z: farthest.z } : { x: 0, z: runtime.bounds.minZ + 20 };
  const environment = structuredClone(rawCourse.environment);
  environment.syntheticTrees ??= [];
  const project = {
    meta: {
      id: projectId,
      name,
      mode: rawCourse.meta.mode,
      schema: COURSE_PROJECT_SCHEMA_VERSION,
      notes: rawCourse.meta.notes,
    },
    activeHoleId: holeId,
    site: {
      bounds: structuredClone(rawCourse.bounds),
      catalogVersion: rawCourse.catalogVersion,
      placementAlgorithmVersion: rawCourse.placementAlgorithmVersion,
      biome: rawCourse.biome,
      biomeTransitions: structuredClone(rawCourse.biomeTransitions),
      environmentSeed: rawCourse.environmentSeed,
      atmosphere: defaultAtmosphere(),
      environment,
    },
    holes: [{
      id: holeId,
      name: runtime.greens.length > 1 ? 'Practice Range' : 'Hole 1',
      number: 1,
      kind: runtime.greens.length > 1 ? 'practice' : 'hole',
      par: runtime.greens.length > 1 ? 3 : inferPar(farthest?.yards ?? 150),
      seed: rawCourse.environmentSeed,
      route: {
        id: `${holeId}-route`,
        points: [{ x: rawCourse.tee.x, z: rawCourse.tee.z }, end],
        fairwayHalfWidth: rawCourse.corridor.c0,
        roughWidth: rawCourse.corridor.rough,
      },
      tees: [{
        id: `${holeId}-tee`, label: 'Primary', x: rawCourse.tee.x, z: rawCourse.tee.z,
        boxHalfX: rawCourse.tee.boxHalfX, z0: rawCourse.tee.z0, z1: rawCourse.tee.z1,
      }],
      fringeWidth: rawCourse.fringeW,
      greens: rawCourse.greens.map((green, index) => ({
        id: `${holeId}-green-${index + 1}`, ...structuredClone(green), z: runtime.greens[index].z,
      })),
      bunkers: rawCourse.bunkers.map((bunker, index) => ({ id: `${holeId}-bunker-${index + 1}`, ...structuredClone(bunker) })),
      ponds: rawCourse.ponds.map((pond, index) => ({ id: `${holeId}-pond-${index + 1}`, ...structuredClone(pond) })),
      landforms: (rawCourse.landforms ?? []).map((landform, index) => ({ id: `${holeId}-landform-${index + 1}`, ...structuredClone(landform) })),
      runtime: { corridor: structuredClone(rawCourse.corridor) },
    }],
  };
  return normalizeCourseProject(project);
}

export function normalizeCourseProject(raw) {
  const project = cloneObject(raw, 'project');
  exactKeys(project, ['meta', 'activeHoleId', 'site', 'holes'], 'project');
  project.meta = validateMeta(project.meta);
  project.site = validateSite(project.site);
  const ids = new Set([project.meta.id]);
  project.site.environment.syntheticTrees = project.site.environment.syntheticTrees.map((tree, index) => {
    const path = `project.site.environment.syntheticTrees[${index}]`; const value = validateSyntheticTree(tree, path, project.site.bounds);
    uniqueId(value.id, `${path}.id`, ids); return value;
  });
  project.holes = array(project.holes, 'project.holes');
  if (project.holes.length < 1 || project.holes.length > 18) fail('project.holes must contain 1..18 holes');
  project.holes = project.holes.map((hole, index) => validateHole(hole, index, project.site.bounds, ids));
  identifier(project.activeHoleId, 'project.activeHoleId');
  if (!project.holes.some((hole) => hole.id === project.activeHoleId)) fail('project.activeHoleId must reference a hole');
  return deepFreeze(project);
}

export function compileActiveCourse(rawProject, { catalogAssetIds } = {}) {
  const project = normalizeCourseProject(rawProject);
  const hole = project.holes.find((candidate) => candidate.id === project.activeHoleId);
  const tee = hole.tees[0];
  const runtime = {
    meta: {
      name: `${project.meta.name} — ${hole.name}`,
      mode: project.meta.mode === 'realistic' ? 'realistic' : 'realistic',
      schema: 3,
      ...(project.meta.notes ? { notes: project.meta.notes } : {}),
    },
    catalogVersion: project.site.catalogVersion,
    placementAlgorithmVersion: project.site.placementAlgorithmVersion,
    biome: project.site.biome,
    biomeTransitions: structuredClone(project.site.biomeTransitions),
    environmentSeed: project.site.environmentSeed,
    bounds: structuredClone(project.site.bounds),
    tee: stripId(tee, ['label']),
    corridor: structuredClone(hole.runtime.corridor),
    fringeW: hole.fringeWidth,
    greens: hole.greens.map((entry) => stripId(entry)),
    bunkers: hole.bunkers.map((entry) => stripId(entry)),
    ponds: hole.ponds.map((entry) => stripId(entry)),
    landforms: hole.landforms.map((entry) => stripId(entry)),
    atmosphere: structuredClone(project.site.atmosphere),
    environment: structuredClone(project.site.environment),
  };
  const normalized = normalizeCourse(runtime, { ...(catalogAssetIds ? { catalogAssetIds } : {}) });
  return { project, hole, runtime, normalized };
}

export function projectRevision(project) {
  const source = stableStringify(normalizeCourseProject(project));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v4-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function applyCourseMutations(rawProject, mutations) {
  if (!Array.isArray(mutations) || !mutations.length) fail('mutations must be a non-empty array');
  const project = structuredClone(normalizeCourseProject(rawProject));
  for (let index = 0; index < mutations.length; index += 1) applyMutation(project, mutations[index], index);
  return normalizeCourseProject(project);
}

export function findCourseEntity(rawProject, entityType, entityId) {
  const project = normalizeCourseProject(rawProject);
  if (entityType === 'project') return project.meta.id === entityId ? project : null;
  if (entityType === 'site') return entityId === 'site' ? project.site : null;
  if (entityType === 'atmosphere') return entityId === 'atmosphere' ? project.site.atmosphere : null;
  if (entityType === 'route') {
    return project.holes.map((hole) => hole.route).find((route) => route.id === entityId) ?? null;
  }
  if (entityType === 'environment-object') {
    const collections = ['placements', 'scatter', 'assembly', 'edgeDressing'];
    for (const collection of collections) {
      const found = project.site.environment[collection].find((entry) => entry.id === entityId);
      if (found) return found;
    }
    return null;
  }
  const descriptor = ENTITY_ARRAYS[entityType];
  if (!descriptor) return null;
  if (descriptor[0] === 'holes' && descriptor.length === 1) return project.holes.find((entry) => entry.id === entityId) ?? null;
  if (descriptor[0] === 'holes') {
    for (const hole of project.holes) {
      const found = hole[descriptor[1]].find((entry) => entry.id === entityId);
      if (found) return found;
    }
  } else return project.site.environment.syntheticTrees.find((entry) => entry.id === entityId) ?? null;
  return null;
}

function applyMutation(project, rawMutation, index) {
  const path = `mutations[${index}]`;
  const mutation = cloneObject(rawMutation, path);
  exactKeys(mutation, ['op', 'entityType', 'entityId', 'parentId', 'value'], path, ['parentId', 'value']);
  oneOf(mutation.op, ['create', 'replace', 'delete'], `${path}.op`);
  oneOf(mutation.entityType, ['project', 'site', 'atmosphere', 'hole', 'route', 'tee', 'green', 'bunker', 'pond', 'landform', 'environment-object', 'synthetic-tree'], `${path}.entityType`);
  identifier(mutation.entityId, `${path}.entityId`);
  const located = locateMutable(project, mutation.entityType, mutation.entityId, mutation.parentId);
  if (mutation.op === 'create') {
    if (located.index >= 0 || located.singleton) fail(`${path} cannot create existing ${mutation.entityType} "${mutation.entityId}"`);
    const value = structuredClone(mutation.value);
    if (!value || value.id !== mutation.entityId) fail(`${path}.value.id must equal entityId`);
    located.collection.push(value);
  } else if (mutation.op === 'replace') {
    if (located.singleton) located.parent[located.key] = structuredClone(mutation.value);
    else {
      if (located.index < 0) fail(`${path} cannot replace missing ${mutation.entityType} "${mutation.entityId}"`);
      const value = structuredClone(mutation.value);
      if (!value || value.id !== mutation.entityId) fail(`${path}.value.id must equal entityId`);
      located.collection[located.index] = value;
    }
  } else {
    if (located.singleton) fail(`${path} cannot delete singleton ${mutation.entityType}`);
    if (located.index < 0) fail(`${path} cannot delete missing ${mutation.entityType} "${mutation.entityId}"`);
    located.collection.splice(located.index, 1);
  }
}

function locateMutable(project, type, id, parentId) {
  if (type === 'project') {
    if (id !== project.meta.id) fail(`project mutation must target "${project.meta.id}"`);
    return { singleton: true, parent: project, key: 'meta' };
  }
  if (type === 'site') {
    if (id !== 'site') fail('site mutation must target "site"');
    return { singleton: true, parent: project, key: 'site' };
  }
  if (type === 'atmosphere') {
    if (id !== 'atmosphere') fail('atmosphere mutation must target "atmosphere"');
    return { singleton: true, parent: project.site, key: 'atmosphere' };
  }
  if (type === 'hole') return locateArray(project.holes, id);
  if (type === 'synthetic-tree') return locateArray(project.site.environment.syntheticTrees, id);
  if (type === 'environment-object') {
    const collectionName = mutationCollectionForValue(project.site.environment, id, parentId);
    return locateArray(project.site.environment[collectionName], id);
  }
  const hole = project.holes.find((entry) => entry.id === parentId)
    ?? project.holes.find((entry) => entry.route.id === id || ['tees', 'greens', 'bunkers', 'ponds', 'landforms'].some((key) => entry[key].some((item) => item.id === id)));
  if (!hole) fail(`mutation parent hole "${parentId ?? 'unknown'}" does not exist`);
  if (type === 'route') return { singleton: true, parent: hole, key: 'route' };
  return locateArray(hole[`${type}s`], id);
}

function mutationCollectionForValue(environment, id, preferred) {
  const valid = ['placements', 'scatter', 'assembly', 'edgeDressing'];
  if (preferred && valid.includes(preferred)) return preferred;
  return valid.find((key) => environment[key].some((entry) => entry.id === id)) ?? 'placements';
}

function locateArray(collection, id) { return { collection, index: collection.findIndex((entry) => entry.id === id), singleton: false }; }

function validateMeta(raw) {
  const value = cloneObject(raw, 'project.meta');
  exactKeys(value, ['id', 'name', 'mode', 'schema', 'notes'], 'project.meta', ['notes']);
  identifier(value.id, 'project.meta.id');
  nonEmpty(value.name, 'project.meta.name');
  oneOf(value.mode, COURSE_PROJECT_MODES, 'project.meta.mode');
  if (value.schema !== COURSE_PROJECT_SCHEMA_VERSION) fail(`project.meta.schema must be ${COURSE_PROJECT_SCHEMA_VERSION}`);
  if (value.notes !== undefined) nonEmpty(value.notes, 'project.meta.notes');
  return value;
}

function validateSite(raw) {
  const site = cloneObject(raw, 'project.site');
  exactKeys(site, ['bounds', 'catalogVersion', 'placementAlgorithmVersion', 'biome', 'biomeTransitions', 'environmentSeed', 'atmosphere', 'environment'], 'project.site');
  const bounds = cloneObject(site.bounds, 'project.site.bounds');
  exactKeys(bounds, ['minX', 'maxX', 'minZ', 'maxZ'], 'project.site.bounds');
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) finite(bounds[key], `project.site.bounds.${key}`);
  if (!(bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ)) fail('project.site.bounds must have positive area');
  if (!Number.isInteger(site.catalogVersion) || site.catalogVersion < 1) fail('project.site.catalogVersion must be a positive integer');
  if (!Number.isInteger(site.placementAlgorithmVersion) || site.placementAlgorithmVersion < 1) fail('project.site.placementAlgorithmVersion must be a positive integer');
  nonEmpty(site.biome, 'project.site.biome');
  array(site.biomeTransitions, 'project.site.biomeTransitions');
  uint32(site.environmentSeed, 'project.site.environmentSeed');
  site.atmosphere = validateAtmosphere(site.atmosphere);
  site.environment = cloneObject(site.environment, 'project.site.environment');
  site.environment.syntheticTrees ??= [];
  array(site.environment.syntheticTrees, 'project.site.environment.syntheticTrees');
  return site;
}

function validateAtmosphere(raw) {
  const value = cloneObject(raw, 'project.site.atmosphere');
  exactKeys(value, ['climate', 'season', 'localTime', 'weather', 'cloudCoverage', 'windSpeedMph', 'windDirectionDegrees'], 'project.site.atmosphere');
  nonEmpty(value.climate, 'project.site.atmosphere.climate');
  oneOf(value.season, ['spring', 'summer', 'autumn', 'winter'], 'project.site.atmosphere.season');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)) fail('project.site.atmosphere.localTime must be HH:MM');
  oneOf(value.weather, ['clear', 'partly-cloudy', 'overcast', 'mist', 'light-rain'], 'project.site.atmosphere.weather');
  bounded(value.cloudCoverage, 0, 1, 'project.site.atmosphere.cloudCoverage');
  bounded(value.windSpeedMph, 0, 60, 'project.site.atmosphere.windSpeedMph');
  bounded(value.windDirectionDegrees, 0, 360, 'project.site.atmosphere.windDirectionDegrees');
  return value;
}

function validateHole(raw, index, bounds, ids) {
  const path = `project.holes[${index}]`;
  const hole = cloneObject(raw, path);
  exactKeys(hole, ['id', 'name', 'number', 'kind', 'par', 'seed', 'route', 'tees', 'fringeWidth', 'greens', 'bunkers', 'ponds', 'landforms', 'runtime'], path);
  uniqueId(hole.id, `${path}.id`, ids); nonEmpty(hole.name, `${path}.name`);
  boundedInteger(hole.number, 1, 18, `${path}.number`); oneOf(hole.kind, COURSE_PROJECT_KINDS, `${path}.kind`);
  boundedInteger(hole.par, 3, 6, `${path}.par`); uint32(hole.seed, `${path}.seed`);
  hole.route = validateRoute(hole.route, `${path}.route`, bounds, ids);
  hole.tees = validateIdArray(hole.tees, `${path}.tees`, ids, (tee, teePath) => validateTee(tee, teePath, bounds));
  if (!hole.tees.length) fail(`${path}.tees must not be empty`);
  bounded(hole.fringeWidth, 0, 12, `${path}.fringeWidth`);
  hole.greens = validateIdArray(hole.greens, `${path}.greens`, ids, (green, greenPath) => validateFeature(green, greenPath, bounds, 'green'));
  if (!hole.greens.length) fail(`${path}.greens must not be empty`);
  hole.bunkers = validateIdArray(hole.bunkers, `${path}.bunkers`, ids, (feature, featurePath) => validateFeature(feature, featurePath, bounds, 'bunker'));
  hole.ponds = validateIdArray(hole.ponds, `${path}.ponds`, ids, (feature, featurePath) => validateFeature(feature, featurePath, bounds, 'pond'));
  hole.landforms = validateIdArray(hole.landforms, `${path}.landforms`, ids, (landform, landformPath) => validateLandform(landform, landformPath, bounds));
  hole.runtime = cloneObject(hole.runtime, `${path}.runtime`);
  exactKeys(hole.runtime, ['corridor'], `${path}.runtime`);
  const corridor = cloneObject(hole.runtime.corridor, `${path}.runtime.corridor`);
  exactKeys(corridor, ['c0', 'k', 'rough'], `${path}.runtime.corridor`);
  bounded(corridor.c0, 4, 100, `${path}.runtime.corridor.c0`);
  bounded(corridor.k, 0, 1, `${path}.runtime.corridor.k`);
  bounded(corridor.rough, 0, 100, `${path}.runtime.corridor.rough`);
  hole.runtime.corridor = corridor;
  return hole;
}

function validateRoute(raw, path, bounds, ids) {
  const route = cloneObject(raw, path);
  exactKeys(route, ['id', 'points', 'fairwayHalfWidth', 'roughWidth'], path);
  uniqueId(route.id, `${path}.id`, ids);
  route.points = array(route.points, `${path}.points`).map((point, index) => validatePoint(point, `${path}.points[${index}]`, bounds));
  if (route.points.length < 2 || route.points.length > 24) fail(`${path}.points must contain 2..24 points`);
  bounded(route.fairwayHalfWidth, 4, 80, `${path}.fairwayHalfWidth`);
  bounded(route.roughWidth, 0, 80, `${path}.roughWidth`);
  return route;
}

function validateTee(raw, path, bounds) {
  const tee = cloneObject(raw, path);
  exactKeys(tee, ['id', 'label', 'x', 'z', 'boxHalfX', 'z0', 'z1'], path);
  nonEmpty(tee.label, `${path}.label`); validatePoint(tee, path, bounds);
  bounded(tee.boxHalfX, 0.5, 20, `${path}.boxHalfX`); finite(tee.z0, `${path}.z0`); finite(tee.z1, `${path}.z1`);
  if (!(tee.z0 < tee.z1)) fail(`${path}.z0 must be below z1`);
  return tee;
}

function validateFeature(raw, path, bounds, kind) {
  const value = cloneObject(raw, path);
  const allowed = kind === 'green' ? ['id', 'yards', 'x', 'z', 'r', 'contour', 'shape']
    : kind === 'bunker' ? ['id', 'x', 'z', 'r', 'depth', 'pot', 'shape']
      : ['id', 'x', 'z', 'r', 'depth', 'shape'];
  exactKeys(value, allowed, path, ['shape']); validatePoint(value, path, bounds); bounded(value.r, kind === 'green' ? 3 : 1.5, 80, `${path}.r`);
  if (kind === 'green') { finite(value.yards, `${path}.yards`); nonEmpty(value.contour, `${path}.contour`); }
  else { bounded(value.depth, 0.3, 6, `${path}.depth`); if (kind === 'bunker' && typeof value.pot !== 'boolean') fail(`${path}.pot must be boolean`); }
  if (value.shape !== undefined) value.shape = array(value.shape, `${path}.shape`).map((point, index) => validatePoint(point, `${path}.shape[${index}]`, bounds));
  return value;
}

function validateLandform(raw, path, bounds) {
  const value = cloneObject(raw, path);
  exactKeys(value, ['id', 'kind', 'points', 'width', 'height', 'falloff'], path);
  oneOf(value.kind, LAND_FORM_KINDS, `${path}.kind`);
  value.points = array(value.points, `${path}.points`).map((point, index) => validatePoint(point, `${path}.points[${index}]`, bounds));
  if (!value.points.length) fail(`${path}.points must not be empty`);
  bounded(value.width, 1, 160, `${path}.width`); bounded(value.height, -20, 20, `${path}.height`); bounded(value.falloff, 1, 200, `${path}.falloff`);
  return value;
}

function validateSyntheticTree(raw, path, bounds) {
  const value = cloneObject(raw, path);
  exactKeys(value, ['id', 'archetype', 'x', 'z', 'rotationY', 'scale', 'seed', 'age', 'health', 'windExposure'], path);
  oneOf(value.archetype, SYNTHETIC_TREE_ARCHETYPES, `${path}.archetype`); validatePoint(value, path, bounds);
  bounded(value.rotationY, -Math.PI * 4, Math.PI * 4, `${path}.rotationY`); bounded(value.scale, 0.36, 2.5, `${path}.scale`);
  uint32(value.seed, `${path}.seed`); bounded(value.age, 0, 1, `${path}.age`); bounded(value.health, 0.25, 1, `${path}.health`); bounded(value.windExposure, 0, 1, `${path}.windExposure`);
  return value;
}

function validateIdArray(raw, path, ids, validate) {
  return array(raw, path).map((entry, index) => {
    const itemPath = `${path}[${index}]`; const value = cloneObject(entry, itemPath);
    uniqueId(value.id, `${itemPath}.id`, ids); return validate(value, itemPath);
  });
}

function validatePoint(raw, path, bounds) {
  finite(raw.x, `${path}.x`); finite(raw.z, `${path}.z`);
  if (raw.x < bounds.minX || raw.x > bounds.maxX || raw.z < bounds.minZ || raw.z > bounds.maxZ) fail(`${path} is outside site bounds`);
  return raw;
}

function defaultAtmosphere() {
  return { climate: 'temperate-maritime', season: 'summer', localTime: '15:30', weather: 'partly-cloudy', cloudCoverage: 0.25, windSpeedMph: 8, windDirectionDegrees: 250 };
}

function inferPar(yards) { return yards < 250 ? 3 : yards < 470 ? 4 : 5; }
function stripId(value, extra = []) { const copy = structuredClone(value); delete copy.id; for (const key of extra) delete copy[key]; return copy; }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function cloneObject(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`); return structuredClone(value); }
function array(value, path) { if (!Array.isArray(value)) fail(`${path} must be an array`); return value; }
function exactKeys(value, allowed, path, optional = []) { const keys = new Set(allowed); const optionalKeys = new Set(optional); for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${path}.${key} is not allowed`); for (const key of allowed) if (!(key in value) && !optionalKeys.has(key)) fail(`${path}.${key} is required`); }
function finite(value, path) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`); }
function bounded(value, min, max, path) { finite(value, path); if (value < min || value > max) fail(`${path} must be in [${min}, ${max}]`); }
function boundedInteger(value, min, max, path) { if (!Number.isInteger(value) || value < min || value > max) fail(`${path} must be an integer in [${min}, ${max}]`); }
function uint32(value, path) { boundedInteger(value, 0, 0xffffffff, path); }
function identifier(value, path) { if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${path} must be a stable kebab-case identifier`); }
function uniqueId(value, path, ids) { identifier(value, path); if (ids.has(value)) fail(`${path} duplicates stable ID "${value}"`); ids.add(value); }
function nonEmpty(value, path) { if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`); }
function oneOf(value, values, path) { if (!values.includes(value)) fail(`${path} has unsupported value "${value}"`); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function fail(message) { throw new CourseProjectSchemaError(message); }
