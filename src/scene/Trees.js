import {
  Group, DoubleSide, Box3, Matrix4, Vector2, Vector3, Color,
  SRGBColorSpace, TextureLoader, PlaneGeometry,
  LinearFilter, ClampToEdgeWrapping, Float32BufferAttribute,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  disposeComputeNodes, disposeMaterialTextures, disposeWebGPUAttributes, disposeWebGPUGeometries,
} from './WebGPUResourceDisposal.js';
import {
  texture, materialColor, saturation, positionLocal, normalLocal,
  cameraWorldMatrix, cameraPosition, mix, smoothstep, oneMinus, vec2, vec3, float, max, vertexColor,
  Fn, If, atomicAdd, atomicLoad, atomicOr, atomicStore,
  cameraViewMatrix, instanceIndex, mrt, positionGeometry, positionWorld,
  storage, uint, uniform, uv, atan, vec4, BRDF_Lambert, diffuseColor,
} from 'three/tsl';
import {
  BufferAttribute, EnvironmentNode, InstancedBufferGeometry, Mesh, MeshBasicMaterial,
  MeshBasicNodeMaterial, MeshPhongNodeMaterial, PhongLightingModel,
  IndirectStorageBufferAttribute, StorageBufferAttribute, StorageInstancedBufferAttribute,
} from 'three/webgpu';
import { foliageTint } from './Vegetation.js';
import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';
import { EnvironmentGpuBindings } from '../environment/EnvironmentGpuBindings.js';

// Catalog tree derivatives are meshopt-packed. Register the decoder on the
// specialized GPU-tree loader before Range's required startup barrier loads them.
const _loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const _textureLoader = new TextureLoader();

// MeshPhong's stock indirect path reads `irradiance`, while EnvironmentNode's
// actual PMREM contribution is stored in `iblIrradiance`. Bridge that real PMREM
// irradiance into the Phong diffuse term; do not replace it with a fixed fill.
class SharedEnvironmentTreePhongLightingModel extends PhongLightingModel {
  indirect(builder) {
    super.indirect(builder);
    const { iblIrradiance, reflectedLight } = builder.context;
    reflectedLight.indirectDiffuse.addAssign(
      iblIrradiance.mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })),
    );
  }
}

// Reviewed v7/v8 Phong path. MeshPhong retains the renderer's real directional
// shadows while EnvironmentNode supplies the shared PMREM diffuse/specular
// response through the bridged lighting model above.
class SharedEnvironmentTreePhongMaterial extends MeshPhongNodeMaterial {
  // Shared output integration. Applying aerial perspective after the
  // Phong/PMREM/key result keeps atmospheric transmittance physically ordered:
  // the shared sun and sky light the needles first, then the camera ray mixes
  // toward the same chromatic horizon used by the HDR valley. The material
  // disables NodeMaterial's scene FogExp2 path to avoid applying two unrelated
  // fog factors to the same fragment; v8 production and v7 trial fixtures use
  // this class while v3-v6 retain their established MeshStandard path.
  setupOutput(builder, outputNode) {
    if (!this.treeEnvironment) return super.setupOutput(builder, outputNode);
    const toCamera = cameraPosition.sub(positionWorld);
    const aerialRgb = this.treeEnvironment.aerialPerspective(
      outputNode.rgb,
      toCamera,
      toCamera.length(),
    );
    return vec4(aerialRgb, outputNode.a);
  }

  setupEnvironment(builder) {
    const environment = builder.environmentNode || this.envNode;
    return environment ? new EnvironmentNode(environment) : null;
  }

  setupLightingModel() {
    return new SharedEnvironmentTreePhongLightingModel();
  }
}

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
// Fix: collect EVERY sub-mesh into a prototype and build one GPU-indirect draw
// per source material. Foliage keeps the source PBR response under the production
// lighting system; TSL adds only restrained seeded variation.
// ---------------------------------------------------------------------------

// The fir source calls its opaque structural primitive `branches`; that part also
// contains the trunk. Treat only the alpha-cut twig/needle primitive as foliage.
// Classifying `branches` as foliage puffs and lowers the trunk independently from
// the crown, producing the torn-card / walk-through-under-canopy failure.
const _isFoliageName = (n = '') => /leaf|leaves|twig|needle|foliage|pine_canopy/i.test(n);
const _isAuthoredAlphaAtlas = (part) => /authored_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '')
  || /conifer_v[678]_macro_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '');
// Legacy candidate branches remain material-role gated. The v8 macro-atlas role
// is reviewed production data after promotion; v3's authored-alpha material and
// v4-v7 trial outputs retain their established paths.
const _isConiferV4Atlas = (part) => /conifer_v4_authored_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '');
const _isConiferV5Atlas = (part) => /conifer_v5_authored_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '');
const _isConiferV6Atlas = (part) => /conifer_v6_macro_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '');
const _isConiferV7Atlas = (part) => /conifer_v7_macro_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '');
const _isConiferV8Atlas = (part) => /conifer_v8_macro_alpha_atlas/i.test(part?.material?.name || part?.sourceName || '');
const _isConiferV8Prototype = (proto) => proto?.parts?.some(_isConiferV8Atlas) === true;
const _treeRoleForName = (n = '') => {
  if (_isFoliageName(n)) return 'foliage';
  if (/branch|deadwood|dead/i.test(n)) return 'branches';
  if (/trunk|bark|stem/i.test(n)) return 'trunk';
  return null;
};
const TREE_ROLE_ORDER = ['trunk', 'branches', 'foliage'];

const TREE_ALPHA_CUTOFF = 0.05;
// Atlas mip generation averages a source-authored 3–6 px trunk toward transparent
// at address distance. A lower far-only threshold preserves that real thin feature;
// geometry retains the crisper cutoff above.
const TREE_IMPOSTOR_ALPHA_CUTOFF = 0.06;
// At the 72–108m band, crowns are still large enough for any binary coverage
// transition to read as holes. Keep full geometry through the playable edge and
// move the GPU dual-list dissolve deeper into the tree line.
const TREE_LOD_NEAR = 10;
const TREE_LOD_FAR = 20;
// Distance alone is a poor proxy for tree silhouette error.  A 19 m fir at
// 120 m is still a large, perception-sensitive object in the fixed broadcast
// cameras, while a 5 m sapling at that same distance is not.  Keep modeled
// topology until its projected crown is genuinely small; these are NDC heights
// (projectionScale.y * world-height / camera distance), not camera-relative
// rings, so residency is stable under camera motion and FOV changes.
// Projected-size residency is shared by the GPU classifier and the synchronous
// lab estimate below.  These are deliberately conservative: source-derived
// geometry remains visible until the authored silhouette is small enough that
// the baked atlas can take over without a perceptible crown change.
// LOD1 is a source-derived mesh (56.2% of LOD0's indexed triangles), so its
// measured silhouette remains stable above this handoff. At the fixed 720 px
// camera this is about 270 px of full-tree height; keeping LOD0 through that
// measured band preserves hero and midground crown continuity.
const TREE_LOD0_PROJECTED_HEIGHT = 0.75;
// LOD1 remains resident while its measured branchlet/needle structure is
// readable. At the fixed 720 px production height this gate is about 2.9 px of
// fine structure (roughly 70–100 px of full-tree height), so the neutral atlas
// can take over background crowns without turning the near forest into cards.
const TREE_LOD1_PROJECTED_HEIGHT = 0.20;
const TREE_PROJECTED_STRUCTURE_RATIO = 0.03;
const TREE_IMPOSTOR_PROJECTED_STRUCTURE = 0.009;
// v8 is a source-derived, silhouette-validated candidate (98.1–98.4% LOD1
// coverage of LOD0). Only this candidate may hand off modeled geometry earlier;
// the production v3 and other candidate prototypes retain the global constants
// above. The .011 structure gate corresponds to .367 full-tree projected height
// (.011 / .03), about 132 px at the fixed 720 px evaluator projection.
const TREE_V8_LOD0_PROJECTED_HEIGHT = 1.0;
const TREE_V8_IMPOSTOR_PROJECTED_STRUCTURE = 0.011;

function treeResidencyThresholds(proto) {
  const candidateV8 = _isConiferV8Prototype(proto);
  return Object.freeze({
    candidate: candidateV8 ? 'conifer_v8' : 'production',
    lod0: candidateV8 ? TREE_V8_LOD0_PROJECTED_HEIGHT : TREE_LOD0_PROJECTED_HEIGHT,
    lod1: TREE_LOD1_PROJECTED_HEIGHT,
    projectedStructureRatio: TREE_PROJECTED_STRUCTURE_RATIO,
    impostorStructure: candidateV8 ? TREE_V8_IMPOSTOR_PROJECTED_STRUCTURE : TREE_IMPOSTOR_PROJECTED_STRUCTURE,
  });
}
// v8 atlas calibration, measured in the authored PNG before
// runtime lighting: bark tile-0 mean sRGB [72.76, 66.35, 56.51] => linear
// [0.0662, 0.0551, 0.0402]. The alpha>=16 needle population (excluding bark)
// has mean sRGB [65.28, 75.84, 38.14], median [67, 78, 38], and p90
// [93, 109, 58]; its median is linear [0.0561, 0.0762, 0.0194]. The prior
// sub-unity grades pushed this already-dark source below a plausible conifer
// reflectance. These bounded linear targets preserve the authored olive hue:
// bark target mean [0.080, 0.065, 0.048], needle target median [0.124, 0.168,
// 0.042]. The p90 remains below 1.0 in every channel after this normalization.
// Keep these constants scoped to the v8 atlas; shared PMREM, sun, and shadows
// remain the sole lighting response.
const CONIFER_CANDIDATE_BARK_SOURCE_LINEAR = Object.freeze([0.0662, 0.0551, 0.0402]);
const CONIFER_CANDIDATE_BARK_TARGET_LINEAR = Object.freeze([0.080, 0.065, 0.048]);
const CONIFER_CANDIDATE_NEEDLE_SOURCE_MEDIAN_LINEAR = Object.freeze([0.0561, 0.0762, 0.0194]);
const CONIFER_CANDIDATE_NEEDLE_TARGET_MEDIAN_LINEAR = Object.freeze([0.124, 0.168, 0.042]);
const CONIFER_CANDIDATE_BARK_LINEAR_NORMALIZATION = vec3(1.21, 1.18, 1.19);
const CONIFER_CANDIDATE_NEEDLE_LINEAR_NORMALIZATION = vec3(2.21, 2.21, 2.16);
// v8 response compression. The source median above is the measured
// linear target, not a baked light value: blending toward it keeps low-alpha
// interior needles from collapsing to black while pulling bright tips back into
// the same olive reflectance range. The restrained saturation grade preserves
// species chroma without making the HDR valley's green backdrop neon.
const CONIFER_CANDIDATE_NEEDLE_CONTRAST = 0.72;
const CONIFER_CANDIDATE_NEEDLE_SATURATION = 0.82;
// The production v3 catalog bounds are 8.687 m wide, 18.833 m tall, 8.616 m
// deep, with a 6.118 m horizontal bounding radius.  The classifier's sphere is
// centred at half height; add the authored 3.2% burial and a 1% wind allowance,
// then use the larger catalog-horizontal/vertical extent. This is a measured v3
// bound, rather than the former generic 0.78 * height pad that kept far-off trees
// resident and made the edge workload camera-insensitive.
const TREE_V3_BOUND_RADIUS = 6.118;
const TREE_V3_REFERENCE_HEIGHT = 18.833;
const TREE_FRUSTUM_RADIUS_RATIO = Math.max(
  TREE_V3_BOUND_RADIUS / TREE_V3_REFERENCE_HEIGHT,
  0.5 + 0.032 + 0.01,
);
// Albedo node for a foliage part. `tintNode` is the per-instance foliage tint.
function foliageColorNode(material, tintNode) {
  const baseRgb = material.map ? texture(material.map).rgb : materialColor;
  // Preserve the source PBR albedo and let the production lighting own every
  // highlight and underside. Seeded tint is intentionally subtle; the old full
  // tint + fake AO + emissive rim turned green leaves cream and their gaps black.
  // Catalog foliage is already a pale, scan-derived green. Keep variation
  // narrow and bias the response toward olive rather than multiplying a cool
  // mint tint through the PBR key/IBL twice. This is albedo shaping only; sky,
  // sun direction, shadows, and roughness remain renderer-owned.
  return saturation(baseRgb.mul(mix(vec3(1), tintNode, 0.22)), 0.78)
    .mul(vec3(0.80, 0.84, 0.56));
}

