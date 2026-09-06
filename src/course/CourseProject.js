import { DEFAULT_SURFACE_MATERIALS, normalizeCourse, normalizeSurfaceMaterials } from './course.js';
import {
  polylineDistance, polylineLength, polylinesCross, transformLocalPoint, transformTee,
} from './RouteGeometry.js';
import {
  legacyTreeDefinition, normalizeTreeDefinition, normalizeTreePlacement,
} from '../trees/TreeDefinition.js';
import { polygonArea, polygonSelfIntersects } from './featureGeometry.js';

export const COURSE_PROJECT_SCHEMA_VERSION = 5;
export const COURSE_PROJECT_MODES = Object.freeze(['realistic', 'spectacle', 'hybrid']);
export const COURSE_PROJECT_KINDS = Object.freeze(['hole', 'practice']);
export const LAND_FORM_KINDS = Object.freeze([
  'ridge', 'bowl', 'shelf', 'saddle', 'shoulder', 'drainage-channel', 'plateau', 'swale',
]);

const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const ROUTED_LOCAL_BOUNDS = Object.freeze({ minX: -500, maxX: 500, minZ: -800, maxZ: 120 });
const ENTITY_ARRAYS = Object.freeze({
  hole: ['holes'],
  tee: ['holes', 'tees'],
  green: ['holes', 'greens'],
  bunker: ['holes', 'bunkers'],
  pond: ['holes', 'ponds'],
  landform: ['holes', 'landforms'],
  'forest-floor-area': ['site', 'forestFloorAreas'],
  'procedural-tree-definition': ['site', 'environment', 'proceduralTreeDefinitions'],
  'procedural-tree': ['site', 'environment', 'proceduralTrees'],
});

export class CourseProjectSchemaError extends Error {
  constructor(message) {
    super(`Course project schema invalid: ${message}`);
    this.name = 'CourseProjectSchemaError';
  }
}

