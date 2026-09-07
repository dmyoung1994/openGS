import {
  DataTexture, DataArrayTexture, RGBAFormat, HalfFloatType, LinearFilter,
  ClampToEdgeWrapping, DataUtils,
} from 'three';
import { Noise } from '../util/noise.js';
import { compileRouteCorridor, routeCorridorSignedDistance } from '../course/RouteGeometry.js';

// Baked SIGNED DISTANCE FIELD of the course's turf zones.
//
// WHY A DISTANCE FIELD AND NOT AN ID / GREY-LEVEL MAP
// The obvious encoding is one grey level per surface. It doesn't work: with linear
// filtering a fairway texel (say 0.4) next to a rough texel (0.6) interpolates to 0.5,
// which decodes as whatever surface happens to live at 0.5 — a ring of wrong surface
// along every boundary. NEAREST filtering avoids that but gives stair-stepped square
// edges, which is exactly what the analytic classification existed to prevent.
// Distances, by contrast, interpolate CORRECTLY: the midpoint of two distances is the
// distance of the midpoint. So a coarse SDF still reconstructs a razor-smooth curved
// edge under bilinear filtering — the same reason SDF text stays crisp when magnified.
//
// WHY IT'S WORTH BAKING AT ALL
// Not really the noise. The analytic path loops over EVERY green and EVERY bunker for
// every pixel on screen, so its cost grows with how elaborate the course is (this
// course is already 6 greens + 5 bunkers = 11 circle tests per pixel per frame). One
// texture fetch makes that O(1) no matter how big the course gets, which matters far
// more for the course-builder direction than shaving a few noise evaluations.
//
// PRIMARY CHANNELS (metres, POSITIVE INSIDE): R fairway, G green, B sand, A tee.
// AUXILIARY CHANNELS: R per-route rough, G per-green fringe. The auxiliary field is
// required because a shared site can vary rough and collar widths per hole.
//
// Stored as RGBA16F: half floats are linearly filterable in WebGPU without requesting
// any optional feature, and 8-bit can't work here — the rough band sits 26 m from the
// fairway edge, so the channel has to carry tens of metres AND stay accurate to well
// under the 0.16 m edge-softening width. That's far more range than 256 levels allow.
const TEXELS_PER_M = 2;

// Signed distance to a box, positive inside.
function boxSD(px, pz, hx, z0, z1) {
  const cz = (z0 + z1) / 2, hz = (z1 - z0) / 2;
  const dx = hx - Math.abs(px);
  const dz = hz - Math.abs(pz - cz);
  if (dx > 0 && dz > 0) return Math.min(dx, dz);            // inside
  return -Math.hypot(Math.max(-dx, 0), Math.max(-dz, 0));   // outside
}

export function buildZoneMap(zones, bounds) {
  return createZoneMapTextures(bakeZoneMap(zones, bounds));
}

