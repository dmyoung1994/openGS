import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { buildBunkerMesh } from '../scene/Bunkers.js';
import { createGolfBallMesh } from '../scene/GolfBall.js';
import { loadTreePrototype, buildTreeBeautyLod0 } from '../scene/Trees.js';
import { GeneratedFoliageForest, GeneratedFoliageTree } from '../scene/GeneratedFoliageTree.js';
import { createLocalFoliagePackRegistry, loadFoliageAlias } from '../foliage/FoliagePackResolver.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  BufferAttribute, BufferGeometry, ClampToEdgeWrapping, CylinderGeometry,
  DoubleSide, Group, LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, NearestFilter, PlaneGeometry,
  SRGBColorSpace, TextureLoader, Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { mix, texture, vec3 } from 'three/tsl';

const viewerGltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const viewerTextureLoader = new TextureLoader();
const localFoliagePackRegistry = createLocalFoliagePackRegistry(
  globalThis.__GOLF_LOCAL_FOLIAGE_PACKS__ ?? [],
);
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
async function firTreePatch({ camera, renderer, motionHistory, environment, treePrefix = 'fir_tree_01', prototypeBase = null, targetHeight = 18.895 }) {
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
  const baseY = terrain.heightAt(cx, cz);
  const treeBeauty = buildTreeBeautyLod0(proto, [{
    x: cx, z: cz, y: baseY, rotY: 0, targetHeight,
  }], {
    renderer, camera, motionHistory, environment,
    wind: { model: 'hierarchical-tree-v1', trunkStiffness: 0.94, branchStiffness: 0.72, leafStiffness: 0.38, gustResponse: 0.52 },
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

function generatedFirCardGeometry(clusters) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const up = new Vector3(0, 1, 0);
  const tangent = new Vector3();
  const branch = new Vector3();
  const cardUp = new Vector3();
  const normal = new Vector3();
  const center = new Vector3();
  const corner = new Vector3();
  let cardCount = 0;
  const random = (n) => {
    const value = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  };

  function appendCard({ y, azimuth, length, width, roll, cluster }) {
    branch.set(Math.cos(azimuth), 0.055 + random(cardCount + 71) * 0.08, Math.sin(azimuth)).normalize();
    tangent.set(-Math.sin(azimuth), 0, Math.cos(azimuth));
    cardUp.copy(up).multiplyScalar(Math.cos(roll)).addScaledVector(tangent, Math.sin(roll)).normalize();
    center.copy(branch).multiplyScalar(length * 0.5 + 0.10);
    center.y += y;
    // Broad canopy lighting should follow the crown volume, not expose the
    // orientation of each flat support plane. Fine needle response stays in the
    // albedo; this spherical normal keeps adjacent crossed sprays coherent.
    normal.set(center.x, Math.max(0.35, width * 0.22), center.z).normalize();
    const halfLength = length * 0.5;
    const halfWidth = width * 0.5;
    const base = positions.length / 3;
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [su, sv] of signs) {
      corner.copy(center).addScaledVector(branch, su * halfLength).addScaledVector(cardUp, sv * halfWidth);
      positions.push(corner.x, corner.y, corner.z);
      normals.push(normal.x, normal.y, normal.z);
    }
    const { u0, v0, u1, v1 } = cluster.uv;
    const uBase = cluster.baseEdge === 'right' ? u1 : u0;
    const uTip = cluster.baseEdge === 'right' ? u0 : u1;
    uvs.push(uBase, v0, uTip, v0, uTip, v1, uBase, v1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    cardCount++;
  }

  // A Douglas-fir crown is assembled from radial branch sprays, not random
  // billboards. Dense cards mass the interior while crossed sparse cards break
  // the outline and keep the crown volumetric when a radial plane turns edge-on.
  const levels = 15;
  for (let level = 0; level < levels; level++) {
    const t = level / (levels - 1);
    const y = 1.8 + t * 17.1;
    const radius = 0.68 + 4.55 * Math.pow(1 - t, 0.76);
    const branches = level < 9 ? 7 : (level < 13 ? 6 : 5);
    for (let branchIndex = 0; branchIndex < branches; branchIndex++) {
      const seed = level * 19 + branchIndex * 7;
      const azimuth = branchIndex * Math.PI * 2 / branches + level * 0.47 + (random(seed) - 0.5) * 0.18;
      const length = radius * (0.84 + random(seed + 1) * 0.20);
      const primaryIndex = level < 3 ? 3 : (level > 9 ? 0 : [1, 2, 5][(level + branchIndex) % 3]);
      const primary = clusters[primaryIndex];
      appendCard({
        y, azimuth, length,
        width: Math.max(0.50, length / Math.max(1.15, primary.aspect) * 0.62),
        roll: (random(seed + 2) - 0.5) * 0.72,
        cluster: primary,
      });
      if (level < 14) {
        const breaker = clusters[(level + branchIndex) % 3 === 0 ? 7 : 0];
        appendCard({
          y: y + 0.08, azimuth: azimuth + 0.035, length: length * 0.88,
          width: Math.max(0.42, length / Math.max(1.1, breaker.aspect) * 0.46),
          roll: 0.94 + (random(seed + 3) - 0.5) * 0.54,
          cluster: breaker,
        });
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return { geometry, cardCount };
}

// Candidate-only generated-cluster renderer. It proves the source/processing/card
// assembly loop in the real viewer while staying isolated from Range and the
// production tree catalog. One masked foliage draw plus one trunk draw makes its
// performance shape honest enough to evaluate before building hierarchical LOD.
function generatedPackInspection(pack, { subject, mipLevel = 0 }) {
  const group = new Group();
  group.name = `generated-foliage-pack-${subject}`;
  if (subject === 'mip') {
    // Forced low mips are magnified for inspection; nearest filtering makes the
    // actual retained texels readable instead of smoothly reconstructing them.
    pack.atlas.magFilter = NearestFilter;
    pack.atlas.needsUpdate = true;
  }
  const atlasSample = texture(pack.atlas).level(mipLevel);
  const material = new MeshBasicNodeMaterial({ side: DoubleSide });
  if (subject === 'atlas' || subject === 'mip') {
    // Composite transparent atlas texels over a neutral reference so dilation,
    // fringe, cell gutters, and a forced mip are visible without checkerboard
    // aliasing becoming part of the inspection result.
    material.colorNode = mix(vec3(0.075), atlasSample.rgb, atlasSample.a);
    material.opacity = 1;
  } else {
    material.colorNode = atlasSample.rgb;
    material.opacityNode = atlasSample.a;
    material.alphaTest = 0.02;
    material.transparent = false;
    material.depthWrite = true;
  }
  material.needsUpdate = true;

  if (subject === 'atlas' || subject === 'mip') {
    const plane = new Mesh(new PlaneGeometry(12, 12), material);
    plane.position.set(-2, 9.5, 0);
    group.add(plane);
  } else {
    for (const [index, cluster] of pack.metadata.clusters.entries()) {
      const width = 2.8;
      const height = width / Math.max(0.5, cluster.aspect);
      const geometry = new PlaneGeometry(width, height);
      const cardUv = geometry.getAttribute('uv');
      for (let vertex = 0; vertex < cardUv.count; vertex++) {
        cardUv.setXY(vertex,
          cluster.uv.u0 + (cluster.uv.u1 - cluster.uv.u0) * cardUv.getX(vertex),
          cluster.uv.v0 + (cluster.uv.v1 - cluster.uv.v0) * cardUv.getY(vertex));
      }
      cardUv.needsUpdate = true;
      const card = new Mesh(geometry, material);
      card.name = `generated-foliage-card:${index}:${cluster.name}`;
      card.position.set(-2 + (index % 4 - 1.5) * 3.25, 12.0 - Math.floor(index / 4) * 5.0, 0);
      group.add(card);
    }
  }

  return {
    group,
    diagnostics: Object.freeze({
      candidateOnly: true, generatedSource: true, labSubject: subject,
      mipLevel, clusterCount: pack.metadata.clusters.length,
      clusterNames: pack.metadata.clusters.map(({ name }) => name),
      drawCalls: subject === 'cards' ? pack.metadata.clusters.length : 1,
      textureMode: pack.textureMode, atlasMetrics: pack.metadata.metrics,
    }),
    dispose() {
      for (const child of group.children) child.geometry?.dispose();
      material.dispose();
      pack.atlas.dispose(); pack.materialMask.dispose();
      for (const barkTexture of Object.values(pack.bark)) barkTexture.dispose();
    },
  };
}

async function generatedTreePatch({ renderer, camera, environment, motionHistory }, {
  alias, height, foliageStandoff, frameWidth, forceBand = null,
}) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer,
  });
  const textureMode = new URL(window.location.href).searchParams.get('texture') === 'png' ? 'png' : 'ktx2';
  const requestedDebug = new URL(window.location.href).searchParams.get('debug') ?? 'beauty';
  const debugMode = ['beauty', 'alpha', 'material', 'normal', 'lod', 'hull', 'overdraw'].includes(requestedDebug)
    ? requestedDebug : 'beauty';
  const boundedQueryNumber = (name, fallback, min, max) => {
    const value = new URL(window.location.href).searchParams.get(name);
    if (value === null || value.trim() === '') return fallback;
    const raw = Number(value);
    return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
  };
  const labControls = {
    alphaTest: boundedQueryNumber('alphaTest', 0.20, 0, 0.95),
    roughnessStrength: boundedQueryNumber('roughness', 1, 0, 1),
    normalShaping: boundedQueryNumber('normalShape', 0, 0, 1),
    transmissionStrength: boundedQueryNumber('transmission', 1, 0, 2),
  };
  const pack = await loadFoliageAlias(alias, {
    renderer, textureMode, allowCandidate: true, local: localFoliagePackRegistry,
  });
  const requestedSubject = new URL(window.location.href).searchParams.get('subject') ?? 'tree';
  const subject = ['tree', 'atlas', 'cards', 'mip'].includes(requestedSubject) ? requestedSubject : 'tree';
  if (subject !== 'tree') {
    const mipLevel = subject === 'mip' ? boundedQueryNumber('mip', 4, 0, 10) : 0;
    const inspection = generatedPackInspection(pack, { subject, mipLevel });
    const baseY = terrain.heightAt(cx, cz);
    inspection.group.position.set(cx, baseY, cz);
    const treeBeauty = {
      group: inspection.group, update() {},
      residencyEstimate() { return inspection.diagnostics; },
      readDiagnostics() { return inspection.diagnostics; },
      dispose() { inspection.dispose(); },
    };
    return {
      terrain, objects: [terrain.mesh, inspection.group], focus: { x: cx, z: cz }, treeBeauty,
      focusY: baseY + 9.5, foliageStandoff: 10,
      frameBounds: { center: [cx, baseY + 9.5, cz], size: [14, 14, 1] },
    };
  }
  const generatedTree = new GeneratedFoliageTree({ pack, environment, camera, motionHistory,
    seed: 0x51a7e5d, height, debugMode, forceBand, labControls });
  const group = generatedTree.group;
  const baseY = terrain.heightAt(cx, cz);
  group.position.set(cx, baseY, cz);
  const treeBeauty = {
    group,
    update(activeCamera) { generatedTree.update(activeCamera); },
    residencyEstimate(activeCamera) { return generatedTree.diagnostics(activeCamera); },
    readDiagnostics() { return generatedTree.diagnostics(camera); },
    dispose() { generatedTree.dispose(); },
  };
  return {
    terrain, objects: [terrain.mesh, group], focus: { x: cx, z: cz }, treeBeauty,
    focusY: baseY + height * 0.49,
    foliageStandoff,
    frameBounds: { center: [cx, baseY + height * 0.5, cz], size: [frameWidth, height, frameWidth] },
  };
}

async function generatedDouglasFirForestPatch({ renderer, camera, environment, motionHistory }) {
  const minX = PATCH_X - 28, minZ = -32;
  const cx = PATCH_X, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + 56, minZ, maxZ: minZ + 64 },
    spacing: 0.8, renderSpacing: 0.8, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer,
  });
  const textureMode = new URL(window.location.href).searchParams.get('texture') === 'png' ? 'png' : 'ktx2';
  const pack = await loadFoliageAlias('builtin.douglas-fir.pnw.v1', {
    renderer, textureMode, allowCandidate: true,
  });
  const perimeter = [
    [-24, -26, 0.96], [-15, -29, 0.72], [-5, -30, 1.08], [7, -29, 0.82], [20, -25, 1.02],
    [-25, -12, 0.76], [-24, 5, 1.12], [-25, 22, 0.88],
    [25, -9, 1.04], [24, 8, 0.70], [26, 24, 0.98],
    [-18, 27, 0.74], [-6, 29, 1.06], [8, 28, 0.84], [20, 26, 0.94],
  ].map(([dx, dz, scale], index) => ({
    x: cx + dx, z: cz + dz, y: terrain.heightAt(cx + dx, cz + dz), scale,
    rotY: index * 2.399 + (index % 3) * 0.17,
  }));
  const forest = new GeneratedFoliageForest({ pack, placements: perimeter, environment, camera, motionHistory, renderer,
    seed: 0x67d0a61, identityCount: 3 });
  return {
    terrain, objects: [terrain.mesh, forest.group], focus: { x: cx, z: cz },
    focusY: terrain.heightAt(cx, cz) + 8,
    frameBounds: { center: [cx, terrain.heightAt(cx, cz) + 10, cz], size: [56, 22, 64] },
    treeBeauty: {
      group: forest.group,
      update(activeCamera) { forest.update(activeCamera); },
      residencyEstimate() { return forest.residencyEstimate(); },
      readDiagnostics() { return forest.residencyEstimate(); },
      dispose() { forest.dispose(); },
    },
  };
}