export function migrateCourseV3(rawCourse, { projectId = 'local-course-project' } = {}) {
  const migratedCourse = { ...structuredClone(rawCourse), environment: migrateLegacyTreeEnvironment(structuredClone(rawCourse.environment)) };
  const runtime = normalizeCourse(migratedCourse);
  const name = runtime.meta.name;
  const holeId = runtime.greens.length > 1 ? 'practice-range' : 'hole-1';
  const farthest = runtime.greens.reduce((best, green) => (green.yards > best.yards ? green : best), runtime.greens[0]);
  const end = farthest ? { x: farthest.x, z: farthest.z } : { x: 0, z: runtime.bounds.minZ + 20 };
  const environment = migrateLegacyTreeEnvironment(structuredClone(rawCourse.environment));
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
      groundCover: rawCourse.groundCover ?? 'turf',
      forestFloorAreas: structuredClone(rawCourse.forestFloorAreas ?? []),
      surfaceMaterials: structuredClone(rawCourse.surfaceMaterials ?? DEFAULT_SURFACE_MATERIALS),
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

export function migrateCourseProjectV4(rawProject) {
  const project = structuredClone(rawProject);
  if (project?.meta?.schema !== 4) fail('v4 migration requires project.meta.schema 4');
  project.meta.schema = COURSE_PROJECT_SCHEMA_VERSION;
  project.site.environment = migrateLegacyTreeEnvironment(project.site.environment);
  return normalizeCourseProject(project);
}

function migrateLegacyTreeEnvironment(rawEnvironment) {
  const environment = structuredClone(rawEnvironment ?? {});
  const definitions = [...(environment.proceduralTreeDefinitions ?? [])];
  const placements = [...(environment.proceduralTrees ?? [])];
  const known = new Set(definitions.map(({ id }) => id));
  const addDefinition = (archetype) => {
    const definition = legacyTreeDefinition(archetype);
    if (!known.has(definition.id)) { definitions.push(definition); known.add(definition.id); }
    return definition.id;
  };
  for (const tree of environment.syntheticTrees ?? []) {
    placements.push({
      id: tree.id, definitionId: addDefinition(tree.archetype), x: tree.x, z: tree.z,
      rotationY: tree.rotationY, scale: tree.scale, seed: tree.seed,
      age: tree.age, health: tree.health, windExposure: tree.windExposure,
    });
  }
  const aliases = environment.foliageAliases ?? (environment.foliageAlias ? [environment.foliageAlias] : []);
  for (const alias of aliases) {
    const archetype = alias.includes('douglas-fir') ? 'douglas-fir'
      : alias.includes('loblolly') ? 'loblolly-pine'
        : alias.includes('monterey') || alias.includes('italian-cypress') ? 'monterey-cypress'
          : alias.includes('sugar-maple') ? 'maple'
            : alias.includes('live-oak') ? 'live-oak'
              : alias.includes('oak') ? 'broadleaf-oak' : null;
    if (!archetype) fail(`cannot migrate unknown foliage alias "${alias}"`);
    addDefinition(archetype);
  }
  delete environment.syntheticTrees; delete environment.foliageAlias; delete environment.foliageAliases;
  environment.proceduralTreeDefinitions = definitions;
  environment.proceduralTrees = placements;
  return environment;
}

export function normalizeCourseProject(raw) {
  const project = cloneObject(raw, 'project');
  exactKeys(project, ['meta', 'activeHoleId', 'site', 'holes'], 'project');
  project.meta = validateMeta(project.meta);
  project.site = validateSite(project.site);
  const ids = new Set([project.meta.id]);
  project.site.environment.proceduralTreeDefinitions = project.site.environment.proceduralTreeDefinitions.map((definition, index) => {
    const path = `project.site.environment.proceduralTreeDefinitions[${index}]`; let value;
    try { value = normalizeTreeDefinition(definition, path); } catch (error) { fail(String(error.message).replace(/^Procedural tree schema invalid:\s*/, '')); }
    uniqueId(value.id, `${path}.id`, ids); return value;
  });
  const definitionIds = new Set(project.site.environment.proceduralTreeDefinitions.map(({ id }) => id));
  project.site.environment.proceduralTrees = project.site.environment.proceduralTrees.map((tree, index) => {
    const path = `project.site.environment.proceduralTrees[${index}]`; let value;
    try { value = normalizeTreePlacement(tree, definitionIds, project.site.bounds, path); } catch (error) { fail(String(error.message).replace(/^Procedural tree schema invalid:\s*/, '')); }
    uniqueId(value.id, `${path}.id`, ids); return value;
  });
  project.holes = array(project.holes, 'project.holes');
  if (project.holes.length < 1 || project.holes.length > 18) fail('project.holes must contain 1..18 holes');
  const holeBounds = project.site.routing === undefined ? project.site.bounds : ROUTED_LOCAL_BOUNDS;
  project.holes = project.holes.map((hole, index) => validateHole(hole, index, holeBounds, ids));
  if (!project.site.routing && project.holes.some(hole => hole.route.fairwayStartMeters > 0)) fail('fairwayStartMeters requires shared-site routing');
  const holeNumbers = project.holes.map((hole) => hole.number).sort((a, b) => a - b);
  if (new Set(holeNumbers).size !== holeNumbers.length || holeNumbers.some((number, index) => number !== index + 1)) fail('project.holes must use unique contiguous numbers beginning at 1');
  identifier(project.activeHoleId, 'project.activeHoleId');
  if (!project.holes.some((hole) => hole.id === project.activeHoleId)) fail('project.activeHoleId must reference a hole');
  if (project.site.routing !== undefined) project.site.routing = validateSiteRouting(project.site.routing, project.holes, project.site.bounds, ids);
  return deepFreeze(project);
}

export function compileActiveCourse(rawProject, { catalogAssetIds } = {}) {
  const project = normalizeCourseProject(rawProject);
  const hole = project.holes.find((candidate) => candidate.id === project.activeHoleId);
  const shared = project.site.routing ? compileSharedSite(project) : null;
  const tee = shared?.activeTee ?? hole.tees[0];
  const runtime = {
    meta: {
      name: `${project.meta.name} — ${hole.name}`,
      mode: project.meta.mode === 'realistic' ? 'realistic' : 'realistic',
      schema: shared ? 4 : 3,
      ...(project.meta.notes ? { notes: project.meta.notes } : {}),
    },
    catalogVersion: project.site.catalogVersion,
    placementAlgorithmVersion: project.site.placementAlgorithmVersion,
    biome: project.site.biome,
    groundCover: project.site.groundCover,
    forestFloorAreas: structuredClone(project.site.forestFloorAreas),
    surfaceMaterials: structuredClone(project.site.surfaceMaterials),
    biomeTransitions: structuredClone(project.site.biomeTransitions),
    environmentSeed: project.site.environmentSeed,
    bounds: structuredClone(project.site.bounds),
    tee: stripId(tee, ['label', 'shape', 'holeId']),
    corridor: structuredClone(hole.runtime.corridor),
    fringeW: shared?.fringeWidth ?? hole.fringeWidth,
    greens: shared?.greens ?? hole.greens.map((entry) => stripId(entry)),
    bunkers: shared?.bunkers ?? hole.bunkers.map((entry) => stripId(entry)),
    ponds: shared?.ponds ?? hole.ponds.map((entry) => stripId(entry)),
    landforms: shared?.landforms ?? hole.landforms.map((entry) => stripId(entry)),
    ...(shared ? { routing: shared.routing } : {}),
    atmosphere: structuredClone(project.site.atmosphere),
    environment: structuredClone(project.site.environment),
  };
  const normalized = normalizeCourse(runtime, { ...(catalogAssetIds ? { catalogAssetIds } : {}) });
  return { project, hole, runtime, normalized };
}

function compileSharedSite(project) {
  const placementByHole = new Map(project.site.routing.placements.map((placement) => [placement.holeId, placement]));
  const greens = [];
  const bunkers = [];
  const ponds = [];
  const landforms = [];
  const routingHoles = [];
  let activeTee = null;
  for (const hole of [...project.holes].sort((a, b) => a.number - b.number)) {
    const placement = placementByHole.get(hole.id);
    const routePoints = hole.route.points.map((point) => transformLocalPoint(point, placement));
    const tees = hole.tees.map((tee) => ({ holeId: hole.id, ...transformTee(tee, placement) }));
    const greenStart = greens.length;
    greens.push(...hole.greens.map((feature) => transformFeature(feature, placement)));
    const bunkerStart = bunkers.length;
    bunkers.push(...hole.bunkers.map((feature) => transformFeature(feature, placement)));
    const pondStart = ponds.length;
    ponds.push(...hole.ponds.map((feature) => transformFeature(feature, placement)));
    const landformStart = landforms.length;
    landforms.push(...hole.landforms.map((landform) => ({
      ...stripId(landform),
      points: landform.points.map((point) => transformLocalPoint(point, placement)),
    })));
    if (hole.id === project.activeHoleId) activeTee = tees[0];
    routingHoles.push({
      holeId: hole.id,
      name: hole.name,
      number: hole.number,
      par: hole.par,
      route: {
        points: routePoints,
        c0: hole.runtime.corridor.c0,
        k: hole.runtime.corridor.k,
        rough: hole.runtime.corridor.rough,
        ...(hole.route.fairwayStartMeters === undefined ? {} : {fairwayStartMeters: hole.route.fairwayStartMeters}),
      },
      tees,
      greenStart,
      greenCount: hole.greens.length,
      bunkerStart,
      bunkerCount: hole.bunkers.length,
      pondStart,
      pondCount: hole.ponds.length,
      landformStart,
      landformCount: hole.landforms.length,
      fringeWidth: hole.fringeWidth,
    });
  }
  const transitions = project.site.routing.transitions.map((transition) => ({
    id: transition.id,
    fromHoleId: transition.fromHoleId,
    toHoleId: transition.toHoleId,
    points: structuredClone(transition.points),
    width: transition.width,
  }));
  return {
    activeTee,
    fringeWidth: project.holes.find((hole) => hole.id === project.activeHoleId).fringeWidth,
    greens,
    bunkers,
    ponds,
    landforms,
    routing: {
      activeHoleId: project.activeHoleId,
      clubhouse: structuredClone(project.site.routing.clubhouse),
      holes: routingHoles,
      transitions,
    },
  };
}

function transformFeature(feature, placement) {
  const point = transformLocalPoint(feature, placement);
  return {
    ...stripId(feature),
    x: point.x,
    z: point.z,
    ...(feature.shape ? { shape: feature.shape.map((entry) => transformLocalPoint(entry, placement)) } : {}),
    ...(feature.pin ? { pin: transformLocalPoint(feature.pin, placement) } : {}),
  };
}

export function projectRevision(project) {
  const source = stableStringify(normalizeCourseProject(project));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v5-${(hash >>> 0).toString(16).padStart(8, '0')}`;
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
  if (entityType === 'surface-materials') return entityId === 'surface-materials' ? project.site.surfaceMaterials : null;
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
  } else if (descriptor[0] === 'site') {
    return project.site[descriptor[1]].find((entry) => entry.id === entityId) ?? null;
  } else return project.site.environment[descriptor[2]].find((entry) => entry.id === entityId) ?? null;
  return null;
}

function applyMutation(project, rawMutation, index) {
  const path = `mutations[${index}]`;
  const mutation = cloneObject(rawMutation, path);
  exactKeys(mutation, ['op', 'entityType', 'entityId', 'parentId', 'value'], path, ['parentId', 'value']);
  oneOf(mutation.op, ['create', 'replace', 'delete'], `${path}.op`);
  oneOf(mutation.entityType, ['project', 'site', 'atmosphere', 'surface-materials', 'hole', 'route', 'tee', 'green', 'bunker', 'pond', 'landform', 'forest-floor-area', 'environment-object', 'procedural-tree-definition', 'procedural-tree'], `${path}.entityType`);
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
  if (type === 'surface-materials') {
    if (id !== 'surface-materials') fail('surface-materials mutation must target "surface-materials"');
    return { singleton: true, parent: project.site, key: 'surfaceMaterials' };
  }
  if (type === 'hole') return locateArray(project.holes, id);
  if (type === 'forest-floor-area') return locateArray(project.site.forestFloorAreas, id);
  if (type === 'procedural-tree-definition') return locateArray(project.site.environment.proceduralTreeDefinitions, id);
  if (type === 'procedural-tree') return locateArray(project.site.environment.proceduralTrees, id);
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
  exactKeys(site, ['bounds', 'catalogVersion', 'placementAlgorithmVersion', 'biome', 'groundCover', 'forestFloorAreas', 'surfaceMaterials', 'biomeTransitions', 'environmentSeed', 'atmosphere', 'environment', 'routing'], 'project.site', ['forestFloorAreas', 'surfaceMaterials', 'routing']);
  const bounds = cloneObject(site.bounds, 'project.site.bounds');
  exactKeys(bounds, ['minX', 'maxX', 'minZ', 'maxZ'], 'project.site.bounds');
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) finite(bounds[key], `project.site.bounds.${key}`);
  if (!(bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ)) fail('project.site.bounds must have positive area');
  if (!Number.isInteger(site.catalogVersion) || site.catalogVersion < 1) fail('project.site.catalogVersion must be a positive integer');
  if (!Number.isInteger(site.placementAlgorithmVersion) || site.placementAlgorithmVersion < 1) fail('project.site.placementAlgorithmVersion must be a positive integer');
  nonEmpty(site.biome, 'project.site.biome');
  oneOf(site.groundCover, ['turf', 'pine-needle-litter', 'native-grasslands'], 'project.site.groundCover');
  site.forestFloorAreas = array(site.forestFloorAreas ?? [], 'project.site.forestFloorAreas')
    .map((area, index) => validateForestFloorArea(area, index, bounds));
  if (new Set(site.forestFloorAreas.map(({ id }) => id)).size !== site.forestFloorAreas.length) {
    fail('project.site.forestFloorAreas must use unique IDs');
  }
  try {
    site.surfaceMaterials = normalizeSurfaceMaterials(site.surfaceMaterials, { path: 'project.site.surfaceMaterials' });
  } catch (error) {
    fail(String(error?.message || error).replace(/^Course schema invalid:\s*/, ''));
  }
  array(site.biomeTransitions, 'project.site.biomeTransitions');
  uint32(site.environmentSeed, 'project.site.environmentSeed');
  site.atmosphere = validateAtmosphere(site.atmosphere);
  site.environment = cloneObject(site.environment, 'project.site.environment');
  site.environment.proceduralTreeDefinitions ??= [];
  site.environment.proceduralTrees ??= [];
  array(site.environment.proceduralTreeDefinitions, 'project.site.environment.proceduralTreeDefinitions');
  array(site.environment.proceduralTrees, 'project.site.environment.proceduralTrees');
  return site;
}

function validateForestFloorArea(raw, index, bounds) {
  const path = `project.site.forestFloorAreas[${index}]`;
  const area = cloneObject(raw, path);
  exactKeys(area, ['id', 'shape'], path);
  identifier(area.id, `${path}.id`);
  area.shape = array(area.shape, `${path}.shape`)
    .map((point, pointIndex) => validatePoint(point, `${path}.shape[${pointIndex}]`, bounds));
  if (area.shape.length < 4 || area.shape.length > 32) fail(`${path}.shape must contain 4..32 control points`);
  if (polygonSelfIntersects(area.shape)) fail(`${path}.shape must not self-intersect`);
  if (Math.abs(polygonArea(area.shape)) < 20) fail(`${path}.shape must enclose at least 20 square metres`);
  return area;
}

function validateSiteRouting(raw, holes, bounds, ids) {
  const path = 'project.site.routing';
  const routing = cloneObject(raw, path);
  exactKeys(routing, ['clubhouse', 'placements', 'transitions'], path);
  routing.clubhouse = validatePoint(cloneObject(routing.clubhouse, `${path}.clubhouse`), `${path}.clubhouse`, bounds);
  routing.placements = array(routing.placements, `${path}.placements`).map((rawPlacement, index) => {
    const placementPath = `${path}.placements[${index}]`;
    const placement = cloneObject(rawPlacement, placementPath);
    exactKeys(placement, ['holeId', 'origin', 'bearingDegrees'], placementPath);
    identifier(placement.holeId, `${placementPath}.holeId`);
    placement.origin = validatePoint(cloneObject(placement.origin, `${placementPath}.origin`), `${placementPath}.origin`, bounds);
    bounded(placement.bearingDegrees, 0, 359.999999, `${placementPath}.bearingDegrees`);
    return placement;
  });
  if (routing.placements.length !== holes.length) fail(`${path}.placements must contain exactly one record per hole`);
  const placementByHole = new Map();
  for (const placement of routing.placements) {
    if (placementByHole.has(placement.holeId)) fail(`${path}.placements duplicates hole "${placement.holeId}"`);
    if (!holes.some((hole) => hole.id === placement.holeId)) fail(`${path}.placements references unknown hole "${placement.holeId}"`);
    placementByHole.set(placement.holeId, placement);
  }
  for (const hole of holes) {
    const placement = placementByHole.get(hole.id);
    if (!placement) fail(`${path}.placements is missing hole "${hole.id}"`);
    const authoredPoints = [
      ...hole.route.points,
      ...hole.tees.flatMap((tee) => [{ x: tee.x - tee.boxHalfX, z: tee.z0 }, { x: tee.x + tee.boxHalfX, z: tee.z1 }]),
      ...hole.greens.flatMap((feature) => [feature, ...(feature.shape ?? []), ...(feature.pin ? [feature.pin] : [])]),
      ...hole.bunkers.flatMap((feature) => [feature, ...(feature.shape ?? [])]),
      ...hole.ponds.flatMap((feature) => [feature, ...(feature.shape ?? [])]),
      ...hole.landforms.flatMap((landform) => landform.points),
    ];
    for (const point of authoredPoints) {
      const transformed = transformLocalPoint(point, placement);
      if (!insideBounds(transformed, bounds)) fail(`${path} places ${hole.id} outside project.site.bounds`);
    }
  }
  const ordered = [...holes].sort((a, b) => a.number - b.number);
  routing.transitions = array(routing.transitions, `${path}.transitions`).map((rawTransition, index) => {
    const transitionPath = `${path}.transitions[${index}]`;
    const transition = cloneObject(rawTransition, transitionPath);
    exactKeys(transition, ['id', 'fromHoleId', 'toHoleId', 'points', 'width'], transitionPath);
    uniqueId(transition.id, `${transitionPath}.id`, ids);
    identifier(transition.fromHoleId, `${transitionPath}.fromHoleId`);
    identifier(transition.toHoleId, `${transitionPath}.toHoleId`);
    bounded(transition.width, 1, 8, `${transitionPath}.width`);
    transition.points = array(transition.points, `${transitionPath}.points`).map((point, pointIndex) => validatePoint(point, `${transitionPath}.points[${pointIndex}]`, bounds));
    if (transition.points.length < 2 || transition.points.length > 16) fail(`${transitionPath}.points must contain 2..16 points`);
    if (polylineLength(transition.points) > 240) fail(`${transitionPath} is too long to read as an intentional green-to-tee transition`);
    return transition;
  });
  if (routing.transitions.length !== Math.max(0, ordered.length - 1)) fail(`${path}.transitions must connect each consecutive pair of holes exactly once`);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    const transition = routing.transitions.find((entry) => entry.fromHoleId === from.id && entry.toHoleId === to.id);
    if (!transition) fail(`${path}.transitions must connect ${from.id} to ${to.id}`);
    const fromPlacement = placementByHole.get(from.id);
    const toPlacement = placementByHole.get(to.id);
    const green = transformLocalPoint(from.greens[0], fromPlacement);
    const tee = transformLocalPoint(to.tees[0], toPlacement);
    if (Math.hypot(transition.points[0].x - green.x, transition.points[0].z - green.z) > 30) fail(`${path}.${transition.id} must begin within 30 m of ${from.id}'s primary green`);
    if (Math.hypot(transition.points.at(-1).x - tee.x, transition.points.at(-1).z - tee.z) > 30) fail(`${path}.${transition.id} must end within 30 m of ${to.id}'s primary tee`);
    validateAdjacentTeeSafety(from, to, fromPlacement, toPlacement, path);
  }
  const routed = ordered.map((hole) => {
    const points = hole.route.points.map((point) => transformLocalPoint(point, placementByHole.get(hole.id)));
    const length = polylineLength(points);
    return {
      hole, points,
      envelope: hole.runtime.corridor.c0 + length * hole.runtime.corridor.k + hole.runtime.corridor.rough,
    };
  });
  for (let first = 0; first < routed.length; first += 1) {
    for (let second = first + 1; second < routed.length; second += 1) {
      const a = routed[first]; const b = routed[second];
      if (polylinesCross(a.points, b.points)) fail(`${path} routes for ${a.hole.id} and ${b.hole.id} cross`);
      // Consecutive holes intentionally approach through a connector. Non-neighboring
      // playing envelopes need a real forest buffer, not merely non-crossing lines.
      if (second > first + 1) {
        const clearance = polylineDistance(a.points, b.points) - a.envelope - b.envelope;
        if (clearance < 12) fail(`${path} routes for ${a.hole.id} and ${b.hole.id} need at least 12 m between rough envelopes`);
      }
    }
  }
  return routing;
}