// Thin conifer needles transmit a small amount of sunward green when the source
// normal faces away from the sun and the camera sees the needle edge. This is a
// bounded wrap term, not emissive light: the material remains MeshStandard and
// its direct lobe/shadow map still gates the result. The horizon hue keeps the
// under-canopy return chromatic instead of turning to neutral charcoal.
function needleTransmissionFactor(needleNormalWorld, viewDirectionWorld, environment, foliageMask = null) {
  const sunFacingBack = needleNormalWorld.dot(environment.sunDirection).negate()
    .clamp(0, 1);
  // Crysis/SpeedTree-style transmission is strongest when the camera looks
  // toward the shared sun through a back-facing needle, not on every grazing
  // silhouette. This suppresses the lime edge response on side-lit tips while
  // retaining the physically plausible warm backlight direction.
  const sunToEye = viewDirectionWorld.dot(environment.sunDirection).clamp(0, 1);
  const backlit = smoothstep(0.12, 0.82, sunFacingBack);
  const mask = foliageMask ?? float(1);
  return backlit.mul(sunToEye.mul(0.72).add(0.10)).mul(mask)
    .mul(environment.sunIlluminanceScale.max(0)).mul(0.12).clamp(0, 0.12);
}

function needleTransmission(baseColor, transmissionFactor, environment) {
  // Keep the source albedo dominant. The shared sun supplies the slight warm
  // shift observed in real back-lit needles, while the horizon remains a
  // bounded chromatic return rather than a second light or fixed fill.
  const transmissionTint = environment.horizonColor.mul(0.36)
    .add(environment.sunColor.mul(0.64));
  return baseColor.mul(float(1).add(transmissionFactor.mul(0.20)))
    .add(transmissionTint.mul(transmissionFactor.mul(0.55)));
}

// Prepare a GLB material: correct diffuse colour space, two-sided thin cards, a
// hard alpha cutout (crisp canopy that still writes/casts shadow). GLTFLoader
// builds lit MeshStandard(Node)Materials with normal + ARM maps, so foliage is
// properly lit; the TSL foliage nodes are attached in the compacted draw path.
function prepMaterial(m) {
  m.side = DoubleSide;
  if (m.map) {
    m.map.colorSpace = SRGBColorSpace;
    m.alphaTest = Math.max(m.alphaTest || 0, TREE_ALPHA_CUTOFF);
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
//   parts:  [{ geometry, material, isFoliage, offsetY }],
//   height: number,   // native overall height (bbox)
//   baseY:  number,   // native ground offset (bbox.min.y)
// }
// `offsetY` remains explicit so all LODs share one transform contract.
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
    // Meshopt + KHR_mesh_quantization keep POSITION as normalized i16 and put the
    // decode scale/translation on the glTF node. BufferGeometry.applyMatrix4()
    // writes transformed values back through the original integer setter, where
    // anything outside [-1, 1] clips. The later instance scale then turns those
    // clipped faces into the enormous torn triangles seen at the tree edge.
    // Promote the decoded attribute before baking node transforms. This preserves
    // the exact source topology and leaves compact UV/normal attributes untouched.
    const sourcePosition = geometry.getAttribute('position');
    if (!(sourcePosition.array instanceof Float32Array)) {
      const decoded = new Float32Array(sourcePosition.count * sourcePosition.itemSize);
      for (let index = 0; index < sourcePosition.count; index++) {
        decoded[index * sourcePosition.itemSize] = sourcePosition.getX(index);
        decoded[index * sourcePosition.itemSize + 1] = sourcePosition.getY(index);
        decoded[index * sourcePosition.itemSize + 2] = sourcePosition.getZ(index);
      }
      geometry.setAttribute('position', new Float32BufferAttribute(decoded, sourcePosition.itemSize));
    }
    geometry.applyMatrix4(o.matrixWorld);
    geometry.computeBoundingBox();
    tmp.copy(geometry.boundingBox);
    bbox.union(tmp);

    // The v3 combined atlas is deliberately one canonical mesh/draw. Its
    // material carries authored alpha for foliage tiles but must not be treated
    // as a foliage-only part: doing so offsets/tints the opaque trunk too.
    const isFoliage = !_isAuthoredAlphaAtlas({ material: o.material, sourceName: o.material?.name })
      && (_isFoliageName(o.material && o.material.name) || _isFoliageName(o.name));
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(prepMaterial);
    const role = _isAuthoredAlphaAtlas({ material: o.material, sourceName: o.material?.name })
      ? 'combined-authored-alpha'
      : _treeRoleForName(o.material?.name || o.name || '');
    parts.push({
      geometry,
      material: o.material,
      isFoliage,
      role,
      // Keep a stable semantic tag with the source part. LOD compatibility is
      // checked below by role, not by whichever primitive order a GLB exporter
      // happened to emit.
      sourceName: o.material?.name || o.name || `part-${parts.length}`,
      offsetY: 0,
    });
  });
  if (!parts.length) throw new Error('no meshes in ' + url);

  // Exporters are free to emit primitives in material/database order.  The
  // GPU indirect layout is not: command 0 is trunk, command 1 is branches,
  // command 2 is opaque modeled foliage. Reorder only when all three semantic
  // roles are explicit and unique; legacy catalog trees without that contract
  // retain their authored traversal order and still use the foliage predicate.
  const roles = parts.map((part) => part.role);
  if (parts.length === TREE_ROLE_ORDER.length
    && roles.every(Boolean)
    && new Set(roles).size === TREE_ROLE_ORDER.length) {
    parts.sort((a, b) => TREE_ROLE_ORDER.indexOf(a.role) - TREE_ROLE_ORDER.indexOf(b.role));
  }

  const size = bbox.getSize(new Vector3());
  const height = size.y;
  // Scanned trees commonly retain a sparse spray of root/registration fragments
  // below the opaque trunk flare.  bbox.min.y is therefore not a reliable planting
  // datum: putting that one outlier on terrain leaves the actual trunk suspended.
  // Resolve a robust structural base from the lowest five percent of non-foliage
  // vertices.  The same datum is carried by every source-derived LOD, so a handoff
  // cannot change where the planted tree meets the ground.
  const structuralY = [];
  for (const part of parts) {
    if (part.isFoliage) continue;
    const position = part.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) structuralY.push(position.getY(index));
  }
  structuralY.sort((a, b) => a - b);
  const plantBaseY = structuralY.length
    ? structuralY[Math.min(structuralY.length - 1, Math.floor(structuralY.length * 0.05))]
    : bbox.min.y;
  // Lower the scan's unusually high first branch tier into the trunk silhouette.
  for (const part of parts) if (part.isFoliage) part.offsetY = -height * 0.075;
  return { parts, height, baseY: bbox.min.y, plantBaseY };
}

// Near and middle representations must have the same material-part contract.
// A decimator is allowed to change topology and index counts, but silently
// pairing a trunk primitive with a foliage material (or vice versa) produces the
// exact detached-crown / dark-silhouette failure this path is intended to avoid.
function assertCompatibleTreeLods(near, middle) {
  if (near.parts.length !== middle.parts.length) {
    throw new Error(`Tree LOD topology mismatch: ${near.parts.length} near parts, ${middle.parts.length} middle parts.`);
  }
  near.parts.forEach((part, index) => {
    const other = middle.parts[index];
    if (part.isFoliage !== other.isFoliage) {
      throw new Error(`Tree LOD topology mismatch at part ${index}: foliage role changed.`);
    }
    if (part.role && other.role && part.role !== other.role) {
      throw new Error(`Tree LOD topology mismatch at part ${index}: ${part.role} paired with ${other.role}.`);
    }
    const nearIndexCount = part.geometry.index?.count ?? 0;
    const middleIndexCount = other.geometry.index?.count ?? 0;
    if (!nearIndexCount || !middleIndexCount) {
      throw new Error(`Tree LOD topology mismatch at part ${index}: indexed geometry required.`);
    }
  });
}

function middleLodUsable(near, middle) {
  // The canonical one-draw derivative deliberately folds trunk, branch, and
  // crown geometry into one vertex-coloured primitive. It has no foliage-tagged
  // sub-mesh to inspect, so validate its retained indexed topology directly.
  if (near.parts.length === 1 && middle.parts.length === 1) {
    const nearIndices = near.parts[0].geometry.index?.count ?? 0;
    const middleIndices = middle.parts[0].geometry.index?.count ?? 0;
    return nearIndices > 0 && middleIndices / nearIndices >= 0.08;
  }
  // Aggregate budgets are unsafe: a trunk/branch primitive can make a derivative
  // look sufficiently large while its canopy has collapsed to a lace of twigs.
  // Check each semantic role independently and require materially more foliage
  // retention than the old 1% total-index heuristic. A malformed middle asset is
  // rejected closed; the renderer never presents a sparse crown as a valid LOD.
  const foliage = near.parts
    .map((part, index) => ({ near: part, middle: middle.parts[index] }))
    .filter(({ near }) => near.isFoliage);
  if (!foliage.length) return false;
  return foliage.every(({ near, middle }) => {
    const nearIndices = near.geometry.index?.count ?? 0;
    const middleIndices = middle.geometry.index?.count ?? 0;
    return nearIndices > 0 && middleIndices / nearIndices >= 0.08;
  });
}

