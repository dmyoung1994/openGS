import { DataTexture, LinearFilter, NearestFilter, RedFormat, UnsignedByteType } from 'three';

export const GRASS_GROWABLE_BIT = 128;
export const CANOPY_MASK_MAX = 127;
// The remaining seven bits carry physical distance inward from the authored crown
// perimeter. This is independent of any chosen material feather, so changing the
// live forest-floor uniform never requires rebaking or replacing the shared texture.
export const CANOPY_DISTANCE_MAX_METERS = 12;
export const CANOPY_DISC_RADIUS_SCALE = 1.1;

// Which ground covers own an EXCLUSIVE surface material under their crowns. Only
// these retire blade geometry outright, because a litter bed physically replaces
// the grass there. Every other profile keeps its grass beneath a canopy and merely
// thins it, the way a real tree does — it shades grass out gradually, it does not
// shear it off at the dripline. Terrain resolves its forest-floor maps from this
// same predicate so the material and the geometry can never disagree about which
// courses have a litter bed to hand the ground over to.
export const CANOPY_EXCLUSIVE_SURFACE_GROUND_COVERS = Object.freeze(['pine-needle-litter']);

export function canopyOwnsExclusiveSurface(groundCover) {
  return CANOPY_EXCLUSIVE_SURFACE_GROUND_COVERS.includes(groundCover);
}

// Grass thinning beneath a non-exclusive canopy, expressed against the mask's own
// baked distance-inward field so no rebake is needed. Density falls from full at the
// crown perimeter to CANOPY_THINNED_DENSITY by CANOPY_THINNING_DEPTH_METERS inward.
//
// These were briefly 0.18 over 3 m, tightened only because the far LOD2 tier was
// then running at ~98% of a 786,432 reservation and the first pass at these values
// crossed it by 178 blades — which blanks the ENTIRE grass field, since any tier
// over its cap zeroes all three draw commands by design. That reservation is now
// 1,572,864 with ~793k spare at the worst measured crown pose, so the values below
// are chosen for how a crown actually shades grass rather than for a budget.
//
// Still re-measure `grass.gpu.lod.counts` against `capacities` after changing them.
// Most of a crown's area is its outer annulus, so the depth governs cost more than
// the floor does.
export const CANOPY_THINNED_DENSITY = 0.30;
export const CANOPY_THINNING_DEPTH_METERS = 6;
// Forest-floor habitat follows visible crowns and the minimum set of corridors
// that joins one authored stand. It never paints an assembly's rectangular bounds.

export function decodeCanopyDistanceMeters(packedValue) {
  return (packedValue % GRASS_GROWABLE_BIT) / CANOPY_MASK_MAX * CANOPY_DISTANCE_MAX_METERS;
}

export function canopyForestFloorWeight(packedValue, featherMeters) {
  if (!Number.isFinite(featherMeters) || featherMeters <= 0) {
    throw new Error('Canopy feather must be a positive finite distance.');
  }
  const t = Math.max(0, Math.min(1, decodeCanopyDistanceMeters(packedValue) / featherMeters));
  return t * t * (3 - 2 * t);
}

export function sampleCanopyForestFloorWeight(data, nx, nz, grid, x, z, featherMeters) {
  const fx = Math.max(0, Math.min(nx - 1, (x - grid.minX) / grid.spacing));
  const fz = Math.max(0, Math.min(nz - 1, (z - grid.minZ) / grid.spacing));
  const i = Math.min(Math.floor(fx), nx - 2);
  const j = Math.min(Math.floor(fz), nz - 2);
  const tx = fx - i;
  const tz = fz - j;
  const a = data[j * nx + i] * (1 - tx) + data[j * nx + i + 1] * tx;
  const b = data[(j + 1) * nx + i] * (1 - tx) + data[(j + 1) * nx + i + 1] * tx;
  return canopyForestFloorWeight(a * (1 - tz) + b * tz, featherMeters);
}

