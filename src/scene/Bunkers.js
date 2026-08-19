import {
  Mesh, MeshStandardNodeMaterial, Group, BufferGeometry, BufferAttribute,
  TextureLoader, RepeatWrapping, SRGBColorSpace, NormalRGPacking,
} from 'three';
import { normalMap, texture, uv, vec2 } from 'three/tsl';
import { Noise } from '../util/noise.js';

const _tex = new TextureLoader();
const _edgeNoise = new Noise(11);

// ---------------------------------------------------------------------------
// Bunker sand overlay for the standalone asset viewer. Production Range rendering
// deliberately does not call this module's mesh builders: Terrain owns the gameplay
// sand surface so its geometry, zone mask, and material cannot diverge. This module
// mirrors src/scene/Trees.js's shape: a loader for the shared
// material/prototype, a pure per-instance builder that takes explicit params
// (no reach into a Range instance or course-global state), and a batch
// convenience for callers with a list of bunker specs.
//
// `terrain` is duck-typed, NOT required to be a real Terrain instance — anything
// exposing { heightAt(x,z), renderSpacing, bounds:{minX,minZ} } works, so the
// standalone asset viewer can hand this a small synthetic terrain patch instead
// of building a whole course.
// ---------------------------------------------------------------------------

// Radius of the visible sand (floor + wall face). Pot bunkers keep sand to the
// small flat floor (≈ rFloor in the engine's height-carve, see Range._height) so
// their steep turf walls rise revetted above it, rather than draping sand up a
// near-vertical face. Exported so callers (Range.js's terrain-zone spec, the
// terrain-carve math, the asset viewer) all agree on one definition of "how much
// of this bunker is sand".
export function bunkerSandRadius(b) {
  return b.pot ? b.r * 0.72 : b.r;
}

// Load the shared bunker-sand material template ONCE. Real bunker sand: pale,
// fine-grained, matte-to-faintly-sparkly, softly raked — see
// scripts/gen_bunker_sand.mjs for how the maps were generated (procedural, no
// baked lighting; shape lives in the normal map, occlusion in its own channel).
// This REPLACES the old sand_diff/sand_nor_gl/sand_rough.jpg binding, which was
// actually a coarse rocky-gravel/dry-dirt photo texture — it read as a quarry
// floor, not a maintained bunker.
let _matLoad = null;
let _matCache = null;   // set once _matLoad resolves, so a SYNCHRONOUS caller can check readiness
export function loadBunkerSandMaterial() {
  if (_matLoad) return _matLoad;
  _matLoad = (async () => {
    const [alb, nrao] = await Promise.all([
      _tex.loadAsync('/assets/textures/bunker_sand_alb.png'),
      _tex.loadAsync('/assets/textures/bunker_sand_nrao.png'),
    ]);
    alb.colorSpace = SRGBColorSpace;
    for (const t of [alb, nrao]) { t.wrapS = t.wrapT = RepeatWrapping; t.anisotropy = 8; }
    _matCache = { alb, nrao };
    return _matCache;
  })();
  return _matLoad;
}

// Build ONE bunker-sand material instance. `rep` is how many times the map tiles
// across the disc's full UV span (0..1 == the bunker's diameter). The repeat lives in
// the shader UV expression, so every bunker shares the same two immutable GPU images
// without cloning ~11 MiB of texture storage per bunker.
function makeSandMaterial({ alb, nrao }, rep) {
  const mat = new MeshStandardNodeMaterial({ metalness: 0.0 });
  const uvNode = uv().mul(rep);
  const albTex = texture(alb, uvNode);
  const naoTex = texture(nrao, uvNode);

  // R,G contain a packed tangent-space normal. NormalMapNode reconstructs Z,
  // applies the authored strength, and transforms through the surface TBN.
  // Assigning decoded texture channels directly to material.normalNode treats
  // them as view-space and produces camera-dependent black wedges.
  const sandNormal = normalMap(naoTex, vec2(0.8));
  sandNormal.unpackNormalMode = NormalRGPacking;

  mat.colorNode = albTex.rgb;
  mat.normalNode = sandNormal;
  mat.roughnessNode = naoTex.b.mul(0.9).add(0.08);   // matte base, sparkle grains dip low
  mat.aoNode = naoTex.a;
  return mat;
}

// Fixed-grid interpolation for the standalone asset-viewer overlay. Gameplay does
// not use this mesh: Range renders sand in Terrain's authoritative clipmap material,
// where geometry and shading cannot diverge as camera-centred LOD rings move. Do not
// reuse this approximation over the moving clipmap.
function fixedGridRenderHeight(terrain, x, z) {
  const s = terrain.renderSpacing;
  const { minX, minZ } = terrain.bounds;
  const fx = (x - minX) / s, fz = (z - minZ) / s;
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const gx0 = minX + i * s, gx1 = gx0 + s;
  const gz0 = minZ + j * s, gz1 = gz0 + s;
  const h00 = terrain.heightAt(gx0, gz0), h10 = terrain.heightAt(gx1, gz0);
  const h01 = terrain.heightAt(gx0, gz1), h11 = terrain.heightAt(gx1, gz1);
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  const u = 1 - tx, v = 1 - tz;
  return h11 + (h01 - h11) * u + (h10 - h11) * v;
}