// CPU-only rasterization; workers transfer these exact authored samples back.
export function bakeZoneMap(zones, bounds) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const w = Math.max(2, Math.round((maxX - minX) * TEXELS_PER_M));
  const h = Math.max(2, Math.round((maxZ - minZ) * TEXELS_PER_M));
  const layerLength = w * h * 4;
  const layerData = new Uint16Array(layerLength * 3);
  const data = layerData.subarray(0, layerLength);
  const auxData = layerData.subarray(layerLength, layerLength * 2);
  const greens = zones.greens || [];
  const sands = zones.sands || [];
  const waters = zones.waters || [];
  // A polygon's distance from a point is never smaller than the point's
  // distance from that polygon's axis-aligned bounds.  Keep this conservative
  // broad phase beside each authored feature so the exact SDF only runs when it
  // can still improve the nearest edge. This preserves every baked value while
  // avoiding millions of obviously-losing segment walks during range startup.
  const greenEntries = greens.map((feature) => compileFeature(feature));
  const sandEntries = sands.map((feature) => compileFeature(feature));
  const waterEntries = waters.map((feature) => compileFeature(feature));
  const forestFloorEntries = (zones.forestFloors ?? []).map((feature) => compileFeature(feature));
  const teeEntries = (zones.tees ?? []).map((feature) => compileFeature(feature));
  const legacyTee = zones.tee ?? null;
  const routeEntries = (zones.routes ?? []).map((route) => compileRouteCorridor(route));
  // Water remains outside the four turf shader channels, but this companion SDF
  // keeps minimap and diagnostics on the same authored outline as the pond mesh.
  // Keep the CPU copy for minimap/diagnostic classification, but expose the same
  // authored field to the terrain shader as one compact, linearly-filterable RGBA16F
  // texture. The companion channels carry deterministic bank signals baked once on
  // the CPU, so the fragment shader pays one filtered lookup and no bank-specific
  // noise evaluations across the whole terrain.
  const water = new Float32Array(w * h);
  const potOuter = new Float32Array(w * h);
  const potOuterData = new Uint16Array(w * h);
  const waterData = layerData.subarray(layerLength * 2);
  const bankNoise = new Noise(0x6b616e6b);

  for (let j = 0; j < h; j++) {
    // Sample at texel CENTRES so the field is symmetric about the map's edges.
    const wz = minZ + (j + 0.5) / TEXELS_PER_M;
    for (let i = 0; i < w; i++) {
      const wx = minX + (i + 0.5) / TEXELS_PER_M;
      // Use the authored coordinates exactly. Physics/collision, bunker carving,
      // minimap classification, turf shading, and grass transitions must describe the
      // same boundary; an independent visual warp made sand spill outside its bowl.
      const dwx = wx;
      const dwz = wz;

      // Shared-site routes are finite swept centerlines. Legacy schema-v3 courses
      // retain their exact origin-aligned analytic corridor.
      let corridor = -Infinity;
      let rough = -Infinity;
      if (routeEntries.length) {
        for (const route of routeEntries) {
          const distance = routeCorridorSignedDistance(route, dwx, dwz);
          corridor = Math.max(corridor, distance);
          rough = Math.max(rough, distance + route.rough);
        }
      } else {
        const half = zones.corridor.c0 + (-dwz) * zones.corridor.k;
        corridor = half - Math.abs(dwx);
        rough = corridor + zones.corridor.rough;
      }

      // Nearest green / bunker: max of (r - distance) picks the one we're deepest in,
      // and outside everything it degrades to the distance to the closest edge.
      let green = -Infinity;
      let fringe = -Infinity;
      for (const entry of greenEntries) {
        if (canImproveNearest(green, entry.bounds, dwx, dwz)) {
          const distance = compiledSignedDistance(entry, dwx, dwz);
          green = Math.max(green, distance);
          fringe = Math.max(fringe, distance + (entry.feature.fringeWidth ?? zones.fringeW));
        }
      }
      let sand = -Infinity;
      let potOuterSD = -Infinity;
      for (const entry of sandEntries) {
        if (canImproveNearest(sand, entry.bounds, dwx, dwz)
          || (entry.feature.pot && canImproveNearest(potOuterSD, entry.bounds, dwx, dwz))) {
          const s = entry.feature;
          const outerDistance = compiledSignedDistance(entry, dwx, dwz);
          sand = Math.max(sand, outerDistance - (s.inset || 0));
          if (s.pot) potOuterSD = Math.max(potOuterSD, outerDistance);
        }
      }
      let waterSD = -Infinity;
      for (const entry of waterEntries) {
        if (canImproveNearest(waterSD, entry.bounds, dwx, dwz)) {
          waterSD = Math.max(waterSD, compiledSignedDistance(entry, dwx, dwz));
        }
      }
      if (green === -Infinity) green = -1e3;
      if (fringe === -Infinity) fringe = -1e3;
      if (sand === -Infinity) sand = -1e3;
      if (potOuterSD === -Infinity) potOuterSD = -1e3;
      if (waterSD === -Infinity) waterSD = -1e3;
      let forestFloorSD = -Infinity;
      for (const entry of forestFloorEntries) {
        if (canImproveNearest(forestFloorSD, entry.bounds, dwx, dwz)) {
          forestFloorSD = Math.max(forestFloorSD, compiledSignedDistance(entry, dwx, dwz));
        }
      }
      if (forestFloorSD === -Infinity) forestFloorSD = -1e3;

      let teeSD = -Infinity;
      for (const entry of teeEntries) teeSD = Math.max(teeSD, compiledSignedDistance(entry, dwx, dwz));
      if (legacyTee) teeSD = Math.max(teeSD, boxSD(dwx, dwz, legacyTee.x, legacyTee.z0, legacyTee.z1));
      if (teeSD === -Infinity) teeSD = -1e3;

      // Clamped to a band that comfortably covers every boundary offset in use
      // (the widest is the 26 m rough band) while keeping half-float precision high.
      const k = (j * w + i) * 4;
      data[k] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, corridor)));
      data[k + 1] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, green)));
      data[k + 2] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, sand)));
      data[k + 3] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, teeSD)));
      auxData[k] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, rough)));
      auxData[k + 1] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, fringe)));
      auxData[k + 2] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, forestFloorSD)));
      auxData[k + 3] = DataUtils.toHalfFloat(0);
      water[j * w + i] = waterSD;
      potOuter[j * w + i] = potOuterSD;
      potOuterData[j * w + i] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, potOuterSD)));
      const bankWidthNoise = bankNoise.noise2(wx * 0.082, dwz * 0.057) * 0.5 + 0.5;
      const broadMottle = bankNoise.noise2(wx * 0.30, dwz * 0.30) * 0.5 + 0.5;
      const mineralPatch = bankNoise.noise2(wx * 1.22, dwz * 1.22) * 0.5 + 0.5;
      const wk = (j * w + i) * 4;
      waterData[wk] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, waterSD)));
      // Keep broad wash and exposed mineral patches in one filtered channel. The
      // 0.5m bake cannot represent literal 6–12cm pebbles; the turf detail atlas
      // supplies that final micro-scale variation in the material below.
      waterData[wk + 1] = DataUtils.toHalfFloat(Math.max(0, Math.min(1, bankWidthNoise)));
      waterData[wk + 2] = DataUtils.toHalfFloat(Math.max(0, Math.min(1, broadMottle * 0.70 + mineralPatch * 0.30)));
      // A is the pot-bunker outer SDF. Folding it into this already-sampled zone
      // companion retires a whole fragment sampler while preserving the exact
      // analytic patch authority and half-float distance precision.
      waterData[wk + 3] = DataUtils.toHalfFloat(Math.max(-60, Math.min(60, potOuterSD)));
    }
  }

  return { width: w, height: h, layerData, data, auxData, water, waterData, potOuter, potOuterData,
    bounds, texelsPerM: TEXELS_PER_M };
}