// Load the catalog-authored far representation. Integrity is verified by the
// catalog loader before this point; this stage validates GPU layout metadata and
// configures stable minification for the 8-view atlas.
export async function loadTreeImpostor(impostor) {
  if (impostor?.kind !== 'baked-atlas') throw new Error('Tree impostor must be a verified baked-atlas catalog derivative.');
  const atlas = await _textureLoader.loadAsync(impostor.url);
  const expectedWidth = impostor.columns * impostor.frameSize;
  const expectedHeight = impostor.rows * impostor.frameSize;
  if (atlas.image?.width !== expectedWidth || atlas.image?.height !== expectedHeight) {
    atlas.dispose();
    throw new Error(`Tree impostor atlas dimensions must be ${expectedWidth}x${expectedHeight}.`);
  }
  atlas.name = 'catalog-tree-baked-impostor-atlas';
  atlas.colorSpace = SRGBColorSpace;
  // An atlas has no inter-frame gutter. Hardware mip generation averages the
  // top of a neighboring view into the transparent border, which produced the
  // detached black crown blobs at distance and jitter-dependent alpha coverage.
  // The 512px source frame remains amply oversampled for the far card; TRAA owns
  // its subpixel reconstruction.
  atlas.minFilter = LinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.wrapS = ClampToEdgeWrapping;
  atlas.wrapT = ClampToEdgeWrapping;
  atlas.generateMipmaps = false;
  atlas.anisotropy = 8;
  atlas.needsUpdate = true;
  return atlas;
}

// Clone a foliage material and attach restrained per-instance TSL tint. Cloned per
// compacted material so its source tint node is unique.
function makeFoliageMaterial(base, tintNode, baseColor = null) {
  const m = base.clone();
  m.colorNode = baseColor ?? foliageColorNode(m, tintNode);
  // colorNode replaces the whole diffuse pipeline, including the map's alpha —
  // so re-wire the leaf texture's alpha as opacity or the alphaTest cutout that
  // carves leaf shapes out of the cards is lost (canopy renders as bare branches).
  if (m.map) {
    // Source-derived v3 foliage carries the official Poly Haven alpha map
    // embedded in the RGBA atlas. Preserve that authored coverage after
    // replacing colorNode; RGB-threshold heuristics turn transparent card
    // gutters into the opaque triangular halves seen in close views.
    const texel = texture(m.map);
    // Keep authored alpha continuous and let the fixed alpha test perform the
    // single discard. A compare/select here duplicated that branch in the
    // fragment graph for every needle texel without improving coverage.
    m.opacityNode = texel.a;
    m.alphaTest = TREE_ALPHA_CUTOFF;
  }
  m.needsUpdate = true;
  return m;
}

// Build immutable authoring records for the unified tree beauty path. Static
// placement/variation is authored once; the GPU alone chooses source-derived LOD0
// or the offline source-baked impostor every frame. No procedural species or
// runtime billboard substitute is created by the renderer.
function makeTreeBeautyRecords(proto, placements, seed) {
  const transform = [];
  const hero = [];
  const style = [];
  const shadowRecords = [];
  const color = new Color();
  let stableId = 0;
  const append = (p, random) => {
    const scale = p.targetHeight / proto.height;
    const h = p.targetHeight;
    // Plant the entire rigid source (trunk, branches, and every LOD) slightly
    // into the sampled ground.  The extra burial is proportional to authored
    // height, so saplings and mature firs retain the same visual contact ratio;
    // all representations inherit this one baseY and cannot float differently at
    // a LOD handoff.  This is geometric grounding, never an alpha/contact effect.
    // Give the flare enough overlap to remain solid against the 0.6 m terrain
    // triangles at oblique views.  This lowers the whole rigid source by ~0.6 m
    // for a mature 19 m fir; it does not stretch the trunk or detach the crown.
    const baseY = p.y - proto.plantBaseY * scale - h * 0.032;
    const authoredYaw = p.rotY ?? random() * Math.PI * 2;
    // Placement yaw remains the primary authoring signal, with a small seeded
    // offset to stop a distributed edge community reading as a ruler row. The
    // offset is fixed in the source record, so geometry, cards, and shadows agree
    // across frames and LOD bands.
    const rotY = authoredYaw + (random() - 0.5) * 0.18;
    // Keep the scan-derived prototype rigid. Per-part procedural lean made the
    // decimated modeled-needle primitive expose long back-facing triangles in
    // the close LOD path. Authored yaw, height/age classes, crown width and the
    // asymmetric community placement already provide stable stance variation.
    const leanX = 0;
    const leanZ = 0;
    foliageTint(color, random);
    // Transform.w is authoritative authored metres for frustum bounds; hero.w is
    // the shared native-geometry scale for both catalog LOD derivatives.
    transform.push(p.x, baseY, p.z, h);
    hero.push(rotY, leanX, leanZ, scale);
    // RGB8 is exact in one f32 up to 2^24-1. That keeps the compact shader at the
    // portable WebGPU storage-binding limit while retaining the authored tint.
    const packedTint = Math.round(color.r * 255) + Math.round(color.g * 255) * 256 + Math.round(color.b * 255) * 65536;
    // Keep two deterministic age/width controls beside the packed tint.  They
    // are immutable source records (not per-frame noise), so a tree never
    // changes silhouette while the camera crosses a LOD boundary.
    // z is a crown-width class and w is a mature-crown class. Keeping these in the
    // immutable record makes age variation visible without changing draw count or
    // introducing camera-relative noise.
    style.push(stableId++, packedTint, random(), random());
    shadowRecords.push(p.x, baseY, p.z, h);
  };

  const primaryRandom = createRng(deriveSeed(seed, 'tree-primary'));
  for (const p of placements) append(p, primaryRandom);
  if (!stableId || !shadowRecords.length) throw new Error('TreeBeautyLod requires non-empty catalog tree records.');
  return {
    transform: new Float32Array(transform),
    hero: new Float32Array(hero),
    style: new Float32Array(style),
    shadowRecords: new Float32Array(shadowRecords),
  };
}

// Three fixed GPU-indirect beauty draws for every tree source: one canonical
// primitive each from catalog LOD0 and LOD1, plus one 8-view source atlas card.
// There is no CPU near/far split, procedural species, runtime-baked substitute,
// per-frame upload, or readback. Source slots retain stable IDs while output slots
// compact and reorder independently.
export class TreeBeautyLod {
  constructor({ renderer, camera, motionHistory, environment, proto, midProto, impostor, impostorTexture, placements, seed, lodNear = TREE_LOD_NEAR, lodFar = TREE_LOD_FAR }) {
    if (!renderer?.isWebGPURenderer) throw new Error('TreeBeautyLod requires WebGPU; no compatibility tree path exists.');
    if (!camera) throw new Error('TreeBeautyLod requires the active camera.');
    if (!motionHistory) throw new Error('TreeBeautyLod requires SceneManager motion history for TRAA velocity.');
    if (!(environment instanceof EnvironmentGpuBindings)) throw new Error('TreeBeautyLod requires shared EnvironmentGpuBindings.');
    if (!proto?.parts?.length) throw new Error('TreeBeautyLod requires a catalog LOD0 prototype with at least one part.');
    if (!midProto?.parts?.length) throw new Error('TreeBeautyLod requires a catalog LOD1 prototype with at least one part.');
    assertCompatibleTreeLods(proto, midProto);
    // A prototype may be one combined authored-alpha atlas primitive or a set of
    // semantic role primitives (trunk / branches / foliage). Role-split sources keep
    // each role's own texture at its authored resolution and tiling, which a single
    // combined bake cannot preserve. The indirect layout therefore scales with the
    // part count: LOD0 parts, then LOD1 parts, then the one impostor card.
    this.partCount = proto.parts.length;
    this.useMiddleLod = middleLodUsable(proto, midProto);
    // Candidate residency is selected from the authored prototype material, not
    // from distance or a runtime visual heuristic. Production v3 and v4-v7 keep
    // the exact global projected-size policy; only the silhouette-validated v8
    // candidate gets its bounded handoff values.
    this.residencyThresholds = treeResidencyThresholds(proto);
    if (impostor?.kind !== 'baked-atlas' || !impostorTexture?.isTexture) throw new Error('TreeBeautyLod requires the catalog-baked impostor atlas.');
    if (!Number.isFinite(lodNear) || !Number.isFinite(lodFar) || lodNear <= 0 || lodFar <= lodNear) {
      throw new Error('TreeBeautyLod requires ascending positive GPU LOD distances.');
    }
    const records = makeTreeBeautyRecords(proto, placements, normalizeSeed(seed));
    this.group = new Group();
    this.group.name = 'trees-gpu-camera-relative';
    this.renderer = renderer;
    this.camera = camera;
    this.motionHistory = motionHistory;
    this.environment = environment;
    this.impostor = impostor;
    this.impostorTexture = impostorTexture;
    this.sourceCount = records.transform.length / 4;
    this.shadowRecords = records.shadowRecords;
    this.uCameraPosition = uniform(camera.position.clone());
    this.uViewProjection = uniform(new Matrix4());
    this.uProjectionScale = uniform(new Vector2(1, 1));
    // Tier policy changes only these uniform thresholds. All devices execute the
    // exact same compacted source-LOD topology and shader graph.
    this.uLodNear = uniform(lodNear);
    this.uLodFar = uniform(lodFar);
    // The existing device-tier values remain the minimum distance residency. The
    // classifier below extends them for tall / nearby silhouettes using apparent
    // size, so a 19 m fir cannot become a cutout card merely because it is outside
    // a short fixed radius.
    // The only distance cutoff is the active camera's authoritative far plane.
    // An arbitrary 520 m LOD cap would pop in clear/foggy conditions differently.
    this._sourceTransform = storage(new StorageBufferAttribute(records.transform, 4), 'vec4', this.sourceCount).toReadOnly();
    this._sourceHero = storage(new StorageBufferAttribute(records.hero, 4), 'vec4', this.sourceCount).toReadOnly();
    this._sourceStyle = storage(new StorageBufferAttribute(records.style, 4), 'vec4', this.sourceCount).toReadOnly();
    // Zero-based compact ID lists are portable: indirect firstInstance remains 0
    // on every draw. Vertex shaders dereference the immutable source streams.
    this._visibleLod0 = storage(new StorageInstancedBufferAttribute(new Uint32Array(this.sourceCount), 1, Uint32Array), 'uint', this.sourceCount);
    this._visibleLod1 = storage(new StorageInstancedBufferAttribute(new Uint32Array(this.sourceCount), 1, Uint32Array), 'uint', this.sourceCount);
    this._visibleImpostor = storage(new StorageInstancedBufferAttribute(new Uint32Array(this.sourceCount), 1, Uint32Array), 'uint', this.sourceCount);
    // Indexed indirect layout: one command per LOD0 part, one per LOD1 part, then
    // one atlas quad — five words each. The classifier increments a single counter
    // per band (the first command of the band); finalize broadcasts it to that
    // band's sibling parts so every role of a tree draws the same instance set.
    this._commandCount = this.partCount * 2 + 1;
    this._lod0CountWord = 1;
    this._lod1CountWord = this.partCount * 5 + 1;
    this._impostorCountWord = this.partCount * 10 + 1;
    const drawArgWords = this._commandCount * 5;
    this._drawArgsAttr = new IndirectStorageBufferAttribute(new Uint32Array(drawArgWords), 5);
    this._drawArgs = storage(this._drawArgsAttr, 'uint', drawArgWords).toAtomic();
    // Header (16 words) + one atomic membership word per source. Bits: LOD0=1,
    // LOD1=2, impostor=4, rejected=8. Transition sources contain adjacent bits.
    this._diagnosticAttr = new StorageBufferAttribute(new Uint32Array(16 + this.sourceCount), 1, Uint32Array);
    this._diagnostic = storage(this._diagnosticAttr, 'uint', 16 + this.sourceCount).toAtomic();
    this._clearCompute = this._buildClearCompute(proto, midProto);
    this._compactCompute = this._buildCompactCompute();
    this._finalizeCompute = this._buildFinalizeCompute(proto, midProto);
    this._clearCompute.name = 'Tree beauty GPU reset';
    this._compactCompute.name = 'Tree beauty camera-relative LOD compact';
    this._finalizeCompute.name = 'Tree beauty indirect finalize';
    this._addGeometryMeshes(proto, this._visibleLod0, 0, 'lod0');
    this._addGeometryMeshes(midProto, this._visibleLod1, this.partCount, 'lod1');
    this._addImpostorMesh();
  }

