// Generate the ROUGH / DEEP-ROUGH detail maps: the unmown counterpart to
// gen_turf_detail.mjs.
//
// Why this exists: the rough was being textured with turfdetail_*, which is a MOWN
// bake — 7-20 mm blades on a 1 m tile, i.e. a fairway. The 3D blade system only
// carries the rough for the first few tens of metres (a 10 mm blade is under one
// device pixel by ~40 m), so past that the "rough" was reading as fairway with a few
// slivers standing in it. Long grass has to be in the GROUND texture too, or it stops
// being long grass exactly where you can no longer resolve geometry.
//
// Differences from the mown bake, all of them physical:
//   * TILE_M 2.0 (vs 1.0) — a 35-95 mm blade needs room to lie down in the tile, and
//     a 1 m repeat of grass this long is visible as a repeat.
//   * Blades 35-95 mm long (vs 7-20) and 2.0-3.5 mm wide, matching CANOPY_M.rough
//     0.055 / deepRough 0.075 in Terrain.js.
//   * TUFTED, not uniform: rough grows in clumps with thin, thatchy ground between.
//     The clumping is applied to blade DENSITY and LENGTH — never to albedo (see the
//     note in gen_turf_detail.mjs about low-frequency albedo in a tiled map reading as
//     banding). Geometry clumping tiles fine; a painted blotch does not.
//   * Much more lean and curl — unmown grass flops; mown grass is cut to stand up.
//
// Same channel packing and the same no-baked-lighting rule as the mown bake, so the
// two are interchangeable in the shader:
//
//   node scripts/gen_rough_detail.mjs
//
// Writes public/assets/textures/roughdetail_alb.png (sRGB albedo)
//    and public/assets/textures/roughdetail_nrh.png
//        (R,G = normal.xy | B = canopy height | A = canopy AO)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { png } from './lib/png.mjs';

const RES = 2048;
const TILE_M = 2.0;                     // world metres the tile covers
const MM = RES / (TILE_M * 1000);       // texels per millimetre (~1.02)
const BLADES = 105000;

// Mean LINEAR luminance both turf bakes are normalised to. Terrain.js divides the
// sampled luminance by this same constant (TURF_LUM), so if the two maps don't agree
// on it, the ground changes brightness at the mowing line. turfdetail_alb.png measures
// 0.1371 against it.
const TURF_LUM = 0.138;

// Deterministic RNG so re-running gives the identical map.
let _s = 0x2545f491 >>> 0;
const rnd = () => ((_s = (Math.imul(_s, 1664525) + 1013904223) >>> 0) / 4294967296);

// --- palette (sRGB 0-255) ------------------------------------------------
// Rough is the same grass as the fairway but older and drier: it is not cut, so a
// larger fraction of each blade is mature or senescent tissue. Slightly darker and
// noticeably more yellow-spread than the mown palette. The zone tint in the shader
// grades this, so what matters here is the value/structure spread.
const GREEN = [78, 96, 47];
const YELLOW = [148, 136, 74];          // older / sun-bleached blades
const SOIL = [34, 35, 23];              // thatch + shaded ground under the canopy

const size = RES * RES;
const R = new Float32Array(size), G = new Float32Array(size), B = new Float32Array(size);
const NX = new Float32Array(size), NY = new Float32Array(size);
const DEPTH = new Float32Array(size), AO = new Float32Array(size);

// --- tileable value noise ------------------------------------------------
function noiseField(cells) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x, y) => {
    // x,y in texels -> wrapped bilinear sample of the coarse lattice
    const fx = (x / RES) * cells, fy = (y / RES) * cells;
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const tx = fx - i0, ty = fy - j0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const w = (i, j) => g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    const a = w(i0, j0) * (1 - sx) + w(i0 + 1, j0) * sx;
    const b = w(i0, j0 + 1) * (1 - sx) + w(i0 + 1, j0 + 1) * sx;
    return a * (1 - sy) + b * sy;
  };
}
// Keep every authored clump below the footprint that survives into the distance mips.
// The former five-cell field made one lobe roughly 40 cm wide.  Although the atlas was
// seamless, that lobe survived minification and its exact arrangement repeated every
// two metres — an unmistakable stamp across distant rough.  Course-scale variation is
// already non-repeating world-space noise in Terrain.js; this tiled bake should contain
// only the blade/tuft structure that disappears cleanly into its mean when minified.
// Two incommensurate lattices (~12 cm and ~7 cm) retain natural clumping up close
// without leaving a recognizable low-frequency fingerprint in the far mip chain.
const tuftA = noiseField(17);
const tuftB = noiseField(29);
const soilN = noiseField(31);           // fine, soil only — never shows through directly
const tuft = (x, y) => tuftA(x, y) * 0.72 + tuftB(x, y) * 0.28;