export function createZoneMapTextures(packed) {
  const { data, auxData, waterData, width: w, height: h } = packed;
  const arrayTexture = new DataArrayTexture(packed.layerData, w, h, 3);
  arrayTexture.name = 'terrain-zone-sdf-array';
  arrayTexture.format = RGBAFormat;
  arrayTexture.type = HalfFloatType;
  arrayTexture.minFilter = arrayTexture.magFilter = LinearFilter;
  arrayTexture.wrapS = arrayTexture.wrapT = ClampToEdgeWrapping;
  arrayTexture.generateMipmaps = false;
  arrayTexture.needsUpdate = true;
  const tex = new DataTexture(data, w, h, RGBAFormat, HalfFloatType);
  tex.name = 'terrain-zone-sdf';
  tex.minFilter = tex.magFilter = LinearFilter;   // linear is the whole point — see above
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const waterTexture = new DataTexture(waterData, w, h, RGBAFormat, HalfFloatType);
  waterTexture.name = 'terrain-water-bank-sdf-rgba16f';
  waterTexture.minFilter = waterTexture.magFilter = LinearFilter;
  waterTexture.wrapS = waterTexture.wrapT = ClampToEdgeWrapping;
  waterTexture.generateMipmaps = false;
  waterTexture.needsUpdate = true;

  const auxTexture = new DataTexture(auxData, w, h, RGBAFormat, HalfFloatType);
  auxTexture.name = 'terrain-zone-aux-sdf';
  auxTexture.minFilter = auxTexture.magFilter = LinearFilter;
  auxTexture.wrapS = auxTexture.wrapT = ClampToEdgeWrapping;
  auxTexture.generateMipmaps = false;
  auxTexture.needsUpdate = true;

  return {
    ...packed, arrayTexture, texture: tex, auxTexture, waterTexture,
  };
}

