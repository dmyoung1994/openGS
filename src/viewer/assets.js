import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { buildBunkerMesh } from '../scene/Bunkers.js';
import { createGolfBallMesh } from '../scene/GolfBall.js';
import { ProceduralTreeForest } from '../scene/ProceduralTrees.js';
import { legacyTreeDefinition, normalizeTreeDefinition } from '../trees/TreeDefinition.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  LinearFilter, NoColorSpace, SRGBColorSpace, TextureLoader,
} from 'three';

const viewerGltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const viewerTextureLoader = new TextureLoader();
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
    // Viewer patches intentionally end at their 44 m boundary. An exact finite
    // grid keeps that silhouette continuous instead of letting course clipmap
    // sentinel triangles cut notches through the exposed horizon.
    finiteCanvas: true,
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

async function proceduralTreePatch({ renderer, camera }, archetype = 'live-oak') {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), finiteCanvas: true, renderer,
  });
  const query = new URL(window.location.href).searchParams;
  const variant = Math.max(0, Math.min(3, Number.parseInt(query.get('variant') ?? '0', 10) || 0));
  const definition = archetype === 'imagegen-live-oak'
    ? await fetch('/assets/procedural-trees/imagegen-live-oak/definition.json').then((response) => {
      if (!response.ok) throw new Error(`ImageGen tree definition failed to load (${response.status}).`);
      return response.json();
    })
    : archetype === 'l-system' ? {
    id: 'viewer-l-system', generator: 'l-system', seed: 17, variantCount: 1,
    grammar: {
      axiom: ['F'], iterations: 4, angle: 24, step: 0.72, radius: 0.18, tropism: [0, 0.12, 0],
      productions: { F: [{ weight: 1, successor: [
        { symbol: 'F', parameters: [{ op: '*', args: [{ var: 'p0' }, 0.86] }] },
        '[', '+', 'F', 'L', ']', '[', '-', 'F', 'L', ']', 'F',
      ] }] },
    },
    materials: {
      bark: { color: '#513c2a', roughness: 0.96 },
      leaves: { color: '#315b31', roughness: 0.9, alphaCutoff: 0.32, doubleSided: true },
      blossoms: { color: '#efd5d7', roughness: 0.8 },
    },
  } : structuredClone(legacyTreeDefinition(archetype));
  definition.variantCount = 1;
  definition.seed = (definition.seed + variant) >>> 0;
  const normalized = normalizeTreeDefinition(definition);
  const placement = {
    id: 'viewer-tree', definitionId: normalized.id, x: cx, z: cz, rotationY: 0,
    scale: 1, seed: variant, age: 1, health: 1, windExposure: 0.5,
  };
  const forest = await ProceduralTreeForest.create({
    definitions: [normalized], placements: [placement], camera, terrain, renderer, seed: variant,
  });
  const debug = query.get('debug') ?? 'beauty';
  for (const batch of forest.batches) {
    if (debug === 'structure') for (const name of ['nearLeaves', 'nearBlossoms', 'farLeaves', 'farBlossoms']) batch.draws[name].visible = false;
    if (debug === 'foliage') for (const name of ['nearBranches', 'farBranches']) batch.draws[name].visible = false;
  }
  const diagnostics = forest.workloadDiagnostics();
  const bounds = forest.batches[0].skeleton.bounds;
  const baseY = terrain.heightAt(cx, cz);
  return {
    terrain, objects: [terrain.mesh, forest.group, forest.shadow.mesh], focus: { x: cx, z: cz },
    treeBeauty: forest, focusY: baseY + bounds.center[1], foliageStandoff: bounds.canopyRadius,
    frameBounds: { center: [cx + bounds.center[0], baseY + bounds.center[1], cz + bounds.center[2]], size: bounds.size },
    treeDefinition: normalized, proceduralDiagnostics: diagnostics,
  };
}

async function onlineTreeReferencePatch({
  renderer,
  file,
  scale = 1,
  targetHeight = 12,
  frameWidth = targetHeight * 0.82,
  alphaMaps = [],
}) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), finiteCanvas: true, renderer,
  });
  const baseY = terrain.heightAt(cx, cz);
  const [gltf, loadedAlphaMaps] = await Promise.all([
    viewerGltfLoader.loadAsync(file),
    Promise.all(alphaMaps.map(async ({ material, url }) => {
      const alphaMap = await viewerTextureLoader.loadAsync(url);
      alphaMap.colorSpace = NoColorSpace;
      alphaMap.minFilter = LinearFilter;
      alphaMap.magFilter = LinearFilter;
      alphaMap.generateMipmaps = false;
      alphaMap.needsUpdate = true;
      return { material, alphaMap };
    })),
  ]);
  const alphaByMaterial = new Map(loadedAlphaMaps.map(({ material, alphaMap }) => [material, alphaMap]));
  gltf.scene.position.set(cx, baseY, cz);
  gltf.scene.scale.setScalar(scale);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const material of materials) {
      const alphaMap = alphaByMaterial.get(material?.name);
      if (!alphaMap) continue;
      material.alphaMap = alphaMap;
      material.alphaTest = 0.10;
      material.transparent = false;
      material.depthWrite = true;
      material.needsUpdate = true;
    }
  });
  return {
    terrain, objects: [terrain.mesh, gltf.scene], focus: { x: cx, z: cz },
    focusY: baseY + targetHeight * 0.48,
    frameBounds: { center: [cx, baseY + targetHeight * 0.5, cz], size: [frameWidth, targetHeight, frameWidth] },
  };
}

