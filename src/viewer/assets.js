import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { buildBunkerMesh } from '../scene/Bunkers.js';
import { createGolfBallMesh } from '../scene/GolfBall.js';
import { loadTreePrototype, loadTreeImpostor, buildTreeBeautyLod } from '../scene/Trees.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const viewerGltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
import { WaterSurface } from '../scene/WaterSurface.js';

// Asset registry for the isolated viewer (viewer.html).
//
// The point of this file is that each entry builds its subject through the REAL
// production code path — the same Terrain material, the same Grass system, the same
// modules Range.js uses. A viewer that reimplements the shading would let the two
// drift and you'd tune against a lie. So the only thing synthesised here is the
// minimum surrounding context an asset needs to exist at all.
//
// For turf, that context is a `zones` spec. The terrain shader classifies every
// pixel analytically from those zones (corridor -> rough band -> deep rough, with
// greens/bunkers/tee as overrides), so to view ONE surface in isolation we hand it a
// degenerate zone spec that classifies the whole patch as that surface. The patch is
// also parked far off the origin in X, because the corridor is centred on x = 0 and a
// patch straddling it would show a strip of fairway down the middle.

const PATCH = 44;          // metres square — big enough to judge the distance fade
const PATCH_X = 600;       // parked away from the corridor centreline at x = 0

// A gentle swell rather than a dead-flat plane: a flat plane hides how the material
// behaves across grazing angles and self-shadowing, which is usually the thing you're
// actually trying to judge.
function swell(x, z) {
  return Math.sin(x * 0.09) * 0.35 + Math.cos(z * 0.07) * 0.28;
}

// Zone specs that force the entire patch to classify as a single surface.
const ZONES = {
  // Corridor half-width huge => everything is inside the fairway.
  fairway: () => ({
    greens: [], sands: [], fringeW: 3,
    corridor: { c0: 100000, k: 0, rough: 40 },
    tee: { x: -1, z0: 1, z1: 0 },       // degenerate: never matches
  }),
  // Corridor collapsed to nothing but a very wide rough band => all rough.
  rough: () => ({
    greens: [], sands: [], fringeW: 3,
    corridor: { c0: 0, k: 0, rough: 100000 },
    tee: { x: -1, z0: 1, z1: 0 },
  }),
  // Neither corridor nor rough band reaches the patch => deep rough.
  deepRough: () => ({
    greens: [], sands: [], fringeW: 3,
    corridor: { c0: 0, k: 0, rough: 1 },
    tee: { x: -1, z0: 1, z1: 0 },
  }),
  // One oversized green centred on the patch.
  green: (cx, cz) => ({
    greens: [{ x: cx, z: cz, r: PATCH }], sands: [], fringeW: 3,
    corridor: { c0: 0, k: 0, rough: 1 },
    tee: { x: -1, z0: 1, z1: 0 },
  }),
  // A green whose radius sits inside the patch, so you can inspect the collar edge.
  fringe: (cx, cz) => ({
    greens: [{ x: cx, z: cz, r: PATCH * 0.28 }], sands: [], fringeW: 3.5,
    corridor: { c0: 100000, k: 0, rough: 40 },
    tee: { x: -1, z0: 1, z1: 0 },
  }),
  // A sand circle inside a fairway, i.e. a bunker in its natural surround.
  bunker: (cx, cz) => ({
    greens: [], sands: [{ x: cx, z: cz, r: PATCH * 0.22 }], fringeW: 3,
    corridor: { c0: 100000, k: 0, rough: 40 },
    tee: { x: -1, z0: 1, z1: 0 },
  }),
};

