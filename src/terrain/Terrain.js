import {
  BufferGeometry, BufferAttribute, Mesh, MeshPhysicalNodeMaterial, Group,
  Vector2, Vector3, Vector4, Color, DoubleSide, Texture, RepeatWrapping, SRGBColorSpace,
  StorageTexture, DataTexture, RedFormat, FloatType, NearestFilter, LinearFilter, ClampToEdgeWrapping,
  DataArrayTexture, RGBAFormat, UnsignedByteType, LinearMipmapLinearFilter,
} from 'three';
import {
  positionWorld, normalWorld, normalGeometry, positionGeometry, transformNormalToView, cameraPosition,
  mx_noise_float, float, vec2, vec3, vec4, mix, texture, textureLevel,
  luminance, smoothstep, oneMinus, Fn, If, Loop, Break, dFdx, dFdy,
  uniform, instanceIndex, textureStore, uvec2, struct, textureLoad, ivec2, int, mrt,
} from 'three/tsl';
import { surface } from '../physics/groundInteraction.js';
import { buildZoneMap, createZoneMapTextures, zoneAt as zoneAtTexel } from './ZoneMap.js';
import { yieldToRendering } from '../util/yieldToRendering.js';
import { acquireTurfMaps } from './TurfMapResidency.js';
import { TURF_PACK_SOURCE_URLS } from './TurfSources.js';
import { sampleHeightfield, sampleHeightfieldNormal } from './Heightfield.js';
import {
  turfBase,
  turfUndercoatBase,
  NATIVE_GRASS_PIGMENT,
  MOW_STRIPE_ALBEDO_CONTRAST,
  MOW_STRIPE_PERIOD_M,
  MOW_STRIPE_CROSS_SLOPE,
} from './turfColor.js';
import {
  acquireCoastSandTextures, COAST_SAND_SPECULAR_INTENSITY, coastTextureBlendWeights,
  releaseCoastSandTextures,
  sampleCoastSand,
} from '../scene/CoastSandDetail.js';
import {
  bakeDenseCanopyMask, CANOPY_DISTANCE_MAX_METERS, canopyOwnsExclusiveSurface, clearTrunkFootprints,
  createCanopyDistanceTexture, createCanopyTexture, GRASS_GROWABLE_BIT,
  sampleCanopyForestFloorWeight,
} from './CanopyField.js';
import { NEAR_BALL_TURF_DETAIL } from './NearBallTurfDetail.js';
import { signedDistanceToFeature } from '../course/featureGeometry.js';

const GRASS_CANDIDATE_SURFACES = new Set([
  'deepRough', 'rough', 'fairway', 'fringe', 'green', 'tee',
]);

// Turf surface maps: the two maintained turf materials are read separately, and the
// existing long-grass bake is selected for rough. Each bake is sampled at the current
// screen-space footprint, so short fairway/green grass stays a material problem rather
// than becoming a forest of tiny clumps.
//
//   * FAIRWAY (blendkit_fairway_*, historical binding name) — ambientCG Grass005,
//     a pinned CC0 fine-bladed, clean short-lawn material. Its lossless color, GL normal,
//     displacement, roughness, and AO maps remain channel-registered. See
//     docs/ambientcg-grass005-fairway-provenance.md.
//   * GREEN (blendkit_green_*) — the pinned "Golf Bentgrass" material from asset
//     34a832ef-bb9d-4213-89e9-9143b137d99e. It is intentionally a different tile and
//     cut-height response, not a hue tweak of the fairway.
//   * ROUGH (roughdetail_*, scripts/gen_rough_detail.mjs) — 2.0 m tile at 2048 px,
//     ~73k tufted 35-95 mm blades. Rough and deep rough only.
//
// Fairway and green never receive blade geometry: short blades read as scattered
// slivers at playable camera distances. Their PBR maps supply the dense shoot-level
// variation, while the real sun/sky lights the normal and roughness response.
//
// Either bake carries NO baked light: albedo is pigment only, the across-blade rounding
// lives in the normal map so the scene's real sun makes the sheen, and canopy occlusion
// is a separate AO channel that only attenuates ambient.
//
// The two TIERS are the near (blade-resolving, parallax-marched, sampled at the atlas's
// native tile) and the distance tier (the same seamless atlas at its footprint-selected
// mip). They crossfade by `dw` over the last ~28 m, where individual blades stop
// resolving; continuous world-space variation supplies the larger-scale character.
export function loadForestFloorMaps() {
  const load = (filename, srgb = false) => {
    const map = new Texture();
    let disposed = false;
    map.addEventListener('dispose', () => { if (disposed) return; disposed = true; map.image?.close(); });
    // Decode directly to an unpremultiplied bitmap: HTML image uploads otherwise
    // spend ~60 ms per pack converting pixels on this device. Preserve all RGBA
    // channels; WebGPU still applies the texture's existing flip and colour space.
    const ready = (async () => {
      const response = await fetch(`/assets/textures/${filename}`);
      if (!response.ok) throw new Error(`Required forest-floor texture failed: ${filename} (${response.status})`);
      const bitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: 'none', colorSpaceConversion: 'none',
      });
      if (disposed) { bitmap.close(); throw new Error(`Forest-floor texture disposed during load: ${filename}`); }
      map.image = bitmap;
      map.needsUpdate = true;
    })();
    map.name = `forest-floor:${filename}`;
    map.wrapS = map.wrapT = RepeatWrapping;
    map.anisotropy = 8;
    if (srgb) map.colorSpace = SRGBColorSpace;
    return { map, ready };
  };
  // Two registered RGBA packs retain fresh longleaf-straw colour, relief and
  // occlusion without adding another terrain binding or geometry layer.
  const colorRoughness = load('fresh_pine_straw_color_roughness_v2.png', true);
  const normalHeightAo = load('fresh_pine_straw_normal_height_ao_v2.png');
  return {
    colorRoughness: colorRoughness.map,
    normalHeightAo: normalHeightAo.map,
    ready: Promise.all([colorRoughness.ready, normalHeightAo.ready]),
  };
}

// One immutable CPU pack, shared by every course rebuild. No GPU objects or course
// references survive here; production Terrain owners lease their GPU arrays from
// renderer-scoped TurfMapResidency, while standalone callers own their arrays.
// ponytail: retain only the fixed six-map 96 MiB pack; add a byte-budgeted LRU only
// when courses can select different turf packs. Full page reload refreshes assets.
let turfPackedSource = null;

export function loadTurfMaps() {
  const set = (name, tile, farMean, albedoMean, packedRoughness = false,
    resolution = 1024, pigmentMean = [TURF_LUM, TURF_LUM, TURF_LUM],
    albedoLodBias = 0.0, albedoContrast = 1.0) => {
    return { name, tile, farMean, albedoMean, packedRoughness, resolution,
      pigmentMean, albedoLodBias, albedoContrast };
  };
  // Height, AO, roughness, and source-albedo means are measured from the packed maps.
  // Pigment targets recenter the highly saturated procedural sources onto the course's
  // yellow-green turf family; the bounded source deviation still supplies local colour.
  const fairway = set('blendkit_fairway', 1.2,
    [0.25848001, 0.60995079, 0.70157140], 0.20198728, true, 2048,
    // Grass005 has dense, fine short-cut blade structure in every PBR channel. Keep its
// color at the screen-selected footprint so the near-ball view reads as turf,
// while the footprint-driven unresolved blend still removes repeating motifs.
    [0.08400000, 0.16600000, 0.03400000], 0.00, 0.78);
  const green = set('blendkit_green', 1.5,
    [0.61920959, 1.0, 0.99607843], 0.11012081, true, 2048,
    // Preserve the compact bentgrass character through ordinary green-review
    // distances. The old +0.75 mip bias and 24% source contrast averaged the
    // dedicated scan into a flat pigment before lighting could reveal its nap.
    [0.07500000, 0.20000000, 0.04500000], 0.15, 0.60);
  const rough = set('roughdetail', 2.0, [0.50762, 0.66504, 0.54402], TURF_LUM, false, 2048);
  const makeArray = (name, srgb) => {
    const array = new DataArrayTexture(new Uint8Array(3 * 4), 1, 1, 3);
    array.name = name;
    array.format = RGBAFormat;
    array.type = UnsignedByteType;
    array.wrapS = array.wrapT = RepeatWrapping;
    array.magFilter = LinearFilter;
    array.minFilter = LinearMipmapLinearFilter;
    array.generateMipmaps = true;
    array.anisotropy = 8;
    if (srgb) array.colorSpace = SRGBColorSpace;
    array.needsUpdate = true;
    return array;
  };
  const albedoArray = makeArray('turf:albedo-array', true);
  const nrhArray = makeArray('turf:normal-relief-array', false);
  const sets = [fairway, green, rough];
  sets.forEach((entry, layer) => { entry.layer = layer; });
  if (!turfPackedSource) {
    turfPackedSource = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./TurfTextures.worker.js', import.meta.url), { type: 'module' });
      const fail = (message) => { worker.terminate(); reject(new Error(message)); };
      worker.onerror = (event) => { event.preventDefault(); fail(event.message || 'Turf texture worker failed.'); };
      worker.onmessageerror = () => fail('Invalid turf texture worker response.');
      worker.onmessage = ({ data }) => {
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data.packed);
      };
      worker.postMessage({ urls: TURF_PACK_SOURCE_URLS.map(url => new URL(url, location.href).href) });
    }).catch((error) => {
      // Failed requests are retryable; never cache a partial/placeholder pack.
      turfPackedSource = null;
      throw error;
    });
  }
  const ready = turfPackedSource.then((packed) => {
    for (const [index, array] of [albedoArray, nrhArray].entries()) {
      // A distinct descriptor/Texture per owner, identical read-only pixel storage.
      array.image = { ...packed[index] };
      array.dispose();
      array.needsUpdate = true;
    }
  });
  return { fairway, green, rough, albedoArray, nrhArray, ready };
}

// Everything one detail bake contributes to shading, in one value. It has to travel as
// a struct because selecting between the two bakes needs an `If`, `If` needs a shader
// stack (so it has to live inside an Fn), and an Fn returns exactly one thing.
//   far.x = canopy height -> blade-scale gloss | far.y = canopy AO
const turfTierStruct = struct({
  relief: 'vec3', far: 'vec2', shade: 'float', alb: 'vec4',
}, 'TurfTier');
// Common LINEAR source-albedo normalization target. Each baked map is divided by its
// measured mean before its bounded variation is recentered on the per-surface pigment.
const TURF_LUM = 0.138;

// The maintained maps are a material/heightfield solution, not a short-blade draw.
// Keep their screen-space relief bounded by physical source texels: grazing pixels
// that cannot resolve the source are allowed to fall back to filtered normal/albedo
// response instead of turning a two-layer POM march into a streak generator.
const TURF_POM_MAX_TRAVEL_TEXELS = 2.5;
const TURF_POM_MIN_VIEW_UP = 0.18;
const TURF_POM_FULL_VIEW_UP = 0.46;
const TURF_SHADOW_MAX_TRAVEL_TEXELS = 2.0;

// This is a Toksvig-style screen-space proxy. It broadens the leaf highlight when the
// sampled normal changes materially inside one pixel, and reduces the lobe peak by the
// same bounded amount. The constants are intentionally small: turf remains matte and
// the source normal still supplies the visible close-up structure.
const TURF_NORMAL_VARIANCE_START = 0.0025;
const TURF_NORMAL_VARIANCE_FULL = 0.050;
const TURF_NORMAL_VARIANCE_ROUGHNESS = 0.12;
const TURF_NORMAL_VARIANCE_SPECULAR = 0.18;

// Quintic interpolation gives the moving macro-detail footprint a C2-continuous
// edge. The source texture phase never changes; only this zero-mean relief gain does.
const smootherstepNode = (edge0, edge1, value) => {
  const span = typeof edge0 === 'number' && typeof edge1 === 'number'
    ? edge1 - edge0
    : edge1.sub(edge0);
  const x = value.sub(edge0).div(span).clamp(0.0, 1.0);
  return x.mul(x).mul(x).mul(x.mul(x.mul(6.0).sub(15.0)).add(10.0));
};