async function sourceTreePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/tree_small_02_lod0.glb', scale: 2.6,
    targetHeight: 12, frameWidth: 11,
  });
}

async function islandTreeSourcePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/island_tree_01.glb', scale: 2.5,
    targetHeight: 12.5, frameWidth: 12.5,
  });
}

async function pineSaplingSmallSourcePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/pine_sapling_small_exact_a.glb', scale: 12,
    targetHeight: 15.6, frameWidth: 12,
  });
}

async function pineSaplingSmallLod1Patch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/pine_sapling_small_component_lod1.glb', scale: 12,
    targetHeight: 15.6, frameWidth: 12,
  });
}

async function pineTree01SourcePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/pine_tree_01_source_lod0.glb', scale: 1,
    targetHeight: 14.858, frameWidth: 11,
    alphaMaps: [{ material: 'pine_tree_01_twig.001', url: '/assets/trees/pine_tree_01_twig_alpha_1k.png' }],
  });
}

async function pineTree01Lod1Patch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/pine_tree_01_source_lod1.glb', scale: 1,
    targetHeight: 14.858, frameWidth: 11,
    alphaMaps: [{ material: 'pine_tree_01_twig.001', url: '/assets/trees/pine_tree_01_twig_alpha_1k.png' }],
  });
}

async function firTree01SourcePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/fir_tree_01_source_lod0.glb', scale: 1,
    targetHeight: 14.055, frameWidth: 13,
  });
}

async function firTree01Lod1Patch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/fir_tree_01_source_lod1.glb', scale: 1,
    targetHeight: 14.055, frameWidth: 13,
  });
}

async function firSaplingMediumLod0Patch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/fir_sapling_medium_component_lod0.glb', scale: 1,
    targetHeight: 8.83, frameWidth: 9,
  });
}

async function firSaplingMediumExactPatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/fir_sapling_medium_exact_a.glb', scale: 1,
    targetHeight: 8.83, frameWidth: 9,
  });
}

async function firSaplingMediumLod1Patch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/fir_sapling_medium_component_lod1.glb', scale: 1,
    targetHeight: 8.83, frameWidth: 9,
  });
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
    finiteCanvas: true,
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
  'procedural: ImageGen live oak': (ctx) => proceduralTreePatch(ctx, 'imagegen-live-oak'),
  'procedural: live oak': (ctx) => proceduralTreePatch(ctx, 'live-oak'),
  'procedural: broadleaf oak': (ctx) => proceduralTreePatch(ctx, 'broadleaf-oak'),
  'procedural: douglas fir': (ctx) => proceduralTreePatch(ctx, 'douglas-fir'),
  'procedural: loblolly pine': (ctx) => proceduralTreePatch(ctx, 'loblolly-pine'),
  'procedural: stochastic l-system': (ctx) => proceduralTreePatch(ctx, 'l-system'),
  'tree: source broadleaf comparator': (ctx) => sourceTreePatch(ctx),
  'reference: Poly Haven Tree Small 02 (CC0)': (ctx) => sourceTreePatch(ctx),
  'reference: Poly Haven Island Tree 01 (CC0)': (ctx) => islandTreeSourcePatch(ctx),
  'reference: Poly Haven Pine Sapling Small (CC0)': (ctx) => pineSaplingSmallSourcePatch(ctx),
  'reference: Poly Haven Pine Sapling Small LOD1 (CC0)': (ctx) => pineSaplingSmallLod1Patch(ctx),
  'reference: Poly Haven Pine Tree 01 (CC0)': (ctx) => pineTree01SourcePatch(ctx),
  'reference: Poly Haven Pine Tree 01 LOD1 (CC0)': (ctx) => pineTree01Lod1Patch(ctx),
  'reference: Poly Haven Fir Tree 01 (CC0)': (ctx) => firTree01SourcePatch(ctx),
  'reference: Poly Haven Fir Tree 01 LOD1 (CC0)': (ctx) => firTree01Lod1Patch(ctx),
  'reference: Poly Haven Fir Sapling Medium LOD0 (CC0)': (ctx) => firSaplingMediumLod0Patch(ctx),
  'reference: Poly Haven Fir Sapling Medium Exact (CC0)': (ctx) => firSaplingMediumExactPatch(ctx),
  'reference: Poly Haven Fir Sapling Medium LOD1 (CC0)': (ctx) => firSaplingMediumLod1Patch(ctx),
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
