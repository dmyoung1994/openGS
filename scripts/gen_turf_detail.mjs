// Generate the NEAR-FIELD mown-turf detail maps: a tileable albedo + normal/height
// set that actually contains individual grass blades.
//
// Why this exists: the broad bentgrass bake tiles every 1.8 m at 1024 px = 1.76 mm
// per texel. A real bentgrass blade is ~1.5 mm wide, i.e. ONE texel — so that map
// can only ever be isotropic green fuzz, which is exactly what the fairway looked
// like up close. This map covers TILE_M (1 m) at RES (2048) = ~0.49 mm/texel, so a
// blade is 3-4 texels wide and 20-50 long and reads as a blade.
//
// It's drawn, not noised: ~215k tapered, slightly curved blades are painted with a
// depth buffer, so blades genuinely overlap and occlude each other the way a mown
// canopy does. Per-texel coverage anti-aliases the edges.
//
// NO LIGHTING IS BAKED. The albedo carries only real albedo variation (per-blade
// pigment/age, clumping) — the across-blade rounding goes in the NORMAL map so the
// scene's actual sun direction produces the sheen (and it moves when the sun does),
// and canopy occlusion goes in a separate AO channel that only attenuates ambient.
// Baking either into the base color would double-count against the shader's light.
//
//   node scripts/gen_turf_detail.mjs
//
// Writes public/assets/textures/turfdetail_alb.png (sRGB albedo)
//    and public/assets/textures/turfdetail_nrh.png
//        (R,G = normal.xy | B = canopy height | A = canopy AO)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { png } from './lib/png.mjs';

const RES = 2048;
const TILE_M = 1.0;                     // world metres the tile covers
const MM = RES / (TILE_M * 1000);       // texels per millimetre (~2.05)
const BLADES = 215000;

// Deterministic RNG so re-running gives the identical map.
let _s = 0x9e3779b9 >>> 0;
const rnd = () => ((_s = (Math.imul(_s, 1664525) + 1013904223) >>> 0) / 4294967296);

// --- palette (sRGB 0-255) ------------------------------------------------
// Matched to a photographed sunlit fairway: DESATURATED and YELLOW-shifted, not
// the pure saturated green a naive "grass green" gives. The zone tint in the
// shader grades this, so what matters here is the value/structure spread.
const GREEN = [86, 105, 52];
const YELLOW = [143, 134, 71];          // older / sun-bleached blades
const SOIL = [41, 42, 27];              // thatch + shaded ground under the canopy

const size = RES * RES;
const R = new Float32Array(size), G = new Float32Array(size), B = new Float32Array(size);
const NX = new Float32Array(size), NY = new Float32Array(size);
const DEPTH = new Float32Array(size), AO = new Float32Array(size);

// --- tileable value noise (for clumping) ---------------------------------
function noiseField(cells, seed) {
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
    return a * (1 - sy) + b * sy + seed * 0;
  };
}
// Turf varies at the BLADE scale and at the MOW scale (metres) — almost nothing in
// between. Noise in the 10-30 cm band is what reads as camouflage blotching, so the
// albedo clump is kept large (~33 cm) and very weak; the fine field is only used to
// break up the soil underneath, where it never shows through directly.
const clumpA = noiseField(3, 0);        // ~33 cm, weak
const clumpB = noiseField(19, 1);       // ~5 cm, soil only

// --- background: thatch / soil the canopy sits on ------------------------
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;
    const n = 0.72 + 0.5 * clumpB(x, y);
    R[k] = SOIL[0] * n; G[k] = SOIL[1] * n; B[k] = SOIL[2] * n;
    NX[k] = 0; NY[k] = 0;
    DEPTH[k] = 0;
  }
}

// --- paint the blades ----------------------------------------------------
const wrap = (v) => ((v % RES) + RES) % RES;