// Build a turf patch of one surface kind. `withGrass` adds the 3D blade system, which
// only has geometry on rough/deepRough — on mown surfaces it renders nothing, so it's
// off by default to keep the mown views cheap.
function turfPatch(kind, { withGrass = false, camera, renderer, motionHistory, environmentTier, environment } = {}) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const zones = ZONES[kind](cx, cz);

  // surfaceFn drives PHYSICS/gameplay classification and the Grass system's blade
  // heights; the shader uses `zones`. Both must agree or the blades won't match the
  // ground they stand in, so this mirrors the zone spec rather than guessing.
  const surfaceFn = (x, z) => {
    if (kind === 'bunker') {
      return Math.hypot(x - cx, z - cz) < PATCH * 0.22 ? 'sand' : 'fairway';
    }
    if (kind === 'fringe') {
      const d = Math.hypot(x - cx, z - cz);
      if (d < PATCH * 0.28) return 'green';
      if (d < PATCH * 0.28 + 3.5) return 'fringe';
      return 'fairway';
    }
    return kind;
  };

  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6,
    renderSpacing: 0.6,
    heightFn: swell,
    surfaceFn,
    zones,
    // Terrain's production material owns the GPU-authored macro/zone fields and
    // therefore requires the live WebGPU renderer in the isolated lab too.
    renderer,
  });

  const out = { terrain, objects: [terrain.mesh], focus: { x: cx, z: cz }, grass: null };
  if (withGrass) {
    if (!environmentTier?.grassRadius) throw new Error('Asset viewer grass requires the resolved environment device tier.');
    out.grass = new Grass({ terrain, camera, renderer, motionHistory, environment, radius: environmentTier.grassRadius });
    out.objects.push(out.grass.mesh);
  }
  return out;
}

// Isolated production fir subject. The viewer intentionally uses the same GPU
// classifier as Range, with one catalog record and a real terrain contact. This
// makes close/mid/far residency diagnosable without the course's other foliage
// obscuring the silhouette. `scripts/shot.mjs --cam/--look` controls exact poses.
async function firTreePatch({ camera, renderer, motionHistory, environment, treePrefix = 'fir_tree_01', impostorFile = 'fir_sapling_medium_impostor.png', impostorUrl = null, prototypeBase = null, targetHeight = 18.895 }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6,
    renderSpacing: 0.6,
    heightFn: swell,
    surfaceFn: () => 'fairway',
    zones: ZONES.fairway(),
    motionHistory,
    renderer,
  });
  const prototypeRoot = prototypeBase || `/assets/trees/${treePrefix}`;
  const proto = await loadTreePrototype(`${prototypeRoot}_lod0.glb`);
  const midProto = await loadTreePrototype(`${prototypeRoot}_lod1.glb`);
  const impostor = {
    kind: 'baked-atlas',
    url: impostorUrl || `/assets/trees/${impostorFile}`,
    columns: 4, rows: 2, frameSize: 512, azimuthFrames: 8,
  };
  const impostorTexture = await loadTreeImpostor(impostor);
  const baseY = terrain.heightAt(cx, cz);
  const treeBeauty = buildTreeBeautyLod(proto, midProto, impostor, impostorTexture, [{
    x: cx, z: cz, y: baseY, rotY: 0, targetHeight,
  }], {
    renderer, camera, motionHistory, environment,
    seed: 0x51a7e5d,
    lodNear: 12,
    lodFar: 20,
  });
  // The TreeBeauty group stays at the world origin: placements exist only in GPU
  // buffers, so a node-hierarchy bbox would frame the origin, not the tree. The
  // builder knows the placement and hands the viewer its world bounds directly.
  return {
    terrain,
    objects: [terrain.mesh, treeBeauty.group],
    focus: { x: cx, z: cz },
    treeBeauty,
    frameBounds: {
      center: [cx, baseY + targetHeight / 2, cz],
      size: [targetHeight * 0.6, targetHeight, targetHeight * 0.6],
    },
  };
}