  // Index counts for every indirect command, in layout order: LOD0 parts, LOD1
  // parts, then the six-index impostor quad.
  _commandIndexCounts(proto, midProto) {
    const counts = [
      ...proto.parts.map((part) => part.geometry.index?.count ?? 0),
      ...midProto.parts.map((part) => part.geometry.index?.count ?? 0),
      6,
    ];
    if (counts.some((count) => count <= 0)) throw new Error('TreeBeautyLod requires indexed hero geometry.');
    return counts;
  }

  _buildClearCompute(proto, midProto) {
    const args = this._drawArgs;
    const diagnostics = this._diagnostic;
    const counts = this._commandIndexCounts(proto, midProto);
    return Fn(() => {
      const id = uint(instanceIndex);
      If(id.lessThan(uint(this.sourceCount)), () => {
        atomicStore(diagnostics.element(uint(16).add(id)), uint(0));
      });
      If(id.lessThan(uint(16)), () => { atomicStore(diagnostics.element(id), uint(0)); });
      If(id.equal(uint(0)), () => {
        for (let command = 0; command < counts.length; command++) {
          const base = command * 5;
          atomicStore(args.element(uint(base)), uint(counts[command]));
          atomicStore(args.element(uint(base + 1)), uint(0));
          atomicStore(args.element(uint(base + 2)), uint(0));
          atomicStore(args.element(uint(base + 3)), uint(0));
          atomicStore(args.element(uint(base + 4)), uint(0));
        }
      });
    })().compute(Math.max(this.sourceCount, 16));
  }

  _buildFinalizeCompute(proto, midProto) {
    const args = this._drawArgs;
    const diagnostics = this._diagnostic;
    const counts = this._commandIndexCounts(proto, midProto);
    const parts = this.partCount;
    return Fn(() => {
      const lod0Count = atomicLoad(args.element(uint(this._lod0CountWord)));
      const lod1Count = atomicLoad(args.element(uint(this._lod1CountWord)));
      const impostorCount = atomicLoad(args.element(uint(this._impostorCountWord)));
      for (let command = 0; command < counts.length; command++) {
        const base = command * 5;
        atomicStore(args.element(uint(base)), uint(counts[command]));
        // Sibling parts of one band share the band's compacted instance list, so
        // they must draw the same instance count. Only the band's first command
        // carries the atomic counter; the rest are written here.
        const bandCount = command < parts ? lod0Count : (command < parts * 2 ? lod1Count : impostorCount);
        atomicStore(args.element(uint(base + 1)), bandCount);
        atomicStore(args.element(uint(base + 2)), uint(0));
        atomicStore(args.element(uint(base + 3)), uint(0));
        atomicStore(args.element(uint(base + 4)), uint(0));
      }
      // Fixed capacity is the total source count per category. Any overrun is a
      // hard diagnostic failure; it is never clamped into a partial forest.
      If(lod0Count.greaterThan(uint(this.sourceCount)), () => { atomicStore(diagnostics.element(uint(6)), uint(1)); });
      If(lod1Count.greaterThan(uint(this.sourceCount)), () => { atomicStore(diagnostics.element(uint(7)), uint(1)); });
      If(impostorCount.greaterThan(uint(this.sourceCount)), () => { atomicStore(diagnostics.element(uint(8)), uint(1)); });
    })().compute(1);
  }