export function deriveCanopyHabitatPrimitives(placements = []) {
  const crowns = placements.flatMap((placement, index) => {
    const radius = Number(placement.canopyRadius);
    if (!Number.isFinite(placement.x) || !Number.isFinite(placement.z)
      || !Number.isFinite(radius) || radius <= 0) return [];
    return [{
      key: String(placement.sourceId ?? placement.id ?? `canopy-${index}`),
      x: placement.x,
      z: placement.z,
      radius,
      discRadius: radius * CANOPY_DISC_RADIUS_SCALE,
      habitatGroupId: placement.habitatGroupId ?? null,
      habitatMassId: placement.habitatMassId ?? null,
      semantic: placement.semantic ?? null,
      region: placement.region ?? null,
      seed: placement.seed ?? 0,
    }];
  }).sort(compareCrown);
  const standaloneCrowns = [];
  const massCrowns = new Map();
  for (const crown of crowns) {
    const groupedForest = (crown.semantic === 'forest-cluster' || crown.semantic === 'forest-understory')
      && crown.habitatMassId;
    if (!groupedForest) {
      standaloneCrowns.push(crown);
      continue;
    }
    if (!massCrowns.has(crown.habitatMassId)) massCrowns.set(crown.habitatMassId, []);
    massCrowns.get(crown.habitatMassId).push(Object.freeze(crown));
  }

  const masses = [...massCrowns.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([habitatMassId, groupedCrowns]) => {
      groupedCrowns.sort(compareCrown);
      return Object.freeze({
        habitatMassId,
        crowns: Object.freeze(groupedCrowns),
        connectors: Object.freeze(deriveMassConnectors(habitatMassId, groupedCrowns)),
      });
    });
  return Object.freeze({
    crowns: Object.freeze(standaloneCrowns.map((crown) => Object.freeze(crown))),
    masses: Object.freeze(masses),
  });
}

function compareCrown(a, b) {
  return a.key.localeCompare(b.key) || a.x - b.x || a.z - b.z || a.radius - b.radius;
}

function pointSegmentDistance(x, z, ax, az, bx, bz) {
  const dx = bx - ax; const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return Math.hypot(x - ax, z - az);
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function connectorEndpoints(a, b, distance) {
  const dx = (b.x - a.x) / distance;
  const dz = (b.z - a.z) / distance;
  return {
    ax: a.x + dx * a.discRadius,
    az: a.z + dz * a.discRadius,
    bx: b.x - dx * b.discRadius,
    bz: b.z - dz * b.discRadius,
  };
}

function deriveMassConnectors(habitatMassId, crowns) {
  const edges = [];
  for (let first = 0; first < crowns.length; first += 1) {
    for (let second = first + 1; second < crowns.length; second += 1) {
      const distance = Math.hypot(
        crowns[second].x - crowns[first].x,
        crowns[second].z - crowns[first].z,
      );
      const gap = Math.max(0, distance - crowns[first].discRadius - crowns[second].discRadius);
      if (distance > 1e-6 && gap > 0.2) {
        edges.push({
          first, second, distance, gap,
          key: `${crowns[first].key}\u0000${crowns[second].key}`,
        });
      }
    }
  }
  edges.sort((a, b) => a.gap - b.gap || a.distance - b.distance || a.key.localeCompare(b.key));
  const parent = crowns.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index]; parent[index] = root; index = next;
    }
    return root;
  };
  const connectors = [];
  for (const edge of edges) {
    const firstRoot = find(edge.first); const secondRoot = find(edge.second);
    if (firstRoot === secondRoot) continue;
    parent[secondRoot] = firstRoot;
    const a = crowns[edge.first]; const b = crowns[edge.second];
    const endpoints = connectorEndpoints(a, b, edge.distance);
    connectors.push(Object.freeze({
      habitatMassId,
      ...endpoints,
      halfWidth: Math.min(12, Math.max(6, Math.min(a.discRadius, b.discRadius) * 0.9)),
    }));
  }
  return connectors;
}