// Candidate-only source-faithful viewer path. This deliberately bypasses the
// production TreeBeauty classifier so the authored GLB's PBR materials and full
// twig-card silhouette can be judged directly under the same SceneManager,
// Lighting, atmosphere, and terrain contact as every other viewer asset. It is
// not imported by Range/Trees and has no catalog/course dependency.
async function firTreeSourceCandidatePatch({ renderer, lod = 0 }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer,
  });
  const gltf = await viewerGltfLoader.loadAsync(
    `/assets/trees_candidates/fir_tree_01/fir_tree_01_source_candidate_lod${lod}.glb`,
  );
  const subject = gltf.scene;
  subject.position.set(cx, terrain.heightAt(cx, cz), cz);
  subject.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material?.name !== 'fir_source_twig_authored_alpha') continue;
        // Runtime foliage must be an opaque masked surface, not sorted BLEND.
        // Keep a low cutoff so the authored needle tips survive while depth,
        // shadows, and viewer cost remain representative of production.
        material.transparent = false;
        material.alphaTest = 0.12;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
    }
  });
  // The viewer's subject-mask and diagnostics APIs are treeBeauty-shaped by
  // contract; the wrapper owns no extra GPU object and simply exposes this GLTF
  // scene as the isolated subject.
  const treeBeauty = {
    group: subject,
    update() {},
    residencyEstimate() {
      return {
        candidateOnly: true,
        lod,
        uploadVertices: lod === 0 ? 112264 : 25360,
        renderVertices: lod === 0 ? 434988 : 68823,
        triangles: lod === 0 ? 144996 : 22941,
        materialPrimitives: 4,
        twigAlphaTest: 0.12,
      };
    },
    readDiagnostics() { return this.residencyEstimate(); },
    dispose() {},
  };
  return { terrain, objects: [terrain.mesh, subject], focus: { x: cx, z: cz }, treeBeauty };
}

// Candidate-only v4 viewer path.  This is deliberately a direct GLTF subject:
// it exercises the authored masked PBR atlas and scaffold without importing the
// production tree residency/catalog path.  The candidate is CPU-baked and is
// not referenced by Range/Trees/course assets.
async function coniferV4CandidatePatch({ renderer, lod = 0 }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer,
  });
  const gltf = await viewerGltfLoader.loadAsync(
    `/assets/trees_candidates/conifer_v4/conifer_v4_lod${lod}.glb`,
  );
  const subject = gltf.scene;
  subject.position.set(cx, terrain.heightAt(cx, cz), cz);
  subject.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.transparent = false;
      material.alphaTest = 0.06;
      material.depthWrite = true;
      material.needsUpdate = true;
    }
  });
  const renderVertices = lod === 0 ? 116652 : 62172;
  const triangles = lod === 0 ? 38884 : 20724;
  const treeBeauty = {
    group: subject,
    update() {},
    residencyEstimate() {
      return { candidateOnly: true, lod, renderVertices, triangles,
        materialPrimitives: 1, twigAlphaTest: 0.06, height: 18.895 };
    },
    readDiagnostics() { return this.residencyEstimate(); },
    dispose() {},
  };
  return { terrain, objects: [terrain.mesh, subject], focus: { x: cx, z: cz }, treeBeauty };
}

async function sourceTreePatch({ renderer }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer,
  });
  const gltf = await viewerGltfLoader.loadAsync('/assets/trees/tree_small_02_lod0.glb');
  gltf.scene.position.set(cx, terrain.heightAt(cx, cz), cz);
  gltf.scene.scale.setScalar(2.6);
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { terrain, objects: [terrain.mesh, gltf.scene], focus: { x: cx, z: cz } };
}

async function pineSourcePatch({ renderer }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({ bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH }, spacing: 0.6, renderSpacing: 0.6, heightFn: swell, surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer });
  const gltf = await viewerGltfLoader.loadAsync('/assets/trees/pine_tree_01_lod0.glb');
  gltf.scene.position.set(cx, terrain.heightAt(cx, cz), cz);
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { terrain, objects: [terrain.mesh, gltf.scene], focus: { x: cx, z: cz } };
}

