import {
  InstancedMesh, Object3D, Group, DoubleSide, Box3, Vector3, Color,
  SRGBColorSpace, CylinderGeometry, ConeGeometry, MeshStandardMaterial,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  texture, materialColor, saturation, positionLocal, normalWorld, positionWorld,
  cameraPosition, smoothstep, mix, vec3, float, max, dot, pow, oneMinus, normalize,
  instancedBufferAttribute,
} from 'three/tsl';
import {
  makeCanopyBillboardTexture, instanceBillboards, foliageTint,
} from './Vegetation.js';

const _loader = new GLTFLoader();

// Sun world direction (matches main.js) — normalized for the rim-light dot.
const SUN = new Vector3(-0.82, 0.4, -0.12).normalize();

// ---------------------------------------------------------------------------
// Tree prototypes & instancing  (WebGPU / TSL).
//
// ROOT CAUSE of the original "dead tumbleweed" trees: loadTreePrototype grabbed
// only the FIRST mesh of the GLB. GLTFLoader splits a multi-primitive mesh (trunk
// + branches + leaves, one primitive per material) into a Group of separate Mesh
// objects, so taking the first one kept the trunk and dropped the whole canopy.
// (The processed GLB had also lost its leaves to over-aggressive decimation —
// re-baked per-material with scripts/process_tree_multimaterial.py.)
//
// Fix: collect EVERY sub-mesh into a prototype and build one InstancedMesh per
// part. Foliage is then shaded with TSL nodes (GLSL onBeforeCompile does NOT run
// under WebGPU): a top-lit/bottom-dark canopy gradient, a warm sun-side rim, and
// a desaturation pass that kills the "radioactive green".
// ---------------------------------------------------------------------------

const _isFoliageName = (n = '') => /leaf|leaves|twig|needle|foliage|pine_canopy/i.test(n);

// Inflate a canopy mesh about its own centre so the leaf volume engulfs the bare
// branch tips that would otherwise poke out as dark spikes. Centre is preserved.
function puffGeometry(geometry, factor) {
  geometry.computeBoundingBox();
  const c = geometry.boundingBox.getCenter(new Vector3());
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.scale(factor, factor, factor);
  geometry.translate(c.x, c.y, c.z);
  return geometry;
}

// ---- Foliage TSL shading ---------------------------------------------------
// KNOBS (tune these for the look):
const CANOPY_SATURATION = 0.8;                 // <1 desaturates (kills radioactive green)
const CANOPY_WARM = vec3(1.06, 1.0, 0.82);     // warm/olive albedo nudge
const CANOPY_TOP = vec3(1.22, 1.14, 0.9);      // top-of-canopy tint (warm, bright)
const CANOPY_BOTTOM = vec3(0.42, 0.5, 0.5);    // underside tint (cool, dark) — fake AO
const RIM_COLOR = vec3(1.0, 0.72, 0.36);       // warm sun-side rim
const RIM_STRENGTH = 0.6;
const RIM_POWER = 3.0;

// Albedo node for a foliage part. `tintNode` is the per-instance foliage tint;
// minY/maxY are the canopy's local-space vertical extent for the AO gradient.
function foliageColorNode(material, minY, maxY, tintNode) {
  const baseRgb = material.map ? texture(material.map).rgb : materialColor;
  let col = baseRgb.mul(tintNode);                       // per-instance tint FIRST
  col = saturation(col, CANOPY_SATURATION);              // then desaturate
  col = col.mul(CANOPY_WARM);                            // then warm/olive nudge
  // Top-lit / bottom-dark: blend a canopy-height gradient with world-up facing.
  const gy = smoothstep(float(minY), float(maxY), positionLocal.y);   // 0 bottom → 1 top
  const nUp = normalWorld.y.mul(0.5).add(0.5);                        // 0 down → 1 up
  const lit = gy.mul(0.6).add(nUp.mul(0.4));
  return col.mul(mix(CANOPY_BOTTOM, CANOPY_TOP, lit));   // fake AO / sky gradient
}

// Warm rim on the sun-facing, grazing-angle edges of the canopy (emissive add).
function foliageEmissiveNode() {
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = oneMinus(max(dot(normalWorld, viewDir), 0.0));         // silhouette edges
  const sunFace = max(dot(normalWorld, vec3(SUN.x, SUN.y, SUN.z)), 0.0);
  return RIM_COLOR.mul(pow(fres, RIM_POWER)).mul(sunFace).mul(RIM_STRENGTH);
}