// A walk can connect neighboring holes without putting the next tee inside the
// normal long-shot dispersion beyond the previous green. Adjacent holes are
// intentionally exempt from whole-envelope separation, so this is the safety
// invariant that prevents that exemption from hiding a green-to-tee conflict.
function validateAdjacentTeeSafety(from, to, fromPlacement, toPlacement, path) {
  const green = transformLocalPoint(from.greens[0], fromPlacement);
  const tee = transformLocalPoint(to.tees[0], toPlacement);
  const dx = tee.x - green.x;
  const dz = tee.z - green.z;
  const centerDistance = Math.hypot(dx, dz);
  const greenRadius = from.greens[0].r;
  const minimumCenterDistance = greenRadius + 32;
  if (centerDistance < minimumCenterDistance) {
    fail(`${path} places ${to.id}'s primary tee only ${centerDistance.toFixed(1)} m from ${from.id}'s primary green; adjacent tees require at least ${minimumCenterDistance.toFixed(1)} m center clearance`);
  }

  const route = from.route.points.map((point) => transformLocalPoint(point, fromPlacement));
  let tangent = null;
  for (let index = route.length - 1; index > 0 && !tangent; index -= 1) {
    const tx = route[index].x - route[index - 1].x;
    const tz = route[index].z - route[index - 1].z;
    const length = Math.hypot(tx, tz);
    if (length > 1e-9) tangent = { x: tx / length, z: tz / length };
  }
  if (!tangent) return;
  const forward = dx * tangent.x + dz * tangent.z;
  const lateral = Math.abs(dx * tangent.z - dz * tangent.x);
  const missConeHalfWidth = greenRadius + 18 + Math.max(0, forward) * 0.22;
  if (forward >= -12 && forward <= 95 && lateral < missConeHalfWidth) {
    fail(`${path} places ${to.id}'s primary tee inside ${from.id}'s long-shot miss cone (${forward.toFixed(1)} m forward, ${lateral.toFixed(1)} m lateral)`);
  }
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
  const primaryTee = hole.tees[0];
  const primaryGreen = hole.kind === 'practice'
    ? hole.greens.reduce((farthest, green) => green.yards > farthest.yards ? green : farthest, hole.greens[0])
    : hole.greens[0];
  if (Math.hypot(hole.route.points[0].x - primaryTee.x, hole.route.points[0].z - primaryTee.z) > 12) fail(`${path}.route must begin within 12 m of its primary tee`);
  if (Math.hypot(hole.route.points.at(-1).x - primaryGreen.x, hole.route.points.at(-1).z - primaryGreen.z) > 35) fail(`${path}.route must end within 35 m of its primary green`);
  const routeYards = polylineLength(hole.route.points) / 0.9144;
  if (Math.abs(routeYards - primaryGreen.yards) > Math.max(18, primaryGreen.yards * 0.12)) fail(`${path}.route arc length must agree with its primary green yardage`);
  return hole;
}

