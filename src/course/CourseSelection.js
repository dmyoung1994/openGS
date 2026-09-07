import { inverseSitePoint, pointToPolylineDistance } from './RouteGeometry.js';
import { signedDistanceToFeature } from './featureGeometry.js';

// Resolve a clicked terrain point to the nearest stable v4 authoring entity.
// Picking remains semantic: the renderer supplies the world point, while this
// module identifies the editable project object that owns that part of the course.
export function selectCourseContext(project, x, z, terrain = {}) {
  if (!project || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const point = { x: round(x), z: round(z) };
  const placements = new Map((project.site?.routing?.placements ?? []).map((entry) => [entry.holeId, entry]));
  const authoredHoles = placements.size
    ? project.holes ?? []
    : [project.holes?.find((entry) => entry.id === project.activeHoleId) ?? project.holes?.[0]].filter(Boolean);
  let hole = authoredHoles[0] ?? null;
  if (placements.size) hole = authoredHoles.reduce((nearest, candidate) => {
    const local = inverseSitePoint({ x, z }, placements.get(candidate.id));
    const distance = pointToPolylineDistance(local, candidate.route?.points);
    return !nearest || distance < nearest.distance ? { value: candidate, distance } : nearest;
  }, null)?.value ?? hole;
  const candidates = [];
  const add = (entityType, entity, distance, label, threshold = Infinity, parentId = null) => {
    if (!entity?.id || !Number.isFinite(distance) || distance > threshold) return;
    candidates.push({ entityType, entityId: entity.id, parentId, label, distance });
  };

  for (const authoredHole of authoredHoles) {
    const local = placements.size ? inverseSitePoint({ x, z }, placements.get(authoredHole.id)) : { x, z };
    for (const tee of authoredHole.tees ?? []) {
      const inside = Math.abs(local.x - tee.x) <= (tee.boxHalfX ?? 3.2)
        && local.z >= Math.min(tee.z0 ?? tee.z - 4, tee.z1 ?? tee.z + 4)
        && local.z <= Math.max(tee.z0 ?? tee.z - 4, tee.z1 ?? tee.z + 4);
      add('tee', tee, inside ? 0 : distanceTo(local.x, local.z, tee.x, tee.z), `${tee.label || 'Tee'} · ${tee.id}`, inside ? 0 : 4, authoredHole.id);
    }
    for (const green of authoredHole.greens ?? []) add('green', green, featureDistance(green, local.x, local.z), `Green · ${green.id}`, (green.r ?? 9) + 4, authoredHole.id);
    for (const bunker of authoredHole.bunkers ?? []) add('bunker', bunker, featureDistance(bunker, local.x, local.z), `Bunker · ${bunker.id}`, (bunker.r ?? 5) + 3, authoredHole.id);
    for (const pond of authoredHole.ponds ?? []) add('pond', pond, featureDistance(pond, local.x, local.z), `Water · ${pond.id}`, (pond.r ?? 12) + 4, authoredHole.id);
    for (const landform of authoredHole.landforms ?? []) {
      const distance = pointCollectionDistance(landform.points ?? landform.path ?? [landform], local.x, local.z);
      add('landform', landform, distance, `${titleCase(landform.form || 'Landform')} · ${landform.id}`, Math.max(8, landform.width ?? landform.radius ?? 12), authoredHole.id);
    }
  }

  const environment = project.site?.environment ?? {};
  for (const area of project.site?.forestFloorAreas ?? []) {
    const distance = Math.max(0, -signedDistanceToFeature(area, x, z));
    add('forest-floor-area', area, distance, `Pine-straw bed · ${area.id}`, 8, 'forestFloorAreas');
  }
  for (const placement of environment.placements ?? []) {
    add('environment-object', placement, distanceTo(x, z, placement.x, placement.z), `Object · ${placement.id}`, 8, 'placements');
  }
  for (const tree of environment.proceduralTrees ?? []) {
    add('procedural-tree', tree, distanceTo(x, z, tree.x, tree.z), `Tree · ${tree.id}`, 8, 'proceduralTrees');
  }
  for (const collection of ['scatter', 'assembly', 'edgeDressing']) {
    for (const record of environment[collection] ?? []) {
      const distance = regionDistance(record.region, x, z);
      add('environment-object', record, distance, `${titleCase(record.semantic || collection)} · ${record.id}`, 6, collection);
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  const winner = candidates[0];
  const surface = terrain.surface ?? null;
  const biome = compactBiome(terrain.biome);
  if (winner) return { ...winner, distance: round(winner.distance), point, surface, biome, holeId: winner.parentId && project.holes?.some((entry) => entry.id === winner.parentId) ? winner.parentId : hole?.id ?? null };
  return {
    entityType: 'terrain', entityId: hole?.id ?? 'site', parentId: hole?.id ?? null,
    label: `${titleCase(surface || 'Terrain')} at ${point.x}, ${point.z}`,
    distance: 0, point, surface, biome, holeId: hole?.id ?? null,
  };
}

function featureDistance(feature, x, z) {
  if (pointInPolygon(feature.shape, x, z)) return 0;
  return distanceTo(x, z, feature.x, feature.z ?? -(feature.yards ?? 0) * 0.9144);
}

function pointInPolygon(points, x, z) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (((a.z > z) !== (b.z > z)) && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function pointCollectionDistance(points, x, z) {
  const finite = (points ?? []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z));
  if (!finite.length) return Infinity;
  return Math.min(...finite.map((point) => distanceTo(x, z, point.x, point.z)));
}

function regionDistance(region, x, z) {
  if (!region) return Infinity;
  if (region.kind === 'bounds' || ['minX', 'maxX', 'minZ', 'maxZ'].every((key) => Number.isFinite(region[key]))) {
    const dx = Math.max(region.minX - x, 0, x - region.maxX);
    const dz = Math.max(region.minZ - z, 0, z - region.maxZ);
    return Math.hypot(dx, dz);
  }
  if (Array.isArray(region.points)) return pointInPolygon(region.points, x, z) ? 0 : pointCollectionDistance(region.points, x, z);
  return Infinity;
}

function distanceTo(x, z, targetX, targetZ) {
  return Number.isFinite(targetX) && Number.isFinite(targetZ) ? Math.hypot(x - targetX, z - targetZ) : Infinity;
}

function compactBiome(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  return value.primaryBiome ?? value.targetBiome ?? value.habitat ?? value.semanticOwner ?? null;
}

function titleCase(value) { return String(value).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function round(value) { return Math.round(value * 10) / 10; }
