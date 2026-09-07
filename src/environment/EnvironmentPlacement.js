import { deriveSeed, createRng } from '../util/random.js';
import { getCatalogAsset } from './EnvironmentCatalog.js';
import { signedDistanceToFeature } from '../course/featureGeometry.js';
import { routeCorridorSignedDistance } from '../course/RouteGeometry.js';

const MAX_ATTEMPTS_PER_OBJECT = 256;
const MAINTAINED_ENVIRONMENT_SURFACES = new Set([
  'tee', 'fairway', 'green', 'fringe', 'sand', 'water',
]);

// Resolve semantic authoring records into immutable, renderer-ready placements.
// Every requested object must be placed or the build fails; silently shortening a
// scatter would make authored presence dependent on terrain or algorithm accidents.
export function resolveEnvironmentPlacements(course, catalog, terrain, biomeField = terrain?._biomeField) {
  if (!course?.environment || !catalog?.byId || !terrain?.heightAt || !terrain?.normalAt) {
    throw new Error('Environment placement requires strict course, catalog, and terrain inputs.');
  }
  const result = [];
  const occupied = [];

  const append = (
    assetId, x, z, rotationY, scale, sourceId, authoredMinSpacing = 0,
    {
      habitatGroupId = null, habitatMassId = null, semantic = null,
      region = null, seed = null, protectMaintainedSurface = false,
    } = {},
  ) => {
    const asset = getCatalogAsset(catalog, assetId);
    if (!asset.biomes.includes(course.biome)) return false;
    const biomeClassification = biomeField?.sample?.(x, z) ?? null;
    const suitability = environmentHabitatSuitability(asset, biomeClassification);
    if (!suitability.allowed) return false;
    const normal = terrain.normalAt(x, z);
    const slope = Math.acos(Math.min(1, Math.max(-1, normal.y))) * 180 / Math.PI;
    if (slope > asset.placement.maxSlopeDegrees) return false;
    const radius = asset.bounds.radius * scale;
    if (protectMaintainedSurface
      && environmentFootprintTouchesMaintainedSurface(course, terrain, x, z, radius)) return false;
    const minSpacing = Math.max(asset.placement.minSpacing, authoredMinSpacing);
    for (const prior of occupied) {
      const pairSpacing = requiredPairSpacing({ assetId, asset, radius, minSpacing }, prior);
      if (Math.hypot(x - prior.x, z - prior.z) < pairSpacing) return false;
    }
    const grounding = resolvedGrounding(asset, course.environmentSeed, sourceId);
    const y = terrain.heightAt(x, z)
      - asset.bounds.baseY * scale
      - asset.dimensions.height * scale * grounding.burialFraction;
    if (!Number.isFinite(y)) throw new Error(`Environment placement ${sourceId} resolved a non-finite terrain height.`);
    const surfaceNormal = blendedSurfaceNormal(normal, grounding.slopeAlignment);
    const orientation = createRng(deriveSeed(course.environmentSeed, `${sourceId}:surface-variation`));
    const maxTilt = asset.category === 'rock' ? 0.07
      : asset.category === 'deadwood' ? 0.025
        : asset.category === 'groundcover' || asset.category === 'shrub' ? 0.018 : 0;
    const placement = Object.freeze({
      sourceId, assetId, x, y, z, rotationY, scale,
      rotationX: (orientation() * 2 - 1) * maxTilt,
      rotationZ: (orientation() * 2 - 1) * maxTilt,
      normalX: surfaceNormal.x,
      normalY: surfaceNormal.y,
      normalZ: surfaceNormal.z,
      burialFraction: grounding.burialFraction,
      targetHeight: asset.dimensions.height * scale,
      habitat: biomeClassification?.habitat ?? null,
      vegetationWeight: suitability.vegetationWeight,
      ...(habitatGroupId ? { habitatGroupId } : {}),
      ...(habitatMassId ? { habitatMassId } : {}),
      ...(semantic ? { semantic } : {}),
      ...(region ? { region } : {}),
      ...(Number.isInteger(seed) ? { seed } : {}),
    });
    result.push(placement);
    occupied.push({ x, z, minSpacing, assetId, category: asset.category, radius });
    return true;
  };

  for (const placement of [...course.environment.placements].sort(byId)) {
    if (!append(placement.assetId, placement.x, placement.z, placement.rotationY, placement.scale, placement.id)) {
      throw new Error(`Explicit environment placement "${placement.id}" violates runtime slope or spacing.`);
    }
  }

  const distributed = [
    ...course.environment.scatter.map((record) => ({ ...record, kind: 'scatter' })),
    ...course.environment.assembly.map((record) => ({ ...record, kind: 'assembly' })),
    ...course.environment.edgeDressing.map((record) => ({ ...record, kind: 'edgeDressing' })),
  ].sort(byId);
  for (const record of distributed) {
    const habitatMetadata = record.kind === 'assembly'
      ? {
        habitatGroupId: record.id,
        habitatMassId: record.semantic === 'forest-cluster' || record.semantic === 'forest-understory'
          ? (record.habitatMassId ?? record.id)
          : null,
        semantic: record.semantic ?? null,
        region: Object.freeze({ ...record.region }),
        seed: record.seed,
        protectMaintainedSurface: record.semantic === 'forest-cluster'
          || record.semantic === 'forest-understory',
      }
      : undefined;
    const random = createRng(deriveSeed(deriveSeed(course.environmentSeed, record.id), record.seed));
    const strikeRandom = createRng(deriveSeed(deriveSeed(course.environmentSeed, record.id), `${record.seed}:strike`));
    const sharedStrike = strikeRandom() * Math.PI * 2;
    let placed = 0;
    for (let attempt = 0; placed < record.count && attempt < record.count * MAX_ATTEMPTS_PER_OBJECT; attempt++) {
      const assetId = record.assetIds[Math.floor(random() * record.assetIds.length)];
      const asset = getCatalogAsset(catalog, assetId);
      const p = candidate(record, random, placed);
      const scale = distributedScale(record, asset, random, placed);
      const rotationY = distributedRotationY(record, asset, random, sharedStrike);
      if (append(
        assetId, p.x, p.z, rotationY, scale, `${record.id}-${placed}`,
        record.minSpacing, habitatMetadata,
      )) placed++;
    }
    if (placed !== record.count) {
      throw new Error(`Environment record "${record.id}" placed ${placed}/${record.count}; density, slope, or spacing is invalid.`);
    }
  }

  const catalogObjectCount = course.environment.proceduralTrees
    ? course.environment.objectCount - course.environment.proceduralTrees.length
    : course.environment.objectCount;
  if (result.length !== catalogObjectCount) {
    throw new Error(`Catalog environment placement count mismatch: ${result.length}/${catalogObjectCount}.`);
  }
  return Object.freeze(result);
}