function rasterizeHabitatBinary(binary, nx, nz, grid, primitives) {
  const rasterize = ({ minPrimitiveX, maxPrimitiveX, minPrimitiveZ, maxPrimitiveZ, inside }) => {
    const ix0 = Math.max(0, Math.floor((minPrimitiveX - grid.minX) / grid.spacing));
    const ix1 = Math.min(nx - 1, Math.ceil((maxPrimitiveX - grid.minX) / grid.spacing));
    const iz0 = Math.max(0, Math.floor((minPrimitiveZ - grid.minZ) / grid.spacing));
    const iz1 = Math.min(nz - 1, Math.ceil((maxPrimitiveZ - grid.minZ) / grid.spacing));
    for (let iz = iz0; iz <= iz1; iz += 1) {
      const wz = grid.minZ + iz * grid.spacing;
      for (let ix = ix0; ix <= ix1; ix += 1) {
        const wx = grid.minX + ix * grid.spacing;
        if (inside(wx, wz)) binary[iz * nx + ix] = 1;
      }
    }
  };
  for (const crown of primitives.crowns) {
    rasterize({
      minPrimitiveX: crown.x - crown.discRadius,
      maxPrimitiveX: crown.x + crown.discRadius,
      minPrimitiveZ: crown.z - crown.discRadius,
      maxPrimitiveZ: crown.z + crown.discRadius,
      inside: (x, z) => Math.hypot(x - crown.x, z - crown.z) < crown.discRadius,
    });
  }
  for (const mass of primitives.masses) {
    for (const crown of mass.crowns) {
      rasterize({
        minPrimitiveX: crown.x - crown.discRadius,
        maxPrimitiveX: crown.x + crown.discRadius,
        minPrimitiveZ: crown.z - crown.discRadius,
        maxPrimitiveZ: crown.z + crown.discRadius,
        inside: (x, z) => Math.hypot(x - crown.x, z - crown.z) < crown.discRadius,
      });
    }
    for (const connector of mass.connectors) {
      rasterize({
        minPrimitiveX: Math.min(connector.ax, connector.bx) - connector.halfWidth,
        maxPrimitiveX: Math.max(connector.ax, connector.bx) + connector.halfWidth,
        minPrimitiveZ: Math.min(connector.az, connector.bz) - connector.halfWidth,
        maxPrimitiveZ: Math.max(connector.az, connector.bz) + connector.halfWidth,
        inside: (x, z) => pointSegmentDistance(
          x, z, connector.ax, connector.az, connector.bx, connector.bz,
        ) < connector.halfWidth,
      });
    }
  }
}

function distanceTransform1D(source, length, target, vertices, boundaries) {
  let k = 0;
  vertices[0] = 0;
  boundaries[0] = -Infinity;
  boundaries[1] = Infinity;
  for (let q = 1; q < length; q += 1) {
    let intersection;
    do {
      const vertex = vertices[k];
      intersection = ((source[q] + q * q) - (source[vertex] + vertex * vertex))
        / (2 * (q - vertex));
      if (intersection <= boundaries[k]) k -= 1;
    } while (intersection <= boundaries[k]);
    k += 1;
    vertices[k] = q;
    boundaries[k] = intersection;
    boundaries[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < length; q += 1) {
    while (boundaries[k + 1] < q) k += 1;
    const delta = q - vertices[k];
    target[q] = delta * delta + source[vertices[k]];
  }
}

function encodeInwardDistanceField(data, binary, nx, nz, spacing) {
  const width = nx + 2; const height = nz + 2;
  const infinite = (width * width + height * height) * 4;
  const rowPass = new Float64Array(width * height);
  const source = new Float64Array(Math.max(width, height));
  const target = new Float64Array(Math.max(width, height));
  const vertices = new Int32Array(Math.max(width, height));
  const boundaries = new Float64Array(Math.max(width, height) + 1);
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const interior = x > 0 && x <= nx && z > 0 && z <= nz;
      source[x] = interior && binary[(z - 1) * nx + x - 1] ? infinite : 0;
    }
    distanceTransform1D(source, width, target, vertices, boundaries);
    rowPass.set(target.subarray(0, width), z * width);
  }
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < height; z += 1) source[z] = rowPass[z * width + x];
    distanceTransform1D(source, height, target, vertices, boundaries);
    if (x === 0 || x > nx) continue;
    for (let z = 1; z <= nz; z += 1) {
      const index = (z - 1) * nx + x - 1;
      if (!binary[index]) continue;
      const inwardMeters = Math.sqrt(target[z]) * spacing;
      const encoded = Math.max(1, Math.round(
        Math.min(inwardMeters, CANOPY_DISTANCE_MAX_METERS)
          / CANOPY_DISTANCE_MAX_METERS * CANOPY_MASK_MAX,
      ));
      data[index] = (data[index] & GRASS_GROWABLE_BIT) | encoded;
    }
  }
}