// A heightfield that is simultaneously the physics collision surface and the
// rendered ground. Heights are baked into a grid once at construction (CPU) so
// heightAt/normalAt are O(1) bilinear lookups; all per-frame shading work lives
// in the GPU material (turf albedo, canopy depth grading, micro-detail).
//
// config:
//   bounds:      { minX, maxX, minZ, maxZ }
//   spacing:     meters between grid samples (default 2)
//   heightFn:    (x, z) => elevation meters
//   surfaceFn:   (x, z) => key into SURFACES
//   variationSeed: stable course seed for world-anchored turf nap
export class Terrain {
  static async create(config) {
    const worker = new Worker(new URL('./ZoneMap.worker.js', import.meta.url), { type: 'module' });
    try {
      const zoneReady = new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.packed);
        worker.onerror = event => reject(new Error(`Terrain zone worker failed: ${event.message}`));
        worker.onmessageerror = () => reject(new Error('Terrain zone worker returned an unreadable payload.'));
        worker.postMessage({ zones: config.zones, bounds: config.bounds });
      });
      // Observe failure immediately even while cooperative height rows are running.
      // The awaited promise below still propagates the original failure.
      void zoneReady.catch(() => {});
      // This sampler includes live analytic callbacks and cannot be transferred.
      // Bound its work to short row batches while the zone worker rasterizes.
      const spacing = config.spacing ?? 2;
      const nx = Math.floor((config.bounds.maxX - config.bounds.minX) / spacing) + 1;
      const nz = Math.floor((config.bounds.maxZ - config.bounds.minZ) / spacing) + 1;
      const heights = new Float32Array(nx * nz);
      const growable = new Uint8Array(nx * nz);
      let deadline = performance.now() + 4;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const x = config.bounds.minX + i * spacing, z = config.bounds.minZ + j * spacing;
          heights[j * nx + i] = config.heightFn(x, z);
          if (GRASS_CANDIDATE_SURFACES.has(config.surfaceFn(x, z))) growable[j * nx + i] = GRASS_GROWABLE_BIT;
        }
        if (performance.now() >= deadline) {
          await yieldToRendering();
          deadline = performance.now() + 4;
        }
      }
      const zoneMapData = await zoneReady;
      await yieldToRendering();
      return new Terrain({ ...config, preparedHeights: heights, preparedGrowable: growable, zoneMapData });
    } finally { worker.terminate(); }
  }

  constructor(config) {
    // `spacing` is the FINE physics/collision grid (heightAt/normalAt sample it, so
    // ball roll and contours stay accurate). `renderSpacing` is the coarser step
    // the render mesh + shadow pass use — a distance-independent LOD that keeps the
    // heavy vertex work down while the fine grid preserves gameplay fidelity.
    const {
      bounds, spacing = 2, renderSpacing = spacing, heightFn, surfaceFn, zones,
      motionHistory = null, renderer, biomeField = null,
      analyticHeightFn = null, analyticPatchContains = null, finiteCanvas = false,
      finiteOutline = null, finiteCutout = null, variationSeed = 0,
      groundCover = 'turf',
    } = config;
    if (!renderer?.isWebGPURenderer) {
      throw new Error('Terrain requires the strict WebGPU renderer for its GPU-authored variation field.');
    }
    this.bounds = bounds;
    this.spacing = spacing;
    this.renderSpacing = renderSpacing;
    this.heightFn = heightFn;
    this.analyticHeightFn = analyticHeightFn;
    this.analyticPatchContains = analyticPatchContains;
    this.surfaceFn = surfaceFn;
    // Geometric zone spec (greens/sands circles, fairway corridor, tee box) used
    // to classify the turf ANALYTICALLY in the shader — smooth-curve boundaries
    // instead of a rasterized splat's stair-stepped squares. See turfColorNode.
    this.zones = zones;
    this._biomeField = biomeField;
    this.groundCover = groundCover;
    this._forestFloorMaps = canopyOwnsExclusiveSurface(groundCover) ? loadForestFloorMaps() : null;
    this._coastSandAsset = biomeField?.hasTransitions ? acquireCoastSandTextures() : null;
    this.motionHistory = motionHistory;
    this.activeCup = config.cupCutout ? uniform(new Vector3()) : null;
    this.finiteCanvas = finiteCanvas === true;
    this.finiteOutline = Array.isArray(finiteOutline) && finiteOutline.length >= 3
      ? finiteOutline.map(({ x, z }) => Object.freeze({ x, z }))
      : null;
    this.finiteCutout = this.finiteCanvas
      && Number.isFinite(finiteCutout?.x)
      && Number.isFinite(finiteCutout?.z)
      && Number.isFinite(finiteCutout?.radius)
      && finiteCutout.radius > 0
      ? Object.freeze({ x: finiteCutout.x, z: finiteCutout.z, radius: finiteCutout.radius })
      : null;

    this.nx = Math.floor((bounds.maxX - bounds.minX) / spacing) + 1;
    this.nz = Math.floor((bounds.maxZ - bounds.minZ) / spacing) + 1;
    this.heights = config.preparedHeights ?? new Float32Array(this.nx * this.nz);
    this._growableData = config.preparedGrowable ?? new Uint8Array(this.nx * this.nz);
    this._canopyData = new Uint8Array(this.nx * this.nz);
    // The tight pine-litter cut is visual-only and needs more contour resolution
    // than the compact terrain/grass-eligibility grid. It adds no geometry or draw.
    this._canopyDistanceSpacing = this._forestFloorMaps ? Math.min(spacing, 0.3) : spacing;
    this._canopyDistanceNx = Math.floor(
      (bounds.maxX - bounds.minX) / this._canopyDistanceSpacing,
    ) + 1;
    this._canopyDistanceNz = Math.floor(
      (bounds.maxZ - bounds.minZ) / this._canopyDistanceSpacing,
    ) + 1;
    this._canopyDistanceData = new Uint8Array(
      this._canopyDistanceNx * this._canopyDistanceNz,
    );
    this._canopyTexture = createCanopyTexture(this._canopyData, this.nx, this.nz);
    this._canopyDistanceTexture = createCanopyDistanceTexture(
      this._canopyDistanceData, this._canopyDistanceNx, this._canopyDistanceNz,
    );

    // Strength of the native-scale turf micro-relief fed to the surface normal.
    // Footprint filtering below retires it when individual blades no longer resolve;
    // there is deliberately no enlarged copy pretending to be a distance LOD.
    this.uDetailNormal = uniform(1.0);
    // Multiplier on the real canopy depths the parallax march carves (1.0 = as
    // measured). Live-tunable so the mm-scale relief can be dialled against the ball.
    this.uParallax = uniform(1.0);
    this.uAO = uniform(0.62);            // measured canopy AO, slightly stronger in long rough
    // Turf roughness floor / range. Grass is MATTE: a leaf cuticle measures ~0.6-0.8
    // and a canopy — which is mostly gaps, shaded litter and blades at every angle —
    // averages higher still. These used to sit at 0.34/0.34, i.e. blade tops at 0.34,
    // which is near-plastic; under a 5.0-intensity sun a near-flat ground plane the
    // size of a fairway threw a broad specular sheet and the turf read wet.
    this.uRoughBase = uniform(0.72);
    this.uRoughRange = uniform(0.16);
    // Amount of extra grazing-angle roughening (see the uGraze comment by the
    // roughnessNode). Kept as a knob, but it is no longer load-bearing now that the
    // base is genuinely matte.
    this.uGraze = uniform(0.4);
    // Specular REFLECTANCE of the canopy. Roughness only blurs the lobe; this scales
    // how much light it carries at all. The standard model's F0 = 0.04 assumes a
    // smooth dielectric sheet — a grass canopy is microflakes separated by gaps and
    // self-shadow, so its effective reflectance is well below that. Unlike roughness
    // this touches neither the PMREM mip nor the reflection vector, so it can never
    // produce a threshold artifact.
    // A little more dielectric return lets the mown fibre normal catch the
    // shared sun at grazing angles; roughness remains high so this is not a wet
    // or plastic fairway.
    this.uSpecular = uniform(0.58);
    this.uBackdropJoin = uniform(0);
    this.uSat = uniform(1.0);            // final turf grade
    this.uVal = uniform(1.0);
    this.uShadow = uniform(0.55);        // restrained canopy self-shadow strength
    this.uNearTurfActivation = uniform(0.0);
    this.uNearTurfCameraXZ = uniform(new Vector2());
    this.uNearTurfForwardXZ = uniform(new Vector2(0, -1));
    this.uForestFloorDepth = uniform(0.028);
    this.uForestFloorNormal = uniform(0.72);
    this.uForestFloorSourceColor = uniform(1.0);
    this.uForestFloorMacro = uniform(0.20);
    this.uForestFloorCanopyAffinity = uniform(0.0);
    this.uCrownCoreGrassDensity = uniform(0.0);
    this.uCrownFeatherMeters = uniform(0.45);
    // Sun direction, set from main.js so the canopy self-shadow marches toward the
    // same light the rig uses (see setSun).
    this.uSunDir = uniform(new Vector3(-0.82, 0.4, -0.12).normalize());

    // Baked signed-distance map of the turf zones. Built once here so the shader
    // never re-derives zone membership per pixel (see ZoneMap.js).
    this._zoneMap = config.zoneMapData ? createZoneMapTextures(config.zoneMapData) : buildZoneMap(zones, bounds);
    this._initMacroVariation(renderer);
    this._initGreenNapVariation(renderer, variationSeed);

    this._initDivots();          // divot scar field (GPU compute-stamped mask, read by the turf shader)
    if (!config.preparedHeights) this._bake();
    this.setCanopyPlacements([]);
    // Rendering samples this exact immutable physics heightfield on the GPU. It is
    // deliberately nearest-only because `_heightNode()` performs the same explicit
    // bilinear reconstruction as `heightAt()`, including edge clamping.
    this._heightTex = new DataTexture(this.heights, this.nx, this.nz, RedFormat, FloatType);
    this._heightTex.name = 'terrain-heightfield-r32f';
    this._heightTex.minFilter = this._heightTex.magFilter = NearestFilter;
    this._heightTex.generateMipmaps = false;
    this._heightTex.needsUpdate = true;
    this._turfMaps = null;
    this._turfRenderer = renderer;
    this.mesh = this._buildMesh();
    // prepopulateDivots(renderer) is called from main once the WebGPU backend is
    // initialized (compute needs a live renderer).
  }

  // Divots live entirely on the GPU: a StorageTexture mask (R = scar, G = kicked-up
  // lip) that a COMPUTE shader stamps into, and that the turf shader samples once per
  // pixel. Each stamp dispatches only the conservative texture-space rectangle that
  // can contain its torn teardrop, rather than walking the whole 1536² mask. There is
  // still no CPU rasterization or per-frame upload. Elongated along the swing line,
  // rotated by `angle`; writes only inside the oval so prior divots elsewhere persist.
  _initDivots() {
    // Tight, high-res region around the hitting area: club-width divots (~4 cm) are only a
    // few cm, so the mask needs fine texels. 1536 over ~12 m ≈ 128 texels/m ≈ 8 mm/texel.
    const RES = 1536;
    const originX = -6, originZ = -12, sizeX = 12, sizeZ = 18;    // metres, around the tee
    const tpmX = RES / sizeX, tpmZ = RES / sizeZ;
    this._divotRegion = { originX, originZ, sizeX, sizeZ, res: RES };

    const tex = new StorageTexture(RES, RES);
    tex.name = 'terrain-divot-mask';
    tex.minFilter = tex.magFilter = LinearFilter;      // smooth scar edges
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;        // 0 border → no divots outside the region
    this._divotTex = tex;

    // The mask covers a small high-res window; its ORIGIN is a uniform so the window can
    // RE-CENTER on wherever the ball is actually hit from (a course lie), not just the
    // tee — divots anywhere, without a course-sized texture. colorNode + roughnessNode
    // read the same uniform so the sampling always matches the compute.
    this._uDivOrigin = uniform(new Vector2(originX, originZ));
    // Per-stamp params fed to the compute shader:
    //   D  = (x, z, halfWidth, angle)
    //   D2 = (dryness 0..1, aspect = length/width, seed for unique tearing, spare)
    this._uDiv = uniform(new Vector4(0, 0, 0, 0));
    this._uDiv2 = uniform(new Vector4(0.3, 2.8, 0, 0));
    const D = this._uDiv, D2 = this._uDiv2, O = this._uDivOrigin;

    // The active stamp rectangle is changed on the CPU once per *event*, then used to
    // map a compact 1-D dispatch back into absolute texture coordinates. These are
    // uint uniforms because textureStore coordinates must remain integer exact.
    this._uDivStampX = uniform(0, 'uint');
    this._uDivStampY = uniform(0, 'uint');
    this._uDivStampW = uniform(RES, 'uint');
    const stampX = this._uDivStampX, stampY = this._uDivStampY, stampW = this._uDivStampW;

    const texelWorld = () => {
      const ix = instanceIndex.mod(RES);
      const iy = instanceIndex.div(RES);
      const wx = float(ix).div(tpmX).add(O.x);
      const wz = float(iy).div(tpmZ).add(O.y);
      return { ix, iy, wx, wz };
    };

    const stampTexelWorld = () => {
      const ix = instanceIndex.mod(stampW).add(stampX);
      const iy = instanceIndex.div(stampW).add(stampY);
      const wx = float(ix).div(tpmX).add(O.x);
      const wz = float(iy).div(tpmZ).add(O.y);
      return { ix, iy, wx, wz };
    };

    // Stamp: one "bacon-strip" scar — a tapered teardrop (wide at the club-entry/leading
    // edge, narrowing to the exit) with a NOISE-TORN outline, not a clean oval. Channels:
    //   R = exposed-soil mask, G = leading-edge depth (for the depression shadow),
    //   B = per-divot dryness. Store only where soil is present, so prior divots persist.
    this._divotStamp = Fn(() => {
      const { ix, iy, wx, wz } = stampTexelWorld();
      const dx = wx.sub(D.x), dz = wz.sub(D.y);
      const ca = D.w.cos(), sa = D.w.sin();
      const lx = dx.mul(ca).sub(dz.mul(sa));            // across the swing line
      const ly = dx.mul(sa).add(dz.mul(ca));            // along the swing line (leading = -ly)
      const rx = D.z, ry = D.z.mul(D2.y);               // half-width, half-length (elongated)
      const ny = ly.div(ry);
      // Teardrop taper: narrow the trailing (+ly) half toward the exit.
      const taper = float(1.0).sub(ny.max(0.0).mul(0.55));
      const nx = lx.div(rx.mul(taper).max(0.02));
      // Torn outline: warp the distance field with per-divot-seeded noise (2 scales).
      const seed = D2.z;
      const n1 = mx_noise_float(vec3(wx.mul(9.0).add(seed), wz.mul(9.0), seed));
      const n2 = mx_noise_float(vec3(wx.mul(3.2).add(seed), wz.mul(3.2), seed.add(4.0)));
      const od = vec2(nx, ny).length().add(n1.mul(0.13)).add(n2.mul(0.09));
      const mask = oneMinus(smoothstep(0.5, 1.0, od));
      // Leading edge (ny ~ -1) is deepest; fades to 0 by mid-scar.
      const depth = oneMinus(smoothstep(-0.9, 0.15, ny)).mul(mask);
      If(mask.greaterThan(0.01), () => {
        textureStore(this._divotTex, uvec2(ix, iy), vec4(mask, depth, D2.x, 1.0)).toWriteOnly();
      });
    })().compute(RES * RES);

    // Clear the whole mask (StorageTexture contents aren't guaranteed zeroed).
    this._divotClear = Fn(() => {
      const { ix, iy } = texelWorld();
      textureStore(this._divotTex, uvec2(ix, iy), vec4(0.0, 0.0, 0.0, 1.0)).toWriteOnly();
    })().compute(RES * RES);
  }

  // Restrict the stamp dispatch to the exact texture rectangle that can receive a
  // write. The shader's noise can move the signed-distance outline by at most 0.22,
  // so 1.30 scar radii is deliberately conservative; rounding one texel outward keeps
  // this byte-for-byte equivalent to the former full-texture dispatch for all texels
  // that could pass `mask > 0.01`.
  _setDivotStampRegion(x, z, radius, angle, aspect) {
    const R = this._divotRegion;
    const origin = this._uDivOrigin.value;
    const noiseReach = 1.30;
    const halfX = radius * noiseReach;
    const halfZ = radius * aspect * noiseReach;
    const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const extentX = halfX * c + halfZ * s;
    const extentZ = halfX * s + halfZ * c;
    const tpmX = R.res / R.sizeX, tpmZ = R.res / R.sizeZ;

    // A floor/ceil pair is intentionally one texel wider than the mathematical
    // interval at the far edge. It avoids any edge loss from floating-point rounding
    // while still leaving a typical club divot at a few hundred invocations.
    const minX = Math.max(0, Math.floor((x - extentX - origin.x) * tpmX));
    const maxX = Math.min(R.res - 1, Math.ceil((x + extentX - origin.x) * tpmX));
    const minY = Math.max(0, Math.floor((z - extentZ - origin.y) * tpmZ));
    const maxY = Math.min(R.res - 1, Math.ceil((z + extentZ - origin.y) * tpmZ));
    const width = Math.max(1, maxX - minX + 1);
    const height = Math.max(1, maxY - minY + 1);

    this._uDivStampX.value = minX;
    this._uDivStampY.value = minY;
    this._uDivStampW.value = width;
    this._divotStamp.count = width * height;
  }

  // Stamp one divot into the mask on the GPU. `renderer` is the live WebGPURenderer.
  //   radius = half-WIDTH (m); the scar length is radius*aspect. dryness/seed vary the look.
  stampDivot(renderer, x, z, radius = 0.022, angle = 0, dryness = 0.25, aspect = 4.5, seed = 0) {
    // If the strike is outside the current mask window (a shot from a new part of the
    // course), re-center the window on it and clear — so divots follow you anywhere.
    // Shots within the window (e.g. every tee shot on the range) never trigger this, so
    // the used-tee scatter accumulates intact.
    const R = this._divotRegion, O = this._uDivOrigin.value, m = 2.0;
    if (x < O.x + m || x > O.x + R.sizeX - m || z < O.y + m || z > O.y + R.sizeZ - m) {
      O.set(x - R.sizeX / 2, z - R.sizeZ / 2);
      renderer.compute(this._divotClear);
    }
    this._uDiv.value.set(x, z, radius, angle);
    this._uDiv2.value.set(dryness, aspect, seed, 0);
    this._setDivotStampRegion(x, z, radius, angle, aspect);
    renderer.compute(this._divotStamp);
  }

  // Clear + scatter a "used" hitting area of THIN, varied scars target-side of the ball
  // (rests at ~x0,z2), fanning down range (-z), denser near the hitting spot. Deterministic
  // seed so it's stable across loads. Must run after the WebGPU backend is initialized.
  prepopulateDivots(renderer) {
    renderer.compute(this._divotClear);
    let s = 20260803 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 34; i++) {
      const spread = 0.4 + 0.6 * rnd();          // bias the cluster toward the centre line
      const x = (rnd() - 0.5) * 5.0 * spread;
      const z = 1.2 - Math.pow(rnd(), 0.7) * 8.0; // denser near the tee, thinning down range
      const r = 0.015 + rnd() * 0.017;           // half-WIDTH ~1.5-3.2cm -> ~3-6cm wide (a club)
      const a = (rnd() - 0.5) * 0.5;             // roughly aligned to the -z target line
      const dry = 0.05 + rnd() * 0.4;
      const aspect = 3.5 + rnd() * 3.0;          // long, thin bacon-strips
      this.stampDivot(renderer, x, z, r, a, dry, aspect, rnd() * 20.0);
    }
  }

  _idx(i, j) { return j * this.nx + i; }

  _bake() {
    const { minX, minZ } = this.bounds;
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = minX + i * this.spacing;
        const z = minZ + j * this.spacing;
        this.heights[this._idx(i, j)] = this.heightFn(x, z);
        if (this.isGrassCandidateSurface(this.surfaceAt(x, z))) this._growableData[this._idx(i, j)] = GRASS_GROWABLE_BIT;
      }
    }
  }

  // Bilinear height lookup, clamped to bounds.
  heightAt(x, z) {
    if (this.analyticHeightFn && this.analyticPatchContains?.(x, z, this.spacing)) {
      return this.analyticHeightFn(x, z);
    }
    return sampleHeightfield(this, x, z);
  }

  // Surface normal from central differences of the height field.
  normalAt(x, z, out = new Vector3()) {
    const e = this.spacing;
    if (this.analyticHeightFn && this.analyticPatchContains?.(x, z, e)) {
      // Resolve the near-vertical analytic wall instead of averaging it across a
      // complete 0.6 m heightfield cell. This is also the normal authored into the
      // fixed patch, so lighting and collision share the same local derivative.
      const analyticE = Math.min(e, 0.06);
      const hL = this.analyticHeightFn(x - analyticE, z);
      const hR = this.analyticHeightFn(x + analyticE, z);
      const hD = this.analyticHeightFn(x, z - analyticE);
      const hU = this.analyticHeightFn(x, z + analyticE);
      out.set(hL - hR, 2 * analyticE, hD - hU).normalize();
      return out;
    }
    return sampleHeightfieldNormal(this, x, z, out);
  }

  surfaceAt(x, z) {
    return this.surfaceFn(x, z);
  }

  // CPU diagnostic/readiness view of the same baked zone field consumed by the
  // terrain and grass shaders. Sampling the nearest texel is intentional: callers
  // use this to prove authored feature ownership, while rendering keeps the texture's
  // bilinear SDF transition at sub-texel boundaries.
  renderedZoneAt(x, z) {
    const map = this._zoneMap;
    if (!map) return null;
    const u = Math.max(0, Math.min(1, (x - map.bounds.minX) / (map.bounds.maxX - map.bounds.minX)));
    const v = Math.max(0, Math.min(1, (z - map.bounds.minZ) / (map.bounds.maxZ - map.bounds.minZ)));
    const i = Math.min(map.width - 1, Math.floor(u * map.width));
    const j = Math.min(map.height - 1, Math.floor(v * map.height));
    return zoneAtTexel(map, i, j, this.zones);
  }

  forestFloorWeightAt(x, z, surface = this.surfaceAt(x, z)) {
    if (!this._forestFloorMaps) return 0;
    if (this.zones.forestFloors?.length) {
      const distance = this.zones.forestFloors.reduce(
        (nearest, area) => Math.max(nearest, signedDistanceToFeature(area, x, z)), -Infinity,
      );
      if (distance <= 0 || !['rough', 'deepRough'].includes(surface)) return 0;
      const t = Math.min(1, distance / this.uCrownFeatherMeters.value);
      return t * t * (3 - 2 * t);
    }
    const crown = surface === 'rough' || surface === 'deepRough'
      ? sampleCanopyForestFloorWeight(
        this._canopyDistanceData, this._canopyDistanceNx, this._canopyDistanceNz, {
          minX: this.bounds.minX,
          minZ: this.bounds.minZ,
          spacing: this._canopyDistanceSpacing,
        }, x, z, this.uCrownFeatherMeters.value,
      )
      : 0;
    const affinity = this.uForestFloorCanopyAffinity.value;
    return (surface === 'deepRough' ? 1 - affinity : 0) + crown * affinity;
  }

  // Shared immutable rendering copy of `heights`.  Grass and terrain vertices sample
  // this exact texture; CPU reads stay confined to collision/physics methods above.
  get heightTexture() {
    return this._heightTex;
  }

  get canopyTexture() {
    return this._canopyTexture;
  }

  get canopyDistanceTexture() {
    return this._canopyDistanceTexture;
  }

  isGrassCandidateSurface(name) {
    return GRASS_CANDIDATE_SURFACES.has(name);
  }

  async prepareCanopyPlacements(placements = []) {
    if (!placements.length) return this.setCanopyPlacements(placements);
    const worker = new Worker(new URL('./CanopyField.worker.js', import.meta.url), { type: 'module' });
    let timeout;
    try {
      const fields = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Canopy field preparation timed out')), 60000);
        worker.onerror = event => reject(new Error(`Canopy field worker failed: ${event.message}`));
        worker.onmessageerror = () => reject(new Error('Canopy field worker returned an unreadable payload'));
        worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.fields);
        // Transfer copies: the live Terrain retains its texture storage until the
        // entire pair is ready, and Grass continues borrowing those same textures.
        const fields = [
          { data: this._growableData.slice(), nx: this.nx, nz: this.nz, spacing: this.spacing },
          { data: new Uint8Array(this._canopyDistanceData.length), nx: this._canopyDistanceNx,
            nz: this._canopyDistanceNz, spacing: this._canopyDistanceSpacing },
        ].map(({ spacing, ...field }) => ({ ...field,
          grid: { minX: this.bounds.minX, minZ: this.bounds.minZ, spacing } }));
        worker.postMessage({ fields, placements }, fields.map(field => field.data.buffer));
      });
      if (this._disposed) throw new Error('Terrain disposed during canopy field preparation');
      this._canopyData.set(fields[0]);
      this._canopyDistanceData.set(fields[1]);
      this._canopyTexture.needsUpdate = true;
      this._canopyDistanceTexture.needsUpdate = true;
      return this._canopyTexture;
    } finally { clearTimeout(timeout); worker.terminate(); }
  }

  setCanopyPlacements(placements = []) {
    this._canopyData.fill(0);
    bakeDenseCanopyMask(this._canopyData, this.nx, this.nz, {
      minX: this.bounds.minX,
      minZ: this.bounds.minZ,
      spacing: this.spacing,
    }, placements);
    bakeDenseCanopyMask(
      this._canopyDistanceData, this._canopyDistanceNx, this._canopyDistanceNz, {
        minX: this.bounds.minX,
        minZ: this.bounds.minZ,
        spacing: this._canopyDistanceSpacing,
      }, placements,
    );
    // Surface ownership is immutable for this Terrain. Do not repeat every
    // polygon/route query when only the tree-canopy field changes.
    for (let index = 0; index < this._canopyData.length; index++) this._canopyData[index] |= this._growableData[index];
    // After ownership is restored, take the trunks back out again: a blade growing
    // out of a root is worse than a bare patch under a tree, which is what the
    // ground looks like there anyway.
    clearTrunkFootprints(this._canopyData, this.nx, this.nz, {
      minX: this.bounds.minX, minZ: this.bounds.minZ, spacing: this.spacing,
    }, placements);
    this._canopyTexture.needsUpdate = true;
    this._canopyDistanceTexture.needsUpdate = true;
    return this._canopyTexture;
  }

  surfaceMaterialSnapshot() {
    return {
      version: 1,
      turf: {
        parallax: this.uParallax.value,
        detailNormal: this.uDetailNormal.value,
        ao: this.uAO.value,
        selfShadow: this.uShadow.value,
        roughnessBase: this.uRoughBase.value,
        roughnessRange: this.uRoughRange.value,
        specular: this.uSpecular.value,
        grazingRoughness: this.uGraze.value,
        saturation: this.uSat.value,
        value: this.uVal.value,
      },
      forestFloor: {
        reliefDepthMeters: this.uForestFloorDepth.value,
        normalStrength: this.uForestFloorNormal.value,
        sourceColorStrength: this.uForestFloorSourceColor.value,
        macroVariation: this.uForestFloorMacro.value,
        canopyAffinity: this.uForestFloorCanopyAffinity.value,
        crownCoreGrassDensity: this.uCrownCoreGrassDensity.value,
        crownFeatherMeters: this.uCrownFeatherMeters.value,
      },
    };
  }

  snapshotSurfaceMaterials() {
    return this.surfaceMaterialSnapshot();
  }

  applySurfaceMaterials(settings = {}) {
    const turf = settings.turf ?? settings;
    const floor = settings.forestFloor ?? {};
    const assign = (node, value) => { if (Number.isFinite(value)) node.value = value; };
    assign(this.uParallax, turf.parallax);
    assign(this.uDetailNormal, turf.detailNormal);
    assign(this.uAO, turf.ao);
    assign(this.uShadow, turf.selfShadow);
    assign(this.uRoughBase, turf.roughnessBase);
    assign(this.uRoughRange, turf.roughnessRange);
    assign(this.uSpecular, turf.specular);
    assign(this.uGraze, turf.grazingRoughness);
    assign(this.uSat, turf.saturation);
    assign(this.uVal, turf.value);
    assign(this.uForestFloorDepth, floor.reliefDepthMeters);
    assign(this.uForestFloorNormal, floor.normalStrength);
    assign(this.uForestFloorSourceColor, floor.sourceColorStrength);
    assign(this.uForestFloorMacro, floor.macroVariation);
    assign(this.uForestFloorCanopyAffinity, floor.canopyAffinity);
    assign(this.uCrownCoreGrassDensity, floor.crownCoreGrassDensity);
    assign(this.uCrownFeatherMeters, floor.crownFeatherMeters);
    return this.surfaceMaterialSnapshot();
  }

  // Ephemeral presentation state, updated after the final camera pose each frame.
  // It never enters surfaceMaterials and never rebuilds the terrain or its material.
  setNearBallTurfDetail({ activation = 0, cameraXZ, forwardXZ } = {}) {
    if (Number.isFinite(activation)) {
      this.uNearTurfActivation.value = Math.min(1, Math.max(0, activation));
    }
    if (cameraXZ && Number.isFinite(cameraXZ.x) && Number.isFinite(cameraXZ.y)) {
      this.uNearTurfCameraXZ.value.copy(cameraXZ);
    }
    if (forwardXZ && Number.isFinite(forwardXZ.x) && Number.isFinite(forwardXZ.y)) {
      const length = Math.hypot(forwardXZ.x, forwardXZ.y);
      if (length > 1e-6) this.uNearTurfForwardXZ.value.set(
        forwardXZ.x / length,
        forwardXZ.y / length,
      );
    }
    return this.uNearTurfActivation.value;
  }

  // Grass consumes the same signed-distance field as the ground shader so blade
  // height can cross rough/deep-rough boundaries continuously instead of following
  // the nearest CPU surface sample. Terrain remains the sole texture owner.
  get zoneTexture() {
    return this._zoneMap?.texture;
  }

  get zoneAuxTexture() {
    return this._zoneMap?.auxTexture;
  }

  // The irregular authored pond outline is also available as a compact, filtered
  // signed-distance field.  Terrain owns this texture; consumers borrow it just like
  // zoneTexture and never dispose it independently.
  get waterZoneTexture() {
    return this._zoneMap?.waterTexture;
  }

  get biomeTransitionTextures() {
    return this._biomeField?.hasTransitions
      ? Object.freeze({ land: this._biomeField.landTexture, water: this._biomeField.waterTexture })
      : null;
  }

  createHazardPatchMaterial() {
    const material = this._buildTurfMaterial(uniform(new Vector2(0, 0)), { useGeometrySurface: true });
    material.name = 'terrain-pbr-hazard-patch';
    return material;
  }

  classifyBiomeAt(x, z) {
    return this._biomeField?.sample(x, z) ?? null;
  }

  // Node graphs retain textures outside ordinary material properties, so Range's
  // generic material scan cannot own these.  Terrain owns them explicitly; Grass
  // borrows `heightTexture` / `zoneTexture` and must never dispose either one.
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // These authoring callbacks close over the owning Range. Async node/material
    // bookkeeping can retain a disposed Terrain briefly; severing the callbacks here
    // prevents that renderer lifetime from retaining the entire superseded course.
    this.heightFn = null;
    this.analyticHeightFn = null;
    this.analyticPatchContains = null;
    this.surfaceFn = null;
    this.finiteOutline = null;
    this.finiteCutout = null;
    this._heightTex?.dispose();
    this._canopyTexture?.dispose();
    this._canopyDistanceTexture?.dispose();
    this._zoneMap?.texture?.dispose();
    this._zoneMap?.auxTexture?.dispose();
    this._zoneMap?.waterTexture?.dispose();
    this._zoneMap?.arrayTexture?.dispose();
    this._biomeField?.dispose();
    this._biomeField = null;
    this._divotTex?.dispose();
    this._macroTexture?.dispose();
    this._macroInit?.dispose();
    this._greenNapTexture?.dispose();
    this._greenNapInit?.dispose();
    this._turfMaps?.release();
    this._turfMaps = null;
    this._turfRenderer = null;
    this._forestFloorMaps?.colorRoughness?.dispose();
    this._forestFloorMaps?.normalHeightAo?.dispose();
    if (this._coastSandAsset?.textures) releaseCoastSandTextures(this._coastSandAsset.textures);
    this._coastSandAsset = null;
  }

  // Course-scale variation is invariant under camera/time, so evaluating its twelve
  // procedural noise fields in every terrain fragment was pure repeated work. Bake the
  // seamless phase offsets, color variation, and moisture once into a filtered GPU
  // texture at the same 0.5 m authoring resolution as the zone SDF. No data crosses the
  // CPU and no alternate asset/path exists: every turf material samples this texture.
  _initMacroVariation(renderer) {
    const width = this._zoneMap.width;
    const height = this._zoneMap.height;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const textureOut = new StorageTexture(width, height);
    textureOut.name = 'terrain-macro-variation-gpu';
    textureOut.minFilter = textureOut.magFilter = LinearFilter;
    textureOut.wrapS = textureOut.wrapT = ClampToEdgeWrapping;
    // The compute pass writes only mip 0. Let the WebGPU binding generate the
    // remaining levels once the write has completed, so the persistent 0.5 m field
    // is footprint filtered at distance instead of aliasing into turf noise.
    textureOut.generateMipmaps = true;
    textureOut.mipmapsAutoUpdate = true;
    this._macroTexture = textureOut;

    this._macroInit = Fn(() => {
      const id = instanceIndex;
      const ix = id.mod(width);
      const iy = id.div(width);
      const wx = float(ix).add(0.5).div(width).mul(maxX - minX).add(minX);
      const wz = float(iy).add(0.5).div(height).mul(maxZ - minZ).add(minZ);
      const world = vec2(wx, wz);

      const ax = mx_noise_float(vec3(world.x.mul(0.083), world.y.mul(0.083), 7.1));
      const az = mx_noise_float(vec3(world.x.mul(0.083), world.y.mul(0.083), 19.4));
      const bx = mx_noise_float(vec3(world.x.mul(0.021), world.y.mul(0.021), 31.7));
      const bz = mx_noise_float(vec3(world.x.mul(0.021), world.y.mul(0.021), 47.9));
      const phase = vec2(mix(ax, bx, 0.35), mix(az, bz, 0.35)).sub(0.5).mul(0.32);

      const color0 = mx_noise_float(vec3(wx.mul(0.22), wz.mul(0.22), 8.0)).mul(0.5).add(0.5);
      const color1 = mx_noise_float(vec3(wx.mul(0.03), wz.mul(0.03), 0.0)).mul(0.5).add(0.5);
      const color2 = mx_noise_float(vec3(wx.mul(0.007), wz.mul(0.007), 3.0)).mul(0.5).add(0.5);
      const colorFactor = color0.mul(0.08).add(0.96)
        .mul(color1.mul(0.16).add(0.88))
        .mul(color2.mul(0.12).add(0.94));
      const moistureA = mx_noise_float(vec3(wx.mul(0.055), wz.mul(0.055), 17.0)).mul(0.5).add(0.5);
      const moistureB = mx_noise_float(vec3(wx.mul(0.014), wz.mul(0.014), 41.0)).mul(0.5).add(0.5);
      const moisture = mix(moistureA, moistureB, 0.45);

      // RG: phase [-.16,.16] -> [0,1]. B: expected color factor [.75,1.15]
      // -> [0,1]. A: moisture already lies in [0,1]. RGBA8 quantization is below
      // the physical turf-texel scale and keeps this persistent field compact.
      textureStore(textureOut, uvec2(ix, iy), vec4(
        phase.add(0.16).div(0.32),
        colorFactor.sub(0.75).div(0.4).clamp(0.0, 1.0),
        moisture,
      )).toWriteOnly();
    })().compute(width * height, [64]);
    this._macroInit.name = 'Terrain macro variation initialize';
    renderer.compute(this._macroInit);
  }

  // A dedicated maintained-turf nap field fills the scale gap between the authored
  // 1.5 m / 2K bentgrass scan and the 0.5 m course-scale macro bake. The scan owns
  // individual shoots; this field owns coherent 0.2--1.2 m density/leaf-lay patches
  // that remain visible from a normal green-inspection camera. Baking once at a
  // declared world resolution keeps the signal deterministic and lets the mip chain
  // retire it cleanly instead of evaluating live full-screen noise or stretching the
  // source atlas beyond its physical scale.
  _initGreenNapVariation(renderer, variationSeed = 0) {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    // The finite creator maquette is a small hero object, so it can afford the
    // 5 cm authoring texels needed for a visibly plush collar. Full courses retain
    // the capped 20 cm field; their closer play cameras resolve the source scans.
    const texelsPerM = this.finiteCanvas
      ? 20
      : Math.min(5, 2048 / spanX, 2048 / spanZ);
    const width = Math.max(2, Math.round(spanX * texelsPerM));
    const height = Math.max(2, Math.round(spanZ * texelsPerM));
    const seed = Number.isFinite(variationSeed) ? (variationSeed >>> 0) / 0xffffffff : 0;

    const textureOut = new StorageTexture(width, height);
    textureOut.name = 'terrain-green-nap-gpu';
    textureOut.magFilter = LinearFilter;
    textureOut.minFilter = LinearMipmapLinearFilter;
    textureOut.wrapS = textureOut.wrapT = ClampToEdgeWrapping;
    textureOut.generateMipmaps = true;
    textureOut.mipmapsAutoUpdate = true;
    this._greenNapTexture = textureOut;

    this._greenNapInit = Fn(() => {
      const id = instanceIndex;
      const ix = id.mod(width);
      const iy = id.div(width);
      const wx = float(ix).add(0.5).div(width).mul(spanX).add(minX);
      const wz = float(iy).add(0.5).div(height).mul(spanZ).add(minZ);
      const seedPhase = seed * 37.0;

      // The channels are deliberately incommensurate. Their frequencies follow the
      // declared bake resolution: the creator resolves roughly 12 cm collar clumps,
      // while a full course bottoms out near 0.5 m and relies on its closer camera
      // plus the authored atlas for finer shoots. B remains the broader wet/dry
      // cuticle response used only to perturb roughness/chroma.
      const napFrequency = Math.min(3.4, texelsPerM * 0.22);
      const densityFrequency = Math.min(8.4, texelsPerM * 0.42);
      const cuticleFrequency = Math.min(1.8, texelsPerM * 0.12);
      const nap = mx_noise_float(vec3(
        wx.mul(napFrequency), wz.mul(napFrequency * 0.86), float(401.0 + seedPhase),
      ));
      const density = mx_noise_float(vec3(
        wx.mul(densityFrequency), wz.mul(densityFrequency * 0.84), float(719.0 + seedPhase * 0.73),
      ));
      const cuticle = mx_noise_float(vec3(
        wx.mul(cuticleFrequency), wz.mul(cuticleFrequency * 1.18), float(977.0 + seedPhase * 1.17),
      ));
      textureStore(textureOut, uvec2(ix, iy), vec4(nap, density, cuticle, 1.0))
        .toWriteOnly();
    })().compute(width * height, [64]);
    this._greenNapInit.name = 'Terrain green nap initialize';
    renderer.compute(this._greenNapInit);
  }

  _buildMesh() {
    if (this.finiteCanvas) return this._buildFiniteCanvasMesh();
    // Fixed nested camera-centred rings. Each ring is a shared static grid with a
    // centre hole (except L0), so it has no overdraw/z-fight with its finer neighbour.
    // Every level is an exact multiple of the authoritative 0.6 m height grid and
    // remains registered to the common 4.8 m camera snap. This prevents small,
    // steep pot-bunker walls from changing coverage as ring ownership changes.
    // The outer ring keeps the same 160-cell budget as the former 384 m / 4.8 m
    // tier, but its 768 m reach covers this full routed site from every play camera.
    // This prevents an in-bounds hole between the real course and mountain shell.
    const rings = [
      { half: 36, step: 0.6, inner: 0 },
      { half: 72, step: 1.2, inner: 36 },
      { half: 144, step: 2.4, inner: 72 },
      { half: 768, step: 9.6, inner: 144 },
    ];
    const group = new Group();
    group.name = 'terrain-gpu-clipmap';
    this._rings = [];
    let vertices = 0, triangles = 0, bytes = 0;
    for (let level = 0; level < rings.length; level++) {
      const spec = rings[level];
      const origin = uniform(new Vector2());
      const geo = this._ringGeometry(spec);
      // Keep one real course cell beneath the mountain shell. Boundary-straddling
      // clipmap cells otherwise send their outside vertices to the sentinel and
      // expose a sky slit before the shell's exact edge begins.
      const boundsOverlap = level === rings.length - 1 ? spec.step : 0;
      const mat = this._buildTurfMaterial(origin, { boundsOverlap });
      const mesh = new Mesh(geo, mat);
      mesh.name = `terrain-clipmap-l${level}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      // Layer 2 is the solid-contact depth set used by the restrained AO pass.
      // Alpha-cut grass/tree cards stay on beauty layer 0 only, so they cannot
      // turn the underlying terrain into dirty screen-space occlusion.
      mesh.layers.enable(2);
      group.add(mesh);
      this._rings.push({ ...spec, origin, mesh });
      vertices += geo.getAttribute('position').count;
      triangles += geo.index.count / 3;
      bytes += geo.getAttribute('position').array.byteLength
        + geo.getAttribute('normal').array.byteLength + geo.index.array.byteLength;
    }
    const fullNx = Math.floor((this.bounds.maxX - this.bounds.minX) / this.renderSpacing) + 1;
    const fullNz = Math.floor((this.bounds.maxZ - this.bounds.minZ) / this.renderSpacing) + 1;
    this.drawStats = {
      draws: rings.length,
      vertices,
      triangles,
      groundCoverTriangles: 0,
      geometryBytes: bytes,
      previousFullGrid: {
        draws: 1,
        triangles: (fullNx - 1) * (fullNz - 1) * 2,
        geometryBytes: fullNx * fullNz * 32 + (fullNx - 1) * (fullNz - 1) * 6 * 4,
      },
      previousChunkGrid: { cellsPerChunk: 24, draws: Math.ceil((fullNx - 1) / 24) * Math.ceil((fullNz - 1) / 24) },
    };
    return group;
  }

  // The ordinary course uses camera-centred clipmap rings and sends out-of-bounds
  // vertices below the scene so the authored edge can meet its backdrop. The blank
  // creator deliberately exposes that edge as a maquette, so it needs an exact
  // finite grid: a sentinel-clipped ring produces huge edge triangles at oblique
  // angles. This remains the same Terrain material and authoritative height map.
  _buildFiniteCanvasMesh() {
    if (this.finiteOutline) return this._buildFiniteOutlineMesh();
    const width = this.bounds.maxX - this.bounds.minX;
    const depth = this.bounds.maxZ - this.bounds.minZ;
    const cellsX = Math.ceil(width / this.renderSpacing);
    const cellsZ = Math.ceil(depth / this.renderSpacing);
    const vertsX = cellsX + 1;
    const vertsZ = cellsZ + 1;
    const positions = new Float32Array(vertsX * vertsZ * 3);
    const normals = new Float32Array(vertsX * vertsZ * 3);
    for (let z = 0; z < vertsZ; z++) for (let x = 0; x < vertsX; x++) {
      const index = z * vertsX + x;
      const worldX = this.bounds.minX + width * x / cellsX;
      const worldZ = this.bounds.minZ + depth * z / cellsZ;
      positions[index * 3] = worldX;
      positions[index * 3 + 1] = this.heightAt(worldX, worldZ);
      positions[index * 3 + 2] = worldZ;
      normals[index * 3 + 1] = 1;
    }
    const indices = new Uint32Array(cellsX * cellsZ * 6);
    let cursor = 0;
    for (let z = 0; z < cellsZ; z++) for (let x = 0; x < cellsX; x++) {
      const a = z * vertsX + x;
      const b = a + 1;
      const d = a + vertsX;
      const e = d + 1;
      indices.set([a, d, b, b, d, e], cursor);
      cursor += 6;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    const origin = uniform(new Vector2());
    const mesh = new Mesh(geometry, this._buildTurfMaterial(origin, { useGeometrySurface: true }));
    mesh.name = 'terrain-creator-finite-grid';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.layers.enable(2);
    const group = new Group();
    group.name = 'terrain-creator-finite-canvas';
    group.add(mesh);
    this._rings = [{ half: width / 2, step: width / cellsX, inner: 0, origin, mesh, static: true }];
    this.drawStats = {
      draws: 1,
      vertices: vertsX * vertsZ,
      triangles: cellsX * cellsZ * 2,
      groundCoverTriangles: 0,
      geometryBytes: positions.byteLength + normals.byteLength + indices.byteLength,
      finiteCanvas: true,
    };
    return group;
  }

  // The creator showcase is a deliberately finite terrain maquette, but its top is
  // the generated fringe outline rather than the course's square sampling bounds.
  // A star-convex radial grid keeps every boundary vertex on that exact outline,
  // while the ordinary height texture remains the sole source of visible elevation.
  _buildFiniteOutlineMesh() {
    const outline = this.finiteOutline;
    // A cutout needs a true inner boundary, so use the cup itself as the radial
    // origin. Creator outlines are authored star-convex around the green centre;
    // this keeps every strip from the cup rim to the outer fringe non-crossing.
    const center = this.finiteCutout
      ? { x: this.finiteCutout.x, z: this.finiteCutout.z }
      : outline.reduce((sum, point) => ({
        x: sum.x + point.x / outline.length,
        z: sum.z + point.z / outline.length,
      }), { x: 0, z: 0 });
    const maxRadius = Math.max(...outline.map((point) => Math.hypot(point.x - center.x, point.z - center.z)));
    const rings = Math.max(2, Math.ceil(maxRadius / this.renderSpacing));
    const segments = outline.length;
    const hasCutout = Boolean(this.finiteCutout);
    const vertexCount = hasCutout ? (rings + 1) * segments : 1 + rings * segments;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    if (hasCutout) {
      for (let segment = 0; segment < segments; segment += 1) {
        // Preserve each outline ray's authored angle at the inner boundary. The
        // organic outline can begin at any world rotation; using segment index as
        // an absolute angle would twist all spokes between the cup and first ring.
        const dx = outline[segment].x - center.x;
        const dz = outline[segment].z - center.z;
        const length = Math.hypot(dx, dz) || 1;
        positions[segment * 3] = center.x + dx / length * this.finiteCutout.radius;
        positions[segment * 3 + 2] = center.z + dz / length * this.finiteCutout.radius;
        positions[segment * 3 + 1] = this.heightAt(positions[segment * 3], positions[segment * 3 + 2]);
        normals[segment * 3 + 1] = 1;
      }
    } else {
      positions[0] = center.x;
      positions[1] = this.heightAt(center.x, center.z);
      positions[2] = center.z;
      normals[1] = 1;
    }
    for (let ring = 1; ring <= rings; ring += 1) {
      const amount = ring / rings;
      for (let segment = 0; segment < segments; segment += 1) {
        const point = outline[segment];
        const vertex = (hasCutout ? ring * segments : 1 + (ring - 1) * segments) + segment;
        positions[vertex * 3] = center.x + (point.x - center.x) * amount;
        positions[vertex * 3 + 2] = center.z + (point.z - center.z) * amount;
        positions[vertex * 3 + 1] = this.heightAt(positions[vertex * 3], positions[vertex * 3 + 2]);
        normals[vertex * 3 + 1] = 1;
      }
    }

    const indexData = [];
    if (!hasCutout) {
      for (let segment = 0; segment < segments; segment += 1) {
        const next = (segment + 1) % segments;
        indexData.push(0, 1 + next, 1 + segment);
      }
    }
    for (let ring = hasCutout ? 1 : 2; ring <= rings; ring += 1) {
      const innerStart = hasCutout ? (ring - 1) * segments : 1 + (ring - 2) * segments;
      const outerStart = hasCutout ? ring * segments : 1 + (ring - 1) * segments;
      for (let segment = 0; segment < segments; segment += 1) {
        const next = (segment + 1) % segments;
        const inner = innerStart + segment;
        const innerNext = innerStart + next;
        const outer = outerStart + segment;
        const outerNext = outerStart + next;
        indexData.push(inner, outerNext, outer, inner, innerNext, outerNext);
      }
    }
    const indices = new Uint32Array(indexData);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    const origin = uniform(new Vector2());
    const mesh = new Mesh(geometry, this._buildTurfMaterial(origin, { useGeometrySurface: true }));
    mesh.name = 'terrain-creator-organic-outline';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.layers.enable(2);
    const group = new Group();
    group.name = 'terrain-creator-finite-canvas';
    group.add(mesh);
    this._rings = [{ half: maxRadius, step: maxRadius / rings, inner: 0, origin, mesh, static: true }];
    this.drawStats = {
      draws: 1,
      vertices: vertexCount,
      triangles: indices.length / 3,
      groundCoverTriangles: 0,
      geometryBytes: positions.byteLength + normals.byteLength + indices.byteLength,
      finiteCanvas: true,
      finiteOutline: true,
      finiteCutout: this.finiteCutout ? { ...this.finiteCutout } : null,
    };
    return group;
  }

  _ringGeometry({ half, step, inner }) {
    const cells = Math.round((half * 2) / step);
    const verts = cells + 1;
    const positions = new Float32Array(verts * verts * 3);
    const normals = new Float32Array(verts * verts * 3);
    for (let z = 0; z < verts; z++) for (let x = 0; x < verts; x++) {
      const i = z * verts + x;
      positions[i * 3] = -half + x * step;
      positions[i * 3 + 2] = -half + z * step;
      normals[i * 3 + 1] = 1;
    }
    const hole = Math.round((inner * 2) / step);
    const h0 = (cells - hole) / 2, h1 = h0 + hole;
    const data = [];
    for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
      if (inner > 0 && x >= h0 && x < h1 && z >= h0 && z < h1) continue;
      const a = z * verts + x, b = a + 1, d = a + verts, e = d + 1;
      data.push(a, d, b, b, d, e);
    }
    if (inner > 0) {
      // A shallow inner skirt closes the T-junctions where the finer ring has vertices
      // between this ring's coarse edge vertices.  Keep the drop deliberately tiny:
      // shared anchors make the two top boundaries meet, so it only has to cover the
      // sub-metre interpolation error, not form a retaining wall.  Larger skirts were
      // visibly self-shadowing as a black band at grazing angles.
      const seamDepth = -0.35;
      const pos = Array.from(positions);
      const nor = Array.from(normals);
      const edge = (a, b) => {
        const base = pos.length / 3;
        const ax = positions[a * 3], az = positions[a * 3 + 2];
        const bx = positions[b * 3], bz = positions[b * 3 + 2];
        pos.push(ax, seamDepth, az, bx, seamDepth, bz);
        nor.push(0, 1, 0, 0, 1, 0);
        data.push(a, b, base, b, base + 1, base);
      };
      for (let x = h0; x < h1; x++) {
        edge(h0 * verts + x, h0 * verts + x + 1);
        edge(h1 * verts + x + 1, h1 * verts + x);
      }
      for (let z = h0; z < h1; z++) {
        // The hole's left edge is vertex column h0.  h0 + 1 is one vertex
        // inside the deleted top-face region and leaves a thin vertical gap.
        edge(z * verts + h0, (z + 1) * verts + h0);
        edge((z + 1) * verts + h1, z * verts + h1);
      }
      // The static arrays above cannot grow; construct extended attributes below.
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
      geo.setIndex(new BufferAttribute(new Uint32Array(data), 1));
      return geo;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('normal', new BufferAttribute(normals, 3));
    geo.setIndex(new BufferAttribute(new Uint32Array(data), 1));
    return geo;
  }

  // Called after the final camera pose each frame. EVERY ring takes the same coarsest
  // (4.8m) anchor. Independent per-ring snaps create fractional ring offsets and turn
  // their matching inner/outer boundaries into gaps; a shared anchor keeps all powers
  // of two registered through every camera phase.  Temporal history is derived from
  // the same world sample through the previous camera below, never from a snapped
  // local vertex index.
  update(camera) {
    if (!this._rings || !camera) return;
    if (this.finiteCanvas) return;
    const anchorStep = this._rings[this._rings.length - 1].step;
    const x = Math.floor(camera.position.x / anchorStep) * anchorStep;
    const z = Math.floor(camera.position.z / anchorStep) * anchorStep;
    for (const ring of this._rings) {
      ring.origin.value.set(x, z);
      ring.mesh.position.set(x, 0, z);
    }
  }

  // A single native grass substrate surrounds every alpine course edge. Borrow
  // the resident rough maps so physical scale and filtering agree on both meshes.
  backdropSurfaceNodes() {
    const set = this._turfMaps.rough;
    const uv = vec2(positionWorld.x, positionWorld.z).div(set.tile);
    const albedo = texture(this._turfMaps.albedoArray).sample(uv).depth(int(set.layer));
    const nrh = texture(this._turfMaps.nrhArray).sample(uv).depth(int(set.layer));
    const c = turfUndercoatBase('deepRough', new Color());
    let color = vec3(c.r, c.g, c.b).mul(luminance(albedo.rgb).div(set.albedoMean).clamp(0.65, 1.35)).mul(0.90);
    color = mix(vec3(luminance(color)), color, this.uSat.mul(0.98))
      .mul(vec3(1.03, 1, 0.95)).mul(this.uVal);
    return { color, roughness: float(0.94),
      ao: mix(float(1), nrh.a, this.uAO), specular: this.uSpecular.mul(0.90) };
  }

  // GPU reconstruction of the authoritative physics heightfield. Clamp BEFORE
  // texel fetches, so central-difference normals at course edges have no OOB loads
  // and behave exactly like CPU `heightAt()`'s clamped samples.
  _heightNode(x, z) {
    const uvx = x.sub(this.bounds.minX).div(this.bounds.maxX - this.bounds.minX).clamp(0.0, 1.0);
    const uvz = z.sub(this.bounds.minZ).div(this.bounds.maxZ - this.bounds.minZ).clamp(0.0, 1.0);
    const gx = uvx.mul(this.nx - 1);
    const gz = uvz.mul(this.nz - 1);
    const ix = gx.floor().min(this.nx - 2);
    const iz = gz.floor().min(this.nz - 2);
    const fx = gx.sub(ix), fz = gz.sub(iz);
    const load = (i, j) => textureLoad(this._heightTex, ivec2(int(i), int(j))).x;
    return mix(
      mix(load(ix, iz), load(ix.add(1), iz), fx),
      mix(load(ix, iz.add(1)), load(ix.add(1), iz.add(1)), fx),
      fz,
    );
  }

  _normalNode(x, z) {
    const e = this.renderSpacing;
    const hL = this._heightNode(x.sub(e), z);
    const hR = this._heightNode(x.add(e), z);
    const hD = this._heightNode(x, z.sub(e));
    const hU = this._heightNode(x, z.add(e));
    return vec3(hL.sub(hR), float(2 * e), hD.sub(hU)).normalize();
  }

  // Shared turf material: analytic per-zone tint (smooth-curve boundaries) relit
  // by a lawn detail texture. Sand keeps its own tan (the green-ward turfBase
  // transform is only for grass).
  _buildTurfMaterial(origin = uniform(new Vector2()), {
    useGeometrySurface = false, boundsOverlap = 0,
  } = {}) {
    if (!this._turfMaps) {
      this._turfMaps = acquireTurfMaps(this._turfRenderer, loadTurfMaps);
      // Some terrain materials are compiled while image decode is still in flight.
      // Three records the texture's byte size when its first GPU handle is created;
      // without this one-time invalidation, a handle initially made from the 1×1
      // loading image keeps that tiny accounting entry after the real 2048px source
      // replaces it.  These are the same loaded texture objects (not a secondary
      // asset path): dispose only forces the next bind to allocate their final image
      // and makes renderer memory reporting match the actual GPU allocation.
      this.assetsReady = Promise.all([
        this._turfMaps.ready,
        this._coastSandAsset?.ready || Promise.resolve(),
        this._forestFloorMaps?.ready || Promise.resolve(),
      ]);
    }
    const maps = this._turfMaps;
    // One base TextureNode per array is essential: samples cloned from this base
    // share one WebGPU texture/sampler binding even when they select different
    // layers and LODs. Creating a new texture node per layer defeats the array's
    // binding compaction and consumes the same sampler budget as six 2D textures.
    const turfAlbedoArrayNode = texture(maps.albedoArray);
    const turfNrhArrayNode = texture(maps.nrhArray);
    const mat = new MeshPhysicalNodeMaterial({ metalness: 0.0, side: DoubleSide });
    // `positionGeometry` carries only static X/Z grid topology. Reconstruct Y and
    // the matching central-difference normal from the authoritative height texture
    // in the vertex path; physics remains the sole CPU consumer of `heights`.
    const terrainX = positionGeometry.x.add(origin.x);
    const terrainZ = positionGeometry.z.add(origin.y);
    const terrainHeight = useGeometrySurface ? positionGeometry.y : this._heightNode(terrainX, terrainZ);
    const terrainNormal = useGeometrySurface ? normalGeometry.normalize() : this._normalNode(terrainX, terrainZ);
    const inBounds = terrainX.greaterThanEqual(this.bounds.minX - boundsOverlap)
      .and(terrainX.lessThanEqual(this.bounds.maxX + boundsOverlap))
      .and(terrainZ.greaterThanEqual(this.bounds.minZ - boundsOverlap))
      .and(terrainZ.lessThanEqual(this.bounds.maxZ + boundsOverlap));
    // Sampling clamps safely at the texture boundary, but rendering that clamped edge
    // beyond the authored course would create a giant flat apron. Drop those vertices
    // far below the camera instead; no fragment or shadow can leak in from OOB space.
    const renderedHeight = inBounds.select(terrainHeight, float(-10000));
    // Mesh transform owns the snapped origin so positionWorld-dependent turf/zones
    // see true world coordinates; the uniform remains the height-sample coordinate.
    // Ring top vertices have local Y = 0; the inner skirt uses a small negative local
    // Y.  Preserve it after displacement or the skirt collapses onto the top surface.
    mat.positionNode = vec3(positionGeometry.x,
      renderedHeight.add(positionGeometry.y), positionGeometry.z);
    if (useGeometrySurface) mat.positionNode = vec3(positionGeometry.x, renderedHeight, positionGeometry.z);
    if (this.motionHistory) {
      // A shared anchor is an integer multiple of every ring step: at a snap, the
      // *same world samples* are still present, merely under different static vertex
      // indices. Their previous clip is therefore the current world position through
      // the previous camera, not `positionGeometry + previousOrigin` (which would
      // invent a 4.8m terrain velocity and smear TRAA).
      const currentClip = this.motionHistory.currentProjection.mul(this.motionHistory.currentView)
        .mul(vec4(terrainX, renderedHeight, terrainZ, 1));
      const previousClip = this.motionHistory.previousProjection.mul(this.motionHistory.previousView)
        .mul(vec4(terrainX, renderedHeight, terrainZ, 1));
      mat.mrtNode = mrt({ velocity: currentClip.xy.div(currentClip.w)
        .sub(previousClip.xy.div(previousClip.w)).toVarying('vTerrainClipmapVelocity') });
    }
    // Physical (not Standard) purely for specularIntensity — see uSpecular. The final
    // node is assigned with the registered mower-lay response below, after the shared
    // strip phase and view/light alignment have been built.

    // The moving 15-yard focus footprint is low-frequency relative to the nearest
    // 0.6 m terrain grid, so evaluate its C2 wedge in the vertex stage and interpolate
    // one scalar. Keeping the quintic arithmetic out of every fragment makes inactive
    // menu/editor views and active play views share a negligible presentation cost.
    const nearVertexXZ = vec2(terrainX, terrainZ);
    const nearVertexDelta = nearVertexXZ.sub(this.uNearTurfCameraXZ);
    const nearVertexForward = nearVertexDelta.dot(this.uNearTurfForwardXZ);
    const nearVertexLateral = nearVertexDelta.x.mul(this.uNearTurfForwardXZ.y)
      .sub(nearVertexDelta.y.mul(this.uNearTurfForwardXZ.x)).abs();
    const nearLeading = smootherstepNode(
      NEAR_BALL_TURF_DETAIL.forwardStartMeters,
      NEAR_BALL_TURF_DETAIL.forwardFullMeters,
      nearVertexForward,
    );
    const nearTrailing = oneMinus(smootherstepNode(
      NEAR_BALL_TURF_DETAIL.forwardFadeMeters,
      NEAR_BALL_TURF_DETAIL.forwardEndMeters,
      nearVertexForward,
    ));
    const nearForwardPositive = nearVertexForward.max(0.0);
    const nearLateralFull = nearForwardPositive.mul(NEAR_BALL_TURF_DETAIL.lateralFullSlope)
      .add(NEAR_BALL_TURF_DETAIL.lateralFullBaseMeters);
    const nearLateralEnd = nearForwardPositive.mul(NEAR_BALL_TURF_DETAIL.lateralEndSlope)
      .add(NEAR_BALL_TURF_DETAIL.lateralEndBaseMeters);
    const nearLateralWeight = oneMinus(smootherstepNode(
      nearLateralFull, nearLateralEnd, nearVertexLateral,
    ));
    const nearTurfFootprint = nearLeading.mul(nearTrailing).mul(nearLateralWeight)
      .toVarying('vNearTurfFootprint');

    const worldXZ = vec2(positionWorld.x, positionWorld.z);
    const macroUv = vec2(
      worldXZ.x.sub(this.bounds.minX).div(this.bounds.maxX - this.bounds.minX),
      worldXZ.y.sub(this.bounds.minZ).div(this.bounds.maxZ - this.bounds.minZ),
    );
    const macroVariation = texture(this._macroTexture, macroUv);
    const greenNapVariation = texture(this._greenNapTexture, macroUv);
    // All three fields retain RGBA16F/linear filtering, but share one sampler.
    // Clone samples from one base node so Three also shares the binding.
    const zoneArray = texture(this._zoneMap.arrayTexture);
    const zoneSample = zoneArray.sample(macroUv).depth(int(0)).toVar('zoneSD');
    const zoneAuxSample = zoneArray.sample(macroUv).depth(int(1)).toVar('zoneAuxSD');
    const waterZoneSample = zoneArray.sample(macroUv).depth(int(2)).toVar('waterBankSample');
    let biomeLand = null;
    let biomeWater = null;
    let coastWeights = null;
    let coastSand = null;
    if (this._biomeField?.hasTransitions) {
      biomeLand = texture(this._biomeField.landTexture, macroUv);
      biomeWater = texture(this._biomeField.waterTexture, macroUv);
      coastWeights = coastTextureBlendWeights({
        dune: biomeLand.b, drySand: biomeLand.a, wetSand: biomeWater.r,
        shallowShelf: biomeWater.g,
      }, worldXZ);
      if (this._coastSandAsset?.textures) {
        coastSand = sampleCoastSand(this._coastSandAsset.textures, worldXZ, coastWeights);
      }
    }
    if (!useGeometrySurface) {
      // The fixed analytic patch owns the complete pot-bunker footprint. Removing
      // the coarse clipmap below it prevents z-fighting and stops camera snaps from
      // changing which low-resolution wall triangles remain visible.
      const potOuter = waterZoneSample.a;
      mat.opacityNode = oneMinus(smoothstep(-0.12, 0.04, potOuter));
      mat.alphaTestNode = 0.5;
    }
    if (this.activeCup) {
      const outsideCup = worldXZ.sub(this.activeCup.xz).length().greaterThanEqual(this.activeCup.y).select(1, 0);
      mat.opacityNode = (mat.opacityNode ?? float(1)).mul(outsideCup);
      mat.alphaTestNode = 0.5;
    }
    const flat = smoothstep(0.75, 0.97, terrainNormal.y);

    // Detail is filtered by the texture footprint below, not by camera distance. A
    // radial fade creates a moving viewer-centred ring on flat turf and pollutes
    // temporal history; the surface/slope gate is world-stable.
    const dw = flat;

    // ---- Real surface normal. This replaces the old parallax hack, which offset
    // every texture read by a PER-PIXEL sample of a high-frequency noise height map
    // (divided by Vdir.y, so up to ~0.24 m of offset at grazing angles). Neighbouring
    // pixels therefore got wildly different UVs and the turf tore into liquid swirls.
    // Single-tap parallax is only valid on a SMOOTH height field.
    //
    // Note the material no longer sets `normalMap`: three's node path takes tangents
    // from an `attribute('tangent')` and never derives them, and the terrain geometry
    // has none — so the old normal map was feeding a degenerate TBN and the sun was
    // never reaching the turf relief (part of why it looked flat enough to "need"
    // parallax). Our mapping is planar down world XZ, so no TBN is needed at all:
    // the map's U/V axes ARE world X/Z, and the relief is just added to the terrain
    // normal. Chunk meshes are untransformed, so object space == world space.
    // ---- Canopy depth, in millimetres of real turf. Fairway and green never get
    // blade GEOMETRY (short blades read as scattered slivers), so all of their height
    // has to come from here — this is what gives the ball something to sit down into
    // instead of resting on a painted plane.
    const m = turfZoneMasks(zoneSample, zoneAuxSample, waterZoneSample, this.zones);
    const canopyMask = texture(this._canopyDistanceTexture, macroUv).r;
    const canopyInwardMeters = canopyMask.mul(CANOPY_DISTANCE_MAX_METERS);
    const maintainedOrHazard = m.visualFairway.add(m.fringe).add(m.green)
      .add(m.tee).add(m.sand).add(m.waterBank).clamp(0.0, 1.0);
    // The packed habitat field is stable physical distance, while feathering is a
    // live material uniform. Editing crownFeatherMeters therefore moves only this
    // visible pine-floor boundary on the next frame; Terrain, Grass, and the shared
    // R8 texture all retain identity. Exact packed zero remains outside-canopy turf.
    const crownFloorWeight = smoothstep(
      0.0, this.uCrownFeatherMeters, canopyInwardMeters,
    ).mul(oneMinus(maintainedOrHazard));
    const legacyNativeWeight = oneMinus(m.rough.add(maintainedOrHazard).clamp(0.0, 1.0));
    // Affinity 1 makes the litter literal pine habitat, including rough beneath a
    // crown; affinity 0 retains the former all-native-floor behavior for migration.
    const nativeFloorWeight = this._forestFloorMaps
      ? (this.zones.forestFloors?.length
        ? smoothstep(0.0, this.uCrownFeatherMeters, zoneAuxSample.b)
          .mul(oneMinus(maintainedOrHazard))
        : mix(legacyNativeWeight, crownFloorWeight, this.uForestFloorCanopyAffinity))
      : float(0.0);
    // Keep every PBR channel on the scan's one physical two-metre projection.
    // Distant repetition is removed below by footprint-filtering albedo contrast,
    // never by misregistering colour from normal, height, roughness, and AO.
    const forestFloorUv = worldXZ.div(2.0);
    const zone = turfCanopyDepth(m);
    const zoneDepth = zone.depth;
    // Which detail family this pixel belongs to (0 = rough/deepRough,
    // 1 = maintained fairway/green). See turfMownWeight.
    const mownW = turfMownWeight(m);

    // Low, ball-adjacent inspection views reveal more of the authored maintained
    // turf's registered normal/height signal over a 15-yard camera-forward wedge.
    // This is intentionally not a radial camera-distance fade: a broad C2 trapezoid
    // follows the visible ground, preserves the source phase/mean response, and never
    // loads or swaps a texture while the camera moves.
    const nearMaintainedMask = m.visualFairway.add(m.fringe).add(m.green).add(m.tee)
      .clamp(0.0, 1.0).mul(smoothstep(0.18, 0.35, mownW));
    const nearTurfDetailWeight = this.uNearTurfActivation.mul(nearTurfFootprint)
      .mul(nearMaintainedMask);

    // ---- LAYERED parallax occlusion. The ray from the eye is marched DOWN through
    // the baked canopy height field in NL equal steps and stopped at the first step
    // that is below the surface, so every pixel resolves to a real ray/height-field
    // intersection. That is the crucial difference from the old single-tap parallax:
    // that one just offset the lookup by this pixel's own height sample, so on a
    // high-frequency field neighbouring pixels jumped to unrelated texels and the turf
    // tore into liquid swirls. Marching is exactly the fix for a noisy height field.
    //
    // The ray-march samples use an explicit LOD because WGSL forbids implicit
    // derivatives under non-uniform control flow. Final PBR reads use the explicit
    // screen gradients calculated outside that march so anisotropy remains available.
    // Crossing interpolation turns the two retained samples into a continuous secant
    // intersection rather than two visible depth shelves. At a true 4–11 mm mown
    // canopy, more samples do not add screen-resolvable silhouette information at
    // native 1440p; rough receives real near-field blades on top of this map.
    const NL = 2;
    const V = cameraPosition.sub(positionWorld).normalize();
    const S = this.uSunDir;
    // POM is intentionally disabled at the most grazing view angles. There is no
    // stable texel intersection to recover there once a pixel spans multiple source
    // texels; the filtered normal/roughness path is the higher-quality answer than a
    // stretched heightfield streak.
    const pomViewWeight = smoothstep(TURF_POM_MIN_VIEW_UP, TURF_POM_FULL_VIEW_UP, V.y);
    const depthM = zoneDepth.mul(dw).mul(this.uParallax).mul(pomViewWeight);
    // Per-pixel world footprint in METRES, taken once here. Parallax/self-shadow
    // marches use a conservative scalar LOD; final material reads below retain both
    // gradients and WebGPU's anisotropic filtering.
    const duvM = dFdx(worldXZ).length().max(dFdy(worldXZ).length());
    const lodFor = (scaleM, resolution, albedoBias = 0.0) => duvM.div(scaleM).mul(resolution).log2()
      .max(0.0).min(Math.log2(resolution) - albedoBias);
    // A parallax or blade-shadow ray can only add information while the native
    // canopy texture is actually resolved.  Once one shaded fragment covers several
    // source texels, ray-marching that texture is both undersampled (it aliases) and
    // needlessly expensive: the atlas mip already contains its filtered average.
    //
    // This is deliberately driven by the *screen-space texture footprint*, not
    // camera distance.  It therefore follows the same minification boundary as the
    // texture filter rather than painting a circular camera-relative handoff across a
    // flat fairway.  We only fade parallax displacement and its micro self-shadow;
    // normal, canopy AO, roughness, and the material's base albedo keep their normal
    // mip-filtered path at every distance, so there is no luminance ring.
    const microRayWeight = (lod) => oneMinus(smoothstep(0.75, 1.75, lod));

    // The native forest floor is a real-scale 2 m fresh longleaf-pine-straw material.
    // March its displacement map at a bounded 28 mm physical depth so overlapping
    // straw and twigs sit above the compacted soil instead of reading as a flat tan
    // photograph. The ray retires by texture footprint and grazing angle, exactly
    // where filtered normal/roughness becomes the more stable representation.
    const forestFloorLod = lodFor(2.0, 2048);
    const forestFloorMicro = microRayWeight(forestFloorLod);
    const forestFloorRayWeight = nativeFloorWeight.mul(flat)
      .mul(forestFloorMicro).mul(pomViewWeight);
    const forestFloorDepthM = this.uForestFloorDepth.mul(forestFloorRayWeight);
    const forestFloorTravel = vec2(V.x, V.z).div(V.y.abs().max(0.30))
      .mul(forestFloorDepthM.div(2.0));
    const forestFloorMaxTravelUv = float(3.0 / 2048.0);
    const forestFloorTravelScale = forestFloorMaxTravelUv
      .div(forestFloorTravel.length().max(1e-6)).min(1.0);
    const forestFloorUvP = this._forestFloorMaps
      ? forestFloorParallaxUV(
        this._forestFloorMaps.normalHeightAo,
        forestFloorUv,
        forestFloorTravel.mul(forestFloorTravelScale).negate().div(3),
        forestFloorLod,
        forestFloorRayWeight,
        3,
      )
      : forestFloorUv;
    const forestFloorColorRoughness = this._forestFloorMaps
      ? textureLevel(this._forestFloorMaps.colorRoughness, forestFloorUvP, forestFloorLod)
      : vec4(0.0, 0.0, 0.0, 0.96);
    const forestFloorNormalHeightAo = this._forestFloorMaps
      ? textureLevel(this._forestFloorMaps.normalHeightAo, forestFloorUvP, forestFloorLod)
      : vec4(0.5, 0.5, 0.0, 1.0);
    // The source's measured linear mean preserves energy while its recognizable
    // two-metre arrangement retires between LOD 3 and 7. The already-resident
    // aperiodic macro field then owns distance-scale variation at no extra fetch.
    const forestFloorMacroGrade = macroVariation.r.sub(0.5)
      .mul(this.uForestFloorMacro).add(1.0);
    const forestFloorSourceMean = vec3(0.162029, 0.056128, 0.024158);
    const forestFloorSourceDetail = oneMinus(smoothstep(4.5, 10.5, forestFloorLod));
    const forestFloorAlbedo = mix(
      forestFloorSourceMean, forestFloorColorRoughness.rgb, forestFloorSourceDetail,
    ).mul(forestFloorMacroGrade).mul(this.uForestFloorSourceColor);
    const forestFloorNormalXY = forestFloorNormalHeightAo.rg.mul(2.0).sub(1.0);
    const forestFloorNormal = vec3(
      forestFloorNormalXY,
      oneMinus(forestFloorNormalXY.x.mul(forestFloorNormalXY.x)
        .add(forestFloorNormalXY.y.mul(forestFloorNormalXY.y))).max(0.0).sqrt(),
    );
    // CAP the total march distance. Horizontal travel goes as V.xz/V.y, so at ball-eye
    // height the ray wants to cross far more texels than NL steps can sample, and the
    // march strides straight over whole blades — which shows up as smearing along the
    // view direction. Capping the TOTAL travel (rather than the angle) bounds the
    // two-layer march to 2.5 source texels at any angle: depth is preserved wherever
    // it can be resolved and quietly gives way where it can't, which is the honest
    // trade at a fixed layer count. The old global 2048 assumption made the 1024px
    // maintained maps start one mip too blurry and halved their useful close-range
    // parallax travel.

    // Everything read out of ONE detail bake. Called once per bake so the mown and
    // rough sets go through identical code — they differ only in content and in the
    // world size of their tile.
    // The phase field is common to both bakes.  Keeping it outside readTier makes the
    // rough overwrite path share the same four procedural samples with maintained
    // default instead of evaluating them twice per rough fragment.
    // Continuous phase offsets are generated once on the GPU for the entire authored
    // course. They break repeated atlas seam alignment without twelve live noise fields.
    const phase = macroVariation.rg.mul(0.32).sub(0.16);
    const readTier = (set) => {
      const T = set.tile;
      // Reserve the source's positive albedo bias inside the final mip boundary.
      // The normal/height read can stop two levels earlier because its unresolved
      // response is already retired before that boundary.
      const lod = lodFor(T, set.resolution, set.albedoLodBias);
      const maxTravelUV = float(TURF_POM_MAX_TRAVEL_TEXELS / set.resolution);
      const micro = microRayWeight(lod);
      // The conservative scalar LOD above owns ray-march safety, but it must not
      // select the final PBR samples: at a grazing golfer view the along-fairway
      // footprint is much larger than the cross-fairway footprint, and choosing the
      // worst axis blurs still-resolvable blade fibres in both directions. Preserve
      // the two screen gradients for WebGPU's anisotropic filter. The finite-tile
      // collapse uses the same bounded 8:1 footprint, so only detail unresolved by
      // that filter converges to the measured mean.
      const uv0 = worldXZ.mul(1 / T).add(phase);
      const uvDx = dFdx(uv0);
      const uvDy = dFdy(uv0);
      const uvDxLength = uvDx.length();
      const uvDyLength = uvDy.length();
      const anisotropicFootprint = uvDxLength.max(uvDyLength).div(8.0)
        .max(uvDxLength.min(uvDyLength));
      const filteredLod = anisotropicFootprint.mul(set.resolution).log2()
        .max(0.0).min(Math.log2(set.resolution));
      const unresolved = smoothstep(5.5, 8.0, filteredLod);
      const rayActive = dw.mul(micro).mul(pomViewWeight);
      // A continuous phase warp makes the atlas's U/V wrap lines wander naturally
      // through world space instead of accumulating into straight visible seams.
      // Horizontal travel per unit of depth is V.xz / V.y, away from the eye. V.y is
      // clamped so a grazing view can't demand an unbounded march.
      // Fade the displacement itself as the source signal becomes minified.  Merely
      // skipping the loop would make a hard UV step at its coverage boundary.
      const microDepthM = depthM.mul(micro);
      const travel = vec2(V.x, V.z).div(V.y.abs().max(0.30)).mul(microDepthM.div(T));
      const scale = maxTravelUV.div(travel.length().max(1e-6)).min(1.0);
      const stepUV = travel.mul(scale).negate().div(NL);
      const uvP = turfParallaxUV(
        turfNrhArrayNode, int(set.layer), uv0, stepUV, lod, rayActive, NL,
      );

      const dNrh = texture(turfNrhArrayNode, uvP).depth(int(set.layer))
        .grad(uvDx, uvDy);
      // Keep the full-resolution relief signal, but do not mistake every baked colour
      // fleck for a separate blade. Short, tightly cut turf reads as a coherent
      // pigment layer whose fine structure appears through normal/height response to
      // light. A positive albedo-only mip bias prefilters the source colour while the
      // 2K NRH map remains at native footprint resolution.
      // A positive albedo-only bias is represented by scaling both gradients;
      // this preserves their anisotropic ratio instead of falling back to one
      // explicit isotropic mip level.
      const albedoGradientScale = float(2).pow(set.albedoLodBias);
      const dAlb = texture(turfAlbedoArrayNode, uvP).depth(int(set.layer))
        .grad(uvDx.mul(albedoGradientScale), uvDy.mul(albedoGradientScale));
      const pigmentMean = vec3(...set.pigmentMean);
      const normalizedAlbedo = dAlb.rgb.mul(TURF_LUM / set.albedoMean);
      const pigment = mix(pigmentMean, normalizedAlbedo, set.albedoContrast);
      const nDetail = vec3(dNrh.r.mul(2).sub(1), 0.0, dNrh.g.mul(2).sub(1));
      // Same cap on the shadow march, for the same reason (a low sun grazes just as hard).
      const sunTravel = vec2(S.x, S.z).div(S.y.max(0.15)).mul(microDepthM.div(T));
      const shadowTravelUV = float(TURF_SHADOW_MAX_TRAVEL_TEXELS / set.resolution);
      const sunUVFull = sunTravel.mul(shadowTravelUV.div(sunTravel.length().max(1e-6)).min(1.0));

      return {
        // The detail relief is NOT gated by camera distance, and must never be again.
        // That `dw` factor is what painted the ring on the fairway. Fading a normal
        // map's AMPLITUDE with distance changes the surface's mean brightness — a
        // perturbed normal field under a low sun does not average to the same N.L as a
        // flat one — so the ramp itself is a radial brightness gradient centred on the
        // viewer, with its ends visible as an arc. Smoothing the ramp (smoothstep ->
        // smootherstep) barely touched it, because the artifact is the ramp, not a
        // corner in it. Bisected offline: zeroing the former detail/mid relief removed
        // the arc completely, and so did forcing the former handoff to its detail
        // tier everywhere. The production path below is now footprint/world driven.
        //
        // Distance flattening still happens, properly and per-pixel: `lod` grows with
        // the texel footprint, and a normal map's mips average toward flat on their own.
        // That is view-independent, so it cannot draw a ring. `flat` stays — a steep
        // face genuinely can't take a planar-projected map, and it is a property of the
        // SURFACE, not of where the camera is standing.
        relief: nDetail.mul(this.uDetailNormal.mul(flat).mul(oneMinus(unresolved)))
          .mul(nearTurfDetailWeight.mul(NEAR_BALL_TURF_DETAIL.normalGain).add(1.0)),
        // The resolved NRH sample already carries canopy height + AO. Near pixels
        // should use the actual ray intersection; distant pixels have uvP == uv0.
        // Re-reading the same four-channel atlas at uv0 spent one fetch over every
        // ground fragment and added no independent signal.
        far: mix(vec2(dNrh.b, dNrh.a), vec2(set.farMean[0], set.farMean[1]), unresolved),
      // Two fixed probes are enough to catch a neighbouring long blade at the sun
      // direction while keeping the branch spatially coherent and bounded.
      shade: turfSelfShadow(
        turfNrhArrayNode, int(set.layer), uvP, dNrh.b, sunUVFull, lod, rayActive, 2,
      ),
        // `uvP` is exactly `uv0` once the footprint disables the ray, and its
        // displacement smoothly tends to zero through the minification band.  Sampling
        // this single UV is therefore equivalent at both ends to the former far/near
        // blend while avoiding a second albedo fetch in every terrain fragment.
        // Normalize each source's measured linear luminance before the common zone
        // grade. This keeps the existing rough bake stable while the Blendkit sources
        // retain their real chroma/structure. Alpha carries measured roughness for the
        // source; the generated rough tier uses its neutral declared constant.
        alb: vec4(
          mix(pigment, pigmentMean, unresolved),
          set.packedRoughness
            ? mix(dAlb.a, float(set.farMean[2]), unresolved)
            : float(set.farMean[2]),
        ),
      };
    };

    // ---- Pick the bake. Rough and deep rough get long, tufted grass; maintained
    // surfaces get their authored Blendkit material. Fairway and green are read in
    // parallel and blended only by the analytic green mask, so the cut-height change
    // is spatially stable and does not depend on camera distance.
    //
    // Branch rough rather than blend it with maintained turf. A pixel is essentially
    // always fully one surface or the other — the only pixels that are both lie in the
    // outer ~1 m shoulder — so this is spatially coherent and whole waves take the same
    // path, the same argument the parallax/self-shadow marches already rely on.
    //
    // ---- EXACTLY ONE CONDITIONAL, and the other case is the unconditional DEFAULT.
    //
    // This shape is forced by three r185's TSL, and it is worth spelling out because
    // every natural way to write this branch is silently broken here. In one shader
    // stack, ONLY THE FIRST conditional's body actually delivers its writes to the
    // enclosing scope:
    //   * `.Else(fn)` never does. StackNode.Else hangs the body off a ConditionalNode
    //     that is already on the stack (`this._currentCond.elseNode = new ShaderNode(fn)`),
    //     so it is built outside the stack that owns these vars. `.ElseIf()` assigns
    //     `elseNode` the same way, so swapping between them never helped.
    //   * A SECOND `If` doesn't either — only the first one takes.
    // Either way the vars keep their declared values, which for this struct is
    // alb = vec3(0) and far = vec2(0): a PURE BLACK ground with zero canopy AO on
    // whichever surface lost the race. That is the "black rough" this file has now been
    // through twice. Bisected offline (scripts/shot.mjs): plain CONSTANTS in the else
    // body changed nothing, and swapping the two branches' order moved the black from
    // the rough to the fairway.
    //
    // So the fairway and green tiers are read unconditionally, then the rough tier
    // overwrites the maintained result under a single `If`. This costs the second
    // maintained material read on every turf fragment, but keeps green transitions
    // branch-free and avoids the broken nested-conditional path documented above.
    //
    // IF YOU TOUCH THIS: never add a second `If`, an `Else`, or an `ElseIf` here. Verify
    // any change with `node scripts/shot.mjs --asset "turf: rough" --probe` — a broken
    // branch shows up as pctNearBlack ~99, not as an error.
    //
    // There is no third path for the mowing line. Both maintained source bakes are
    // normalized before being recentered on their own fairway/green pigments; the
    // long-grass bake begins only after the measured carpet transition, and canopy
    // depth follows that same world-space shoulder.
    const tier = Fn(() => {
      const fairway = readTier(maps.fairway);
      const putting = readTier(maps.green);
      const greenW = m.green;
      const relief = mix(fairway.relief, putting.relief, greenW).toVar();
      const far = mix(fairway.far, putting.far, greenW).toVar();
      const shade = mix(fairway.shade, putting.shade, greenW).toVar();
      const alb = mix(fairway.alb, putting.alb, greenW).toVar();
      // Keep the expensive rough bake on the long-grass side of the transition. The
      // maintained default owns the first part of the shoulder, where the geometry carpet is
      // also thinning, so no hard texture seam can sit beneath it.
      If(mownW.lessThanEqual(0.18), () => {
        const r = readTier(maps.rough);
        relief.assign(r.relief); far.assign(r.far);
        shade.assign(r.shade); alb.assign(r.alb);
      });
      return turfTierStruct(relief, far, shade, alb);
    })();
    const tRelief = tier.get('relief');
    const tFar = tier.get('far');       // x = canopy height (gloss), y = canopy AO
    const tShade = tier.get('shade');
    const tAlb = tier.get('alb');

    // Sand is shaded on this same clipmap surface. It must not inherit the maintained
    // turf normal atlas: doing so recreates grass-blade relief inside a bunker.
    // The same canopy bake serves the maintained surfaces, but their real cut
    // heights are different: a green is roughly 4 mm, a fairway 11 mm, while the
    // rough bake carries its own longer blades. Scale the relief by the authored
    // canopy depth so green/fairway/rough do not collapse to one normal response;
    // the scale is render-only and cannot move the collision surface.
    const reliefScale = zoneDepth.div(CANOPY_M.fairway).clamp(0.35, 1.35);
    // Keep the measured canopy relief proportional to the authored mowing height,
    // but let long grass retain more of its broad blade roll after the source bake is
    // minified. This is still a render-only normal response; collision and the ball lie
    // remain on the heightfield. The unbounded ratio is deliberately capped so a steep
    // rough shoulder cannot become a corrugated wall.
    // Cut-height alone correctly orders canopy depth, but it made the 4 mm green
    // almost optically flat once the atlas reached its first mip.  Real tightly cut
    // turf is low, not featureless: its dense shoot tips still make a fine normal
    // field. Apply a bounded class profile to the SAME measured micro relief so the
    // hierarchy survives real light without changing canopy depth or gameplay grade.
    // The fairway gets a stronger authored response than the cleaner green, while
    // both remain below a geometric-blade interpretation of the source.
    let cutMicroGain = float(1.0);
    cutMicroGain = mix(cutMicroGain, float(1.12), m.visualFairway);
    cutMicroGain = mix(cutMicroGain, float(0.96), m.fringe);
    cutMicroGain = mix(cutMicroGain, float(1.28), m.green);
    cutMicroGain = mix(cutMicroGain, float(0.98), m.tee);
    const reliefAmplitude = reliefScale.mul(0.94).mul(cutMicroGain).clamp(0.22, 1.8);
    const grassNormal = terrainNormal.add(tRelief.mul(reliefAmplitude)).normalize();
    // Directional fibre relief stays visible after the atlas is minified. Keep this
    // fine field restrained: the fairway's readable structure is the reel-pass
    // pass below, not a high-frequency procedural noise carpet.
    // The macro bake already carries a filtered, world-stable low-frequency field.
    // Reuse its phase/moisture channels as the fibre signal instead of evaluating
    // another full 3D noise field in every terrain fragment. The source NRH map
    // remains the blade/near-meso signal, while this field stays continuous across
    // all four clipmaps.
    // The former fibre field was a live 3-D noise evaluation per fragment. It was
    // stable in world space, but its screen-space derivative became visible grain in
    // close fairway views and then aliased when the footprint grew. Use the already
    // generated phase/moisture bands instead; the source NRH map owns the fine scale,
    // while this pair supplies only broad, filtered fibre drift.
    // Retired bake comparison (do not reintroduce as a live fragment signal):
    // const fibreField = mx_noise_float(vec3(worldXZ.x.mul(1.16), worldXZ.y.mul(0.93), 181.0));
    // Former normal path: vec3(dFdx(fibreField), 0.0, dFdy(fibreField)).mul(0.34)
    const fibreBand = oneMinus(smoothstep(0.035, 0.16, duvM));
    const fibreSignal = macroVariation.r.mul(0.62).add(macroVariation.a.mul(0.38));
    const fibreGradient = vec3(dFdx(fibreSignal), 0.0, dFdy(fibreSignal));
    // Keep a visible but physically small fibre roll after the source atlas is
    // minified. This is a broad normal response, not displacement, and it disappears
    // by physical footprint before the 0.5 m macro texel can alias.
    const visualMaintained = m.visualFairway.add(m.fringe).add(m.green).add(m.tee).clamp(0.0, 1.0);
    // The authored gameplay fairway mask is the sole owner of mowing response.
    // Explicit exclusions prevent its antialiased corridor edge from leaking the
    // directional fibre/lay onto collar, green, tee, sand, shoreline, rough, or native.
    const fairwayMowMask = m.fairway
      .mul(oneMinus(m.fringe)).mul(oneMinus(m.green)).mul(oneMinus(m.tee))
      .mul(oneMinus(m.sand)).mul(oneMinus(m.waterBank)).clamp(0.0, 1.0);
    const fibreBump = fibreGradient.mul(0.34).mul(0.42)
      .mul(fairwayMowMask).mul(fibreBand);
    // Straight 2.54 m reel passes. The coordinate is exactly linear in authored
    // world/course axes: no noise, warp, curvature, or per-pass phase perturbation.
    const stripCoordinate = worldXZ.x.add(worldXZ.y.mul(MOW_STRIPE_CROSS_SLOPE));
    const stripPhase = stripCoordinate.mul(6.2831853 / MOW_STRIPE_PERIOD_M);
    const stripWave = stripPhase.cos().mul(0.5).add(0.5);
    // Equal-width passes with a broad transition through the real inter-pass overlap.
    // The former near-step made the fairway look painted even after albedo contrast
    // was reduced; this softer lay still changes sign at the exact reel boundary.
    const stripLay = smoothstep(0.28, 0.72, stripWave);
    // Adjacent mower runs lay the leaf canopy in opposite directions along the pass.
    // This is a real directional normal response (sun/view dependent), not a painted
    // shadow or height corrugation.  The ~2.3 degree lean remains appropriate for
    // closely cut fairway grass.
    const layDirection = vec3(-MOW_STRIPE_CROSS_SLOPE, 0.0, 1.0).normalize();
    // Keep the cut direction legible from broadcast/golfer height after the
    // mown atlas has minified.  This is a shallow leaf-lay normal, not a
    // geometric corrugation: the full alternating delta remains below eight degrees
    // collision scale while giving the alternating passes a real sun response.
    // Mower lay is screen-footprint filtered: fully readable through the golfer's
    // 2–30 m inspection range, then it loses contrast as a pixel covers more of the
    // canopy. The zero-mean response cannot create a radial brightness shelf.
    // Fade only as the footprint approaches the 2.54 m pass' Nyquist limit;
    // derivatives provide natural recession without a radial LOD boundary.
    const mowResolution = oneMinus(smoothstep(0.28, 1.10, duvM));
    const mowBump = layDirection.mul(stripLay.sub(0.5).mul(0.035))
      .mul(fairwayMowMask).mul(mowResolution);
    // Surface-wide meso relief prevents a perfectly planar fairway/green after
    // the atlas is minified. The warped isotropic field avoids long directional
    // shelves while retaining the separate fine mowing response above.
    // The macro phase field is already a filtered low-frequency warp. Keep one live
    // meso field for relief breakup, but do not spend another noise evaluation to
    // perturb its coordinates.
    // Retired bake comparison (the old signal was a live full-screen noise field):
    // const mesoReliefField = mx_noise_float(vec3(worldXZ.x.mul(0.24), worldXZ.y.mul(0.19), 229.0));
    const mesoBand = oneMinus(smoothstep(0.12, 0.55, duvM));
    const mesoSignal = macroVariation.b.mul(0.68).add(macroVariation.a.mul(0.32));
    const mesoGradient = vec3(dFdx(mesoSignal), 0.0, dFdy(mesoSignal)).mul(mesoBand);
    // The same 4--5 m field must not make every maintained surface one material.
    // Fairway retains the strongest fibrous undulation, fringe is coarser but less
    // uniformly worked, tee is compact, and the dense low green carries only a small
    // residual roll. These are normal amplitudes under the shared light, not pigment
    // decals; the masks and heightfield remain authoritative and world stable.
    let cutMesoNormal = float(0.0);
    cutMesoNormal = mix(cutMesoNormal, float(0.19), m.visualFairway);
    cutMesoNormal = mix(cutMesoNormal, float(0.14), m.fringe);
    cutMesoNormal = mix(cutMesoNormal, float(0.095), m.green);
    cutMesoNormal = mix(cutMesoNormal, float(0.105), m.tee);
    const mesoBump = mesoGradient.mul(cutMesoNormal);
    // The green-specific field is a real intermediate-scale normal response. It is
    // separate from both terrain contours and blade relief: density/leaf-lay clumps
    // on tightly maintained turf alter how the real sun catches the canopy, while
    // mip filtering removes the response before it can sparkle at distance.
    const greenNapSignal = greenNapVariation.r.mul(0.66)
      .add(greenNapVariation.g.mul(0.34));
    const greenNapBand = oneMinus(smoothstep(0.16, 0.72, duvM));
    let greenNapNormalStrength = float(0.0);
    greenNapNormalStrength = mix(greenNapNormalStrength, float(0.38), m.fringe);
    greenNapNormalStrength = mix(greenNapNormalStrength, float(0.20), m.green);
    const greenNapBump = vec3(
      dFdx(greenNapSignal), 0.0, dFdy(greenNapSignal),
    ).mul(greenNapNormalStrength).mul(greenNapBand);
    // The packed NRH height is a second, broader source of the same authored blade
    // relief. Its screen derivative reads as coherent shoot-scale roll at a grazing
    // angle, while the footprint band retires it before a pixel spans the source
    // pattern. This is a normal-only contribution: no gameplay height or silhouette
    // changes, and the green remains deliberately quieter than the fairway.
    const canopyHeightGradient = vec3(dFdx(tFar.x), 0.0, dFdy(tFar.x));
    const canopyGradientBand = oneMinus(smoothstep(0.025, 0.20, duvM));
    let cutHeightNormal = float(0.0);
    cutHeightNormal = mix(cutHeightNormal, float(0.16), m.visualFairway);
    cutHeightNormal = mix(cutHeightNormal, float(0.10), m.fringe);
    cutHeightNormal = mix(cutHeightNormal, float(0.075), m.green);
    cutHeightNormal = mix(cutHeightNormal, float(0.09), m.tee);
    const canopyHeightBump = canopyHeightGradient.mul(cutHeightNormal)
      .mul(visualMaintained).mul(flat).mul(canopyGradientBand);
    // Native shoulders expose more mineral structure as slope increases. Reuse the
    // already-paid 4–5 m meso field and 0.5 m baked macro channels, so this is
    // slope-aware, world stable, and adds no texture fetch or procedural evaluation.
    const nativeCoverage = oneMinus(visualMaintained.add(m.sand).clamp(0.0, 1.0));
    const nativeSlope = oneMinus(smoothstep(0.64, 0.94, terrainNormal.y));
    const nativeRockPatch = smoothstep(0.58, 0.82,
      macroVariation.r.mul(0.56).add(macroVariation.b.mul(0.44)))
      .mul(nativeSlope).mul(nativeCoverage);
    const nativeBump = mesoGradient.mul(0.34).mul(nativeRockPatch);
    // Mineral bank relief stays shallow and world anchored. It is a real normal
    // response for the gravel patches, not a baked darkening or a second contact/AO
    // term; the SDF confines it to the shoreline shelf.
    const bankRelief = vec3(dFdx(m.waterMottle), 0.0, dFdy(m.waterMottle))
      .mul(0.42).mul(m.waterBank);
    const maintainedNormal = grassNormal.add(fibreBump).add(mowBump).add(mesoBump)
      .add(greenNapBump)
      .add(canopyHeightBump).add(nativeBump).add(bankRelief).normalize();
    // Normal-variance/specular AA: source turf normals and the mower lay can carry
    // more directional change than one pixel can resolve. Estimating variance from
    // the final world-anchored normal lets the PBR response average those microfacets
    // instead of producing isolated sparkling pixels in close-up grazing views. The
    // same variance signal broadens roughness and lowers only the lobe peak; pigment,
    // silhouette, and the actual heightfield remain untouched.
    const normalDx = dFdx(maintainedNormal);
    const normalDy = dFdy(maintainedNormal);
    const normalVariance = normalDx.dot(normalDx).add(normalDy.dot(normalDy)).mul(0.5);
    const normalVarianceWeight = smoothstep(
      TURF_NORMAL_VARIANCE_START, TURF_NORMAL_VARIANCE_FULL, normalVariance,
    );
    const normalVarianceRoughness = normalVarianceWeight.mul(TURF_NORMAL_VARIANCE_ROUGHNESS);
    const specularAA = oneMinus(normalVarianceWeight.mul(TURF_NORMAL_VARIANCE_SPECULAR))
      .clamp(0.82, 1.0);
    // The same world-anchored fibre field also gives a tiny roughness modulation.
    // It is broad enough to survive 2–30 m minification, but remains far below
    // the roughness floor so the turf never turns into a glossy sheet.
    const fibreRoughness = fibreSignal.sub(0.5).mul(0.070)
      .mul(fairwayMowMask);
    // Sand has no canopy relief, but its fine aggregate still breaks the broad
    // bunker floor into a granular, matte response. A derivative of a low-amplitude
    // world-space noise field keeps this non-repeating and render-only.
    // Maintained bunker sand is represented at two declared world scales: a stable
    // ~0.56 m aggregate/clump field plus 0.28 m rake spacing. The rake response is
    // footprint-filtered before it aliases, while the carved terrain owns the lip.
    const sandHeight = mx_noise_float(vec3(worldXZ.x.mul(1.8), worldXZ.y.mul(1.8), 73.0));
    const rakeCoordinate = worldXZ.x.mul(0.34).add(worldXZ.y.mul(0.94))
      .add(macroVariation.a.sub(0.5).mul(0.12));
    const rakeResolution = oneMinus(smoothstep(0.045, 0.20, duvM));
    const sandRake = rakeCoordinate.mul(6.2831853 / 0.28).sin().mul(0.035).mul(rakeResolution);
    // The maintained-tier albedo was already fetched for every bunker fragment. Reuse only
    // its scalar, normalized high-frequency luminance as sub-decimetre aggregate:
    // no turf colour/normal enters sand, and this adds no texture sample. Its own mip
    // chain naturally removes grains when they cease to resolve.
    const sandMicro = luminance(tAlb.rgb).div(TURF_LUM).clamp(0.35, 2.4);
    const sandSurface = sandHeight.mul(0.74).add(sandRake)
      .add(sandMicro.sub(1.0).mul(0.055));
    const sandBump = vec3(dFdx(sandSurface), 0.0, dFdy(sandSurface)).mul(0.32).mul(m.sand);
    const sandNormal = terrainNormal.add(sandBump).normalize();
    let resolvedGroundNormal = mix(maintainedNormal, sandNormal, m.sand).normalize();
    if (this._forestFloorMaps) {
      const forestTangentX = vec3(
        1.0, terrainNormal.x.negate().div(terrainNormal.y.max(0.10)), 0.0,
      ).normalize();
      const forestTangentZ = forestTangentX.cross(terrainNormal).normalize();
      const forestNormalWorld = terrainNormal.mul(forestFloorNormal.z)
        .add(forestTangentX.mul(forestFloorNormal.x.mul(this.uForestFloorNormal)))
        .add(forestTangentZ.mul(forestFloorNormal.y.mul(this.uForestFloorNormal)))
        .normalize();
      resolvedGroundNormal = mix(
        resolvedGroundNormal, forestNormalWorld, nativeFloorWeight,
      ).normalize();
    }
    if (coastWeights && coastSand) {
      const beachNormal = terrainNormal.add(vec3(
        coastSand.slope.x, 0.0, coastSand.slope.y,
      ).mul(0.46)).normalize();
      resolvedGroundNormal = mix(
        resolvedGroundNormal, beachNormal, coastWeights.beachWeight,
      ).normalize();
    }
    // transformNormalToView performs the final normalization after the sand/turf
    // blend. A second normalize here was an identical inverse-square-root in every
    // terrain fragment and did not change the resulting view-space normal.
    mat.normalNode = transformNormalToView(resolvedGroundNormal);

    // ---- Occlusion. Two separate terms, combined into aoNode:
    //   * baked canopy AO (far.y) — sky occlusion measured from the bake's own depth
    //     buffer, a property of the micro-geometry and independent of any light;
    //   * a marched SUN self-shadow — direction-dependent, recomputed every frame from
    //     uSunDir, so the micro-shadows swing round as the sun moves.
    // Caveat worth knowing: NodeMaterial's aoNode attenuates INDIRECT light, so
    // strictly the sun term belongs on the direct lobe. Our rig is ambient-dominant
    // (env 0.55 against a low sun at N.L ~ 0.4), so it reads correctly here — but if
    // the lighting is ever rebalanced toward the key, this needs revisiting.
    //
    // Canopy AO is NOT gated by distance — the canopy occludes sky whether or not you
    // can resolve it, and fading it in produced a hard brightness step at the band.
    // Mipping just averages it to a flat term at range, which is the right behaviour.
    const canopyAO = mix(float(1.0), tFar.y, this.uAO);
    // The self-shadow march is too costly to run everywhere, so it stays gated — but
    // over the same wide band as the rest, so what's left is a gradient, not an edge.
    const grassAO = canopyAO.mul(mix(float(1.0), tShade, dw.mul(this.uShadow)));
    let resolvedAO = mix(grassAO, float(1.0), m.sand);
    if (this._forestFloorMaps) {
      resolvedAO = mix(resolvedAO, forestFloorNormalHeightAo.a, nativeFloorWeight);
    }
    if (coastWeights) resolvedAO = mix(resolvedAO, float(1.0), coastWeights.beachWeight);
    mat.aoNode = resolvedAO;

    // Grass is MATTE, with a tight sheen — not a glossy sheet. Roughness has to vary at
    // BLADE scale or the turf reads as one flat painted surface, so it comes from the
    // detail canopy's own height: blade tops (high canopy height) are the waxy,
    // sun-catching surfaces, while the litter down between blades is matte. That
    // per-blade spread is what produces the sharp little highlights real turf throws —
    // a single uniform roughness cannot. STEEP faces (pot-bunker revetted walls) are
    // forced near-matte below so they don't blow out.
    // NOT gated by dw. Anything that fades with camera distance draws a ring centred
    // on the camera, and roughness stepping across that ring was one of the seams.
    // The detail map's own mips average it out at range, which is the right behaviour
    // anyway — the gloss variation just becomes a uniform mid-roughness far away.
    // Continuous world-space moisture variation: it is deliberately low-frequency and
    // small (roughly ±0.03 roughness), enough to keep a long fairway from reading as a uniform
    // CG sheet without ever becoming a visible pattern or texture boundary.
    const moisture = macroVariation.a;
    // Rough retains its canopy-height roughness model. Maintained cuts use the real
    // authored roughness packed into the already-read albedo alpha, remapped into a
    // matte turf range while preserving its measured local variation.
    const canopyRoughness = oneMinus(tFar.x).mul(this.uRoughRange.mul(1.6)).add(this.uRoughBase);
    const scannedRoughness = tAlb.a.mul(0.30).add(0.61);
    const baseMicroRoughness = mix(canopyRoughness, scannedRoughness, mownW);
    const rGrass = baseMicroRoughness
      .add(fibreRoughness)
      .add(greenNapVariation.b.sub(0.5).mul(0.055)
        .mul(m.green.add(m.fringe).clamp(0.0, 1.0)))
      .add(moisture.sub(0.5).mul(0.05));
    // Scuffed soil in the divots is matte — kill the grass sheen there so a scar doesn't
    // glint like turf. One extra sample of the divot mask (0 outside its region).
    const dvR = this._divotRegion, dvO = this._uDivOrigin;
    const divotUv = vec2(
      positionWorld.x.sub(dvO.x).div(dvR.sizeX),
      positionWorld.z.sub(dvO.y).div(dvR.sizeZ),
    );
    const divotSample = Fn(() => {
      const sample = vec4(0.0).toVar();
      const inside = divotUv.greaterThanEqual(0.0).all().and(divotUv.lessThanEqual(1.0).all());
      // The active scar window occupies only a few metres around the lie. A coherent
      // bounds branch prevents millions of zero-valued texture reads over the rest of
      // the course while preserving the exact GPU-stamped sample inside it.
      If(inside, () => { sample.assign(texture(this._divotTex, divotUv)); });
      return sample;
    })();
    const rGrassD = mix(rGrass, float(0.96), divotSample.r.mul(0.85));
    // ---- Grazing-view-angle roughening: real, but it has to be MONOTONE.
    //
    // This was a smoothstep(0.05, 0.45, N.V), on the theory that keying off N.V rather
    // than camera distance avoids painting a ring centred on the viewer. That theory is
    // wrong on a near-flat ground plane, where N.V = eyeHeight/dist EXACTLY — so N.V is
    // just camera distance relabelled, and because the map is 1/d the whole 0.05..0.45
    // window collapsed into a few metres of ground. That alone would only be a gradient;
    // what made it an EDGE is that specular-vs-roughness is not monotone through three's
    // env path. Sweeping roughness 0.34 -> 1.0 runs the split-sum DFG weight up to a peak
    // around r ~ 0.5 and back down (5.6x lower by the end), while pow4(roughness) in
    // EnvironmentNode simultaneously bends the reflection vector toward the normal and
    // jumps to the blurred PMREM mips. Result: a bright disc a few metres across with a
    // hard rim — lighter and, since the added light is achromatic sky, less saturated
    // inside. That is the ring that kept showing up on the fairway.
    //
    // So: Schlick's own (1 - N.V)^5, scaled, instead of a smoothstep. C-infinity, no
    // shoulders, never plateaus at 1.0. And with a genuinely matte base (0.72) the
    // roughness it sweeps is ~0.72 -> 0.95, a range over which the env specular weight
    // decreases monotonically — there is no interior peak left to read as a ring.
    const NoV = terrainNormal.dot(V).clamp(0.0, 1.0);
    // Schlick's fifth power is fixed, so use a multiply chain rather than lowering a
    // general pow in the full-screen terrain fragment. This is algebraically exact.
    const grazeBase = oneMinus(NoV);
    const graze2 = grazeBase.mul(grazeBase);
    const graze4 = graze2.mul(graze2);
    const graze = graze4.mul(grazeBase).mul(this.uGraze);
    // A canopy gets more matte at grazing angles because the view sees more shaded
    // leaf sides and thatch, but it never needs a distance/camera ring. Blend toward a
    // physically plausible matte ceiling rather than forcing roughness to one, which
    // erased all fibre response in the edge view.
    // Mown leaves do not merely change pigment between passes: the lay direction
    // changes how a grazing sun/view pair sees the cuticle.  This bounded scalar
    // anisotropy is coupled to the world-anchored pass, so it cannot become a
    // camera-centred ring.  It stays small enough that turf remains matte.
    const viewAlongLay = V.x.mul(layDirection.x).add(V.z.mul(layDirection.z)).abs();
    const sunAlongLay = S.x.mul(layDirection.x).add(S.z.mul(layDirection.z)).abs();
    const grazingLay = oneMinus(NoV).mul(0.65).add(0.35);
    // One signed leaf-lay signal drives both roughness and dielectric return. This
    // keeps the straight 5.08 m alternating cycle in phase while contrast responds to
    // the actual sun/view pair instead of increasing painted albedo contrast.
    // Retroreflection from a laid leaf canopy is view-led under a broad sky; direct
    // sun alignment modulates it but must not zero the pass whenever the sun happens
    // to sit across the mower direction. Both real directions remain in the signal.
    const layAlignment = viewAlongLay.mul(0.70).add(sunAlongLay.mul(0.30));
    const mowOptical = stripLay.sub(0.5).mul(layAlignment)
      .mul(grazingLay).mul(fairwayMowMask).mul(mowResolution);
    const mowAnisotropy = mowOptical.mul(0.025);
    const rGrassV = rGrassD.add(graze.mul(0.16)).add(mowAnisotropy).clamp(0.68, 0.98);
    const steepR = smoothstep(0.82, 0.55, terrainNormal.y);
    let zoneRoughness = float(0.91);
    zoneRoughness = mix(zoneRoughness, float(0.98), m.rough);
    zoneRoughness = mix(zoneRoughness, float(0.82), m.visualFairway);
    // A 20 mm collar is optically rougher than an 11 mm fairway; the former 0.75
    // value inverted that physical ordering and merged collar/green into one sheen.
    zoneRoughness = mix(zoneRoughness, float(0.87), m.fringe);
    zoneRoughness = mix(zoneRoughness, float(0.60), m.green);
    zoneRoughness = mix(zoneRoughness, float(0.75), m.tee);
    const surfaceRoughness = mix(mix(rGrassV, float(0.97), steepR), zoneRoughness, 0.56);
    const filteredSurfaceRoughness = surfaceRoughness.add(normalVarianceRoughness)
      .clamp(0.68, 0.99);
    // The water-bank shelf is damp mineral soil/gravel, not a painted radial ring:
    // its moisture response comes from the authored pond SDF and stays matte under
    // the same sun/sky rig. Interior water is excluded by the SDF mask and remains
    // hidden beneath the dedicated water surface.
    const bankRoughness = filteredSurfaceRoughness.add(m.waterBank.mul(0.075)).clamp(0.68, 0.99);
    const sandRoughness = sandHeight.mul(0.035).add(sandMicro.sub(1.0).mul(0.025))
      .add(0.90).clamp(0.86, 0.95);
    let resolvedRoughness = mix(
      mix(bankRoughness, sandRoughness, m.sand),
      float(0.97), m.waterBank.mul(oneMinus(m.sand)),
    );
    if (this._forestFloorMaps) {
      resolvedRoughness = mix(
        resolvedRoughness, forestFloorColorRoughness.a.clamp(0.72, 1.0), nativeFloorWeight,
      );
    }
    if (coastWeights && coastSand) {
      resolvedRoughness = mix(
        resolvedRoughness, coastSand.roughness, coastWeights.beachWeight,
      );
    }
    mat.roughnessNode = resolvedRoughness;
    // Opposite mower lays expose a bounded amount of cuticle to the same real light.
    // The inverse relationship with roughness avoids a wet/plastic lobe: the pass
    // made rougher above also carries less dielectric return here (maximum +/-16%).
    const mowSpecular = oneMinus(mowOptical.mul(0.04)).clamp(0.97, 1.03);
    // Cut height changes the coherence of the dielectric leaf return. Keep every
    // surface in a restrained matte-turf range while allowing green, tee, collar,
    // and fairway to separate under the one shared sun/PMREM state.
    let cutSpecular = float(0.90);
    cutSpecular = mix(cutSpecular, float(0.98), m.visualFairway);
    cutSpecular = mix(cutSpecular, float(0.92), m.fringe);
    cutSpecular = mix(cutSpecular, float(1.20), m.green);
    cutSpecular = mix(cutSpecular, float(1.05), m.tee);
    let resolvedSpecular = this.uSpecular.mul(mowSpecular).mul(cutSpecular)
      .mul(specularAA);
    if (coastWeights) {
      resolvedSpecular = mix(
        resolvedSpecular, float(COAST_SAND_SPECULAR_INTENSITY), coastWeights.beachWeight,
      );
    }
    mat.specularIntensityNode = resolvedSpecular;
    // The zone tint is the turf's ALBEDO — the light rig and tone-map decide how
    // bright it ends up, so it must not be pre-darkened. The old chain stacked three
    // separate sub-1.0 multipliers (turfBase's 0.82 lightness, this 0.82, and a
    // final desaturate) and landed the fairway around L 0.26 — a dark, saturated
    // video-game green. Reference turf photographs at H 80 deg / S 0.20 / L 0.36.
    const grassCol = (name, extra = 1) => {
      const c = turfBase(name, new Color()).multiplyScalar(extra);
      return vec3(c.r, c.g, c.b);
    };
    const roughUndercoat = (name) => {
      const c = turfUndercoatBase(name, new Color());
      return vec3(c.r, c.g, c.b);
    };
    // Sand keeps its darkening: removing it along with the turf's blew the bunkers out
    // to a near-white (188,176,121). Sand albedo really is high, but not that high.
    const sc = new Color(surface('sand').color).multiplyScalar(0.78);
    const palette = {
      fairway: grassCol('fairway'),
      // Rough and deep rough share ONE albedo — deep rough is the same grass mown
      // longer (turfBase aliases it), so the mowing line between them shows up through
      // canopy depth and blade height, not pigment.
      //
      // And no extra darkening on either. That 0.85 existed to push the ground under
      // the blades toward the shaded blade bases, so gaps in a thinned canopy read as
      // shadow rather than a lighter speckle — but the rough bake now measures that
      // occlusion for real (its canopy-AO channel is authored separately from the
      // 0.758, because long grass genuinely shadows itself far more), and stacking a
      // hand-picked multiplier on top of a measured one double-counts.
      // Derive the undercoat from the same chlorophyll tint as the geometry, then
      // compensate for its stronger upward-facing sky fill. Texture, AO, normals,
      // and real lighting retain depth without exposing pale gaps between ribbons.
      rough: roughUndercoat('rough'),
      deepRough: this.groundCover === 'native-grasslands'
        ? mix(vec3(...NATIVE_GRASS_PIGMENT.living), vec3(...NATIVE_GRASS_PIGMENT.straw), 0.5)
        : roughUndercoat('deepRough'),
      // The putting surface is the same believable plant family but not the same
      // material as fairway. Its dedicated gameplay pigment is slightly cleaner and
      // more yellow-green; the restrained exposure multiplier prevents a bright
      // nested target decal while cut height and dielectric response do most of the
      // separation under real light.
      green: grassCol('green', 0.92), fringe: grassCol('fringe', 0.96), tee: grassCol('tee'),
      sand: vec3(sc.r, sc.g, sc.b),
    };
    let nativeBiomeWeight = float(1.0);
    if (this._biomeField?.hasTransitions) {
      // Only the managed/native turf channel may receive the rough under-canopy
      // response. Strand, dune, beach, shelf, and ocean bands retain their own
      // substrate optics even while the visual transition is fractional.
      nativeBiomeWeight = biomeLand.r;
    }
    const turfColor = turfColorNode(tAlb.rgb, m, {
      ...this.zones, colors: palette, sat: this.uSat, val: this.uVal,
      divotSample, mowResolution, sandSignal: sandHeight, sandMicro,
      maintainedCoverage: visualMaintained, sourceAlbedo: tAlb.rgb,
      fairwayMowMask, stripLay, nativeRockPatch,
      canopyHeight: tFar.x, nativeBiomeWeight,
      greenNapVariation,
    }, macroVariation, terrainNormal);
    // An isolated creator maquette has no surrounding rough/native context to make
    // the cut-height hierarchy legible. Grade the same authored source maps by their
    // analytic green mask so the 20 mm collar remains visibly deeper/darker than the
    // 4 mm putting surface without adding geometry, a decal, or a second material.
    let presentedTurfColor = this.finiteOutline
      ? mix(
        turfColor.mul(vec3(0.68, 0.78, 0.58)),
        turfColor.mul(vec3(1.16, 1.16, 1.00)),
        m.green,
      )
      : turfColor;
    if (this._forestFloorMaps) {
      presentedTurfColor = mix(
        presentedTurfColor, forestFloorAlbedo, nativeFloorWeight,
      );
    }
    if (this._biomeField?.hasTransitions && coastWeights && coastSand) {
      const strand = biomeLand.g;
      const ecotoneGrass = presentedTurfColor.mul(vec3(0.86, 0.91, 0.72));
      mat.colorNode = mix(
        mix(presentedTurfColor, ecotoneGrass, strand.mul(0.34)),
        coastSand.color,
        coastWeights.beachWeight,
      );
    } else {
      mat.colorNode = presentedTurfColor;
    }
    // One optical endpoint on both sides of the mesh join. Only unmaintained
    // ground participates; the course SDF and all gameplay surfaces stay intact.
    // The uniform is enabled only when the alpine continuation is installed.
    const insideEdge = worldXZ.x.sub(this.bounds.minX).min(float(this.bounds.maxX).sub(worldXZ.x))
      .min(worldXZ.y.sub(this.bounds.minZ)).min(float(this.bounds.maxZ).sub(worldXZ.y));
    const joinWeight = oneMinus(smoothstep(0, 24, insideEdge))
      .mul(oneMinus(maintainedOrHazard)).mul(this.uBackdropJoin);
    const edge = this.backdropSurfaceNodes();
    mat.colorNode = mix(mat.colorNode, edge.color, joinWeight);
    mat.roughnessNode = mix(mat.roughnessNode, edge.roughness, joinWeight);
    mat.aoNode = mix(mat.aoNode, edge.ao, joinWeight);
    mat.specularIntensityNode = mix(mat.specularIntensityNode, edge.specular, joinWeight);
    mat.normalNode = transformNormalToView(mix(resolvedGroundNormal,
      this._normalNode(worldXZ.x, worldXZ.y), joinWeight).normalize());
    // Do not lift shaded bunker walls or sand with emissive compensation. Their
    // readability comes from the carved terrain, real sun/sky fill, and the
    // restrained geometric canopy/screen-space contact terms above. An emissive
    // patch here would be a camera-independent fake bounce and would flatten the
    // very relief the material is meant to reveal.
    return mat;
  }
}

// Real mown-turf canopy depth per surface, in METRES. These are close to actual
// mowing heights (a green is cut around 3-4 mm, a fairway around 10-12 mm) because
// the parallax march reproduces them at true scale — that's the point: the ball has
// to sit into a canopy of the right depth, not a stylised one.
const CANOPY_M = {
  green: 0.004, tee: 0.010, fairway: 0.011, fringe: 0.020,
  rough: 0.055, deepRough: 0.075, sand: 0.0,
};

// Steep/layered parallax occlusion march over the baked canopy height field.
// Returns the UV where the view ray first passes below the canopy surface.
//
// Wrapped in Fn because If/Loop need a shader stack, and the whole march is skipped
// where the footprint/view-angle weight is ~0 — both inputs are screen-stable and
// world/material based, so distant or grazing pixels genuinely cost nothing.
const turfParallaxUV = Fn(([hTex, layer, uv0, stepUV, lod, active, nl]) => {
  const uv = uv0.toVar();
  If(active.greaterThan(0.02), () => {
    const d = float(0).toVar();            // ray depth below the canopy top, 0..1
    const dStep = float(1).div(nl);
    const uvPrev = uv0.toVar();            // state of the step before the crossing
    const dsPrev = float(0).toVar();
    const dPrev = float(0).toVar();
    Loop(nl, () => {
      // B channel is canopy height with 1 = blade tip, so depth below the tips is 1-h.
      const ds = textureLevel(hTex, uv, lod).depth(layer).b.oneMinus().toVar();
      If(d.greaterThanEqual(ds), () => {
        // Interpolate the crossing between the last two layers. Without this the
        // march quantises to nl flat shelves and the turf shows chevron stair-steps
        // at any real depth — the layer count alone can never hide them.
        const denom = dStep.sub(ds.sub(dsPrev)).max(1e-5);
        const tt = dsPrev.sub(dPrev).div(denom).clamp(0.0, 1.0);
        uv.assign(mix(uvPrev, uv, tt));
        Break();
      });
      uvPrev.assign(uv);
      dsPrev.assign(ds);
      dPrev.assign(d);
      uv.addAssign(stepUV);
      d.addAssign(dStep);
    });
  });
  return uv;
});

// The forest-floor displacement is a regular 2D texture rather than a packed
// turf-array layer. It uses the same crossing interpolation contract so the pine
// straw has continuous physical relief instead of three visible depth shelves.
const forestFloorParallaxUV = Fn(([heightTexture, uv0, stepUV, lod, active, nl]) => {
  const uv = uv0.toVar();
  If(active.greaterThan(0.02), () => {
    const d = float(0).toVar();
    const dStep = float(1).div(nl);
    const uvPrev = uv0.toVar();
    const dsPrev = float(0).toVar();
    const dPrev = float(0).toVar();
    Loop(nl, () => {
      const ds = textureLevel(heightTexture, uv, lod).b.oneMinus().toVar();
      If(d.greaterThanEqual(ds), () => {
        const denom = dStep.sub(ds.sub(dsPrev)).max(1e-5);
        const crossing = dsPrev.sub(dPrev).div(denom).clamp(0.0, 1.0);
        uv.assign(mix(uvPrev, uv, crossing));
        Break();
      });
      uvPrev.assign(uv);
      dsPrev.assign(ds);
      dPrev.assign(d);
      uv.addAssign(stepUV);
      d.addAssign(dStep);
    });
  });
  return uv;
});

// Canopy SELF-SHADOWING: from the point the view ray hit, march back up through the
// height field toward the sun. If the canopy rises above that ray anywhere along the
// way, this point is in the shadow of the blades in front of it.
//
// This is the main thing separating photographic turf from painted turf. Sunlit grass
// is not smooth mid-green — it is a dense field of lit blade tops against hard little
// shadows cast by neighbouring blades, and that high-frequency contrast is what the
// eye reads as "real". A normal map alone can only shade a blade by its own facing; it
// can never let one blade darken another.
const turfSelfShadow = Fn(([hTex, layer, uvHit, h0, sunUVFull, lod, active, ns]) => {
  const shade = float(1.0).toVar();
  If(active.greaterThan(0.02), () => {
    const climb = oneMinus(h0);                 // height left to clear the canopy top
    // Probe inside the remaining canopy interval, never at its empty top boundary.
    // A single midpoint sample retains a real neighbouring-blade visibility test;
    // sampling h=1 with ns=1 would be mathematically incapable of finding occlusion.
    const interval = ns.add(1);
    const stepUV = sunUVFull.mul(climb).div(interval);
    const stepH = climb.div(interval);
    const uv = uvHit.toVar();
    const h = h0.toVar();
    const occ = float(0.0).toVar();
    Loop(ns, () => {
      uv.addAssign(stepUV);
      h.addAssign(stepH);
      // How far the canopy pokes ABOVE the light ray here — the deepest breach along
      // the march sets the shadow, so a single tall blade shadows what's behind it.
      occ.assign(occ.max(textureLevel(hTex, uv, lod).depth(layer).b.sub(h).max(0.0)));
    });
    shade.assign(oneMinus(occ.mul(6.0).clamp(0.0, 1.0)));
  });
  return shade;
});

// Turf zone coverage masks, from ONE fetch of the baked signed-distance map.
//
// This replaces the old analytic classification, which re-derived the zones per pixel:
// a domain warp (two 3D noise evaluations), then a corridor test, then a loop over
// EVERY green and EVERY bunker. That last part is the expensive bit — its cost grew
// with the size of the course (this one is already 11 circle tests per pixel), and
// terrain fragment shading is measurably the single most expensive thing in the frame.
// A distance field makes it O(1) however elaborate the course gets.
//
// Edges stay smooth curves because DISTANCES interpolate correctly under bilinear
// filtering — see ZoneMap.js for why an id/grey-level map could not have worked here.
// The rough band and the fringe collar need no channels of their own: they're just the
// corridor and green distances offset by their widths.
function turfZoneMasks(sd, aux, waterSample, zones) {
  const AA = 0.16;                        // edge softness (m): smooth curve, still crisp
  // Zone and water samples are hoisted by the material so the pot-bunker opacity
  // path and the surface masks share the same two bindings and exact filtered values.
  const waterSD = waterSample.x;
  const outsideWater = oneMinus(smoothstep(0.0, 0.08, waterSD));
  const bankDistance = waterSD.negate().max(0.0);
  const bankWidthNoise = waterSample.y;
  // The exposed contact varies between 0.15 and 0.30 m in world space. Gate that
  // narrow envelope by the baked ecological field so turf and mineral interlock in
  // short tongues instead of producing a continuous concentric bank ribbon.
  const bankWidth = float(0.15).add(bankWidthNoise.mul(0.15));
  const bankEnvelope = oneMinus(smoothstep(0.0, bankWidth, bankDistance)).mul(outsideWater);
  const bankExposure = smoothstep(0.42, 0.76,
    waterSample.z.mul(0.82).add(waterSample.y.mul(0.18)));
  const waterBank = bankEnvelope.mul(bankExposure.mul(0.82).add(0.08));
  const waterBankWet = oneMinus(smoothstep(0.0, 0.075, bankDistance))
    .mul(outsideWater).mul(bankExposure.mul(0.76).add(0.12));
  const soft = (d) => smoothstep(-AA, AA, d);
  // The real mowing operation does not stop at a mathematically sharp SDF edge:
  // the first few metres of the rough shoulder are rolled, cut, and trampled.
  // Offset only the RENDER transition with a broad, seeded ecotone field.  The
  // authoritative SDF, CPU surface classification, and ball physics stay exact;
  // this prevents the fairway/native edge from becoming a ruler-straight line.
  const edgeWarp = mx_noise_float(vec3(
    positionWorld.x.mul(0.045), positionWorld.z.mul(0.036), 317.0,
  )).sub(0.5).mul(2.8);
  const edgeSD = sd.r.add(edgeWarp);
  // Green construction is not a biome ecotone. A reel/collar cut is a hard authored
  // boundary, so both sides resolve over only eight centimetres and use the exact
  // green SDF—no ecological warp and no metre-wide pigment blend.
  const visualGreen = smoothstep(-0.04, 0.04, sd.g);
  const visualFringe = smoothstep(-0.04, 0.04, aux.g);
  const maintainedTransition = smoothstep(-2.0, 2.0, edgeSD);
  // A wider but still bounded visual mix carries the same ecotone into albedo,
  // directional response, and bake ownership. It is not a gameplay mask.
  const visualFairway = smoothstep(-3.2, 3.2, edgeSD);
  return {
    rough: soft(aux.r),
    fairway: soft(sd.r),
    visualFairway,
    fringe: visualFringe,
    green: visualGreen,
    sand: soft(sd.b),
    // Positive distance inside the separately compiled sand contour. This is
    // distinct from the outer grade-flush carve and lets the material resolve a
    // damp flashed face without inventing a radial colour ring.
    sandFaceDistance: sd.b,
    tee: soft(sd.a),
    maintainedTransition,
    waterBank,
    waterBankWet,
    waterMottle: waterSample.z,
    waterGrass: waterSample.z,
  };
}

// Which detail bake this pixel wants: 0 = the rough bake (long, tufted grass), 1 = the
// maintained bake. Composited through the SAME mask chain in the SAME order as the colour and
// depth paths, so the texture switch lands exactly on the mowing line and not a pixel
// off it. Sand takes the maintained bake — it has no canopy of its own, and the short map is
// the more neutral relief to carry under it.
function turfMownWeight(m) {
  // The wide maintained shoulder is intentional: long blades begin thinning before
  // the authored fairway edge, so a hard bake swap would look pasted onto the ground.
  let w = m.maintainedTransition;
  w = mix(w, float(1.0), m.fringe);
  w = mix(w, float(1.0), m.green);
  w = mix(w, float(1.0), m.sand);
  return mix(w, float(1.0), m.tee);
}

// Canopy depth (metres) under this pixel. Composited in the SAME order as the colour
// path, so depth steps exactly where the mowing line does.
function turfCanopyDepth(m) {
  let d = float(CANOPY_M.deepRough);
  d = mix(d, float(CANOPY_M.rough), m.rough);
  // Match the canopy depth to the same broad mowing shoulder used by the detail bake;
  // this prevents a one-pixel height/normal step beneath the thinning grass carpet.
  d = mix(d, float(CANOPY_M.fairway), m.maintainedTransition);
  d = mix(d, float(CANOPY_M.fringe), m.fringe);
  d = mix(d, float(CANOPY_M.green), m.green);
  d = mix(d, float(CANOPY_M.sand), m.sand);
  return { depth: mix(d, float(CANOPY_M.tee), m.tee) };
}

// TSL colorNode: rough/native surfaces retain the shared zone grade, while maintained
// turf uses the actual Blendkit albedo sampled by the detail tier. That distinction is
// important: treating a photographed grass material as mere luminance grain throws
// away the authored pigment and makes every surface converge on the same synthetic
// green. `tex` is mipped at distance and blade-resolving/parallaxed up close (see
// readTier). Continuous macro variation sits on top; the only directional course-scale
// signal is the explicit straight reel pass below, never a hidden atlas period.
function turfColorNode(tex, m, zones, macroVariation, terrainNormal = normalWorld) {
  const wx = positionWorld.x;             // TRUE world pos drives zone classification
  const wz = positionWorld.z;
  const C = zones.colors;                 // vec3 per zone
  const sourceAlbedo = zones.sourceAlbedo || tex;
  const AA = 0.16;                        // edge softness (m): smooth curve, still crisp

  // Zone classification comes from the baked signed-distance map (see turfZoneMasks):
  // one texture fetch instead of a domain warp plus a circle test per green and per
  // bunker. Boundaries are still true smooth curves — distances interpolate correctly,
  // so this is NOT the stair-stepped squares a rasterized id-splat would give.
  let baseCol = C.deepRough;
  baseCol = mix(baseCol, C.rough, m.rough);
  // Use the irregular render-only ecotone for the maintained/native blend. The
  // exact fairway mask still owns gameplay and surface IDs; this shoulder is
  // what lets real mowing and volunteer grass interleave instead of forming a
  // perfect contour line.
  baseCol = mix(baseCol, C.fairway, m.visualFairway);
  baseCol = mix(baseCol, C.fringe, m.fringe);
  baseCol = mix(baseCol, C.green, m.green);
  baseCol = mix(baseCol, C.sand, m.sand);
  baseCol = mix(baseCol, C.tee, m.tee);

  // The maintained tier is the authored Blendkit albedo; the deliberate straight reel
  // pass is added below in world space, where its period and direction remain measurable
  // and stable. Rough pixels still use their dedicated long-grass source through the
  // same `tex` input.
  const texLum = luminance(tex).max(0.001);

  // Render the turf albedo as real detail, not flat grain: its per-blade variation
  // carries the texture while the per-zone tint only GRADES it to the right hue.
  // Normalized against TURF_LUM (both tiers measured at ~0.138 mean linear luminance)
  // so neither tier nor a future map swap shifts the turf's overall brightness.
  // Micro contrast follows shoot architecture rather than one global texture grade.
  // Long/native turf retains open dark gaps, the fairway remains visibly fibrous,
  // while compact tee and dense green average progressively cleaner. This changes
  // only the contrast of the already sampled physical-scale atlas; no class receives
  // a new texture, UV period, or camera-dependent fade.
  // The geometric canopy supplies the close high-frequency silhouette. Compress
  // the baked undercoat's brightest blade marks so an exposed texel reads as shaded
  // vegetation/litter rather than a pale hole between ribbons.
  let microContrast = float(1.12);
  microContrast = mix(microContrast, float(1.06), m.rough);
  microContrast = mix(microContrast, float(0.98), m.visualFairway);
  microContrast = mix(microContrast, float(0.82), m.fringe);
  microContrast = mix(microContrast, float(0.52), m.green);
  microContrast = mix(microContrast, float(0.68), m.tee);
  const detail = texLum.div(TURF_LUM).sub(1.0).mul(microContrast).add(1.0).clamp(0.35, 2.4);
  const chroma = mix(vec3(1.0), tex.div(texLum), 0.8);
  let c = baseCol.mul(detail).mul(chroma);

  // Continuous world-space turf variation: mid-scale moisture and course-scale soil
  // character. Unlike an atlas feature, these fields never repeat at tile boundaries.
  // A few-metre field becomes the visible distance character after the tiled blade
  // signal reaches its measured mean. It is continuous world-space noise, so it can
  // never expose an atlas period or a tile edge.
  // Persistent world-space meso breakup: atlas detail carries blades, while these
  // two incommensurate fields carry 2–20 m moisture/soil variation after the atlas
  // is minified. They are world anchored, not camera/radial, so no ring can form.
  // These two channels are baked at the same 0.5 m authoring resolution as the
  // zone map. They preserve the measured 5–30 m meso breakup but avoid re-running
  // two course-scale noise functions for every terrain fragment. B is the packed
  // macro colour field (which already combines three incommensurate scales), while
  // R is an independent phase field; both remain world-stable under clipmap snaps.
  // Former live field (now represented by the baked channel):
  // const mesoA = mx_noise_float(vec3(wx.mul(0.19), wz.mul(0.19), 91.0)).mul(0.5).add(0.5);
  const mesoA = macroVariation.b;
  const mesoB = macroVariation.r;
  const meso = mesoA.sub(0.5).mul(0.25).add(mesoB.sub(0.5).mul(0.19));
  // Decode the packed macro albedo as a bounded reflectance multiplier. Keep the
  // meso field multiplicative (rather than adding it to the colour) so wet/dry patches
  // cannot create impossible negative/over-bright pigment and remain stable when the
  // atlas is fully minified.
    const maintainedCoverage = zones.maintainedCoverage;
    const fairwayMowMask = zones.fairwayMowMask;
    // The Blendkit maps are authored albedo, not a decorative grayscale detail layer.
    // Replace the synthetic zone grade wherever maintained turf owns the pixel, then
    // let the same world-space macro, moisture, reel-pass, and lighting terms act on
    // that real pigment. Rough/native pixels keep the established shared grade.
    c = mix(c, sourceAlbedo, maintainedCoverage);
    // Restore the filtered source's cut-grass nap after pigment recentering. This is
    // not another texture sample: it amplifies only variation that survived the real
    // screen-space footprint of the dedicated fairway/green atlas. Unresolved fibers
    // therefore still converge to one, while readable clumps keep enough contrast to
    // catch daylight instead of averaging into a flat color swatch.
    const fringeNap = luminance(sourceAlbedo).div(0.139).sub(1.0)
      .mul(2.0).add(1.0).clamp(0.78, 1.22);
    const greenNap = luminance(sourceAlbedo).div(0.1525).sub(1.0)
      .mul(2.35).add(1.0).clamp(0.76, 1.24);
    let cutNap = float(1.0);
    cutNap = mix(cutNap, fringeNap, m.fringe);
    cutNap = mix(cutNap, greenNap, m.green);
    c = c.mul(cutNap);
    // A green needs readable density/nap at the camera distance where the 2K source
    // scan has correctly minified to its mean. This world-scale field is a separate
    // physical band, not an enlarged copy of the blade atlas. Its restrained scalar
    // variation and wet/dry chroma stay registered with the normal/roughness response
    // under the shared sun and disappear through ordinary mip filtering.
    const greenNapVariation = zones.greenNapVariation;
    const puttingNapLuma = greenNapVariation.r.sub(0.5).mul(0.14)
      .add(greenNapVariation.g.sub(0.5).mul(0.08))
      .add(1.0);
    const fringeNapLuma = greenNapVariation.r.sub(0.5).mul(0.24)
      .add(greenNapVariation.g.sub(0.5).mul(0.20))
      .add(1.0);
    let maintainedNapLuma = float(1.0);
    maintainedNapLuma = mix(maintainedNapLuma, fringeNapLuma, m.fringe);
    maintainedNapLuma = mix(maintainedNapLuma, puttingNapLuma, m.green);
    const greenNapChroma = mix(
      vec3(0.975, 1.012, 0.958),
      vec3(1.025, 0.992, 1.018),
      greenNapVariation.b,
    );
    const maintainedNapCoverage = m.green.add(m.fringe).clamp(0.0, 1.0);
    c = c.mul(maintainedNapLuma)
      .mul(mix(vec3(1.0), greenNapChroma, maintainedNapCoverage));
    // The reel pass is the fairway's readable directional signal. Keep the
    // persistent macro field, but compress its contrast over maintained turf so
    // stochastic lime mottling cannot compete with the directional cut pattern.
    let cutMacroStrength = float(0.115);
    cutMacroStrength = mix(cutMacroStrength, float(0.090), m.fringe);
    cutMacroStrength = mix(cutMacroStrength, float(0.095), m.green);
    cutMacroStrength = mix(cutMacroStrength, float(0.080), m.tee);
    const macroStrength = mix(float(0.21), cutMacroStrength, maintainedCoverage);
    const macroAlbedo = float(1.0).add(macroVariation.b.sub(0.5).mul(macroStrength));
    let cutMesoStrength = float(0.30);
    cutMesoStrength = mix(cutMesoStrength, float(0.22), m.fringe);
    cutMesoStrength = mix(cutMesoStrength, float(0.24), m.green);
    cutMesoStrength = mix(cutMesoStrength, float(0.18), m.tee);
    const mesoStrength = mix(float(0.82), cutMesoStrength, maintainedCoverage);
    const mesoAlbedo = float(1.0).add(meso.mul(mesoStrength));
    c = c.mul(macroAlbedo).mul(mesoAlbedo);
  // Low-frequency moisture/soil chroma keeps a fairway from collapsing into one
  // sage swath once blade albedo is minified. The range is deliberately muted and
  // applies to all turf families through their existing zone masks.
  // A broad, low-frequency soil/moisture drift survives the atlas mip chain and
  // gives the playable ground real ecological variation. It is world anchored,
  // not camera/radial, and the restrained endpoints stay within turf pigment.
  // Moisture is also authored into the macro bake. Reuse it for the broad soil
  // drift so albedo remains stable and the fragment does not evaluate another
  // low-frequency procedural field.
  // Former live field (now represented by the baked channel):
  // const soilDrift = mx_noise_float(vec3(wx.mul(0.036), wz.mul(0.029), 173.0)).mul(0.5).add(0.5);
  const soilDrift = macroVariation.a;
  const dryTurf = vec3(1.07, 1.025, 0.93);
  const wetTurf = vec3(0.88, 0.95, 0.91);
  const soilColor = mix(wetTurf, dryTurf, soilDrift.mul(0.74).add(mesoB.mul(0.26)));
  // Preserve a restrained moisture cue on fairway, but do not let wet/dry colour
  // noise erase the broad strip read. Native rough keeps the full soil response.
  // Moisture remains a bounded pigment response, but 78% of the neutralising
  // mix was enough to erase the fairway/green hue separation in the broad,
  // minified approach footprint. Keep the world-anchored field at 55% so it
  // cannot become a second grey daylight model.
  c = c.mul(mix(soilColor, vec3(1.0), maintainedCoverage.mul(0.72)));

  // Mowing is a straight, course-direction pass, not a high-frequency noise field.
  // One 5.08 m cycle represents alternating 2.54 m reel passes. The normal path
  // supplies this exact same unwarped leaf-lay node, so every PBR response agrees.
  // The normal path supplies the exact same leaf-lay node. This keeps pigment,
  // roughness, and normal phase registered after a clipmap snap while avoiding a
  // second cosine/warp/smoothstep chain in the fragment graph.
  // Former live source (now represented by the baked channel):
  // const mowFineAlbedoA = mx_noise_float(vec3(wx.mul(0.018), wz.mul(0.024), 157.0));
  const stripLay = zones.stripLay;
  // Restrained ±2% pigment response supports the directional normal lay above.
  // Most of the read still comes from real light, but the bands remain identifiable
  // under diffuse overcast illumination where directional sheen is naturally weak.
  // A real mower pass is primarily a change in leaf lay. Keep enough pigment
  // separation to read under diffuse sky, but below the contrast that made the
  // overview resemble alternating painted lanes.
  const mowBand = stripLay.sub(0.5).mul(MOW_STRIPE_ALBEDO_CONTRAST);
  c = c.mul(float(1.0).add(mowBand.mul(fairwayMowMask).mul(zones.mowResolution)));

  // A restrained grade separates cut turf families at gameplay distance while
  // preserving the physical palette: putting green is brighter/cleaner, fairway
  // olive, rough/deep rough darker and more moisture-muted.
  // The geometric blade colour averages about 0.90 after its stable age/tuft
  // variation. Use the same mean undercoat value for both long-grass classes.
  let zoneGrade = float(0.90);
  zoneGrade = mix(zoneGrade, float(0.90), m.rough);
  zoneGrade = mix(zoneGrade, float(0.96), m.visualFairway);
  zoneGrade = mix(zoneGrade, float(0.940), m.fringe);
  zoneGrade = mix(zoneGrade, float(0.950), m.green);
  zoneGrade = mix(zoneGrade, float(0.985), m.tee);
  c = c.mul(mix(zoneGrade, float(1.0), m.sand));

  // Reuse the existing rough-detail canopy height to place a restrained same-hue
  // root/litter response under geometric blades. This is world/texture anchored,
  // not camera distance or stochastic screen coverage, so it cannot form an LOD
  // ring or shimmer. Every maintained/hazard mask and every non-turf biome band
  // explicitly retires it.
  const occupiedByOtherSurface = maintainedCoverage.max(m.sand).max(m.waterBank);
  const nativeTurfWeight = oneMinus(occupiedByOtherSurface)
    .mul(zones.nativeBiomeWeight).clamp(0.0, 1.0);
  const rootExposure = oneMinus(smoothstep(0.28, 0.72, zones.canopyHeight));
  const rootLitterWeight = rootExposure.mul(nativeTurfWeight).mul(0.22);
  const rootLitterTint = vec3(0.72, 0.80, 0.48);
  c = mix(c, c.mul(rootLitterTint), rootLitterWeight);

  // Steep native ground reveals a restrained mineral/soil fraction. It follows the
  // actual terrain normal and the same baked 0.5 m macro field used by its normal,
  // so sloped geology neither stretches nor becomes a flat painted rock mask.
  const nativeRockPatch = zones.nativeRockPatch;
  const nativeMineral = c.mul(vec3(0.68, 0.74, 0.61)).add(vec3(0.025, 0.023, 0.018));
  c = mix(c, nativeMineral, nativeRockPatch.mul(0.38));

  // Bunker sand belongs to the terrain itself, so it cannot z-fight or diverge at
  // clipmap ring transitions. Do not tint it with the turf atlas; use the continuous
  // non-repeating material field for restrained aggregate variation instead.
  const sandGrain = zones.sandSignal.mul(0.5).add(0.5);
  // At the turf/sand interface, fine aggregate and the signed inner-face
  // position jointly control the value transition. The perturbed 0.06–0.62 m
  // response prevents a bright constant-width halo; deeper sand returns to its
  // base value without imposing a symmetric dark spot at the bunker centre.
  const sandFacePosition = m.sandFaceDistance
    .add(zones.sandSignal.mul(0.08))
    .add(macroVariation.b.sub(0.5).mul(0.10));
  const sandFaceBlend = smoothstep(0.06, 0.62, sandFacePosition);
  const sandFaceValue = sandFaceBlend.mul(0.10).add(0.88);
  // The same registered microaggregate drives both normal/roughness above and this
  // restrained pigment breakup, so grains do not slide or disagree across channels.
  const sandAggregate = zones.sandMicro.sub(1.0).clamp(-0.35, 0.35);
  const sand = C.sand.mul(macroVariation.b.mul(0.12).add(0.94))
    .mul(sandGrain.sub(0.5).mul(0.18).add(1.0))
    .mul(sandAggregate.mul(0.09).add(1.0))
    .mul(sandFaceValue);
  c = mix(c, sand, m.sand);

  // Slightly desaturate + warm so the fairway is muted olive, not radioactive.
  // sat/val are live uniforms so the grade can be matched against a reference photo
  // without a reload (see TurfPanel).
  const lum = luminance(c);
  c = mix(vec3(lum), c, float(0.98).mul(zones.sat)).mul(vec3(1.03, 1.0, 0.95)).mul(zones.val);

  // Pond banks are a shallow alpine mineral shelf reduced to the real contact, layered from the waterline out:
  // the first 0.28 m is cool wet soil; the shoulder dries into brown-gray
  // gravel; the final metre dissolves back into existing turf. All breakup is
  // world-anchored and the shelf width still comes from the authored water SDF.
  const bankMottle = m.waterMottle;
  const bankPebble = tex.r.mul(0.62).add(tex.g.mul(0.38));
  const bankDryness = bankMottle.mul(0.78).add(m.waterGrass.mul(0.22));
  // Keep the bank below the surrounding turf in value and slightly blue/green in
  // hue: saturated tan reads as a cart path under the neutral alpine daylight.
  const wetBank = vec3(0.042, 0.049, 0.043);
  const dryBank = vec3(0.072, 0.078, 0.066);
  const bankBase = mix(wetBank, dryBank, bankDryness);

  // Sparse mineral patches: one broad 0.5–1.0 m exposed seam plus a low-contrast
  // 6–12 cm aggregate field. Thresholding keeps these as readable flecks/patches,
  // not a high-frequency noisy speckle over the whole shore.
  const mineralPatch = smoothstep(0.73, 0.86, bankMottle).mul(0.48);
  // The already-paid turf detail atlas supplies the remaining micro breakup. At
  // the zone-map's 0.5m texel density, literal 6–12cm stones would alias; using
  // its filtered albedo keeps the flecks stable and avoids another fragment noise.
  const fleckMask = smoothstep(0.58, 0.82, bankPebble).mul(0.25);
  const stone = vec3(0.080, 0.092, 0.088);
  const bankMineral = mix(bankBase, stone, mineralPatch.add(fleckMask).clamp(0.0, 0.62));

  // Keep the toe fully wet, but let the outer shoulder be broken by existing turf
  // pigment. This makes grass intrude in irregular tongues instead of exposing a
  // continuous concentric strip around the pond.
  const grassIntrusion = m.waterGrass;
  const outerBank = m.waterBank.sub(m.waterBankWet).max(0.0);
  // The outer shoulder is existing turf with sparse mineral breaches, not a second
  // continuous ring. Only the 12 cm saturated toe remains continuous at water contact.
  const outerBlend = mineralPatch.mul(0.24).mul(oneMinus(grassIntrusion.mul(0.84)));
  const contactExposure = smoothstep(0.38, 0.70,
    bankMottle.mul(0.72).add(grassIntrusion.mul(0.28)));
  const wetToeBlend = m.waterBankWet.mul(contactExposure).mul(0.52);
  const bankBlend = wetToeBlend.add(outerBank.mul(outerBlend)).clamp(0.0, 1.0);
  c = mix(c, bankMineral, bankBlend);

  // Revetted (stacked-sod) faces: the pot bunkers are the only near-vertical
  // terrain, so trigger on steepness alone. Replace the grass with horizontal
  // banded sod layers (constant world-Y bands = stacked turf courses) — the
  // classic links pot-bunker wall. A little noise breaks the ruler-straight
  // courses so they read as hand-stacked sod.
  // Cover the curved shoulders leading into the near-vertical face as well as its
  // centre. Restricting this to N.y < 0.62 left an unclassified, unlit turf band at
  // each end of the pot wall that read as a black polygon from oblique cameras.
  const steep = smoothstep(0.82, 0.55, terrainNormal.y);
  const yWarp = macroVariation.a.sub(0.5).mul(0.03);
  const sodPhase = positionWorld.y.add(yWarp).mul(42.0);
  const sodResolved = sodPhase.sin().mul(0.5).add(0.5);
  // Each course is 15 cm. Fade its contrast from the analytic phase footprint so
  // revetment converges to its mean under minification instead of stripe-crawling.
  const sodVisibility = oneMinus(smoothstep(0.35, 1.4, sodPhase.fwidth()));
  const sod = mix(float(0.5), sodResolved, sodVisibility);
  // Warm, earthy sod courses (dark peat → tan-olive turf edge); the cool sky fill
  // in the shaded pit would otherwise read blue-grey.
  // Keep the deepest peat course dark, but above the tone-map crush point under the
  // hemisphere-only light that reaches a back-facing pit wall. The former 0.075
  // floor became near-black at exactly the camera angle where the wall occupies the
  // most screen space, making correct stationary geometry resemble a corrupt wedge.
  const revet = mix(vec3(0.13, 0.115, 0.075), vec3(0.24, 0.215, 0.14), sod);
  c = mix(c, revet, steep);

  // A gentle richening of steep faces (green shoulders, bunker walls): steep
  // grass is self-shadowed, so fold albedo down slightly with the slope.
  const slopeShade = smoothstep(0.35, 0.85, terrainNormal.y); // 0 vertical → 1 flat
  c = c.mul(mix(float(0.84), float(1.0), slopeShade));

  // ---- Divots: fresh exposed-soil scars near the hitting area, from a single lookup into
  // the GPU divot mask (R = soil, G = leading-edge depth, B = dryness). Mask is 0 outside
  // its region (ClampToEdge), so this is a no-op over the rest of the course. NO bright ring
  // — real fresh divots are just torn earth: a moist-dark leading edge grading to drier
  // brown, mottled soil texture inside, and a ragged (noise-torn) boundary into the turf.
  if (zones.divotSample) {
    // Roughness and albedo share this one full-screen lookup. Sampling the sparse
    // divot texture independently in both material channels doubled its bandwidth.
    const dm = zones.divotSample;
    const soilMask = dm.r, depth = dm.g, dry = dm.b;

    // Moist-dark earth grading to drier, lighter brown (by per-divot dryness + toward edges).
    const moist = vec3(0.075, 0.052, 0.033);
    const drySoil = vec3(0.155, 0.115, 0.072);
    // Per-divot dryness drives the tone; only the very rim dries a little (kept small so
    // thin strips — which are mostly "edge" — still read as fresh dark soil, not tan).
    const dryAmt = dry.mul(0.7).add(oneMinus(smoothstep(0.5, 0.95, soilMask)).mul(0.15)).clamp(0.0, 1.0);
    let soilCol = mix(moist, drySoil, dryAmt);
    // Reuse the already sampled blade-scale albedo grain inside exposed soil. The
    // divot mask supplies its own per-strike seed/outline; two full-screen 3D-noise
    // evaluations here were invisible outside a few square centimetres of scar.
    soilCol = soilCol.mul(detail.clamp(0.72, 1.08));
    // Leading-edge depression shadow (deepest where the club entered) — replaces the old rim.
    soilCol = soilCol.mul(oneMinus(depth.mul(0.5)));
    // Blend turf -> soil by the ragged mask; keep the very edge partly grass (torn, not painted).
    const soilAmt = smoothstep(0.12, 0.6, soilMask).mul(0.9);
    c = mix(c, soilCol, soilAmt);
  }
  return c;
}