// --- background: thatch / soil the canopy sits on ------------------------
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;
    const n = 0.7 + 0.55 * soilN(x, y);
    R[k] = SOIL[0] * n; G[k] = SOIL[1] * n; B[k] = SOIL[2] * n;
    NX[k] = 0; NY[k] = 0;
    DEPTH[k] = 0;
  }
}

// --- paint the blades ----------------------------------------------------
const wrap = (v) => ((v % RES) + RES) % RES;

let painted = 0;
for (let i = 0; i < BLADES; i++) {
  const x0 = rnd() * RES, y0 = rnd() * RES;

  // Tufting by REJECTION, not by moving blades: sample uniformly and keep with a
  // probability driven by the clump field. Blades that survive stay where they landed,
  // so the tufts have soft, irregular boundaries rather than the smooth density
  // gradients a displacement would give. `q` also drives length below — a tuft is
  // taller as well as denser, which is what makes it read as a clump of long grass
  // rather than a patch of extra blades.
  const q = tuft(x0, y0);
  if (rnd() > 0.22 + 0.95 * q) continue;
  painted++;

  const th = rnd() * Math.PI * 2;
  const dx = Math.cos(th), dy = Math.sin(th);
  const px = -dy, py = dx;                       // across-blade axis

  const L = (35 + 60 * rnd() * (0.55 + 0.75 * q)) * MM;   // ~35-95 mm, longer in tufts
  const w = (2.0 + rnd() * 1.5) * MM;            // 2.0-3.5 mm wide
  // Unmown grass flops: much stronger lateral curve than the mown bake's +-0.275, and
  // biased so most blades bend appreciably rather than clustering around straight.
  const bendAmt = (rnd() - 0.5) * 1.6;
  const z = rnd();                               // height in the canopy (depth test)

  // Blade ALBEDO only: pigment varies genuinely blade to blade (age, moisture,
  // chlorophyll). Rough is uncut, so far more of it is mature/senescent than a mown
  // surface — ~18% strongly bleached vs the fairway's 7%.
  const yellowness = rnd() < 0.18 ? 0.35 + 0.45 * rnd() : 0.16 * rnd();
  const m = 0.80 + rnd() * 0.40;
  const cr = (GREEN[0] + (YELLOW[0] - GREEN[0]) * yellowness) * m;
  const cg = (GREEN[1] + (YELLOW[1] - GREEN[1]) * yellowness) * m;
  const cb = (GREEN[2] + (YELLOW[2] - GREEN[2]) * yellowness) * m;

  const steps = Math.max(2, Math.ceil(L));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const bt = bendAmt * L * t * t;
    const cx = x0 + dx * L * t + px * bt;
    const cy = y0 + dy * L * t + py * bt;
    // Long blades taper less over their length than a cut one does — a mown blade is
    // sheared mid-leaf (blunt), an unmown one runs out to its natural point only at
    // the very tip. So: near-parallel sides, then a fast taper in the last third.
    const hw = (w * 0.5) * (1 - Math.pow(t, 3.0) * 0.9);
    if (hw <= 0.05) continue;
    // Tips are genuinely a touch paler/yellower (young tissue + leaf wax) — that's
    // pigment, not shading, so a small albedo lift here is legitimate. Larger than the
    // mown bake's because far more of an uncut blade's length is exposed tip.
    const tipPig = 1.0 + 0.16 * t;
    const span = Math.ceil(hw + 0.5);
    for (let o = -span; o <= span; o++) {
      const cov = Math.min(1, Math.max(0, hw - Math.abs(o) + 0.5));
      if (cov <= 0) continue;
      const k = wrap(Math.round(cy + py * o)) * RES + wrap(Math.round(cx + px * o));
      // Canopy height rises along the blade: a blade lying over is high at its base
      // and its tip drops toward the thatch. This is what the parallax march reads, so
      // it has to describe a real surface, not a flat stamp.
      const zt = z * (1 - 0.35 * t);
      if (zt <= DEPTH[k]) continue;                         // occluded by a higher blade
      const u = Math.max(-1, Math.min(1, o / hw));
      const a = cov;
      R[k] += (cr * tipPig - R[k]) * a;
      G[k] += (cg * tipPig - G[k]) * a;
      B[k] += (cb * tipPig - B[k]) * a;
      // Rounded normal across the blade width — THIS is what makes the blade catch
      // the sun. The shader lights it; nothing here presumes a light direction.
      const nk = 0.85 * u;
      NX[k] += (px * nk - NX[k]) * a;
      NY[k] += (py * nk - NY[k]) * a;
      DEPTH[k] += (zt - DEPTH[k]) * a;
    }
  }
  if ((i & 0x3fff) === 0) process.stdout.write(`\r  blades ${i}/${BLADES}`);
}
process.stdout.write(`\r  blades ${BLADES}/${BLADES} (${painted} kept after tuft rejection)\n`);