export function bakeDenseCanopyMask(data, nx, nz, { minX, minZ, spacing }, placements = []) {
  if (!(data instanceof Uint8Array) || data.length !== nx * nz) {
    throw new Error('Dense canopy bake requires one byte per terrain texel.');
  }
  // The high bit may already carry caller-owned surface eligibility; the habitat
  // bake always replaces all seven distance bits so outside remains exact zero.
  for (let index = 0; index < data.length; index += 1) data[index] &= GRASS_GROWABLE_BIT;
  const primitives = deriveCanopyHabitatPrimitives(placements);
  if (!primitives.crowns.length && !primitives.masses.length) return data;
  const binary = new Uint8Array(nx * nz);
  rasterizeHabitatBinary(binary, nx, nz, { minX, minZ, spacing }, primitives);
  encodeInwardDistanceField(data, binary, nx, nz, spacing);
  return data;
}

export function createCanopyTexture(data, nx, nz) {
  const result = new DataTexture(data, nx, nz, RedFormat, UnsignedByteType);
  result.name = 'terrain-growable-canopy-r8';
  result.minFilter = result.magFilter = NearestFilter;
  result.generateMipmaps = false;
  result.needsUpdate = true;
  return result;
}

export function createCanopyDistanceTexture(data, nx, nz) {
  const result = new DataTexture(data, nx, nz, RedFormat, UnsignedByteType);
  result.name = 'terrain-canopy-distance-r8';
  result.minFilter = result.magFilter = LinearFilter;
  result.generateMipmaps = false;
  result.needsUpdate = true;
  return result;
}

// Grass has no knowledge of a trunk, so without this it sprouts straight through the
// flare and its surface roots. Clearing the growable bit inside each trunk footprint
// is the whole fix: it is quantized to the terrain grid, which is coarse for a crown
// but the right order of magnitude for a base a metre or so across.
export function clearTrunkFootprints(data, nx, nz, { minX, minZ, spacing }, placements = []) {
  if (!(data instanceof Uint8Array) || data.length !== nx * nz) {
    throw new Error('Trunk footprint clearing requires one byte per terrain texel.');
  }
  for (const placement of placements) {
    const radius = Number(placement?.flareRadius);
    if (!Number.isFinite(radius) || radius <= 0) continue;
    if (!Number.isFinite(placement.x) || !Number.isFinite(placement.z)) continue;
    const reach = Math.ceil(radius / spacing);
    const cx = (placement.x - minX) / spacing, cz = (placement.z - minZ) / spacing;
    const i0 = Math.max(0, Math.floor(cx) - reach), i1 = Math.min(nx - 1, Math.ceil(cx) + reach);
    const j0 = Math.max(0, Math.floor(cz) - reach), j1 = Math.min(nz - 1, Math.ceil(cz) + reach);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = (i - cx) * spacing, dz = (j - cz) * spacing;
        if (dx * dx + dz * dz > radius * radius) continue;
        data[j * nx + i] &= ~GRASS_GROWABLE_BIT;
      }
    }
  }
  return data;
}
