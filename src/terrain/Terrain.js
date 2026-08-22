import {
  BufferGeometry, BufferAttribute, Mesh, MeshPhysicalNodeMaterial, Group,
  Vector2, Vector3, Vector4, Color, DoubleSide, TextureLoader, RepeatWrapping, SRGBColorSpace,
  StorageTexture, DataTexture, RedFormat, FloatType, NearestFilter, LinearFilter, ClampToEdgeWrapping,
} from 'three';
import {
  positionWorld, normalWorld, positionGeometry, transformNormalToView, cameraPosition,
  mx_noise_float, float, vec2, vec3, vec4, mix, texture, textureLevel,
  luminance, smoothstep, oneMinus, Fn, If, Loop, Break, dFdx, dFdy,
  uniform, instanceIndex, textureStore, uvec2, struct, textureLoad, ivec2, int, mrt,
} from 'three/tsl';
import { surface } from '../physics/groundInteraction.js';
import { buildZoneMap, zoneAt as zoneAtTexel } from './ZoneMap.js';
import {
  turfBase,
  turfBladeBase,
  MOW_STRIPE_PERIOD_M,
  MOW_STRIPE_CROSS_SLOPE,
} from './turfColor.js';

// Turf surface maps: TWO BAKES (which surface), each read at TWO TIERS (how far away).
//
// The bakes differ by mowing height, because a mown surface and long rough are not the
// same texture at different scales — they are different plants' worth of structure:
//   * MOWN  (turfdetail_*, scripts/pack_ambientcg_grass001.py) — ambientCG CC0
//     Grass001 at its declared 1.40 m tile / 1024 px = 1.367 mm/texel. Its measured
//     albedo, GL normal, displacement, roughness, and AO serve fairway, green, fringe,
//     tee, and the ground under sand. See docs/turf-grass001-provenance.md.
//   * ROUGH (roughdetail_*, scripts/gen_rough_detail.mjs) — 2.0 m tile at 2048 px =
//     0.98 mm/texel, ~73k tufted 35-95 mm blades. Rough and deep rough.
// The rough used to be textured with the MOWN bake, on the theory that the 3D blade
// system carried it. It doesn't: a 10 mm blade is under one device pixel by ~40 m, so
// past the blade LOD the rough was reading as fairway with a few slivers standing in it.
//
// Either bake carries NO baked light: albedo is pigment only, the across-blade rounding
// lives in the normal map so the scene's real sun makes the sheen, and canopy occlusion
// is a separate AO channel that only attenuates ambient.
//
// The two TIERS are the near (blade-resolving, parallax-marched, sampled at the atlas's
// native tile) and the distance tier (the same seamless atlas at its footprint-selected
// mip). They crossfade by `dw` over the last ~28 m, where individual blades stop
// resolving; continuous world-space variation supplies the larger-scale character.
const _texLoader = new TextureLoader();

function loadTurfMaps() {
  const load = (p, srgb) => {
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const t = _texLoader.load(p, () => resolveReady(), undefined, (error) => {
      console.error(`[turf] required texture failed to load: ${p}`);
      rejectReady(error || new Error(`Failed to load ${p}`));
    });
    t.name = `turf:${p.split('/').at(-1)}`;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = SRGBColorSpace;
    return { texture: t, ready };
  };
  // R,G = normal.xy | B = canopy height | A = canopy AO. flipY off on the detail maps
  // so the normal's V axis maps straight onto world +Z (and stays registered with the
  // albedo) — otherwise the baked relief lights from the wrong side.
  const set = (name, tile, farMean, albedoMean, packedRoughness = false) => {
    const albLoad = load(`/assets/textures/${name}_alb.png`, true);
    const nrhLoad = load(`/assets/textures/${name}_nrh.png`, false);
    const alb = albLoad.texture, nrh = nrhLoad.texture;
    alb.flipY = nrh.flipY = false;
    return { alb, nrh, tile, farMean, albedoMean, packedRoughness,
      ready: Promise.all([albLoad.ready, nrhLoad.ready]) };
  };
  // The bentgrass_* bake is deliberately NOT loaded any more. Nothing samples it: the
  // broad tier moved onto the detail bake (see turfColorNode) because bentgrass has a
  // directional artifact that tiled into fake mow stripes, and the normal/rough maps
  // were never wired up at all. Loading it cost ~2.3 MB of download and a GPU upload
  // for a texture no shader read.
  // B/A means are measured from the generated NRH assets. At a footprint where the
  // source blades are sub-pixel, these are the physically correct filtered canopy
  // values; retaining the arrangement of one finite tile is not.
  // Grass001 source means measured from the pinned 1K maps. Rough keeps its existing
  // generated bake and measured means. The third far value is packed roughness;
  // rough has no packed channel and keeps a neutral constant that is ignored there.
  const mown = set('turfdetail', 1.4, [0.36329, 0.81186, 0.54402], 0.092492, true);
  const rough = set('roughdetail', 2.0, [0.50762, 0.66504, 0.54402], TURF_LUM, false);
  return { mown, rough, ready: Promise.all([mown.ready, rough.ready]) };
}