// Forest-cluster regions are permitted to straddle a conservative fairway
// clearance envelope, but the resolved objects are not permitted to do so. Use
// exact route/feature geometry for the large maintained shapes and a bounded
// sampling grid against Terrain.surfaceAt for the production sand/zone shapes.
// This keeps region authoring flexible without allowing random placement to
// gamble on a trunk or mature crown landing over playable turf.
function environmentFootprintTouchesMaintainedSurface(course, terrain, x, z, radius) {
  const footprintRadius = Math.max(0, radius);
  const point = { x, z };

  for (const green of course.greens ?? []) {
    if (signedDistanceToFeature(green, x, z) > -(footprintRadius + (course.fringeW ?? 0))) return true;
  }
  for (const pond of course.ponds ?? []) {
    if (signedDistanceToFeature(pond, x, z) > -footprintRadius) return true;
  }
  for (const tee of environmentTees(course)) {
    if (tee.shape) {
      if (signedDistanceToFeature({ x: tee.x, z: tee.z, r: 0, shape: tee.shape }, x, z) > -footprintRadius) return true;
    } else if (circleIntersectsRect(point, footprintRadius, {
      minX: tee.x - tee.boxHalfX, maxX: tee.x + tee.boxHalfX,
      minZ: tee.z0, maxZ: tee.z1,
    })) return true;
  }
  if (environmentFootprintTouchesFairway(course, x, z, footprintRadius)) return true;

  if (typeof terrain.surfaceAt === 'function') {
    const diameter = footprintRadius * 2;
    // At most 25 samples per axis. Mature crowns therefore stay cheap to reject
    // even when a dense strip needs many deterministic candidate attempts.
    const samplesPerAxis = footprintRadius === 0
      ? 1
      : Math.min(25, Math.max(5, Math.ceil(diameter / 1.25) + 1));
    const step = samplesPerAxis === 1 ? 0 : diameter / (samplesPerAxis - 1);
    for (let row = 0; row < samplesPerAxis; row++) {
      const dz = samplesPerAxis === 1 ? 0 : -footprintRadius + row * step;
      for (let column = 0; column < samplesPerAxis; column++) {
        const dx = samplesPerAxis === 1 ? 0 : -footprintRadius + column * step;
        if (dx * dx + dz * dz > footprintRadius * footprintRadius + 1e-9) continue;
        if (MAINTAINED_ENVIRONMENT_SURFACES.has(terrain.surfaceAt(x + dx, z + dz))) return true;
      }
    }
  } else {
    // Headless callers without the production surface classifier fail closed on
    // the authored bunker footprint rather than silently accepting a hazard hit.
    for (const bunker of course.bunkers ?? []) {
      if (signedDistanceToFeature(bunker, x, z) > -footprintRadius) return true;
    }
  }
  return false;
}