// --- canopy AO (measured from the canopy, not painted) -------------------
// A texel is occluded to the degree it sits BELOW the blades around it. Separable
// max-filter over the depth buffer, then occlusion = how far this texel is beneath
// that local ceiling. Real geometric occlusion, so it's valid on ambient — unlike a
// painted gradient, it doesn't assume where the sun is.
//
// The filter radius is the blade-to-blade SPACING, not the canopy height. Set to the
// canopy height (18 mm here) the max-filter window covers ~100 blades, its local ceiling
// pins at ~1.0, and then occlusion = ceiling - depth ≈ 1 - depth for every texel: the
// map stops measuring occlusion and just becomes an inverted height map. Baked that way
// this channel came out mean 0.596 / 10th-percentile 0.235, and since the turf shader
// (correctly) does NOT gate canopy AO by distance, every gap between blades went black
// wherever the 3D blades weren't covering the ground — i.e. the whole mid-field.
// 8 mm is ~3 blade widths, the same 2-3 blade multiple the mown bake uses at its scale.
const AO_R = Math.max(1, Math.round(8 * MM));
{
  const tmp = new Float32Array(size);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      let m = 0;
      for (let o = -AO_R; o <= AO_R; o++) { const v = DEPTH[y * RES + wrap(x + o)]; if (v > m) m = v; }
      tmp[y * RES + x] = m;
    }
  }
  for (let x = 0; x < RES; x++) {
    for (let y = 0; y < RES; y++) {
      let m = 0;
      for (let o = -AO_R; o <= AO_R; o++) { const v = tmp[wrap(y + o) * RES + x]; if (v > m) m = v; }
      AO[y * RES + x] = m;                    // local ceiling
    }
  }
}

// --- luminance normalisation ---------------------------------------------
// Terrain.js normalises the sampled albedo against TURF_LUM before applying the zone
// tint, so a map whose mean sits somewhere else silently rescales the turf's
// brightness — and, since the mown and rough maps meet at the mowing line, a mismatch
// would show up as a step exactly there. Solve for the scalar in LINEAR light (which
// is what the shader's luminance() sees), then re-encode.
const toLin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const toSrgb = (l) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return s * 255;
};
let sumLum = 0;
for (let k = 0; k < size; k++) {
  sumLum += 0.2126 * toLin(R[k]) + 0.7152 * toLin(G[k]) + 0.0722 * toLin(B[k]);
}
const meanLum = sumLum / size;
const gain = TURF_LUM / meanLum;
console.log(`  mean linear luminance ${meanLum.toFixed(4)} -> gain ${gain.toFixed(4)} -> ${TURF_LUM}`);

// --- encode ---------------------------------------------------------------
const alb = Buffer.alloc(size * 3);
const nrh = Buffer.alloc(size * 4);
const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
let checkLum = 0;
for (let k = 0; k < size; k++) {
  // Gain is applied in linear, per channel, so it's a pure exposure change: hue and
  // saturation are untouched.
  const lr = toLin(R[k]) * gain, lg = toLin(G[k]) * gain, lb = toLin(B[k]) * gain;
  checkLum += 0.2126 * Math.min(1, lr) + 0.7152 * Math.min(1, lg) + 0.0722 * Math.min(1, lb);
  alb[k * 3] = cl(toSrgb(Math.min(1, lr)));
  alb[k * 3 + 1] = cl(toSrgb(Math.min(1, lg)));
  alb[k * 3 + 2] = cl(toSrgb(Math.min(1, lb)));
  const occ = Math.max(0, AO[k] - DEPTH[k]);           // depth below the local ceiling
  nrh[k * 4] = cl((NX[k] * 0.5 + 0.5) * 255);
  nrh[k * 4 + 1] = cl((NY[k] * 0.5 + 0.5) * 255);
  nrh[k * 4 + 2] = cl(DEPTH[k] * 255);
  // Same gain and a floor just under the mown bake's 0.22 — long grass does shadow
  // itself a little harder, but only a little. This is a sky-occlusion term multiplying
  // ambient over the WHOLE ground plane, so a heavy hand here reads as black turf, not
  // as depth; the extra darkness of rough belongs in the marched self-shadow (which is
  // distance-gated and view-dependent) and in the deeper CANOPY_M, not in a constant.
  nrh[k * 4 + 3] = cl(Math.max(0.20, 1 - 0.85 * occ) * 255);
}
console.log(`  post-gain mean linear luminance ${(checkLum / size).toFixed(4)} (target ${TURF_LUM})`);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures');
writeFileSync(join(out, 'roughdetail_alb.png'), png(RES, RES, 3, alb));
writeFileSync(join(out, 'roughdetail_nrh.png'), png(RES, RES, 4, nrh));
console.log(`wrote roughdetail_alb.png / roughdetail_nrh.png  (${RES}px = ${TILE_M} m, ${(TILE_M * 1000 / RES).toFixed(2)} mm/texel)`);