for (let i = 0; i < BLADES; i++) {
  const x0 = rnd() * RES, y0 = rnd() * RES;
  // Near-isotropic orientation with a mild axis bias: the map is sampled in world
  // XZ under mowing stripes that run either way, so it must not carry a strong
  // baked-in grain of its own.
  const th = rnd() * Math.PI * 2 + (rnd() - 0.5) * 0.0;
  const dx = Math.cos(th), dy = Math.sin(th);
  const px = -dy, py = dx;                       // across-blade axis

  const L = (7 + rnd() * 13) * MM;               // 7-20 mm — mown, not meadow
  const w = (1.1 + rnd() * 1.2) * MM;            // 1.1-2.3 mm wide
  const bendAmt = (rnd() - 0.5) * 0.55;          // lateral curve, fraction of L
  const z = rnd();                               // height in the canopy (depth test)

  // Blade ALBEDO only: pigment varies genuinely blade to blade (age, moisture,
  // chlorophyll), and ~7% are sun-bleached. No light term here — depth drives the
  // AO channel instead, and blade curvature drives the normal.
  const yellowness = rnd() < 0.07 ? 0.30 + 0.35 * rnd() : 0.12 * rnd();
  const m = 0.84 + rnd() * 0.34;
  const cr = (GREEN[0] + (YELLOW[0] - GREEN[0]) * yellowness) * m;
  const cg = (GREEN[1] + (YELLOW[1] - GREEN[1]) * yellowness) * m;
  const cb = (GREEN[2] + (YELLOW[2] - GREEN[2]) * yellowness) * m;

  const steps = Math.max(2, Math.ceil(L));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const bt = bendAmt * L * t * t;
    const cx = x0 + dx * L * t + px * bt;
    const cy = y0 + dy * L * t + py * bt;
    const hw = (w * 0.5) * (1 - Math.pow(t, 1.6) * 0.82);   // taper to the tip
    if (hw <= 0.05) continue;
    // Tips are genuinely a touch paler/yellower (young tissue + leaf wax) — that's
    // pigment, not shading, so a small albedo lift here is legitimate.
    const tipPig = 1.0 + 0.10 * t;
    const span = Math.ceil(hw + 0.5);
    for (let o = -span; o <= span; o++) {
      const cov = Math.min(1, Math.max(0, hw - Math.abs(o) + 0.5));
      if (cov <= 0) continue;
      const k = wrap(Math.round(cy + py * o)) * RES + wrap(Math.round(cx + px * o));
      if (z <= DEPTH[k]) continue;                          // occluded by a higher blade
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
      DEPTH[k] += (z - DEPTH[k]) * a;
    }
  }
  if ((i & 0x3fff) === 0) process.stdout.write(`\r  blades ${i}/${BLADES}`);
}
process.stdout.write(`\r  blades ${BLADES}/${BLADES}\n`);

// --- canopy AO (measured from the canopy, not painted) -------------------
// A texel is occluded to the degree it sits BELOW the blades around it. Separable
// max-filter over the depth buffer at ~4 mm (the blade-to-blade shadowing scale),
// then occlusion = how far this texel is beneath that local ceiling. This is real
// geometric occlusion, so it's valid to apply to ambient — unlike a painted
// gradient, it doesn't assume where the sun is.
const AO_R = Math.max(1, Math.round(4 * MM));
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

// --- clump grading + encode ----------------------------------------------
const alb = Buffer.alloc(size * 3);
const nrh = Buffer.alloc(size * 4);
const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;
    // NO low-frequency variation in the albedo. It used to carry a gentle clump term,
    // and that was wrong in principle: this texture TILES, so anything low-frequency
    // in it repeats on a fixed grid and reads as regular banding across the ground —
    // which is exactly what kept being mistaken for mow stripes. Worse, the clump was
    // value noise on a 3x3 lattice, which is axis-aligned by construction.
    //
    // Large-scale turf variation belongs in WORLD space, not in a tiled tile: the
    // shader already applies multi-metre MaterialX drift (m1/m2) that can't repeat.
    // A tiled map should only ever carry detail finer than its own tile.
    const c = 1.0;
    alb[k * 3] = cl(R[k] * c);
    alb[k * 3 + 1] = cl(G[k] * c);
    alb[k * 3 + 2] = cl(B[k] * c);
    const occ = Math.max(0, AO[k] - DEPTH[k]);           // depth below the local ceiling
    nrh[k * 4] = cl((NX[k] * 0.5 + 0.5) * 255);
    nrh[k * 4 + 1] = cl((NY[k] * 0.5 + 0.5) * 255);
    nrh[k * 4 + 2] = cl(DEPTH[k] * 255);
    nrh[k * 4 + 3] = cl(Math.max(0.22, 1 - 0.85 * occ) * 255);
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures');
writeFileSync(join(out, 'turfdetail_alb.png'), png(RES, RES, 3, alb));
writeFileSync(join(out, 'turfdetail_nrh.png'), png(RES, RES, 4, nrh));
console.log(`wrote turfdetail_alb.png / turfdetail_nrh.png  (${RES}px = ${TILE_M} m, ${(TILE_M * 1000 / RES).toFixed(2)} mm/texel)`);