async function pineTreePatch({ camera, renderer, motionHistory, environment }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), motionHistory, renderer,
  });
  const proto = await loadTreePrototype('/assets/trees/pine_tree_01_lod1.glb');
  const midProto = await loadTreePrototype('/assets/trees/pine_tree_01_lod1.glb');
  const impostor = { kind: 'baked-atlas', url: '/assets/trees/pine_tree_01_impostor.png', columns: 4, rows: 2, frameSize: 512, azimuthFrames: 8 };
  const impostorTexture = await loadTreeImpostor(impostor);
  const baseY = terrain.heightAt(cx, cz);
  const targetHeight = 14.85;
  const treeBeauty = buildTreeBeautyLod(proto, midProto, impostor, impostorTexture, [{
    x: cx, z: cz, y: baseY, rotY: 0, targetHeight,
  }], { renderer, camera, motionHistory, environment, seed: 0x51a7e5d, lodNear: 12, lodFar: 20 });
  // See the frameBounds note in firTreePatch: GPU-placed trees expose no CPU bbox.
  return {
    terrain, objects: [terrain.mesh, treeBeauty.group], focus: { x: cx, z: cz }, treeBeauty,
    frameBounds: {
      center: [cx, baseY + targetHeight / 2, cz],
      size: [targetHeight * 0.6, targetHeight, targetHeight * 0.6],
    },
  };
}

// A production-path pond lab.  The basin uses the same dished profile and water
// level relationship as Range, while leaving enough surrounding bank in frame to
// judge the part that usually gives cheap water away: the shoreline contact.
function pondPatch({ renderer, motionHistory, environment }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const pond = { x: cx, z: cz, r: 10.5, depth: 1.6 };
  const heightFn = (x, z) => {
    const base = swell(x, z);
    const d = Math.hypot(x - cx, z - cz);
    const dish = pond.depth * Math.max(0, 1 - (d / (pond.r + 2)) ** 2);
    return base - dish;
  };
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6,
    renderSpacing: 0.6,
    heightFn,
    surfaceFn: (x, z) => Math.hypot(x - cx, z - cz) < pond.r ? 'water' : 'deepRough',
    zones: ZONES.deepRough(),
    motionHistory,
    renderer,
  });
  const level = terrain.heightAt(cx, cz) + pond.depth * 0.55;
  const water = new WaterSurface({ environment, pond, level });
  return {
    terrain,
    objects: [terrain.mesh, water.mesh],
    focus: { x: cx, z: cz },
    focusY: level,
    water,
  };
}

// Turf is judged at play distance, so it opts out of the viewer's automatic subject
// fit (see frame() in main.js) and keeps the standing eye pose.
function standingTurf(kind, opts = {}) {
  return (ctx) => {
    const patch = turfPatch(kind, { ...ctx, ...opts });
    patch.standingView = true;
    return patch;
  };
}