// Prepare a GLB material: correct diffuse colour space, two-sided thin cards, a
// hard alpha cutout (crisp canopy that still writes/casts shadow). GLTFLoader
// builds lit MeshStandard(Node)Materials with normal + ARM maps, so foliage is
// properly lit; the TSL foliage nodes are attached per-instance in fillParts().
function prepMaterial(m) {
  m.side = DoubleSide;
  if (m.map) {
    m.map.colorSpace = SRGBColorSpace;
    m.alphaTest = Math.max(m.alphaTest || 0, 0.4);
    m.transparent = false;
    m.depthWrite = true;
  }
  m.metalness = 0;
  return m;
}

// Load a processed tree GLB and extract an instanceable prototype with ALL of its
// sub-meshes.
//
// Returns: {
//   parts:  [{ geometry, material, isFoliage, offsetY, foliageMinY, foliageMaxY }],
//   height: number,   // native overall height (bbox)
//   baseY:  number,   // native ground offset (bbox.min.y)
// }
// `offsetY` drops foliage so the canopy overlaps the trunk (no "floating ball");
// foliageMinY/MaxY drive the top-lit/bottom-dark gradient.
export async function loadTreePrototype(url) {
  const gltf = await _loader.loadAsync(url);

  const parts = [];
  const bbox = new Box3();
  const tmp = new Box3();
  gltf.scene.updateWorldMatrix(true, true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    // Bake node transforms into the geometry so one matrix per placement lines
    // every part up identically.
    const geometry = o.geometry.clone();
    geometry.applyMatrix4(o.matrixWorld);
    geometry.computeBoundingBox();
    tmp.copy(geometry.boundingBox);
    bbox.union(tmp);

    const isFoliage = _isFoliageName(o.material && o.material.name) || _isFoliageName(o.name);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(prepMaterial);
    parts.push({ geometry, material: o.material, isFoliage, offsetY: 0, foliageMinY: 0, foliageMaxY: 1 });
  });
  if (!parts.length) throw new Error('no meshes in ' + url);

  const size = bbox.getSize(new Vector3());
  const height = size.y;
  // Drop the canopy so it overlaps the trunk, puff it out to swallow scraggly
  // branch tips, and record its extent for the gradient.
  for (const part of parts) {
    if (!part.isFoliage) continue;
    part.offsetY = -height * 0.12;
    puffGeometry(part.geometry, 1.18);
    part.geometry.computeBoundingBox();
    part.foliageMinY = part.geometry.boundingBox.min.y;
    part.foliageMaxY = part.geometry.boundingBox.max.y;
  }

  return { parts, height, baseY: bbox.min.y };
}

// A lightweight PROCEDURAL conifer — real instanced 3D geometry (trunk cylinder +
// stacked cones), not a photoscan. The Poly Haven pine source is a ~950MB scan
// that neither bakes in reasonable time nor is sane to ship to the browser, so we
// synthesise a clean conical species instead. Same prototype shape as a GLB.
export function createPineProto() {
  const H = 9;
  const trunkH = H * 0.34;
  const trunk = new CylinderGeometry(0.09, 0.16, trunkH, 6, 1);
  trunk.translate(0, trunkH / 2, 0);
  trunk.computeVertexNormals();

  const cones = [];
  const tiers = 4;
  const start = trunkH * 0.55;
  for (let i = 0; i < tiers; i++) {
    const f = i / (tiers - 1);
    const r = (1.0 - f * 0.62) * 1.7;               // widest at the bottom
    const ch = ((H - start) / tiers) * 2.0;          // overlapping tiers
    const cy = start + f * (H - start - ch * 0.35);
    const c = new ConeGeometry(r, ch, 9, 1, false);
    c.translate(0, cy + ch / 2, 0);
    cones.push(c);
  }
  const foliage = mergeGeometries(cones, false);
  foliage.computeVertexNormals();
  foliage.computeBoundingBox();

  const bark = new MeshStandardMaterial({ color: 0x584636, roughness: 1, metalness: 0 });
  const needles = new MeshStandardMaterial({ color: 0x33623b, roughness: 0.95, metalness: 0 });

  return {
    parts: [
      { geometry: trunk, material: bark, isFoliage: false, offsetY: 0, foliageMinY: 0, foliageMaxY: 1 },
      {
        geometry: foliage, material: needles, isFoliage: true, offsetY: -H * 0.04,
        foliageMinY: foliage.boundingBox.min.y, foliageMaxY: foliage.boundingBox.max.y,
      },
    ],
    height: H,
    baseY: 0,
  };
}