async function onlineTreeReferencePatch({
  renderer,
  file,
  scale = 1,
  targetHeight = 12,
  frameWidth = targetHeight * 0.82,
}) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), renderer,
  });
  const baseY = terrain.heightAt(cx, cz);
  const gltf = await viewerGltfLoader.loadAsync(file);
  gltf.scene.position.set(cx, baseY, cz);
  gltf.scene.scale.setScalar(scale);
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
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

async function pineSourcePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/pine_tree_01_canonical_lod0.glb', scale: 1,
    targetHeight: 18, frameWidth: 15,
  });
}

async function islandTreeSourcePatch({ renderer }) {
  return onlineTreeReferencePatch({
    renderer, file: '/assets/trees/island_tree_01.glb', scale: 2.5,
    targetHeight: 12.5, frameWidth: 12.5,
  });
}

async function pineTreePatch({ camera, renderer, motionHistory, environment }) {
  const minX = PATCH_X, minZ = -PATCH / 2;
  const cx = minX + PATCH / 2, cz = 0;
  const terrain = new Terrain({
    bounds: { minX, maxX: minX + PATCH, minZ, maxZ: minZ + PATCH },
    spacing: 0.6, renderSpacing: 0.6, heightFn: swell,
    surfaceFn: () => 'fairway', zones: ZONES.fairway(), motionHistory, renderer,
  });
  const proto = await loadTreePrototype('/assets/trees/pine_tree_01_canonical_lod0.glb');
  const baseY = terrain.heightAt(cx, cz);
  const targetHeight = 14.85;
  const treeBeauty = buildTreeBeautyLod0(proto, [{
    x: cx, z: cz, y: baseY, rotY: 0, targetHeight,
  }], {
    renderer, camera, motionHistory, environment,
    wind: { model: 'hierarchical-tree-v1', trunkStiffness: 0.9, branchStiffness: 0.62, leafStiffness: 0.28, gustResponse: 0.66 },
    seed: 0x51a7e5d, lodNear: 12, lodFar: 20,
  });
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
  'tree: pine LOD comparator': (ctx) => pineTreePatch(ctx),
  'tree: pine canonical': (ctx) => firTreePatch({
    ...ctx,
    treePrefix: 'pine_tree_01_canonical',
    targetHeight: 14.85,
  }),
  'tree: source broadleaf comparator': (ctx) => sourceTreePatch(ctx),
  'tree: pine source comparator': (ctx) => pineSourcePatch(ctx),
  'reference: Poly Haven Tree Small 02 (CC0)': (ctx) => sourceTreePatch(ctx),
  'reference: Poly Haven Island Tree 01 (CC0)': (ctx) => islandTreeSourcePatch(ctx),
  'reference: Poly Haven Pine Tree 01 (CC0)': (ctx) => pineSourcePatch(ctx),
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
