import { deriveSeed, createRng } from '../util/random.js';
import { getCatalogAsset } from './EnvironmentCatalog.js';

const MAX_ATTEMPTS_PER_OBJECT = 256;

// Resolve semantic authoring records into immutable, renderer-ready placements.
// Every requested object must be placed or the build fails; silently shortening a
// scatter would make authored presence dependent on terrain or algorithm accidents.
export function resolveEnvironmentPlacements(course, catalog, terrain) {
  if (!course?.environment || !catalog?.byId || !terrain?.heightAt || !terrain?.normalAt) {
    throw new Error('Environment placement requires strict course, catalog, and terrain inputs.');
  }
  const result = [];
  const occupied = [];

  const append = (assetId, x, z, rotationY, scale, sourceId, authoredMinSpacing = 0) => {
    const asset = getCatalogAsset(catalog, assetId);
    if (!asset.biomes.includes(course.biome)) return false;
    const normal = terrain.normalAt(x, z);
    const slope = Math.acos(Math.min(1, Math.max(-1, normal.y))) * 180 / Math.PI;
    if (slope > asset.placement.maxSlopeDegrees) return false;
    const radius = asset.bounds.radius * scale;
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
      if (append(assetId, p.x, p.z, rotationY, scale, `${record.id}-${placed}`, record.minSpacing)) placed++;
    }
    if (placed !== record.count) {
      throw new Error(`Environment record "${record.id}" placed ${placed}/${record.count}; density, slope, or spacing is invalid.`);
    }
  }

  if (result.length !== course.environment.objectCount) {
    throw new Error(`Environment placement count mismatch: ${result.length}/${course.environment.objectCount}.`);
  }
  return Object.freeze(result);
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
    return 0.76 + random() * 0.44;
  }
  if (asset.category === 'tree') {
    // A forest wall needs age structure, not a row of cloned nursery stock.
    // Preserve the authored species while spanning young edge trees through
    // mature canopy dominants; this changes scale only, never placement count.
    return 0.66 + random() * 0.72;
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
  if (record.kind === 'assembly' && record.semantic === 'forest-cluster') {
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
  if (current.asset.category === 'tree' || prior.category === 'tree') return combinedRadius * 0.62;
  return combinedRadius * 0.42;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function byId(a, b) { return a.id.localeCompare(b.id); }