// Clone a foliage material and attach its per-instance TSL shading (tint +
// gradient + rim). Cloned per InstancedMesh so its tint attribute is unique.
function makeFoliageMaterial(base, part, tintNode) {
  const m = base.clone();
  m.colorNode = foliageColorNode(m, part.foliageMinY, part.foliageMaxY, tintNode);
  // colorNode replaces the whole diffuse pipeline, including the map's alpha —
  // so re-wire the leaf texture's alpha as opacity or the alphaTest cutout that
  // carves leaf shapes out of the cards is lost (canopy renders as bare branches).
  if (m.map) m.opacityNode = texture(m.map).a;
  m.emissiveNode = foliageEmissiveNode();
  m.needsUpdate = true;
  return m;
}

// Instance every part of `proto` at `placements` into `group`. All parts of a
// given tree share ONE per-instance transform + tint (precomputed once), so trunk
// and canopy always line up. Per-instance variation: size, a small lean, rotation,
// and a foliage hue/brightness tint (instanced attribute → colorNode).
function fillParts(group, proto, placements) {
  const N = placements.length;

  // Precompute per-tree variation ONCE so it's identical across all parts.
  const vary = new Array(N);
  for (let i = 0; i < N; i++) {
    vary[i] = {
      sizeMul: 0.7 + Math.random() * 0.75,        // 0.70–1.45× → strong size spread
      leanX: (Math.random() - 0.5) * 0.09,        // slight lean (radians)
      leanZ: (Math.random() - 0.5) * 0.09,
      color: foliageTint(new Color()),
    };
  }

  const d = new Object3D();
  for (const part of proto.parts) {
    let material = part.material;
    if (part.isFoliage) {
      const tintArr = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const c = vary[i].color;
        tintArr[i * 3] = c.r; tintArr[i * 3 + 1] = c.g; tintArr[i * 3 + 2] = c.b;
      }
      material = makeFoliageMaterial(part.material, part, instancedBufferAttribute(tintArr, 'vec3'));
    }

    const inst = new InstancedMesh(part.geometry, material, N);
    inst.castShadow = true;
    inst.receiveShadow = true;
    for (let i = 0; i < N; i++) {
      const p = placements[i];
      const v = vary[i];
      const scale = (p.targetHeight * v.sizeMul) / proto.height;
      d.position.set(p.x, p.y - proto.baseY * scale + part.offsetY * scale, p.z);
      d.rotation.set(v.leanX, p.rotY || 0, v.leanZ);
      d.scale.setScalar(scale);
      d.updateMatrix();
      inst.setMatrixAt(i, d.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    // Bound the whole spread so culling only fires when the entire line is
    // off-screen (the origin geometry sphere would cull the field incorrectly).
    inst.computeBoundingSphere();
    group.add(inst);
  }
  return group;
}

// Bake several billboard variants per species (different noise silhouettes) so
// the backdrop doesn't repeat one card. Baked once and reused.
let _billboardTex = null;
function billboardTextures() {
  if (!_billboardTex) {
    _billboardTex = {
      deciduous: [3, 11, 23].map((sd) => makeCanopyBillboardTexture('deciduous', sd)),
      pine: [7, 17, 29].map((sd) => makeCanopyBillboardTexture('pine', sd)),
    };
  }
  return _billboardTex;
}

// Derive a DEEP, layered billboard backdrop from the hero placements. For each
// real tree we scatter imposters across several depth rows further out and back,
// with size falloff and lateral jitter, so the line reads as a forest that
// recedes rather than a single row of blobs.
function addBillboardBackdrop(group, placements) {
  const decid = [];
  const pine = [];
  const rows = [
    { back: 6, spread: 16, sizeF: 0.95, n: 2 },
    { back: 26, spread: 30, sizeF: 0.82, n: 2 },
    { back: 52, spread: 46, sizeF: 0.68, n: 2 },
  ];
  for (const p of placements) {
    const outward = Math.sign(p.x || 1);
    for (const row of rows) {
      for (let k = 0; k < row.n; k++) {
        const item = {
          x: p.x + outward * (row.back * 0.4 + Math.random() * row.spread) + (Math.random() - 0.5) * 12,
          y: p.y,
          z: p.z - row.back - Math.random() * row.spread,
          targetHeight: p.targetHeight * row.sizeF * (0.8 + Math.random() * 0.55),
        };
        (Math.random() < 0.5 ? decid : pine).push(item);
      }
    }
  }
  const tex = billboardTextures();
  // Split each species' cards across its texture variants for silhouette variety.
  const split = (list, texes, widthRatio) => {
    const buckets = texes.map(() => []);
    list.forEach((it, i) => buckets[i % texes.length].push(it));
    buckets.forEach((b, i) => {
      if (b.length) group.add(instanceBillboards(b, { texture: texes[i], widthRatio }));
    });
  };
  split(decid, tex.deciduous, 0.8);
  split(pine, tex.pine, 0.5);
  return group;
}

// Interleave a nudged, differently-sized subset of `placements` for a second
// species so pines mix into (not clone) the deciduous line.
function secondarySpeciesPlacements(placements) {
  return placements
    .filter((_, i) => i % 2 === 1)
    .map((p) => ({
      x: p.x + (Math.random() - 0.5) * 7,
      y: p.y,
      z: p.z - 1.5,
      targetHeight: p.targetHeight * (1.0 + Math.random() * 0.5),
      rotY: Math.random() * Math.PI * 2,
    }));
}

// ---- Public API -----------------------------------------------------------

// ORIGINAL CONTRACT (unchanged): instanceTrees(loadTreePrototype(url), placements)
// returns a single Object3D ready to add to the scene. The returned group holds:
//   • one InstancedMesh per sub-mesh of `proto` (the hero deciduous trees),
//   • procedural pines interleaved for silhouette variety (unless disabled),
//   • a two-species, multi-row billboard forest wall for depth (unless disabled).
//
// options:
//   backdrop   {boolean}  add the billboard forest wall            (default true)
//   secondary  {boolean}  interleave procedural pines              (default true)
export function instanceTrees(proto, placements, options = {}) {
  const { backdrop = true, secondary = true } = options;
  const group = new Group();

  fillParts(group, proto, placements);                       // hero species
  if (secondary) {
    fillParts(group, createPineProto(), secondarySpeciesPlacements(placements));
  }
  if (backdrop) addBillboardBackdrop(group, placements);
  return group;
}

// RICHER MULTI-SPECIES API for Range.js to place several species explicitly.
//
//   const island = await loadTreePrototype('/assets/trees/island_tree_01.glb');
//   const pine   = createPineProto();
//   scene.add(buildForest(
//     [ { proto: island, placements: deciduousSpots },
//       { proto: pine,   placements: pineSpots } ],
//     { backdrop: true, backdropFrom: allSpots },
//   ));
//
// Each entry is { proto, placements }. `proto` comes from loadTreePrototype (any
// species GLB) or createPineProto(). Every placement is { x, y, z, targetHeight,
// rotY } and gets per-instance size/lean/hue variation automatically.
//
// options:
//   backdrop      {boolean}       add the billboard wall           (default true)
//   backdropFrom  {placements[]}  seed row for the wall     (default: all entries)
export function buildForest(entries, options = {}) {
  const { backdrop = true, backdropFrom = null } = options;
  const list = Array.isArray(entries) ? entries : [entries];
  const group = new Group();
  for (const { proto, placements } of list) fillParts(group, proto, placements);
  if (backdrop) {
    const seed = backdropFrom || list.flatMap((e) => e.placements);
    addBillboardBackdrop(group, seed);
  }
  return group;
}

// Convenience: load a species GLB and instance it in one call (no procedural
// second species — use buildForest for explicit multi-species scenes).
export async function loadSpecies(url) {
  return loadTreePrototype(url);
}

// Re-export the vegetation helpers so callers have a single entry point.
export { makeCanopyBillboardTexture, instanceBillboards, foliageTint } from './Vegetation.js';