function featureBounds(feature) {
  let minX = Number.isFinite(feature.r) ? feature.x - feature.r : Infinity;
  let maxX = Number.isFinite(feature.r) ? feature.x + feature.r : -Infinity;
  let minZ = Number.isFinite(feature.r) ? feature.z - feature.r : Infinity;
  let maxZ = Number.isFinite(feature.r) ? feature.z + feature.r : -Infinity;
  for (const point of feature.shape || []) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function compileFeature(feature) {
  const points = feature.shape || null;
  const edges = points ? points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    return { a, b, dx, dz, denominator: dx * dx + dz * dz };
  }) : null;
  return { feature, bounds: featureBounds(feature), edges };
}

function compiledSignedDistance(entry, x, z) {
  const { feature, edges } = entry;
  if (!edges) return feature.r - Math.hypot(x - feature.x, z - feature.z);
  let minDistanceSq = Infinity;
  let inside = false;
  for (const edge of edges) {
    const { a, b, dx, dz, denominator } = edge;
    const t = denominator > 0
      ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / denominator))
      : 0;
    const qx = a.x + dx * t;
    const qz = a.z + dz * t;
    const distanceSq = (x - qx) ** 2 + (z - qz) ** 2;
    if (distanceSq < minDistanceSq) minDistanceSq = distanceSq;
    if (((a.z > z) !== (b.z > z)) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  const distance = Math.sqrt(minDistanceSq);
  return inside ? distance : -distance;
}

function canImproveNearest(current, bounds, x, z) {
  const inside = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  if (inside || current === -Infinity) return true;
  const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
  const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
  // Outside the bounds, the exact signed distance is at most -bboxDistance.
  // Ties are retained so the authored order remains bit-for-bit stable where
  // two conservative bounds meet.
  return -Math.hypot(dx, dz) >= current;
}

// Decode a baked texel to a surface name. Used by the minimap; the ORDER matches the
// shader's compositing order so the two can't disagree about what's on top.
export function zoneAt(map, i, j, zones) {
  const k = (j * map.width + i) * 4;
  if (map.water && map.water[j * map.width + i] > 0) return 'water';
  const f = DataUtils.fromHalfFloat(map.data[k]);
  const g = DataUtils.fromHalfFloat(map.data[k + 1]);
  const s = DataUtils.fromHalfFloat(map.data[k + 2]);
  const t = DataUtils.fromHalfFloat(map.data[k + 3]);
  const rough = map.auxData ? DataUtils.fromHalfFloat(map.auxData[k]) : f + zones.corridor.rough;
  const fringe = map.auxData ? DataUtils.fromHalfFloat(map.auxData[k + 1]) : g + zones.fringeW;
  if (t > 0) return 'tee';
  if (s > 0) return 'sand';
  if (g > 0) return 'green';
  if (fringe > 0) return 'fringe';
  if (f > 0) return 'fairway';
  if (rough > 0) return 'rough';
  return 'deepRough';
}