function validateRoute(raw, path, bounds, ids) {
  const route = cloneObject(raw, path);
  exactKeys(route, ['id', 'points', 'fairwayHalfWidth', 'roughWidth', 'fairwayStartMeters'], path, ['fairwayStartMeters']);
  uniqueId(route.id, `${path}.id`, ids);
  route.points = array(route.points, `${path}.points`).map((point, index) => validatePoint(point, `${path}.points[${index}]`, bounds));
  if (route.points.length < 2 || route.points.length > 24) fail(`${path}.points must contain 2..24 points`);
  for (let index = 1; index < route.points.length; index += 1) if (Math.hypot(route.points[index].x - route.points[index - 1].x, route.points[index].z - route.points[index - 1].z) < 1) fail(`${path}.points contains a degenerate segment`);
  if (polylineSelfIntersects(route.points)) fail(`${path}.points must not self-intersect`);
  bounded(route.fairwayHalfWidth, 4, 80, `${path}.fairwayHalfWidth`);
  bounded(route.roughWidth, 0, 80, `${path}.roughWidth`);
  if (route.fairwayStartMeters !== undefined) bounded(route.fairwayStartMeters, 0, polylineLength(route.points), `${path}.fairwayStartMeters`);
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
  const allowed = kind === 'green' ? ['id', 'yards', 'x', 'z', 'r', 'contour', 'shape', 'pin']
    : kind === 'bunker' ? ['id', 'x', 'z', 'r', 'depth', 'pot', 'shape']
      : ['id', 'x', 'z', 'r', 'depth', 'shape'];
  exactKeys(value, allowed, path, ['shape', 'pin']); validatePoint(value, path, bounds); bounded(value.r, kind === 'green' ? 3 : 1.5, 80, `${path}.r`);
  if (value.pin !== undefined) {
    value.pin = cloneObject(value.pin, `${path}.pin`);
    exactKeys(value.pin, ['x', 'z'], `${path}.pin`);
    value.pin = validatePoint(value.pin, `${path}.pin`, bounds);
  }
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

function validateIdArray(raw, path, ids, validate) {
  return array(raw, path).map((entry, index) => {
    const itemPath = `${path}[${index}]`; const value = cloneObject(entry, itemPath);
    uniqueId(value.id, `${itemPath}.id`, ids); return validate(value, itemPath);
  });
}

function validatePoint(raw, path, bounds) {
  finite(raw.x, `${path}.x`); finite(raw.z, `${path}.z`);
  if (!insideBounds(raw, bounds)) fail(`${path} is outside site bounds`);
  return raw;
}

function insideBounds(point, bounds) {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ;
}

function polylineSelfIntersects(points) {
  for (let first = 0; first < points.length - 1; first += 1) {
    for (let second = first + 2; second < points.length - 1; second += 1) {
      if (segmentsCross(points[first], points[first + 1], points[second], points[second + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(a, b, c, d) {
  const orientation = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0;
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