  _buildCompactCompute() {
    const sourceTransform = this._sourceTransform;
    const sourceHero = this._sourceHero;
    const sourceStyle = this._sourceStyle;
    const visibleLod0 = this._visibleLod0;
    const visibleLod1 = this._visibleLod1;
    const visibleImpostor = this._visibleImpostor;
    const args = this._drawArgs;
    const diagnostics = this._diagnostic;
    const cameraPosition = this.uCameraPosition;
    const viewProjection = this.uViewProjection;
    const projectionScale = this.uProjectionScale;
    const lodNear = this.uLodNear;
    const lodFar = this.uLodFar;
    const residency = this.residencyThresholds;
    // The authored tier's far value is a conservative residency budget. End
    // modeled middle geometry slightly before it so its long, shadowed trunk
    // triangles cannot become a screen-space black strip at the edge; the
    // runtime-lit atlas owns the final part of the transition.
    const lodFarEffective = lodFar.mul(0.9);
    return Fn(() => {
      const id = uint(instanceIndex);
      const transform = sourceTransform.element(id);
      const hero = sourceHero.element(id);
      const style = sourceStyle.element(id);
      const h = transform.w;
      const centre = viewProjection.mul(vec4(transform.x, transform.y.add(h.mul(0.5)), transform.z, 1.0));
      const dx = transform.x.sub(cameraPosition.x);
      const dy = transform.y.add(h.mul(0.5)).sub(cameraPosition.y);
      const dz = transform.z.sub(cameraPosition.z);
      const radius = h.mul(TREE_FRUSTUM_RADIUS_RATIO);
      // All WebGPU clip planes, with a conservative sphere and a small jitter pad.
      // Camera far is represented by the clip-Z plane; a Euclidean sphere cutoff
      // is neither equivalent nor used here.
      const pad = radius.mul(max(projectionScale.x, projectionScale.y)).add(centre.w.mul(0.003));
      const inFrustum = centre.x.abs().lessThanEqual(centre.w.add(pad))
        .and(centre.y.abs().lessThanEqual(centre.w.add(pad)))
        .and(centre.z.greaterThanEqual(pad.negate()))
        .and(centre.z.lessThanEqual(centre.w.add(pad)));
      If(centre.w.lessThanEqual(0.0), () => {
        atomicAdd(diagnostics.element(uint(0)), uint(1));
        atomicOr(diagnostics.element(uint(16).add(id)), uint(8));
      }).Else(() => {
        If(inFrustum, () => {
          // Camera position is unjittered. Source-derived geometry/card boundaries
          // are exclusive: translucent overlap made the darker card protrude beyond
          // geometry crowns and introduced jitter-sensitive temporal coverage.
          const distance = dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz)).sqrt();
          // Exclusive bands: full source topology in the foreground, source-
          // derived middle geometry through the perception-sensitive projected
          // size, and one runtime-lit atlas card only once its silhouette error
          // is small. A source can set exactly one membership bit. This apparent
          // size test is essential for the fixed course cameras: distance-only
          // residency put every production tree on the atlas card band.
          const projectedHeight = h.mul(projectionScale.y).div(max(distance, float(1.0)));
          const farBand = distance.greaterThanEqual(lodFarEffective);
          const nearBand = distance.lessThan(lodNear)
            .or(projectedHeight.greaterThan(float(residency.lod0)));
          // The full tree height is not its perception-sensitive structure. The
          // sparse branchlet/needle detail occupies about 3% of authored height;
          // cards are admitted only when that band is below ~2.9 px at 720p;
          // full-tree height is deliberately not used as a second gate because
          // a 70–100 px crown can still have sub-3 px branchlet structure.
          const projectedStructure = projectedHeight.mul(float(TREE_PROJECTED_STRUCTURE_RATIO));
          const middleDistanceBand = distance.greaterThanEqual(lodNear)
            .and(distance.lessThan(lodFarEffective));
          const cardEligible = distance.greaterThanEqual(lodNear)
            .and(projectedStructure.lessThanEqual(float(residency.impostorStructure)));
          const middleBand = nearBand.not().and(cardEligible.not()).and(
            middleDistanceBand
              .or(farBand)
              .or(projectedHeight.greaterThan(float(residency.lod1))),
          );
          const impostorBand = nearBand.not().and(middleBand.not()).and(cardEligible);
          If(uint(this.useMiddleLod ? 0 : 1).equal(uint(1))
            .or(nearBand), () => {
            const dst = atomicAdd(args.element(uint(this._lod0CountWord)), uint(1));
            If(dst.lessThan(uint(this.sourceCount)), () => { visibleLod0.element(dst).assign(id); }).Else(() => { atomicStore(diagnostics.element(uint(6)), uint(1)); });
            atomicOr(diagnostics.element(uint(16).add(id)), uint(1));
          });
          // Keep modeled middle silhouettes beyond the nominal distance ring when
          // their fine structure is still readable; only the subpixel card gate
          // may replace them.
          If(uint(this.useMiddleLod ? 1 : 0).equal(uint(1)).and(middleBand), () => {
            const dst = atomicAdd(args.element(uint(this._lod1CountWord)), uint(1));
            If(dst.lessThan(uint(this.sourceCount)), () => { visibleLod1.element(dst).assign(id); }).Else(() => { atomicStore(diagnostics.element(uint(7)), uint(1)); });
            atomicOr(diagnostics.element(uint(16).add(id)), uint(2));
          });
          // Every visible source belongs to exactly one exclusive band. The
          // explicit cardEligible predicate avoids gaps for far silhouettes that
          // are still too large for their baked atlas representation.
          If(uint(this.useMiddleLod ? 1 : 0).equal(uint(1)).and(impostorBand), () => {
            const dst = atomicAdd(args.element(uint(this._impostorCountWord)), uint(1));
            If(dst.lessThan(uint(this.sourceCount)), () => { visibleImpostor.element(dst).assign(id); }).Else(() => { atomicStore(diagnostics.element(uint(8)), uint(1)); });
            atomicOr(diagnostics.element(uint(16).add(id)), uint(4));
            atomicAdd(diagnostics.element(uint(4)), uint(1));
          });
        }).Else(() => {
          atomicAdd(diagnostics.element(uint(1)), uint(1));
          atomicOr(diagnostics.element(uint(16).add(id)), uint(8));
        });
      });
    })().compute(this.sourceCount);
  }

  _addGeometryMeshes(proto, visibleIds, firstCommand, label) {
    // The band is named, not inferred from the command offset: with role-split
    // prototypes LOD1's first command is `partCount`, so an offset test would
    // silently give a multi-part middle LOD the full LOD0 shading path.
    const middleLod = label === 'lod1';
    proto.parts.forEach((part, command) => {
      // Each prototype part has exactly one compacted hero consumer. Transfer the
      // loaded geometry rather than cloning it, keeping the draw-path delta below
      // the environment memory gate and making TreeBeautyLod its sole owner.
      const geometry = part.geometry;
      geometry.setIndirect(this._drawArgsAttr, (firstCommand + command) * 20);
      const material = this._geometryMaterial(part, proto, visibleIds, middleLod);
      const mesh = new Mesh(geometry, material);
      mesh.name = `tree-catalog-${label}-gpu-indirect-${command}`;
      mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = false;
      // Bands are exclusive and no alpha dissolve is used, so velocity and depth
      // remain unambiguous to TRAA at every handoff.
      mesh.renderOrder = 1;
      this.group.add(mesh);
    });
  }

  _geometryMaterial(part, nativeProto, visibleIds, middleLod = false) {
    const sourceId = visibleIds.toAttribute();
    const transform = this._sourceTransform.element(sourceId);
    const hero = this._sourceHero.element(sourceId);
    const style = this._sourceStyle.element(sourceId);
    const packedTint = style.y;
    const tint = vec3(packedTint.mod(256.0).div(255.0), packedTint.div(256.0).floor().mod(256.0).div(255.0), packedTint.div(65536.0).floor().mod(256.0).div(255.0));
    // The authored v3 catalog has zero leanX/leanZ. Keep the instance transform
    // explicit and cheap: yaw is the only rotational degree of freedom. This
    // also guarantees that the normal and position paths share exactly the same
    // rigid frame, avoiding the subtle normal drift of a three-axis reconstruction.
    const yawCos = hero.x.cos();
    const yawSin = hero.x.sin();
    const rotateYaw = (v) => vec3(
      v.x.mul(yawCos).add(v.z.mul(yawSin)),
      v.y,
      v.x.mul(yawSin).negate().add(v.z.mul(yawCos)),
    );
    // This is Object3D Euler XYZ exactly: R*(S*local) + base translation +
    // world-Y(part.offsetY*S). The foliage overlap offset is not rotated.
    // Apply one rigid source transform to every semantic primitive. Expanding
    // foliage independently from trunk/branches tears their shared silhouette
    // and magnifies any long triangles left by offline decimation.
    const heightFraction = positionGeometry.y.sub(nativeProto.baseY).div(nativeProto.height).clamp(0, 1);
    // Source crowns are naturally irregular; deterministic width and maturity
    // classes keep the edge from reading as cloned ruler posts while the lower
    // trunk remains on its exact authored silhouette. Mature firs gain volume in
    // the middle canopy, but the top and root stay close to the licensed source
    // shape so the result still reads as conifer rather than a broadleaf proxy.
    const mature = smoothstep(float(8.0), float(15.0), transform.w);
    // The scanned fir is intentionally sparse at its native width.  A modest
    // licensed-geometry expansion restores a believable mature crown mass while
    // retaining the source topology, trunk, and branch structure.  Variation is
    // deterministic per record, so communities do not become identical cones.
    // Source-extracted v3 already carries its authored crown radius in the
    // branchlet scaffold. Applying the old canonical expansion to textured
    // cards multiplied local branchlet offsets into broad triangular shelves.
    // Keep procedural/color-only legacy derivatives varied, but preserve the
    // measured v3 source-derived volume rigidly.
    const crownWidth = part.material?.map
      ? float(1.0)
      : mix(float(2.15), float(2.85), style.z).mul(mix(float(1.0), float(1.16), mature));
    const coniferV4 = _isConiferV4Atlas(part);
    const coniferV5 = _isConiferV5Atlas(part);
    const coniferV6 = _isConiferV6Atlas(part);
    const coniferV7 = _isConiferV7Atlas(part);
    const coniferV8 = _isConiferV8Atlas(part);
    const crownMask = smoothstep(float(0.27), float(0.46), heightFraction);
    const crownMiddle = smoothstep(float(0.30), float(0.48), heightFraction)
      .mul(float(1).sub(smoothstep(float(0.74), float(0.98), heightFraction)));
    const crownProfile = crownMask.add(crownMiddle.mul(0.24)).clamp(0, 1);
    const radialScale = mix(float(1), crownWidth, crownProfile);
    const localPosition = positionGeometry;
    const heightClass = mix(float(0.94), float(1.08), style.w);
    const crownHeight = mix(float(1), heightClass, smoothstep(float(0.18), float(0.38), heightFraction));
    const scaledY = localPosition.y.sub(nativeProto.baseY).mul(crownHeight).add(nativeProto.baseY);
    const scaledLocalPosition = vec3(localPosition.x.mul(radialScale), scaledY, localPosition.z.mul(radialScale));
    const scaledSource = scaledLocalPosition.mul(hero.w);
    const staticWorld = rotateYaw(scaledSource).add(transform.xyz).add(vec3(0, part.offsetY, 0).mul(hero.w));
    const bendWeight = heightFraction.pow(1.7).mul(transform.w).mul(0.004);
    // Wind is a field sampled at the instance root, not once per vertex's world
    // position. Besides removing a large amount of redundant shader work, this
    // keeps one tree's crown in a coherent gust while the height weight supplies
    // the authored bend profile.
    const currentWind = this.environment.windAt(transform.xyz, this.environment.time);
    const previousWind = this.environment.windAt(transform.xyz, this.environment.previousTime);
    const world = staticWorld.add(vec3(currentWind.x, 0, currentWind.z).mul(bendWeight));
    const previousWorld = staticWorld.add(vec3(previousWind.x, 0, previousWind.z).mul(bendWeight));
    const needleNormalWorld = rotateYaw(normalLocal).normalize();
    // v4 branchlet tiles are local source sprays, not broad tree cards. Blend a
    // bounded outward parent-puffiness normal into those tiles only, leaving
    // tile 0 (structural bark) on its authored source normal. This changes the
    // shared-light response, never the albedo into painted illumination.
    const v4AtlasUv = uv();
    const v4BarkTile = v4AtlasUv.x.lessThan(0.25).and(v4AtlasUv.y.lessThan(0.25));
    const v4BranchletTile = v4BarkTile.not();
    const v4ParentOutward = vec3(
      positionGeometry.x,
      positionGeometry.y.sub(float(nativeProto.baseY)).mul(0.12),
      positionGeometry.z,
    ).normalize();
    const v4NormalLocal = v4BranchletTile.select(
      normalLocal.mul(0.64).add(v4ParentOutward.mul(0.36)).normalize(),
      normalLocal,
    );
    const v4NeedleNormalWorld = rotateYaw(v4NormalLocal).normalize();
    const macroClusterAtlas = coniferV4 || coniferV6 || coniferV7 || coniferV8;
    const shadingNormalWorld = macroClusterAtlas ? v4NeedleNormalWorld : needleNormalWorld;
    // Source normals are unit-length and yaw is orthonormal. The cheap LOD1
    // daylight response only needs the shared sun-facing term, so avoid a
    // per-vertex normalize there; retain the normalized node for LOD0's PBR
    // normal response and transmission path.
    const cheapNeedleNormalWorld = rotateYaw(normalLocal);
    const viewNormal = needleNormalWorld.transformDirection(cameraViewMatrix).normalize();
    const v4ViewNormal = v4NeedleNormalWorld.transformDirection(cameraViewMatrix).normalize();
    const shadingViewNormal = macroClusterAtlas ? v4ViewNormal : viewNormal;
    const cheapShadingNormalWorld = macroClusterAtlas ? v4NeedleNormalWorld : cheapNeedleNormalWorld;
    // Transmission is evaluated once in the vertex stage and interpolated over
    // the canopy. The old color-node graph normalized the same sun/needle/view
    // vectors for every fragment (and rebuilt the foliage albedo graph twice),
    // which made the tree draw disproportionately expensive at the edge.
    const transmissionFactor = (foliageMask = null) => {
      const viewDirectionWorld = cameraPosition.sub(staticWorld).normalize();
      return needleTransmissionFactor(shadingNormalWorld, viewDirectionWorld, this.environment, foliageMask)
        .toVarying('vTreeNeedleTransmission');
    };
    // v8 is now the reviewed production catalog derivative. Keep v7's trial
    // branch available for A/B fixtures, but select promoted v8 explicitly by
    // its authored material role so production cannot fall back to the older
    // v3-v6 shading path when its catalog URL leaves trees_candidates.
    const v8ProductionPhongAtlas = coniferV8 && part.material.map;
    const candidatePhongAtlas = (coniferV7 && part.material.map) || v8ProductionPhongAtlas;
    const cheapMiddleAtlas = middleLod && _isAuthoredAlphaAtlas(part)
      && !candidatePhongAtlas && part.material.map;
    let material = part.isFoliage || cheapMiddleAtlas ? null : part.material.clone();
    if (cheapMiddleAtlas) {
      // LOD1 is a source-derived silhouette but its atlas primitive is a
      // combined bark/needle material, so it cannot retain a separate trunk PBR
      // branch. Use a shared vertex-lit, explicitly non-PBR middle path; LOD0
      // keeps the full MeshStandard response. The bake contract gives tile 0 a
      // structural bark albedo and tiles 1–15 source-alpha needle sprays, so
      // grade those roles separately instead of turning the whole atlas green.
      const texel = texture(part.material.map);
      const atlasUv = uv();
      const barkTile = atlasUv.x.lessThan(0.25).and(atlasUv.y.lessThan(0.25));
      // Resolve the authored semantic role at the vertex and interpolate one
      // scalar instead of a vec3 grade. Reconstructing the two fixed grades in
      // the fragment preserves the robust UV tile split with less varying
      // bandwidth than the earlier color-grade varying.
      const barkRole = barkTile.select(float(1), float(0))
        .toVarying('vTreeLod1AtlasBarkRole');
      const roleGrade = mix(
        vec3(0.42, 0.54, 0.32), vec3(0.48, 0.38, 0.28), barkRole,
      );
      const roleAlbedo = texel.rgb.mul(roleGrade);
      const upperSky = this.environment.zenithColor.mul(0.34);
      const horizonSky = this.environment.horizonColor.mul(0.18);
      const sunResponse = cheapShadingNormalWorld.dot(this.environment.sunDirection).abs()
        .mul(0.45).add(0.22);
      const directSun = this.environment.sunColor
        .mul(this.environment.sunIlluminanceScale.max(0)).mul(sunResponse);
      // v4's branchlet atlas is already normalized around its source foliage
      // albedo, while the production v3 atlas is deliberately low-exposure.
      // Reusing v3's 2.85 normalization made the middle v4 crown jump bright
      // green at the exact geometry handoff. Keep the identical shared-light
      // field, but calibrate each neutral atlas to its own measured range.
      const atlasDaylightNormalization = (coniferV4 || coniferV5 || coniferV6 || coniferV7) ? 1.65 : 2.85;
      const sharedDaylight = upperSky.add(horizonSky).add(directSun)
        .mul(atlasDaylightNormalization).toVarying('vTreeLod1SharedDaylight');
      material = new MeshBasicNodeMaterial();
      material.colorNode = roleAlbedo.mul(sharedDaylight);
      // maskNode emits an early alpha discard for the authored atlas. This keeps
      // the cutout/depth contract while avoiding a separate opacity graph.
      material.maskNode = texel.a.greaterThan(TREE_ALPHA_CUTOFF);
      material.alphaTest = TREE_ALPHA_CUTOFF;
      material.alphaHash = false;
      material.transparent = false;
      material.side = DoubleSide;
    }
    if (candidatePhongAtlas) {
      // v7/v8 candidate path: one authored atlas sample feeds both role-grade
      // colour and the early alpha mask. Phong keeps real sun/PMREM and shadow
      // reception while avoiding MeshStandard's dense microfacet fragment path.
      const texel = texture(part.material.map);
      const atlasUv = uv();
      const barkRole = atlasUv.x.lessThan(0.25).and(atlasUv.y.lessThan(0.25));
      const barkAlbedo = texel.rgb.mul(CONIFER_CANDIDATE_BARK_LINEAR_NORMALIZATION)
        .mul(mix(vec3(1), tint, 0.08));
      const measuredNeedleAlbedo = texel.rgb.mul(CONIFER_CANDIDATE_NEEDLE_LINEAR_NORMALIZATION);
      const needleAlbedo = saturation(
        mix(
          vec3(0.124, 0.168, 0.042),
          measuredNeedleAlbedo,
          CONIFER_CANDIDATE_NEEDLE_CONTRAST,
        ),
        CONIFER_CANDIDATE_NEEDLE_SATURATION,
      ).mul(mix(vec3(1), tint, 0.12));
      const boundedTransmission = needleTransmission(
        needleAlbedo,
        transmissionFactor(barkRole.not().select(float(1), float(0))),
        this.environment,
      );
      const candidateAlbedo = barkRole.select(barkAlbedo, boundedTransmission);
      material = new SharedEnvironmentTreePhongMaterial({
        side: DoubleSide,
        // Broad, low-energy leaf response avoids a sharp lime specular cap;
        // bark remains in the same candidate material and keeps real shadows.
        shininess: 2.0,
        reflectivity: 0.03,
      });
      // Use the authoritative EnvironmentGpuBindings aerial perspective on the
      // final lit value, rather than tinting the atlas/albedo before lighting.
      material.treeEnvironment = this.environment;
      material.fog = false;
      material.colorNode = candidateAlbedo;
      material.maskNode = texel.a.greaterThan(TREE_ALPHA_CUTOFF);
      material.alphaTest = TREE_ALPHA_CUTOFF;
      material.alphaHash = false;
      material.transparent = false;
      material.side = DoubleSide;
    }
    if ((coniferV4 || coniferV5 || coniferV6 || coniferV7)
      && !candidatePhongAtlas && !cheapMiddleAtlas && part.material.map) {
      // Candidate v4/v5/v6/v7 remains one masked MeshStandard draw. Tile 0 keeps a
      // restrained structural bark grade; branchlet tiles keep source alpha and
      // receive the existing bounded needle transmission under shared sun/sky.
      // v5 bakes the parent-outward blend into NORMAL offline, so it uses the
      // ordinary source-normal path without rebuilding that basis at runtime.
      const texel = texture(part.material.map);
      const barkRole = v4BarkTile.select(float(1), float(0));
      const roleGrade = mix(
        vec3(0.82, 0.88, 0.68), vec3(0.74, 0.58, 0.42), barkRole,
      );
      const sourceAlbedo = texel.rgb.mul(roleGrade)
        .mul(mix(vec3(1), tint, float(0.12)));
      const branchletAlbedo = needleTransmission(
        sourceAlbedo,
        transmissionFactor(v4BranchletTile.select(float(1), float(0))),
        this.environment,
      );
      material.colorNode = barkRole.select(sourceAlbedo, branchletAlbedo);
      material.opacityNode = texel.a;
      material.alphaTest = TREE_ALPHA_CUTOFF;
    }
    if (part.isFoliage) {
      const foliageBaseColor = foliageColorNode(part.material, tint);
      material = makeFoliageMaterial(part.material, tint, foliageBaseColor);
      material.colorNode = needleTransmission(
        foliageBaseColor, transmissionFactor(), this.environment,
      );
      material.alphaTest = TREE_ALPHA_CUTOFF;
      material.alphaHash = false;
    }
    if (!cheapMiddleAtlas && _isAuthoredAlphaAtlas(part) && material.map) {
      // Combined v3 mesh: one draw, common PBR albedo, source alpha only.
      // Do not invoke foliage tint/offset; tile 0 is opaque bark and tiles 1–15
      // are the official alpha-covered twig sprays.
      const texel = texture(material.map);
      material.opacityNode = texel.a;
      material.alphaTest = TREE_ALPHA_CUTOFF;
      material.alphaHash = false;
    }
    // The canonical derivative intentionally has no UV atlas: its COLOR_0 is
    // the source-role bake (bark/trunk/branches/foliage). Feed that attribute
    // explicitly through the node graph and grade only the canopy. This keeps
    // the trunk readable while restoring deep alpine greens and broad, natural
    // value separation that a white untextured PBR base would flatten.
    if (!part.material.map && part.geometry.hasAttribute('color')) {
      const sourceColor = vertexColor();
      const foliageMask = smoothstep(float(0.03), float(0.16), sourceColor.g.sub(sourceColor.r));
      const tier = smoothstep(float(0.28), float(0.92), heightFraction);
      // The canonical source-color bake is deliberately low-exposure (needle
      // greens are around .04/.095/.019 linear).  Multiplying that by a near-one
      // grade made the real crown effectively black under runtime daylight. Lift
      // the licensed albedo into a normal scene range while preserving its
      // per-vertex variation; this is material albedo, not emissive compensation.
      const foliageGrade = mix(vec3(2.55, 2.75, 2.05), vec3(3.20, 3.40, 2.30), tier);
      // The canonical COLOR_0 bake is linear and intentionally low exposure
      // (roughly 0.04/0.03/0.01 for bark). Feeding it through the lit material's
      // shadowed diffuse response at the old sub-unit grade collapsed a narrow
      // back-facing trunk into a 5/3/2 sRGB-black strip in the edge stress view.
      // Restore the source bark exposure here; this is still albedo, not an
      // emissive lift, so the shared sun/sky and shadow response remain intact.
      const structuralGrade = vec3(2.20, 1.88, 1.34);
      material.vertexColors = false;
      const gradedColor = sourceColor.mul(mix(structuralGrade, foliageGrade, foliageMask))
        .mul(mix(vec3(1), tint, foliageMask.mul(0.16)));
      material.colorNode = (part.isFoliage || _isAuthoredAlphaAtlas(part))
        ? needleTransmission(gradedColor, transmissionFactor(foliageMask), this.environment)
        : gradedColor;
      material.roughnessNode = mix(float(0.90), float(0.76), foliageMask);
    }
    const mh = this.motionHistory;
    const currentClip = mh.currentProjection.mul(mh.currentView.mul(vec4(world, 1.0)));
    const previousClip = mh.previousProjection.mul(mh.previousView.mul(vec4(previousWorld, 1.0)));
    material.positionNode = world;
    // `normalNode` is view-space for the full PBR path. The authored-alpha LOD1
    // branch is intentionally MeshBasic and already receives the shared
    // vertex-lit daylight above; wiring a view-space normal into that material
    // needlessly reintroduces the normal transform/normalization graph across
    // every mid-tree fragment without changing its output. Keep the source
    // normal response for LOD0 and leave the cheap role-graded path unlit by
    // per-fragment normal evaluation.
    if (!cheapMiddleAtlas) material.normalNode = shadingViewNormal;
    material.transparent = false;
    if (material.map && !part.isFoliage && !_isAuthoredAlphaAtlas(part)) {
      // Canonical v3 embeds a real alpha-covered branchlet atlas. Use authored
      // alpha rather than guessing coverage from RGB: dark transparent gutters
      // otherwise become the giant triangular shelf shards seen in close view.
      // Opaque legacy bark JPGs have alpha=1 and remain unchanged.
      const texel = texture(material.map);
      const coverage = texel.a.greaterThan(TREE_ALPHA_CUTOFF);
      material.opacityNode = coverage.select(float(1), float(0));
      material.alphaTest = Math.max(material.alphaTest || 0, TREE_ALPHA_CUTOFF);
    }
    material.depthWrite = true;
    material.mrtNode = mrt({ velocity: currentClip.xy.div(currentClip.w).sub(previousClip.xy.div(previousClip.w)).toVarying('vTreeHeroVelocity') });
    material.needsUpdate = true;
    return material;
  }

  _addImpostorMesh() {
    const geometry = new PlaneGeometry(1, 1, 1, 1);
    // The card is the last command, after both LOD bands' part commands.
    geometry.setIndirect(this._drawArgsAttr, this.partCount * 2 * 20);
    const mesh = new Mesh(geometry, this._impostorMaterial());
    mesh.name = 'tree-catalog-baked-impostor-gpu-indirect';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 0;
    this.group.add(mesh);
  }

  _impostorMaterial() {
    const sourceId = this._visibleImpostor.toAttribute();
    const transform = this._sourceTransform.element(sourceId);
    const hero = this._sourceHero.element(sourceId);
    const style = this._sourceStyle.element(sourceId);
    // Deterministic age classes keep the far line from becoming one cloned
    // ruler row. Re-ground the card after scale variation so every trunk still
    // meets terrain exactly.
    const ageScale = style.x.mul(0.754877666).fract().mul(0.28).add(0.86);
    // `transform.w` is the authored world height. The previous card treated it
    // as both width and height, so a 19 m fir became a 20 m-wide plane with its
    // trunk visually suspended. Preserve the catalog aspect ratio and place the
    // plane's lower edge exactly at the source ground point.
    const height = transform.w.mul(ageScale);
    const width = height.mul(6.467 / 18.895).mul(1.06);
    // The source scan's last opaque trunk pixels are anti-aliased into a narrow
    // transparent foot. At distance that coverage disappears under alpha test and
    // exposes a bright walk-through slot beneath an otherwise grounded plane. Bury
    // the image representation by 4% of its authored height (roughly 0.7 m for the
    // mature fir), matching normal forestry/terrain intersection practice and the
    // solid geometry's terrain contact. This is world grounding, not a view offset.
    const centre = transform.xyz.add(vec3(0, height.mul(0.46), 0));
    // Keep the catalog aspect ratio as the baseline, then apply a small seeded
    // crown-width class. The card remains centered at the shared .46 ground
    // height, so width variation cannot reintroduce a floating trunk.
    const cardWidth = width.mul(mix(float(0.93), float(1.10), style.z));
    // Keep the card upright while it follows camera yaw. The baked frame already
    // contains a small transparent framing gutter, hence the 1.12 source scale.
    const cameraRight = vec3(cameraWorldMatrix[0].x, 0, cameraWorldMatrix[0].z).normalize();
    const staticWorld = centre
      .add(cameraRight.mul(positionGeometry.x.mul(cardWidth)))
      .add(vec3(0, positionGeometry.y.mul(height), 0));
    const bendWeight = positionGeometry.y.add(0.5).clamp(0, 1).pow(1.7).mul(transform.w).mul(0.004);
    // Match hero geometry: one current/previous field sample at the tree root,
    // then apply the per-vertex height weight to the resulting displacement.
    const currentWind = this.environment.windAt(transform.xyz, this.environment.time);
    const previousWind = this.environment.windAt(transform.xyz, this.environment.previousTime);
    const world = staticWorld.add(vec3(currentWind.x, 0, currentWind.z).mul(bendWeight));
    const previousWorld = staticWorld.add(vec3(previousWind.x, 0, previousWind.z).mul(bendWeight));

    const tau = Math.PI * 2;
    // Keep frame selection stable for a fixed camera/placement, while applying a
    // tiny deterministic per-tree view offset. This breaks synchronized 8-view
    // atlas silhouettes in a row without changing authored rotation or causing a
    // temporal random walk.
    const atlasPhaseOffset = style.x.mul(0.61803398875).fract().sub(0.5).mul(0.22);
    const relativeAngle = atan(
      this.uCameraPosition.x.sub(transform.x),
      this.uCameraPosition.z.sub(transform.z),
    ).sub(hero.x).add(atlasPhaseOffset).add(tau).mod(tau);
    // Select one authored view with deterministic nearest-frame quantization. The
    // old adjacent-frame alpha blend doubled foliage overdraw and produced
    // transparent gutters/temporal shimmer as the camera crossed a 45° boundary.
    // Cards are admitted only at subpixel structure, so the discrete silhouette
    // step is below the perception gate and TRAA receives one stable velocity.
    const framePhase = relativeAngle.div(tau).mul(this.impostor.azimuthFrames);
    const frame = framePhase.add(0.5).floor().mod(this.impostor.azimuthFrames);
    // Logical frame zero is stored in the PNG's top row. Three's conventional UV
    // orientation therefore selects rows from the top by reversing atlas Y.
    // The neutral bake fits the source bounds inside each square frame: across
    // all eight views alpha occupies x=177..331 and y=27..471. Sample that
    // verified content rectangle, not the whole 512px square. Otherwise 70% of
    // card width and the bottom 8% are transparent, producing needle-thin firs
    // whose first visible trunk pixel appears metres above the grounded plane.
    // Values are expressed in bottom-origin texture UV after TextureLoader's
    // image flip; keep a small antialias guard around the measured alpha bounds.
    const frameUv = vec2(
      uv().x.mul(0.34).add(0.33),
      // The source alpha reaches the bottom at roughly 0.05 in frame-local UV.
      // Sampling from 0.04 retains the anti-aliased foot instead of cutting the
      // last 10 px and making the grounded card appear to hover above terrain.
      uv().y.mul(0.92).add(0.04),
    );
    const atlasUvForFrame = (sampleFrame) => {
      const column = sampleFrame.mod(this.impostor.columns);
      const rowFromTop = sampleFrame.div(this.impostor.columns).floor();
      return vec2(
        frameUv.x.add(column).div(this.impostor.columns),
        frameUv.y.add(float(this.impostor.rows - 1).sub(rowFromTop)).div(this.impostor.rows),
      );
    };
    const baked = texture(this.impostorTexture, atlasUvForFrame(frame));
    const packedTint = style.y;
    const tint = vec3(
      packedTint.mod(256.0).div(255.0),
      packedTint.div(256.0).floor().mod(256.0).div(255.0),
      packedTint.div(65536.0).floor().mod(256.0).div(255.0),
    );
    // Relight neutral source albedo from the same analytic runtime daylight that
    // drives the visible sky/PMREM. A card normal cannot represent thousands of
    // needle normals, so integrate broad upper-sky plus horizon irradiance and a
    // two-sided distributed-needle sun response. No bake lamp, fixed palette, AO,
    // or emissive compensation participates in this result.
    const toCamera = vec3(
      this.uCameraPosition.x.sub(transform.x),
      0,
      this.uCameraPosition.z.sub(transform.z),
    ).normalize();
    // Far cards cover most forest pixels. Evaluating the full atmospheric phase
    // model twice per card fragment cost more than the four nearby geometry trees.
    // The shared pre-derived daylight palette is the hemispherical integral this
    // diffuse needle cluster needs, and remains tied to the same authored state.
    const upperSky = this.environment.zenithColor.mul(0.34);
    const horizonSky = this.environment.horizonColor.mul(0.18);
    const sunResponse = toCamera.dot(this.environment.sunDirection).abs().mul(0.45).add(0.22);
    const directSun = this.environment.sunColor.mul(this.environment.sunIlluminanceScale).mul(sunResponse);
    // The neutral atlas stores the source's linearized, low-exposure albedo. Keep
    // the shared daylight direction/colour, but normalize its irradiance into the
    // same display range as the lit geometry. This is an albedo/exposure response,
    // not emissive light or baked AO; branch gaps remain governed by atlas alpha.
    // The baked atlas is a neutral albedo, not a display-space photograph. The
    // prior 6x normalization clipped the green channel under the clear-day key;
    // 4.4 keeps far crowns in the same exposure range as hero geometry while
    // preserving the shared daylight direction and chromaticity.
    const runtimeDiffuse = upperSky.add(horizonSky).add(directSun).mul(2.85);
    const material = new MeshBasicNodeMaterial();
    // Pine needles in the source scan are warm desaturated brown-green under the
    // neutral bake. A restrained species response restores alpine green while
    // preserving authored bark/branch separation and seeded variation.
    const pineAlbedo = baked.rgb.mul(vec3(0.62, 0.74, 0.48));
    material.colorNode = pineAlbedo.mul(mix(vec3(1), tint, 0.22)).mul(runtimeDiffuse);
    material.opacityNode = baked.a;
    material.alphaTest = TREE_IMPOSTOR_ALPHA_CUTOFF;
    material.alphaHash = false;
    material.transparent = false;
    material.side = DoubleSide;
    material.depthWrite = true;
    material.positionNode = world;
    const mh = this.motionHistory;
    const currentClip = mh.currentProjection.mul(mh.currentView.mul(vec4(world, 1.0)));
    const previousClip = mh.previousProjection.mul(mh.previousView.mul(vec4(previousWorld, 1.0)));
    material.mrtNode = mrt({ velocity: currentClip.xy.div(currentClip.w).sub(previousClip.xy.div(previousClip.w)).toVarying('vTreeImpostorVelocity') });
    material.needsUpdate = true;
    return material;
  }

  update(camera = this.camera) {
    camera.updateMatrixWorld();
    this.uCameraPosition.value.copy(camera.position);
    this.uViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.uProjectionScale.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    this.renderer.compute(this._clearCompute);
    this.renderer.compute(this._compactCompute);
    this.renderer.compute(this._finalizeCompute);
  }

  async readDiagnostics() {
    const [args, diagnostic] = await Promise.all([
      this.renderer.getArrayBufferAsync(this._drawArgsAttr),
      this.renderer.getArrayBufferAsync(this._diagnosticAttr),
    ]);
    const commands = new Uint32Array(args);
    const values = new Uint32Array(diagnostic);
    const behindRejected = values[0], frustumRejected = values[1], distanceRejected = 0;
    const overflow = values[6] | values[7] | values[8];
    const lod0Count = commands[this._lod0CountWord];
    const lod1Count = commands[this._lod1CountWord];
    const impostorCount = commands[this._impostorCountWord];
    const memberships = values.slice(16);
    let invalidMembership = 0, transitionMembership = 0;
    for (let id = 0; id < memberships.length; id++) {
      const bits = memberships[id];
      if (bits === 3 || bits === 6) transitionMembership++;
      else if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8) invalidMembership++;
    }
    // Every part of a band draws the same compacted instance list. A mismatch means
    // finalize failed to broadcast the band counter and one role of the tree would
    // render for a different set of trees than its siblings.
    let siblingCountsEqual = true;
    for (let command = 0; command < this._commandCount; command++) {
      const expected = command < this.partCount ? lod0Count
        : (command < this.partCount * 2 ? lod1Count : impostorCount);
      if (commands[command * 5 + 1] !== expected) siblingCountsEqual = false;
    }
    return {
      sourceCount: this.sourceCount,
      middleLodUsable: this.useMiddleLod,
      visibleCount: lod0Count + lod1Count + impostorCount,
      behindRejected,
      frustumRejected,
      distanceRejected,
      lod0Count,
      lod1Count,
      impostorCount,
      overflow,
      invalidMembership,
      transitionMembership,
      siblingCountsEqual,
      partCount: this.partCount,
      lod0Draws: this.partCount,
      lod1Draws: this.partCount,
      impostorDraws: 1,
      beautyDraws: this._commandCount,
      thresholds: { ...this.residencyThresholds },
      classificationComplete: invalidMembership === 0 && overflow === 0 && siblingCountsEqual
        && lod0Count + lod1Count + impostorCount + behindRejected + frustumRejected === this.sourceCount + transitionMembership,
    };
  }

  // Synchronous, JSON-safe residency probe for the isolated asset lab and
  // evaluator harness. GPU readback remains available through readDiagnostics(),
  // but a Promise serializes to `{}` when a harness logs it without awaiting.
  // This estimate uses the exact classifier thresholds and immutable source
  // records, so it is useful for pose sweeps and cannot mutate render state.
  residencyEstimate(camera = this.camera) {
    camera.updateMatrixWorld();
    const projectionScale = camera.projectionMatrix.elements[5];
    const thresholds = this.residencyThresholds;
    const counts = { lod0: 0, lod1: 0, impostor: 0, rejected: 0 };
    const projectedHeights = [];
    for (let index = 0; index < this.sourceCount; index++) {
      const x = this.shadowRecords[index * 4];
      const y = this.shadowRecords[index * 4 + 1];
      const z = this.shadowRecords[index * 4 + 2];
      const h = this.shadowRecords[index * 4 + 3];
      const distance = Math.hypot(x - camera.position.x, y + h * 0.5 - camera.position.y, z - camera.position.z);
      const projectedHeight = h * projectionScale / Math.max(distance, 1);
      const projectedStructure = projectedHeight * thresholds.projectedStructureRatio;
      projectedHeights.push(Number(projectedHeight.toFixed(6)));
      if (distance < this.uLodNear.value || projectedHeight > thresholds.lod0) counts.lod0++;
      else if (distance >= this.uLodNear.value
        && projectedStructure <= thresholds.impostorStructure) counts.impostor++;
      else counts.lod1++;
    }
    return {
      sourceCount: this.sourceCount,
      counts,
      projectedHeights,
      thresholds: { ...thresholds },
      classificationComplete: counts.lod0 + counts.lod1 + counts.impostor + counts.rejected === this.sourceCount,
    };
  }

  dispose() {
    disposeComputeNodes([this._clearCompute, this._compactCompute, this._finalizeCompute]);
    const geometries = [];
    const materials = [];
    this.group.traverse((object) => {
      if (object.geometry) geometries.push(object.geometry);
      if (Array.isArray(object.material)) materials.push(...object.material);
      else if (object.material) materials.push(object.material);
    });
    disposeWebGPUGeometries(this.renderer, geometries);
    // Tree GLB textures are owned by this range. Material.dispose() deliberately does
    // not dispose textures in Three, so release the shared map set exactly once.
    disposeMaterialTextures(materials);
    disposeWebGPUAttributes(this.renderer, [
      this._sourceTransform.value,
      this._sourceHero.value,
      this._sourceStyle.value,
      this._visibleLod0.value,
      this._visibleLod1.value,
      this._visibleImpostor.value,
      this._drawArgsAttr,
      this._diagnosticAttr,
    ]);
    this.impostorTexture.dispose();
  }
}