function environmentTees(course) {
  return course.routing
    ? course.routing.holes.flatMap((hole) => hole.tees)
    : course.tee ? [course.tee] : [];
}

function environmentFootprintTouchesFairway(course, x, z, radius) {
  if (course.routing) {
    const routes = [
      ...course.routing.holes.map((hole) => hole.route),
      ...course.routing.transitions.map((transition) => ({
        points: transition.points, c0: transition.width, k: 0, rough: transition.width * 0.75,
      })),
    ];
    return routes.some((route) => routeCorridorSignedDistance(route, x, z) > -radius);
  }
  if (!course.corridor) return false;
  const widestHalfWidth = course.corridor.c0 + (-(z - radius)) * course.corridor.k;
  return Math.abs(x) < widestHalfWidth + radius;
}

function circleIntersectsRect(point, radius, rect) {
  const dx = Math.max(rect.minX - point.x, 0, point.x - rect.maxX);
  const dz = Math.max(rect.minZ - point.z, 0, point.z - rect.maxZ);
  return Math.hypot(dx, dz) <= radius;
}

// Catalog vegetation opts into semantic transition habitats. This keeps a fern or
// tree that is valid for the primary maritime biome from silently surviving into a
// dune merely because both bands share the same broad biome ID. Substrate remains
// authoritative: no decorative asset can bridge dry sand into the intertidal or
// water bands. Non-vegetation retains the existing substrate gate so authored rocks
// and deadwood cannot accidentally be placed under the generated ocean either.
export function environmentHabitatSuitability(asset, biomeClassification) {
  const weights = biomeClassification?.weights ?? null;
  if (!weights) return Object.freeze({ allowed: true, vegetationWeight: 1 });
  const substrateWeight = (weights.drySand ?? 0) + (weights.wetSand ?? 0)
    + (weights.shallowShelf ?? 0) + (weights.deepOcean ?? 0);
  if (substrateWeight > 0.18) {
    return Object.freeze({ allowed: false, vegetationWeight: 0 });
  }
  const vegetationWeight = Math.min(1, Math.max(0,
    (weights.primary ?? 0) + (weights.strandGrass ?? 0)
      + (weights.dune ?? 0) * 0.55 + (weights.alpine ?? 0),
  ));
  const vegetation = asset.category === 'tree' || asset.category === 'shrub'
    || asset.category === 'groundcover';
  const habitat = biomeClassification.habitat;
  if (vegetation && biomeClassification.transitionId && habitat !== 'managed-course'
    && !asset.transitionHabitats?.includes(habitat)) {
    return Object.freeze({ allowed: false, vegetationWeight });
  }
  return Object.freeze({ allowed: vegetationWeight > 0.12, vegetationWeight });
}