// Everything one detail bake contributes to shading, in one value. It has to travel as
// a struct because selecting between the two bakes needs an `If`, `If` needs a shader
// stack (so it has to live inside an Fn), and an Fn returns exactly one thing.
//   far.x = canopy height -> blade-scale gloss | far.y = canopy AO
const turfTierStruct = struct({
  relief: 'vec3', far: 'vec2', shade: 'float', alb: 'vec4',
}, 'TurfTier');
// Mean LINEAR luminance of both albedo tiers (measured, not guessed) — the shader
// divides by this so a map swap doesn't silently change how bright the turf is.
const TURF_LUM = 0.138;

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
export class Terrain {
  constructor(config) {
    // `spacing` is the FINE physics/collision grid (heightAt/normalAt sample it, so
    // ball roll and contours stay accurate). `renderSpacing` is the coarser step
    // the render mesh + shadow pass use — a distance-independent LOD that keeps the
    // heavy vertex work down while the fine grid preserves gameplay fidelity.
    const {
      bounds, spacing = 2, renderSpacing = spacing, heightFn, surfaceFn, zones,
      motionHistory = null, renderer,
    } = config;
    if (!renderer?.isWebGPURenderer) {
      throw new Error('Terrain requires the strict WebGPU renderer for its GPU-authored variation field.');
    }
    this.bounds = bounds;
    this.spacing = spacing;
    this.renderSpacing = renderSpacing;
    this.heightFn = heightFn;
    this.surfaceFn = surfaceFn;
    // Geometric zone spec (greens/sands circles, fairway corridor, tee box) used
    // to classify the turf ANALYTICALLY in the shader — smooth-curve boundaries
    // instead of a rasterized splat's stair-stepped squares. See turfColorNode.
    this.zones = zones;
    this.motionHistory = motionHistory;

    this.nx = Math.floor((bounds.maxX - bounds.minX) / spacing) + 1;
    this.nz = Math.floor((bounds.maxZ - bounds.minZ) / spacing) + 1;
    this.heights = new Float32Array(this.nx * this.nz);

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
    this.uSat = uniform(1.0);            // final turf grade
    this.uVal = uniform(1.0);
    this.uShadow = uniform(0.55);        // restrained canopy self-shadow strength
    // Sun direction, set from main.js so the canopy self-shadow marches toward the
    // same light the rig uses (see setSun).
    this.uSunDir = uniform(new Vector3(-0.82, 0.4, -0.12).normalize());

    // Baked signed-distance map of the turf zones. Built once here so the shader
    // never re-derives zone membership per pixel (see ZoneMap.js).
    this._zoneMap = buildZoneMap(zones, bounds);
    this._initMacroVariation(renderer);

    this._initDivots();          // divot scar field (GPU compute-stamped mask, read by the turf shader)
    this._bake();
    // Rendering samples this exact immutable physics heightfield on the GPU. It is
    // deliberately nearest-only because `_heightNode()` performs the same explicit
    // bilinear reconstruction as `heightAt()`, including edge clamping.
    this._heightTex = new DataTexture(this.heights, this.nx, this.nz, RedFormat, FloatType);
    this._heightTex.name = 'terrain-heightfield-r32f';
    this._heightTex.minFilter = this._heightTex.magFilter = NearestFilter;
    this._heightTex.generateMipmaps = false;
    this._heightTex.needsUpdate = true;
    this._turfMaps = null;
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
      }
    }
  }

  // Bilinear height lookup, clamped to bounds.
  heightAt(x, z) {
    const { minX, minZ, maxX, maxZ } = this.bounds;
    const fx = (Math.min(Math.max(x, minX), maxX) - minX) / this.spacing;
    const fz = (Math.min(Math.max(z, minZ), maxZ) - minZ) / this.spacing;
    const i = Math.min(Math.floor(fx), this.nx - 2);
    const j = Math.min(Math.floor(fz), this.nz - 2);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.heights[this._idx(i, j)];
    const h10 = this.heights[this._idx(i + 1, j)];
    const h01 = this.heights[this._idx(i, j + 1)];
    const h11 = this.heights[this._idx(i + 1, j + 1)];
    const a = h00 * (1 - tx) + h10 * tx;
    const b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - tz) + b * tz;
  }

  // Surface normal from central differences of the height field.
  normalAt(x, z, out = new Vector3()) {
    const e = this.spacing;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    out.set(hL - hR, 2 * e, hD - hU).normalize();
    return out;
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

  // Shared immutable rendering copy of `heights`.  Grass and terrain vertices sample
  // this exact texture; CPU reads stay confined to collision/physics methods above.
  get heightTexture() {
    return this._heightTex;
  }

  // Grass consumes the same signed-distance field as the ground shader so blade
  // height can cross rough/deep-rough boundaries continuously instead of following
  // the nearest CPU surface sample. Terrain remains the sole texture owner.
  get zoneTexture() {
    return this._zoneMap?.texture;
  }

  // The irregular authored pond outline is also available as a compact, filtered
  // signed-distance field.  Terrain owns this texture; consumers borrow it just like
  // zoneTexture and never dispose it independently.
  get waterZoneTexture() {
    return this._zoneMap?.waterTexture;
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
    this.surfaceFn = null;
    this._heightTex?.dispose();
    this._zoneMap?.texture?.dispose();
    this._zoneMap?.waterTexture?.dispose();
    this._divotTex?.dispose();
    this._macroTexture?.dispose();
    this._macroInit?.dispose();
    this._turfMaps?.mown?.alb?.dispose();
    this._turfMaps?.mown?.nrh?.dispose();
    this._turfMaps?.rough?.alb?.dispose();
    this._turfMaps?.rough?.nrh?.dispose();
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
    textureOut.generateMipmaps = false;
    textureOut.mipmapsAutoUpdate = false;
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

  _buildMesh() {
    // Fixed nested camera-centred rings. Each ring is a shared static grid with a
    // centre hole (except L0), so it has no overdraw/z-fight with its finer neighbour.
    // The first three rings deliberately use 0.9/1.8/3.6 m display steps while the
    // authoritative 0.6 m height texture remains intact for bilinear reconstruction,
    // normals, and physics. This removes low-value far vertices without changing any
    // golfer-height landform or surface boundary. The outer ring keeps its 4.8 m
    // anchor so camera snapping/temporal history remain unchanged. Its 384 m
    // reach is intentional: the flight director can rise without following the
    // ball all the way downrange, and a 288 m reach exposed sky between the
    // playable edge and the backdrop shell.
    const rings = [
      { half: 36, step: 0.9, inner: 0 },
      { half: 72, step: 1.8, inner: 36 },
      { half: 144, step: 3.6, inner: 72 },
      { half: 384, step: 4.8, inner: 144 },
    ];
    const group = new Group();
    group.name = 'terrain-gpu-clipmap';
    this._rings = [];
    let vertices = 0, triangles = 0, bytes = 0;
    for (let level = 0; level < rings.length; level++) {
      const spec = rings[level];
      const origin = uniform(new Vector2());
      const geo = this._ringGeometry(spec);
      const mat = this._buildTurfMaterial(origin);
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
    const anchorStep = this._rings[this._rings.length - 1].step;
    const x = Math.floor(camera.position.x / anchorStep) * anchorStep;
    const z = Math.floor(camera.position.z / anchorStep) * anchorStep;
    for (const ring of this._rings) {
      ring.origin.value.set(x, z);
      ring.mesh.position.set(x, 0, z);
    }
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
  _buildTurfMaterial(origin = uniform(new Vector2())) {
    if (!this._turfMaps) {
      this._turfMaps = loadTurfMaps();
      // Some terrain materials are compiled while image decode is still in flight.
      // Three records the texture's byte size when its first GPU handle is created;
      // without this one-time invalidation, a handle initially made from the 1×1
      // loading image keeps that tiny accounting entry after the real 2048px source
      // replaces it.  These are the same loaded texture objects (not a secondary
      // asset path): dispose only forces the next bind to allocate their final image
      // and makes renderer memory reporting match the actual GPU allocation.
      this.assetsReady = this._turfMaps.ready.then(() => {
        if (this._disposed) return;
        for (const set of [this._turfMaps.mown, this._turfMaps.rough]) {
          set.alb.dispose(); set.alb.needsUpdate = true;
          set.nrh.dispose(); set.nrh.needsUpdate = true;
        }
      });
    }
    const maps = this._turfMaps;
    const mat = new MeshPhysicalNodeMaterial({ metalness: 0.0, side: DoubleSide });
    // `positionGeometry` carries only static X/Z grid topology. Reconstruct Y and
    // the matching central-difference normal from the authoritative height texture
    // in the vertex path; physics remains the sole CPU consumer of `heights`.
    const terrainX = positionGeometry.x.add(origin.x);
    const terrainZ = positionGeometry.z.add(origin.y);
    const terrainHeight = this._heightNode(terrainX, terrainZ);
    const terrainNormal = this._normalNode(terrainX, terrainZ);
    const inBounds = terrainX.greaterThanEqual(this.bounds.minX).and(terrainX.lessThanEqual(this.bounds.maxX))
      .and(terrainZ.greaterThanEqual(this.bounds.minZ)).and(terrainZ.lessThanEqual(this.bounds.maxZ));
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

    const worldXZ = vec2(positionWorld.x, positionWorld.z);
    const macroUv = vec2(
      worldXZ.x.sub(this.bounds.minX).div(this.bounds.maxX - this.bounds.minX),
      worldXZ.y.sub(this.bounds.minZ).div(this.bounds.maxZ - this.bounds.minZ),
    );
    const macroVariation = texture(this._macroTexture, macroUv);
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
    const m = turfZoneMasks(this._zoneMap.texture, this._zoneMap.waterTexture, this.bounds, this.zones);
    const zone = turfCanopyDepth(m);
    const zoneDepth = zone.depth;
    // Which of the two detail bakes this pixel belongs to (0 = rough/deepRough,
    // 1 = mown). See turfMownWeight.
    const mownW = turfMownWeight(m);

    // ---- LAYERED parallax occlusion. The ray from the eye is marched DOWN through
    // the baked canopy height field in NL equal steps and stopped at the first step
    // that is below the surface, so every pixel resolves to a real ray/height-field
    // intersection. That is the crucial difference from the old single-tap parallax:
    // that one just offset the lookup by this pixel's own height sample, so on a
    // high-frequency field neighbouring pixels jumped to unrelated texels and the turf
    // tore into liquid swirls. Marching is exactly the fix for a noisy height field.
    //
    // Sampling uses an explicit LOD (derivatives taken once, outside the loop) because
    // WGSL forbids implicit-derivative sampling under non-uniform control flow.
    // Crossing interpolation turns the two retained samples into a continuous secant
    // intersection rather than two visible depth shelves. At a true 4–11 mm mown
    // canopy, more samples do not add screen-resolvable silhouette information at
    // native 1440p; rough receives real near-field blades on top of this map.
    const NL = 2;
    const V = cameraPosition.sub(positionWorld).normalize();
    const S = this.uSunDir;
    const depthM = zoneDepth.mul(dw).mul(this.uParallax);
    // Per-pixel world footprint in METRES, taken once here. Every texture read below
    // uses an explicit LOD derived from this rather than implicit derivatives, for two
    // reasons: WGSL forbids implicit-derivative sampling under non-uniform control flow
    // (and the whole detail tier now sits inside a branch), and the parallax/self-shadow
    // marches were already required to do it. Both bakes are 2048 px, so a map's LOD is
    // just this footprint measured in ITS tile.
    const duvM = dFdx(worldXZ).length().max(dFdy(worldXZ).length());
    const lodFor = (scaleM) => duvM.div(scaleM).mul(2048).log2().max(0.0);
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
    // CAP the total march distance. Horizontal travel goes as V.xz/V.y, so at ball-eye
    // height the ray wants to cross far more texels than NL steps can sample, and the
    // march strides straight over whole blades — which shows up as smearing along the
    // view direction. Capping the travel (rather than the angle) bounds the step to a
    // couple of texels at any angle: depth is preserved wherever it can be resolved and
    // quietly gives way where it can't, which is the honest trade at a fixed layer count.
    // In UV, so it's a fixed ~2.5 texels/step for either bake (both are 2048 px).
    const MAX_TRAVEL = NL * 0.0012;

    // Everything read out of ONE detail bake. Called once per bake so the mown and
    // rough sets go through identical code — they differ only in content and in the
    // world size of their tile.
    // The phase field is common to both bakes.  Keeping it outside readTier makes the
    // rough overwrite path share the same four procedural samples with the mown
    // default instead of evaluating them twice per rough fragment.
    // Continuous phase offsets are generated once on the GPU for the entire authored
    // course. They break repeated atlas seam alignment without twelve live noise fields.
    const phase = macroVariation.rg.mul(0.32).sub(0.16);
    const readTier = (set) => {
      const T = set.tile;
      const lod = lodFor(T);
      const micro = microRayWeight(lod);
      // Once a pixel covers centimetres of turf, the finite atlas's low mips stop
      // representing blades and start representing the unique arrangement of THIS
      // two-metre tile. Repeating that arrangement is the distant rough "stamp".
      // Resolve to the bake's measured mean by screen-space footprint, not camera
      // distance: no radial handoff, and no texture motif survives past its physical
      // resolving limit. Non-repeating world-space fields below carry macro variation.
      const unresolved = smoothstep(4.5, 7.0, lod);
      const rayActive = dw.mul(micro);
      // A continuous phase warp makes the atlas's U/V wrap lines wander naturally
      // through world space instead of accumulating into straight visible seams.
      const uv0 = worldXZ.mul(1 / T).add(phase);
      // Horizontal travel per unit of depth is V.xz / V.y, away from the eye. V.y is
      // clamped so a grazing view can't demand an unbounded march.
      // Fade the displacement itself as the source signal becomes minified.  Merely
      // skipping the loop would make a hard UV step at its coverage boundary.
      const microDepthM = depthM.mul(micro);
      const travel = vec2(V.x, V.z).div(V.y.abs().max(0.30)).mul(microDepthM.div(T));
      const scale = float(MAX_TRAVEL).div(travel.length().max(1e-6)).min(1.0);
      const stepUV = travel.mul(scale).negate().div(NL);
      const uvP = turfParallaxUV(set.nrh, uv0, stepUV, lod, rayActive, NL);

      const dNrh = textureLevel(set.nrh, uvP, lod);
      const dAlb = textureLevel(set.alb, uvP, lod);
      const nDetail = vec3(dNrh.r.mul(2).sub(1), 0.0, dNrh.g.mul(2).sub(1));
      // Same cap on the shadow march, for the same reason (a low sun grazes just as hard).
      const sunTravel = vec2(S.x, S.z).div(S.y.max(0.15)).mul(microDepthM.div(T));
      const sunUVFull = sunTravel.mul(float(MAX_TRAVEL).div(sunTravel.length().max(1e-6)).min(1.0));

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
        relief: nDetail.mul(this.uDetailNormal.mul(flat).mul(oneMinus(unresolved))),
        // The resolved NRH sample already carries canopy height + AO. Near pixels
        // should use the actual ray intersection; distant pixels have uvP == uv0.
        // Re-reading the same four-channel atlas at uv0 spent one fetch over every
        // ground fragment and added no independent signal.
        far: mix(vec2(dNrh.b, dNrh.a), vec2(set.farMean[0], set.farMean[1]), unresolved),
      // Two fixed probes are enough to catch a neighbouring long blade at the sun
      // direction while keeping the branch spatially coherent and bounded.
      shade: turfSelfShadow(set.nrh, uvP, dNrh.b, sunUVFull, lod, rayActive, 2),
        // `uvP` is exactly `uv0` once the footprint disables the ray, and its
        // displacement smoothly tends to zero through the minification band.  Sampling
        // this single UV is therefore equivalent at both ends to the former far/near
        // blend while avoiding a second albedo fetch in every terrain fragment.
        // Normalize each source's measured linear luminance before the common zone
        // grade. This keeps the existing rough bake stable while Grass001 retains its
        // real chroma/structure. Alpha carries measured roughness for the CC0 mown
        // source; the generated rough tier uses its neutral declared constant.
        alb: vec4(
          mix(dAlb.rgb.mul(TURF_LUM / set.albedoMean), vec3(TURF_LUM), unresolved),
          set.packedRoughness
            ? mix(dAlb.a, float(set.farMean[2]), unresolved)
            : float(set.farMean[2]),
        ),
      };
    };

    // ---- Pick the bake. Rough and deep rough get long, tufted grass; the mown
    // surfaces get the short one. This has to switch BOTH tiers together: gating it on
    // anything that varies with camera distance would crossfade one bake into the other
    // as you walked, which is precisely the camera-centred ring the fade below exists
    // to keep smooth.
    //
    // Branch rather than blend. A pixel is essentially always fully one surface or the
    // other — the only pixels that are both lie in the outer ~1 m shoulder — so this is
    // spatially coherent and whole waves take the same path, the same argument the
    // parallax/self-shadow marches already rely on. An unconditional mix would sample
    // both bakes everywhere and roughly double the fetch count of the most expensive
    // shader in the frame.
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
    // So the mown tier is read unconditionally and the rough tier overwrites it under a
    // single `If`. The cost is one extra set of fetches ON ROUGH PIXELS ONLY — mown
    // surfaces, which are most of a course, still pay for exactly one bake. That is the
    // cheapest arrangement that is actually correct; an unconditional mix of both would
    // pay it everywhere.
    //
    // IF YOU TOUCH THIS: never add a second `If`, an `Else`, or an `ElseIf` here. Verify
    // any change with `node scripts/shot.mjs --asset "turf: rough" --probe` — a broken
    // branch shows up as pctNearBlack ~99, not as an error.
    //
    // There is also no third path for the mowing line (it used to cross-fade both bakes
    // there). Both bakes are normalised to the same TURF_LUM, so the inner shoulder
    // remains a stable mown read while the long-grass bake begins only after the
    // measured carpet transition; canopy depth follows that same world-space shoulder.
    const tier = Fn(() => {
      const base = readTier(maps.mown);
      const relief = base.relief.toVar();
      const far = base.far.toVar();
      const shade = base.shade.toVar();
      const alb = base.alb.toVar();
      // Keep the expensive rough bake on the long-grass side of the transition. The
      // mown default owns the first part of the shoulder, where the geometry carpet is
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

    // Sand is shaded on this same clipmap surface. It must not inherit the mown
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
    // field.  Apply a bounded class profile to the SAME measured micro relief so the
    // hierarchy survives real light without changing canopy depth or gameplay grade.
    // The resulting approximate amplitudes remain ordered: green 0.42, tee 0.70,
    // fairway 0.89, fringe 1.02, then the long-grass bake at 1.11.
    let cutMicroGain = float(1.0);
    cutMicroGain = mix(cutMicroGain, float(1.08), m.visualFairway);
    cutMicroGain = mix(cutMicroGain, float(0.92), m.fringe);
    cutMicroGain = mix(cutMicroGain, float(1.42), m.green);
    cutMicroGain = mix(cutMicroGain, float(0.94), m.tee);
    const reliefAmplitude = reliefScale.mul(0.82).mul(cutMicroGain).clamp(0.22, 1.8);
    const grassNormal = terrainNormal.add(tRelief.mul(reliefAmplitude)).normalize();
    // Directional fibre relief stays visible after the atlas is minified. Keep this
    // fine field restrained: the fairway's readable structure is the reel-pass
    // pass below, not a high-frequency procedural noise carpet.
    // The macro bake already carries a filtered, world-stable low-frequency field.
    // Reuse its moisture channel as the fibre warp instead of evaluating another
    // full 3D noise field in every terrain fragment.  The remaining fibre field is
    // still live at blade/near-meso scale, so close turf keeps its directional
    // micro-response while the warp remains continuous across all four clipmaps.
    const fibreWarp = macroVariation.a.sub(0.5);
    const fibreField = mx_noise_float(vec3(
      worldXZ.x.mul(1.16).add(fibreWarp.mul(0.72)),
      worldXZ.y.mul(0.93).sub(fibreWarp.mul(0.58)), 181.0));
    // Keep a visible but physically small fibre roll after the source atlas is
    // minified. The old 0.24 response left the 10--20 m turf footprint almost
    // perfectly planar in the approach capture; this is still only a few
    // centimetres of slope in the normal field, not displacement.
    // The ecotone is a render-only shoulder.  Its low-frequency warp keeps the
    // maintained edge from reading as a ruler-straight SDF cut, while the
    // gameplay masks and collision surface remain untouched.
    const visualMaintained = m.visualFairway.add(m.fringe).add(m.green).add(m.tee).clamp(0.0, 1.0);
    // The authored gameplay fairway mask is the sole owner of mowing response.
    // Explicit exclusions prevent its antialiased corridor edge from leaking the
    // directional fibre/lay onto collar, green, tee, sand, shoreline, rough, or native.
    const fairwayMowMask = m.fairway
      .mul(oneMinus(m.fringe)).mul(oneMinus(m.green)).mul(oneMinus(m.tee))
      .mul(oneMinus(m.sand)).mul(oneMinus(m.waterBank)).clamp(0.0, 1.0);
    const fibreBump = vec3(dFdx(fibreField), 0.0, dFdy(fibreField)).mul(0.34).mul(0.30)
      .mul(fairwayMowMask);
    // Straight 2.54 m reel passes. The coordinate is exactly linear in authored
    // world/course axes: no noise, warp, curvature, or per-pass phase perturbation.
    const stripCoordinate = worldXZ.x.add(worldXZ.y.mul(MOW_STRIPE_CROSS_SLOPE));
    const stripPhase = stripCoordinate.mul(6.2831853 / MOW_STRIPE_PERIOD_M);
    const stripWave = stripPhase.cos().mul(0.5).add(0.5);
    // Equal-width passes with a clean but antialiased reel boundary. Contrast remains
    // physical and restrained below; this only defines which way the leaf is laid.
    const stripLay = smoothstep(0.40, 0.60, stripWave);
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
    const mowBump = layDirection.mul(stripLay.sub(0.5).mul(0.22))
      .mul(fairwayMowMask).mul(mowResolution);
    // Surface-wide meso relief prevents a perfectly planar fairway/green after
    // the atlas is minified. The warped isotropic field avoids long directional
    // shelves while retaining the separate fine mowing response above.
    // The macro phase field is already a filtered low-frequency warp. Keep one live
    // meso field for relief breakup, but do not spend another noise evaluation to
    // perturb its coordinates.
    const mesoWarp = macroVariation.r.sub(0.5);
    const mesoReliefField = mx_noise_float(vec3(
      worldXZ.x.mul(0.24).add(mesoWarp.mul(0.8)),
      worldXZ.y.mul(0.19).sub(mesoWarp.mul(0.6)), 229.0));
    const mesoGradient = vec3(dFdx(mesoReliefField), 0.0, dFdy(mesoReliefField));
    // The same 4--5 m field must not make every maintained surface one material.
    // Fairway retains the strongest fibrous undulation, fringe is coarser but less
    // uniformly worked, tee is compact, and the dense low green carries only a small
    // residual roll. These are normal amplitudes under the shared light, not pigment
    // decals; the masks and heightfield remain authoritative and world stable.
    let cutMesoNormal = float(0.0);
    cutMesoNormal = mix(cutMesoNormal, float(0.19), m.visualFairway);
    cutMesoNormal = mix(cutMesoNormal, float(0.14), m.fringe);
    cutMesoNormal = mix(cutMesoNormal, float(0.065), m.green);
    cutMesoNormal = mix(cutMesoNormal, float(0.105), m.tee);
    const mesoBump = mesoGradient.mul(cutMesoNormal);
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
      .add(nativeBump).add(bankRelief).normalize();
    // The same world-anchored fibre field also gives a tiny roughness modulation.
    // It is broad enough to survive 2–30 m minification, but remains far below
    // the roughness floor so the turf never turns into a glossy sheet.
    const fibreRoughness = fibreField.sub(0.5).mul(0.070)
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
    // The mown-tier albedo was already fetched for every bunker fragment. Reuse only
    // its scalar, normalized high-frequency luminance as sub-decimetre aggregate:
    // no turf colour/normal enters sand, and this adds no texture sample. Its own mip
    // chain naturally removes grains when they cease to resolve.
    const sandMicro = luminance(tAlb.rgb).div(TURF_LUM).clamp(0.35, 2.4);
    const sandSurface = sandHeight.mul(0.74).add(sandRake)
      .add(sandMicro.sub(1.0).mul(0.055));
    const sandBump = vec3(dFdx(sandSurface), 0.0, dFdy(sandSurface)).mul(0.32).mul(m.sand);
    const sandNormal = terrainNormal.add(sandBump).normalize();
    // transformNormalToView performs the final normalization after the sand/turf
    // blend. A second normalize here was an identical inverse-square-root in every
    // terrain fragment and did not change the resulting view-space normal.
    mat.normalNode = transformNormalToView(mix(maintainedNormal, sandNormal, m.sand));

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
    mat.aoNode = mix(grassAO, float(1.0), m.sand);

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
    // Grass001 roughness packed into the already-read albedo alpha, remapped into a
    // matte turf range while preserving its measured local variation.
    const canopyRoughness = oneMinus(tFar.x).mul(this.uRoughRange.mul(1.6)).add(this.uRoughBase);
    const scannedRoughness = tAlb.a.mul(0.30).add(0.61);
    const baseMicroRoughness = mix(canopyRoughness, scannedRoughness, mownW);
    const rGrass = baseMicroRoughness
      .add(fibreRoughness)
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
    const mowAnisotropy = mowOptical.mul(0.14);
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
    // The water-bank shelf is damp mineral soil/gravel, not a painted radial ring:
    // its moisture response comes from the authored pond SDF and stays matte under
    // the same sun/sky rig. Interior water is excluded by the SDF mask and remains
    // hidden beneath the dedicated water surface.
    const bankRoughness = surfaceRoughness.add(m.waterBank.mul(0.075)).clamp(0.68, 0.99);
    const sandRoughness = sandHeight.mul(0.035).add(sandMicro.sub(1.0).mul(0.025))
      .add(0.90).clamp(0.86, 0.95);
    mat.roughnessNode = mix(mix(bankRoughness, sandRoughness, m.sand), float(0.97), m.waterBank.mul(oneMinus(m.sand)));
    // Opposite mower lays expose a bounded amount of cuticle to the same real light.
    // The inverse relationship with roughness avoids a wet/plastic lobe: the pass
    // made rougher above also carries less dielectric return here (maximum +/-16%).
    const mowSpecular = oneMinus(mowOptical.mul(0.24)).clamp(0.86, 1.14);
    // Cut height changes the coherence of the dielectric leaf return. Keep every
    // surface in a restrained matte-turf range while allowing green, tee, collar,
    // and fairway to separate under the one shared sun/PMREM state.
    let cutSpecular = float(0.90);
    cutSpecular = mix(cutSpecular, float(0.98), m.visualFairway);
    cutSpecular = mix(cutSpecular, float(0.92), m.fringe);
    cutSpecular = mix(cutSpecular, float(1.20), m.green);
    cutSpecular = mix(cutSpecular, float(1.05), m.tee);
    mat.specularIntensityNode = this.uSpecular.mul(mowSpecular).mul(cutSpecular);
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
      const c = turfBladeBase(name, new Color());
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
      // occlusion for real (its canopy-AO channel means 0.596 against the mown bake's
      // 0.758, because long grass genuinely shadows itself far more), and stacking a
      // hand-picked multiplier on top of a measured one double-counts.
      // Use the exact same chlorophyll tint as the geometry above. Texture, AO,
      // normals, and real lighting still give the substrate depth; exposed pixels
      // no longer reveal a different grey-green material between blade ribbons.
      rough: roughUndercoat('rough'), deepRough: roughUndercoat('deepRough'),
      // The putting surface is the same believable plant family but not the same
      // material as fairway. Its dedicated gameplay pigment is slightly cleaner and
      // more yellow-green; the restrained exposure multiplier prevents a bright
      // nested target decal while cut height and dielectric response do most of the
      // separation under real light.
      green: grassCol('green', 0.92), fringe: grassCol('fringe', 0.96), tee: grassCol('tee'),
      sand: vec3(sc.r, sc.g, sc.b),
    };
    mat.colorNode = turfColorNode(tAlb.rgb, m, {
      ...this.zones, colors: palette, sat: this.uSat, val: this.uVal,
      divotSample, mowResolution, sandSignal: sandHeight, sandMicro,
      maintainedCoverage: visualMaintained, fairwayMowMask, stripLay, nativeRockPatch,
    }, macroVariation, terrainNormal);
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
// where the near-field weight is ~0 — that branch is spatially coherent (it's purely
// distance-based), so distant pixels genuinely cost nothing.
const turfParallaxUV = Fn(([hTex, uv0, stepUV, lod, active, nl]) => {
  const uv = uv0.toVar();
  If(active.greaterThan(0.02), () => {
    const d = float(0).toVar();            // ray depth below the canopy top, 0..1
    const dStep = float(1).div(nl);
    const uvPrev = uv0.toVar();            // state of the step before the crossing
    const dsPrev = float(0).toVar();
    const dPrev = float(0).toVar();
    Loop(nl, () => {
      // B channel is canopy height with 1 = blade tip, so depth below the tips is 1-h.
      const ds = textureLevel(hTex, uv, lod).b.oneMinus().toVar();
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

// Canopy SELF-SHADOWING: from the point the view ray hit, march back up through the
// height field toward the sun. If the canopy rises above that ray anywhere along the
// way, this point is in the shadow of the blades in front of it.
//
// This is the main thing separating photographic turf from painted turf. Sunlit grass
// is not smooth mid-green — it is a dense field of lit blade tops against hard little
// shadows cast by neighbouring blades, and that high-frequency contrast is what the
// eye reads as "real". A normal map alone can only shade a blade by its own facing; it
// can never let one blade darken another.
const turfSelfShadow = Fn(([hTex, uvHit, h0, sunUVFull, lod, active, ns]) => {
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
      occ.assign(occ.max(textureLevel(hTex, uv, lod).b.sub(h).max(0.0)));
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
function turfZoneMasks(zoneTex, waterTex, bounds, zones) {
  const AA = 0.16;                        // edge softness (m): smooth curve, still crisp
  const sd = texture(zoneTex, vec2(
    positionWorld.x.sub(bounds.minX).div(bounds.maxX - bounds.minX),
    positionWorld.z.sub(bounds.minZ).div(bounds.maxZ - bounds.minZ),
  )).toVar('zoneSD');
  // Water's signed distance and deterministic bank signals are authored from the
  // same irregular pond outline as Range collision and WaterSurface geometry. This
  // is one filtered RGBA16F lookup, not an analytic circle or radial camera fade.
  const waterSample = texture(waterTex, vec2(
    positionWorld.x.sub(bounds.minX).div(bounds.maxX - bounds.minX),
    positionWorld.z.sub(bounds.minZ).div(bounds.maxZ - bounds.minZ),
  )).toVar('waterBankSample');
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
    waterSample.z.mul(0.68).add(waterSample.w.mul(0.32)));
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
  // Green and collar remain derived from the authored SDF, but their render response
  // resolves over a turf-maintenance shoulder instead of a sub-pixel pigment ring.
  // Reusing the fairway's seeded warp prevents perfect concentric bands while leaving
  // gameplay classification and collision untouched.
  const targetWarp = edgeWarp.mul(0.12);
  const visualGreen = smoothstep(-0.72, 0.72, sd.g.add(targetWarp));
  const visualFringe = smoothstep(-0.90, 0.90, sd.g.add(zones.fringeW).add(targetWarp.mul(0.65)));
  const maintainedTransition = smoothstep(-2.0, 2.0, edgeSD);
  // A wider but still bounded visual mix carries the same ecotone into albedo,
  // directional response, and bake ownership. It is not a gameplay mask.
  const visualFairway = smoothstep(-3.2, 3.2, edgeSD);
  return {
    rough: soft(sd.r.add(zones.corridor.rough)),
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
    waterGrass: waterSample.w,
  };
}

// Which detail bake this pixel wants: 0 = the rough bake (long, tufted grass), 1 = the
// mown bake. Composited through the SAME mask chain in the SAME order as the colour and
// depth paths, so the texture switch lands exactly on the mowing line and not a pixel
// off it. Sand takes the mown bake — it has no canopy of its own, and the short map is
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

// TSL colorNode: the per-zone tint (`color`) carrying the grain of a turf albedo
// texture. The texture's luminance supplies the blade-level variation while the zone
// tint sets the actual colour of each surface (fairway/rough/green), so it's
// photographic AND correctly coloured. `tex` is mipped at distance and
// blade-resolving/parallaxed up close (see readTier). Continuous macro variation sits
// on top; the only directional course-scale signal is the explicit straight reel pass
// below, never a hidden atlas period.
function turfColorNode(tex, m, zones, macroVariation, terrainNormal = normalWorld) {
  const wx = positionWorld.x;             // TRUE world pos drives zone classification
  const wz = positionWorld.z;
  const C = zones.colors;                 // vec3 per zone
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

  // Both tiers are sampled from the DETAIL bakes, never from the bentgrass bake.
  // The bentgrass map had a directional artifact that tiled into fake short-period
  // stripes. The detail bakes are drawn with randomly-oriented blades so they have no
  // preferred direction; the deliberate straight reel pass is added below in world
  // space, where its period and direction remain measurable and stable.
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
  let microContrast = float(1.28);
  microContrast = mix(microContrast, float(1.18), m.rough);
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
    // The reel pass is the fairway's readable directional signal. Keep the
    // persistent macro field, but compress its contrast over maintained turf so
    // stochastic lime mottling cannot compete with the directional cut pattern.
    let cutMacroStrength = float(0.115);
    cutMacroStrength = mix(cutMacroStrength, float(0.090), m.fringe);
    cutMacroStrength = mix(cutMacroStrength, float(0.055), m.green);
    cutMacroStrength = mix(cutMacroStrength, float(0.080), m.tee);
    const macroStrength = mix(float(0.21), cutMacroStrength, maintainedCoverage);
    const macroAlbedo = float(1.0).add(macroVariation.b.sub(0.5).mul(macroStrength));
    let cutMesoStrength = float(0.30);
    cutMesoStrength = mix(cutMesoStrength, float(0.22), m.fringe);
    cutMesoStrength = mix(cutMesoStrength, float(0.12), m.green);
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
  // Restrained ±2.25% pigment response supports the directional normal lay above.
  // Most of the read still comes from real light, but the bands remain identifiable
  // under diffuse overcast illumination where directional sheen is naturally weak.
  // A real mower pass is primarily a change in leaf lay. Keep enough pigment
  // separation to read under diffuse sky, but below the contrast that made the
  // overview resemble alternating painted lanes.
  const mowBand = stripLay.sub(0.5).mul(0.045);
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
  const sod = positionWorld.y.add(yWarp).mul(42.0).sin().mul(0.5).add(0.5);
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