// A flat-in-plan disc whose vertices are pinned to the terrain height, so the
// sand hugs the carved bunker bowl. Built as a CONCENTRIC-RING polar grid rather
// than a single-center-vertex fan: a fan makes every floor triangle share the
// one center vertex, so draped over a bowl that vertex's averaged normal
// pinwheels into a radial star artifact. Multiple rings distribute vertices
// across the radius for smooth, well-behaved normals that follow the bowl.
// `jitter` roughens only the OUTER rings into a natural, irregular sand edge
// while the interior stays smooth.
function conformingDisc(terrain, cx, cz, r, yOffset, { radial = 96, rings = 20, jitter = 0 } = {}) {
  const pos = [cx, 0, cz];
  const uvArr = [0.5, 0.5];
  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    for (let a = 0; a < radial; a++) {
      const ang = (a / radial) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const j = jitter > 0 ? jitter * t * _edgeNoise.noise2(ca * 2.5, sa * 2.5) : 0;
      const rad = r * t * (1 + j);
      pos.push(cx + ca * rad, 0, cz + sa * rad);
      uvArr.push(ca * t * 0.5 + 0.5, sa * t * 0.5 + 0.5);
    }
  }
  const idx = [];
  for (let a = 0; a < radial; a++) {
    const a2 = (a + 1) % radial;
    idx.push(0, 1 + a2, 1 + a);
  }
  for (let ri = 1; ri < rings; ri++) {
    const b0 = 1 + (ri - 1) * radial, b1 = 1 + ri * radial;
    for (let a = 0; a < radial; a++) {
      const a2 = (a + 1) % radial;
      idx.push(b0 + a, b1 + a2, b1 + a, b0 + a, b0 + a2, b1 + a2);
    }
  }
  const p = new Float32Array(pos);
  // Small safety margin over the asset viewer's fixed-grid surface.
  for (let i = 0; i < p.length; i += 3) {
    p[i + 1] = fixedGridRenderHeight(terrain, p[i], p[i + 2]) + yOffset;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(p, 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvArr), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Core mesh builder — needs the sand textures ALREADY loaded. `spec` is plain
// data — {x, z, r, pot} — and `terrain` only needs heightAt/renderSpacing/
// bounds, so this composes with a real course Terrain OR a small synthetic
// patch (the standalone asset viewer's use case). Internal: public callers go
// through buildBunkerMesh/buildBunker/buildBunkers below, which all guarantee
// the textures are ready before this runs.
function buildBunkerMeshSync(spec, terrain, sandTextures, opts = {}) {
  const { yOffset = 0.035, radial = 96, rings } = opts;
  const sandR = bunkerSandRadius(spec);
  // Small pot bunkers need proportionally more rings because their wall band can
  // be narrower than one fixed-grid render cell.
  const ringCount = rings || Math.max(20, Math.ceil(sandR * 4));
  const rep = spec.r / 2.6;
  const mat = makeSandMaterial(sandTextures, rep);
  const geo = conformingDisc(terrain, spec.x, spec.z, sandR, yOffset, { radial, rings: ringCount, jitter: 0.08 });
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'bunker';
  return mesh;
}

// PUBLIC, single-object signature. Required sand maps are resolved before a mesh is
// returned; callers must await this function. Rendering a temporary flat material is
// an alternate asset path and is intentionally not supported.
export async function buildBunkerMesh({ terrain, x, z, r, depth = 1.0, pot = false, ...opts }) {
  const spec = { x, z, r, depth, pot };
  const material = _matCache || await loadBunkerSandMaterial();
  return buildBunkerMeshSync(spec, terrain, material, opts);
}

// Batch convenience for a full course: load the shared textures once, build one
// mesh per bunker spec (no placeholder flash — this awaits first), return a
// Group ready to add to the scene. This is what Range.js calls.
export async function buildBunkers(specs, terrain, opts = {}) {
  const sandTextures = await loadBunkerSandMaterial();
  const group = new Group();
  group.name = 'bunkers';
  for (const b of specs) group.add(buildBunkerMeshSync(b, terrain, sandTextures, opts));
  return group;
}

// Single-bunker ASYNC convenience: one merged options object carrying `terrain`
// plus the bunker's own params, awaits the real textures (no placeholder), and
// returns { mesh }. For callers that CAN await — buildBunkerMesh above is the
// one to use from a synchronous call site.
export async function buildBunker({ terrain, x, z, r, depth = 1.0, pot = false, ...opts }) {
  const mesh = await buildBunkerMesh({ terrain, x, z, r, depth, pot, ...opts });
  return { mesh };
}