function distributedScale(record, asset, random, placed) {
  if (record.kind === 'assembly' && asset.category === 'rock') {
    // Outcrops need a hierarchy: one dominant face, a pair of supporting masses,
    // then smaller fragments. A uniform scale range reads as loose garden stones.
    if (placed === 0) return 1.65 + random() * 0.18;
    if (placed < 3) return 1.18 + random() * 0.22;
    return 0.72 + random() * 0.38;
  }
  if (record.kind === 'edgeDressing' && asset.category === 'tree') {
    return 0.88 + random() * 0.62;
  }
  if (asset.category === 'groundcover' || asset.category === 'shrub') {
    // Native grass clumps are authored at different ecological scales: a fine
    // Bermuda tuft is intentionally low, while a medium rough clump and fern
    // need enough vertical presence to read from a golfer-height camera. Keep
    // that authored distinction deterministic instead of flattening every
    // groundcover asset into the same nursery-scale scatter.
    const nativeHeight = asset.dimensions?.height ?? 0;
    if (asset.category === 'groundcover' && nativeHeight >= 0.3) return 1.15 + random() * 0.80;
    if (asset.category === 'groundcover' && nativeHeight >= 0.12) return 1.30 + random() * 0.80;
    return 0.76 + random() * 0.44;
  }
  if (asset.category === 'tree') {
    // Tree source assets vary from 4 m saplings to 15 m mature palms. Scale to
    // physical target heights rather than multiplying every source by the same
    // factor; otherwise changing species can silently create 60–100 m trees.
    // Keep the first anchor tallest, then taper through supports and fill.
    const nativeHeight = Math.max(0.1, asset.dimensions?.height ?? 1);
    if (record.kind === 'assembly') {
      if (record.semantic === 'forest-cluster') {
        if (asset.id === 'polyhaven-fir-tree-01') {
          // The accepted Fir Tree 01 variant is a 13.95 m source specimen. In a
          // mature separator forest it owns the closed primary canopy role, so
          // scale within a plausible adult 18–28 m envelope rather than inheriting
          // the shorter open-pine tiers. Geometry and age class remain authored;
          // this only restores the physical mature height represented by the
          // source collection and lets adjacent crowns form a forest room.
          if (placed === 0) return (25 + random() * 3) / nativeHeight;
          if (placed < 4) return (21 + random() * 5) / nativeHeight;
          return (18 + random() * 6) / nativeHeight;
        }
        // Mature anchors must remain plausible members of their authored age
        // class. Inflating a naturally open 14.9 m pine to 25–45 m magnifies its
        // bare trunk and makes a complete crown read as missing geometry. Keep
        // one emergent, several supports and a native-scale canopy tier instead.
        if (placed === 0) return (22 + random() * 3) / nativeHeight;
        if (placed < 4) return (18 + random() * 5) / nativeHeight;
        return (15 + random() * 5) / nativeHeight;
      }
      if (record.semantic === 'forest-understory') {
        // Understory records retain their catalog age class. They may layer
        // below a 25–45 m overstory, but can never be scaled into substitute
        // mature trees. The narrow native-relative range keeps fir saplings at
        // roughly 8–14 m and 1.3 m pine regeneration near its authored stature.
        return 0.95 + random() * 0.60;
      }
      if (placed === 0) return (20 + random() * 4) / nativeHeight;
      if (placed < 3) return (17 + random() * 4) / nativeHeight;
      return (13 + random() * 5) / nativeHeight;
    }
    return (10 + random() * 7) / nativeHeight;
  }
  return 0.78 + random() * 0.44;
}

function distributedRotationY(record, asset, random, sharedStrike) {
  if (record.kind === 'assembly' && record.semantic === 'rock-outcrop' && asset.category === 'rock') {
    // A shared strike makes an outcrop read as one geologic event. Small yaw
    // variation preserves individual faces without turning it into rock confetti.
    return sharedStrike + (random() * 2 - 1) * 0.18;
  }
  return random() * Math.PI * 2;
}