export const ASSETS = {
  'tree: fir LOD lab': (ctx) => firTreePatch(ctx),
  'tree candidate: source PBR LOD0': (ctx) => firTreeSourceCandidatePatch({ ...ctx, lod: 0 }),
  'tree candidate: source PBR LOD1': (ctx) => firTreeSourceCandidatePatch({ ...ctx, lod: 1 }),
  'tree candidate: conifer v4 LOD0': (ctx) => coniferV4CandidatePatch({ ...ctx, lod: 0 }),
  'tree candidate: conifer v4 LOD1': (ctx) => coniferV4CandidatePatch({ ...ctx, lod: 1 }),
  'tree candidate: conifer v4 TreeBeauty': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'conifer_v4',
    prototypeBase: '/assets/trees_candidates/conifer_v4/conifer_v4',
    // Deliberately reuse an existing runtime-lit atlas only as the far-band
    // placeholder; this entry never promotes v4 into the production catalog.
    impostorFile: 'conifer_v3_impostor.png',
  }),
  'tree candidate: conifer v5 TreeBeauty': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'conifer_v5',
    prototypeBase: '/assets/trees_candidates/conifer_v5/conifer_v5',
    impostorUrl: '/assets/trees_candidates/conifer_v5/conifer_v5_impostor.png',
  }),
  'tree candidate: conifer v6 TreeBeauty': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'conifer_v6',
    prototypeBase: '/assets/trees_candidates/conifer_v6/conifer_v6',
    impostorUrl: '/assets/trees_candidates/conifer_v6/conifer_v6_impostor.png',
  }),
  'tree candidate: conifer v7 TreeBeauty': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'conifer_v7',
    prototypeBase: '/assets/trees_candidates/conifer_v7/conifer_v7',
    impostorUrl: '/assets/trees_candidates/conifer_v7/conifer_v7_impostor.png',
  }),
  'tree candidate: conifer v8 TreeBeauty': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'conifer_v8',
    prototypeBase: '/assets/trees_candidates/conifer_v8/conifer_v8',
    impostorUrl: '/assets/trees_candidates/conifer_v8/conifer_v8_impostor.png',
  }),
  'tree: conifer volume v2': (ctx) => firTreePatch({ ...ctx, treePrefix: 'conifer_volume_v2', impostorFile: 'conifer_volume_v2_impostor.png' }),
  'tree: conifer v3 branchlets': (ctx) => firTreePatch({ ...ctx, treePrefix: 'conifer_v3', impostorFile: 'conifer_v3_impostor.png' }),
  'tree: pine sapling canonical': (ctx) => firTreePatch({ ...ctx, treePrefix: 'pine_sapling_medium_canonical', impostorFile: 'pine_sapling_medium_canonical_impostor.png' }),
  'tree: pine LOD comparator': (ctx) => pineTreePatch(ctx),
  'tree: pine canonical': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'pine_tree_01_canonical',
    impostorFile: 'pine_tree_01_impostor.png',
    targetHeight: 14.85,
  }),
  // Production role-split species: trunk / branches / foliage stay separate
  // primitives so each keeps its own baked tile at authored resolution and
  // tiling. This is the multi-part TreeBeautyLod path; a combined one-part
  // prototype is its partCount === 1 case.
  'tree: blendkit grand fir (role-split)': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'bk_grand_fir',
    impostorFile: 'bk_grand_fir_impostor.png',
    targetHeight: 8.109,
  }),
  // 29 m Scots pine: an open, high crown whose canopy is a realized
  // geometry-nodes scatter thinned to budget rather than decimated.
  'tree: blendkit scots pine (role-split)': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'bk_scots_pine',
    impostorFile: 'bk_scots_pine_impostor.png',
    targetHeight: 29.367,
  }),
  // Autumn accent candidate. Its foliage colour bake writes nothing, so the
  // canopy falls back to a flat golden cutout — usable at distance, flat up close.
  'tree candidate: golden larch': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'bk_golden_larch',
    impostorFile: 'bk_golden_larch_impostor.png',
    targetHeight: 39.09,
  }),
  'tree: source broadleaf comparator': (ctx) => sourceTreePatch(ctx),
  'tree: pine source comparator': (ctx) => pineSourcePatch(ctx),
  'water: pond lab': (ctx) => pondPatch(ctx),
  'turf: fairway': standingTurf('fairway'),
  'turf: green': standingTurf('green'),
  'turf: fringe edge': standingTurf('fringe'),
  'turf: rough': standingTurf('rough', { withGrass: true }),
  'turf: deep rough': standingTurf('deepRough', { withGrass: true }),

  'bunker': async (ctx) => {
    // The turf patch supplies the sand zone and the surrounding fairway; the bunker
    // module (once it exists) adds its own overlay on top of that ground.
    const patch = turfPatch('bunker', ctx);
    const b = await buildBunkerMesh({
      terrain: patch.terrain,
      x: patch.focus.x, z: patch.focus.z, r: PATCH * 0.22,
    });
    if (!b) throw new Error('Bunker builder returned no renderable object');
    patch.objects.push(b.mesh || b.group || b);
    return patch;
  },

  'ball': async (ctx) => {
    // A ball needs turf under it to be judged at all — a ball floating in a void tells
    // you nothing about how it reads at address.
    const patch = turfPatch('fairway', ctx);
    const ball = createGolfBallMesh();
    const mesh = ball?.mesh || ball;
    await mesh.userData?.assetsReady;
    const gy = patch.terrain.heightAt(patch.focus.x, patch.focus.z);
    mesh.position.set(patch.focus.x, gy + 0.021335 - 0.003, patch.focus.z);  // sunk ~3mm, as in play
    patch.objects.push(mesh);
    patch.focusY = mesh.position.y;
    patch.closeUp = true;      // frame the camera at macro distance, not patch distance
    return patch;
  },
};