export function buildTreeBeautyLod(proto, midProto, impostor, impostorTexture, placements, options = {}) {
  return new TreeBeautyLod({ proto, midProto, impostor, impostorTexture, placements, ...options });
}

// One WebGPU-only directional-shadow caster for every hero tree.  The fixed source
// buffer contains seeded authoring transforms; whenever the shadow is dirty the GPU
// tests those records against the SUN'S orthographic frustum, compacts survivors, and
// writes the indirect instance count. The result and completed shadow map remain
// resident between light/caster changes. The mesh lives only on layer 1, which Lighting
// adds solely to the shadow camera: no beauty, velocity, depth, CPU visibility list,
// or readback path.
export class TreeShadowProxy {
  constructor({ renderer, light, records, impostorTexture, impostor }) {
    if (!renderer?.isWebGPURenderer) throw new Error('TreeShadowProxy requires WebGPU; no compatibility shadow path exists.');
    if (!light?.castShadow) throw new Error('TreeShadowProxy requires the directional shadow light.');
    if (!(records instanceof Float32Array) || records.length === 0 || records.length % 4 !== 0) {
      throw new Error('TreeShadowProxy requires non-empty vec4 static tree records.');
    }
    if (!impostorTexture?.isTexture || impostor?.columns !== 4 || impostor?.rows !== 2) {
      throw new Error('TreeShadowProxy requires the verified 4x2 source-baked tree atlas.');
    }
    this.renderer = renderer;
    this.light = light;
    this.sourceCount = records.length / 4;
    this.uLightViewProjection = uniform(light.shadow.camera.projectionMatrix.clone().multiply(light.shadow.camera.matrixWorldInverse));
    this._source = storage(new StorageBufferAttribute(records, 4), 'vec4', this.sourceCount).toReadOnly();
    this._visible = storage(new StorageInstancedBufferAttribute(new Float32Array(records.length), 4), 'vec4', this.sourceCount);
    this._drawArgsAttr = new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 5);
    // Word 1 is both the atomic compaction counter and WebGPU's indirect
    // `instanceCount`.  This avoids a third finalize dispatch and remains scalable
    // beyond today's 13 heroes without a barrier-sensitive workgroup shortcut.
    // Keep exactly one writable TSL view of this buffer.  A normal storage view plus
    // an atomic view aliases the same range and WebGPU correctly rejects that as two
    // writable bindings in a compute pass.
    this._drawArgs = storage(this._drawArgsAttr, 'uint', 5).toAtomic();
    this._clearCompute = this._buildClearCompute();
    this._compactCompute = this._buildCompactCompute();
    this._clearCompute.name = 'Tree shadow GPU reset';
    this._compactCompute.name = 'Tree shadow light-frustum compact';
    this.mesh = new Mesh(this._geometry(), this._material(impostorTexture));
    this.mesh.name = 'tree-shadow-gpu-indirect';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    // Main camera remains on layer 0. ShadowNode preserves layers 0|1 because
    // Lighting explicitly enables 1 on the directional-light shadow camera.
    this.mesh.layers.set(1);
    // A newly authored/rebuilt caster set invalidates both this compaction result
    // and Three's cached directional map. Range.update runs the compute passes
    // before ShadowNode consumes and clears the same bit during the beauty render.
    this.light.shadow.needsUpdate = true;
  }

  _buildClearCompute() {
    const args = this._drawArgs;
    return Fn(() => {
      atomicStore(args.element(uint(0)), uint(6));
      atomicStore(args.element(uint(1)), uint(0));
      atomicStore(args.element(uint(2)), uint(0));
      atomicStore(args.element(uint(3)), uint(0));
      atomicStore(args.element(uint(4)), uint(0));
    })().compute(1);
  }

  _buildCompactCompute() {
    const source = this._source;
    const visible = this._visible;
    const args = this._drawArgs;
    const lightVP = this.uLightViewProjection;
    return Fn(() => {
      const id = uint(instanceIndex);
      const record = source.element(id);
      // Test the canopy centre and add a conservative projected extent.  This never
      // relies on the view camera, and errs toward retaining an edge caster rather
      // than creating a sun-frustum pop. Directional depth itself is left unclipped:
      // WebGPU's depth pass performs the authoritative near/far rejection.
      const centre = lightVP.mul(vec4(record.x, record.y.add(record.w.mul(0.52)), record.z, 1.0));
      const pad = record.w.mul(0.015).add(0.08);
      const inside = centre.x.abs().lessThanEqual(centre.w.add(pad))
        .and(centre.y.abs().lessThanEqual(centre.w.add(pad)));
      If(inside, () => {
        const dst = atomicAdd(args.element(uint(1)), uint(1));
        visible.element(dst).assign(record);
      });
    })().compute(this.sourceCount);
  }

  _geometry() {
    const toSun = this.light.position.clone().sub(this.light.target.position);
    const horizontalLength = Math.hypot(toSun.x, toSun.z);
    if (horizontalLength < 1e-5) throw new Error('TreeShadowProxy requires a directional sun with a horizontal component.');
    // The single vertical card faces the sun in the horizontal plane. The shadow
    // camera therefore sees its authored alpha once, rather than three intersecting
    // cards filling each other's gaps into the rectangular trapezoids QA rejected.
    const dx = -toSun.z / horizontalLength * 0.5;
    const dz = toSun.x / horizontalLength * 0.5;
    const positions = [
      -dx, 0, -dz, dx, 0, dz,
      -dx, 1, -dz, dx, 1, dz,
    ];
    const uvs = [0, 0, 1, 0, 0, 1, 1, 1];
    const indices = [0, 2, 1, 1, 2, 3];
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
    geo.instanceCount = this.sourceCount;
    geo.setIndirect(this._drawArgsAttr);
    return geo;
  }

  _material(impostorTexture) {
    // The shadow caster uses a real source render of this exact catalog tree. A
    // private texture view selects frame zero from the 4x2 atlas, preserving the
    // fir's narrow crown, branch gaps, and trunk instead of projecting the former
    // oversized procedural broadleaf stamp beneath every species.
    const map = impostorTexture.clone();
    map.name = 'tree-shadow-source-impostor-frame';
    map.repeat.set(0.25, 0.5);
    map.offset.set(0, 0.5);
    map.needsUpdate = true;
    const mat = new MeshBasicMaterial({ map, alphaTest: TREE_ALPHA_CUTOFF, transparent: false, side: DoubleSide });
    const record = this._visible.toAttribute();
    const local = positionLocal;
    // Match the beauty card's source framing. Transparent atlas gutter keeps the
    // actual crown narrow while the plane retains every lateral branch tip.
    const cardSize = record.w.mul(1.12);
    mat.positionNode = vec3(local.x.mul(cardSize).add(record.x), local.y.mul(record.w).add(record.y), local.z.mul(cardSize).add(record.z));
    return mat;
  }

  update() {
    const shadow = this.light.shadow;
    // Mirror Three's LightShadow update contract exactly. With Lighting's
    // autoUpdate=false this skips both compute dispatches on unchanged frames;
    // honoring autoUpdate also keeps explicit diagnostic overrides coherent.
    if (!shadow.needsUpdate && !shadow.autoUpdate) return false;
    shadow.updateMatrices(this.light);
    shadow.camera.updateMatrixWorld();
    this.uLightViewProjection.value.multiplyMatrices(shadow.camera.projectionMatrix, shadow.camera.matrixWorldInverse);
    this.renderer.compute(this._clearCompute);
    this.renderer.compute(this._compactCompute);
    return true;
  }

  async readDiagnostics() {
    const args = new Uint32Array(await this.renderer.getArrayBufferAsync(this._drawArgsAttr));
    return { sourceCount: this.sourceCount, visibleCount: args[1], shadowDraws: 1, trianglesPerTree: 2 };
  }

  dispose() {
    disposeComputeNodes([this._clearCompute, this._compactCompute]);
    disposeWebGPUGeometries(this.renderer, [this.mesh.geometry]);
    disposeMaterialTextures([this.mesh.material]);
    disposeWebGPUAttributes(this.renderer, [
      this._source.value,
      this._visible.value,
      this._drawArgsAttr,
    ]);
  }
}