function candidate(record, random, index) {
  const r = record.region;
  const width = r.maxX - r.minX;
  const depth = r.maxZ - r.minZ;
  if (record.kind === 'assembly'
    && (record.semantic === 'forest-cluster' || record.semantic === 'forest-understory')) {
    // Forest communities already have tightly authored asymmetric bounds.  A
    // single expanding spiral trapped retries at one occupied radius once the
    // first few trees were placed, so valid 7 m spacing could never fill the
    // available region.  Deterministic rejection candidates explore the whole
    // authored footprint and keep the strict spacing rule intact.
    return { x: r.minX + random() * width, z: r.minZ + random() * depth };
  }
  if (record.kind === 'assembly') {
    // Asymmetric community: a low-discrepancy spiral around an offset anchor.
    // Rock faces share one stable bedding direction through their rotations while
    // still using the full authored footprint for a dominant/support hierarchy.
    const u = (index * 0.61803398875 + random() * 0.17) % 1;
    const radius = Math.sqrt((index + 0.5) / Math.max(record.count, 1));
    const angle = u * Math.PI * 2;
    const dx = Math.cos(angle) * width * 0.42 * radius;
    const dz = Math.sin(angle) * depth * 0.42 * radius;
    return {
      x: (r.minX + r.maxX) * 0.5 + dx,
      z: (r.minZ + r.maxZ) * 0.5 + dz,
    };
  }
  if (record.kind === 'edgeDressing') {
    // Several staggered depth bands instead of one uniform perimeter row.
    const band = index % 3;
    const longitudinal = (index * 0.754877666 + random() * 0.31) % 1;
    const lateral = (band + 0.18 + random() * 0.64) / 3;
    return { x: r.minX + width * lateral, z: r.minZ + depth * longitudinal };
  }
  return { x: r.minX + random() * width, z: r.minZ + random() * depth };
}

function resolvedGrounding(asset, seed, sourceId) {
  const random = createRng(deriveSeed(seed, `${sourceId}:burial`));
  const authored = asset.grounding?.burialFraction ?? 0;
  if (asset.category === 'rock') {
    return { burialFraction: clamp(authored + (random() - 0.35) * 0.11, 0.12, 0.34), slopeAlignment: 0.82 };
  }
  if (asset.category === 'deadwood') {
    return { burialFraction: clamp(authored + random() * 0.10, 0.05, 0.18), slopeAlignment: 1 };
  }
  if (asset.category === 'groundcover' || asset.category === 'shrub') {
    return { burialFraction: clamp(authored + random() * 0.035, 0.015, 0.08), slopeAlignment: 0.72 };
  }
  return { burialFraction: authored, slopeAlignment: 0 };
}

function blendedSurfaceNormal(normal, amount) {
  const x = Number.isFinite(normal.x) ? normal.x * amount : 0;
  const y = 1 + ((Number.isFinite(normal.y) ? normal.y : 1) - 1) * amount;
  const z = Number.isFinite(normal.z) ? normal.z * amount : 0;
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

function requiredPairSpacing(current, prior) {
  if (current.assetId === prior.assetId) return Math.max(current.minSpacing, prior.minSpacing);
  const combinedRadius = current.radius + prior.radius;
  const isContactLayer = (current.asset.category === 'groundcover' || current.asset.category === 'shrub')
    || (prior.category === 'groundcover' || prior.category === 'shrub');
  if (isContactLayer) return Math.max(0.35, combinedRadius * 0.18);
  // A fallen log is a forest-floor habitat element, not a second standing crown.
  // Tree catalog radii describe the full branch envelope, so applying crown-to-crown
  // clearance to deadwood wrongly evacuates every log from beneath the canopy as soon
  // as a healthier, wider tree asset is promoted. Keep enough plan-view clearance to
  // avoid a trunk/log intersection while allowing the authored under-canopy clusters.
  const isTreeDeadwoodPair = (current.asset.category === 'tree' && prior.category === 'deadwood')
    || (current.asset.category === 'deadwood' && prior.category === 'tree');
  if (isTreeDeadwoodPair) return Math.max(1.5, combinedRadius * 0.25);
  // Boulders are an under-canopy contact layer too. A tree's catalog radius is
  // its full crown, so the generic crown rule would cut an implausibly large
  // clearing around every woodland outcrop. Keep trunk/stone separation while
  // allowing the authored rocks to remain inside the forest room.
  const isTreeRockPair = (current.asset.category === 'tree' && prior.category === 'rock')
    || (current.asset.category === 'rock' && prior.category === 'tree');
  if (isTreeRockPair) return Math.max(1.5, combinedRadius * 0.18);
  // Mature canopy crowns are allowed to overlap at the edges of a community;
  // clear the trunks, not every leaf tip. The old 0.62 crown rule was authored
  // for small nursery-scale trees and rejects the larger Augusta perimeter trees
  // before they can be placed.
  if (current.asset.category === 'tree' || prior.category === 'tree') return Math.max(3, combinedRadius * 0.30);
  return combinedRadius * 0.42;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function byId(a, b) { return a.id.localeCompare(b.id); }
