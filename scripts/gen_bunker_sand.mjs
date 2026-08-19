// Generate a real BUNKER SAND texture set: pale, fine-grained, matte-to-faintly-
// sparkly, with soft raked/wind-smoothed structure — NOT the coarse rocky
// gravel/dry-dirt photo (sand_diff/sand_nor_gl/sand_rough.jpg) the bunkers were
// previously bound to. Those three files are a quarry-floor texture: big lumpy
// pebbles, brown, high-contrast — the opposite of what a maintained bunker reads
// as (fine silica/quartz sand, pale off-white to light tan, soft depressions).
//
// v2: the first version painted ~90k discrete circular "grains". At this tile's
// physical scale (~5.2 m — see the `rep = r/2.6` comment below) and 1024 px, a
// real sand grain (well under 1mm) is a small FRACTION of one texel, so
// individually-drawn grains just aliased into dark clover-shaped blobs — it read
// as moss/gravel, not sand. Fixed here by NOT trying to resolve individual
// grains at all: the whole grain-scale look (colour speckle, bump, AO) comes
// from smooth FRACTAL VALUE NOISE at several octaves down to texel scale, which
// stays clean at any tile size because it has no discrete shape to alias.
//
// Same philosophy as scripts/gen_turf_detail.mjs: NO LIGHTING IS BAKED. The
// albedo carries only pigment variation; all shape lives in a HEIGHT FIELD that
// the normal map is derived from via central differences (so the scene's own
// sun does the shading), and occlusion is measured from that same height field
// into its own channel (ambient-only, never the lit face).
//
//   node scripts/gen_bunker_sand.mjs
//
// Writes public/assets/textures/bunker_sand_alb.png  (sRGB albedo)
//    and public/assets/textures/bunker_sand_nrao.png
//        (R,G = normal.xy | B = roughness | A = ambient occlusion)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { png } from './lib/png.mjs';

const RES = 1024;

let _s = 0xc0ffee ^ 0x9e3779b9;
const rnd = () => ((_s = (Math.imul(_s, 1664525) + 1013904223) >>> 0) / 4294967296);

// Tileable value noise (bilinear over a wrapped coarse lattice), identical
// technique to gen_turf_detail.mjs. Returns roughly [0,1].
function noiseField(cells, seed) {
  const g = new Float32Array(cells * cells);
  let s2 = (seed * 2654435761 + 1) >>> 0;
  const r2 = () => ((s2 = (Math.imul(s2, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < g.length; i++) g[i] = r2();
  return (x, y) => {
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

// fBm over several octaves of tileable noise, normalised to roughly [-1, 1].
function makeFbm(cellsList, seedBase) {
  const layers = cellsList.map((cells, i) => noiseField(cells, seedBase + i * 7));
  return (x, y) => {
    let sum = 0, amp = 1, norm = 0;
    for (const layer of layers) {
      sum += (layer(x, y) * 2 - 1) * amp;
      norm += amp;
      amp *= 0.55;
    }
    return sum / norm;
  };
}

// Grain-scale detail: octaves from "clump" (a few cm) down to near-texel scale
// (the finest a 1024px/5.2m tile can carry without just being uncorrelated
// noise) — this IS the sand's grain read, and it stays smooth/continuous so it
// can never alias into blobs the way discrete painted grains did.
const grainFbm = makeFbm([6, 13, 27, 55, 110, 220], 11);
// A slower, larger-scale wave for gentle colour drift (patches of slightly
// different sand — sun-bleached vs. shaded, coarser vs. finer batch).
const drift = noiseField(4, 101);
// Broad soft undulation (very low freq, weak amplitude) so the floor isn't a
// dead-flat plane under raking light.
const duneField = noiseField(3, 211);
// Patchy mask for where raked grooves survive vs. got smoothed by wind/feet.
const rakeMask = noiseField(3, 303);
// Sparse bright "sparkle" grains (quartz catching the light) and rarer dark
// mineral flecks — thresholded high-frequency noise, kept SMALL and sparse so
// they read as individual catch-lights, not a pattern.
const sparkleField = noiseField(340, 401);
const fleckField = noiseField(210, 501);

const size = RES * RES;
const wrap = (v) => ((v % RES) + RES) % RES;

// --- palette (sRGB 0-255) -------------------------------------------------
// Pale, warm, fine bunker sand — matched close to the terrain's own (darkened)
// sand tint (Terrain.js: `sc = surface('sand').color * 0.78`) so the overlay
// and the ground it sits on read as one material.
const BASE = [214, 196, 158];     // typical warm sand
const LIGHT = [232, 219, 187];    // sun-catching high grain
const SPARKLE = [246, 240, 222];  // bright quartz catch-light (sparse)
const FLECK = [140, 118, 84];     // darker mineral fleck (sparse, still warm — not black)

const R = new Float32Array(size), G = new Float32Array(size), B = new Float32Array(size);
const ROUGH = new Float32Array(size);
const H = new Float32Array(size);          // shared height field for the normal + AO

for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;

    // Grain-scale brightness variation (fine, continuous — this is "the sand").
    const g = grainFbm(x, y);                          // -1..1
    const lift = Math.max(0, g) * 0.6;                  // brighten on the high side only
    const shade = Math.max(0, -g) * 0.35;                // shallow darkening on the low side
    let cr = BASE[0], cg = BASE[1], cb = BASE[2];
    cr += (LIGHT[0] - BASE[0]) * lift; cg += (LIGHT[1] - BASE[1]) * lift; cb += (LIGHT[2] - BASE[2]) * lift;
    cr *= (1 - shade * 0.4); cg *= (1 - shade * 0.4); cb *= (1 - shade * 0.4);

    // Slow colour drift — big soft patches, +/-6%.
    const d = 0.94 + 0.12 * drift(x, y);
    cr *= d; cg *= d; cb *= d;

    // Sparse bright sparkle grains: only the top ~1.5% of a fine noise field.
    const sp = sparkleField(x, y);
    if (sp > 0.985) {
      const t = (sp - 0.985) / 0.015;
      cr += (SPARKLE[0] - cr) * t; cg += (SPARKLE[1] - cg) * t; cb += (SPARKLE[2] - cb) * t;
      ROUGH[k] = 0.4 - 0.15 * t;
    } else {
      ROUGH[k] = 0.88 + 0.08 * Math.max(0, g);
    }
    // Sparser dark mineral flecks (~1%), warm-dark not black.
    const fl = fleckField(x, y);
    if (fl > 0.99) {
      const t = (fl - 0.99) / 0.01;
      cr += (FLECK[0] - cr) * t * 0.8; cg += (FLECK[1] - cg) * t * 0.8; cb += (FLECK[2] - cb) * t * 0.8;
    }

    R[k] = cr; G[k] = cg; B[k] = cb;

    // Height field: dominant fine grain texture (small amplitude — subtle
    // granular relief, not embossed), plus broad undulation. Rake grooves are
    // added in a second pass below (they need a rotated coordinate frame).
    H[k] = g * 0.5 + duneField(x, y) * 0.35;
  }
}

// --- patchy raked grooves ---------------------------------------------------
// Long, faint, slightly wavy parallel ridges — a rake dragged through the sand
// — masked so some patches read freshly raked and others read smoothed. Kept
// LOW amplitude relative to the grain noise: texture, not corduroy.
const RAKE_ANGLE = 0.35;
const ca = Math.cos(RAKE_ANGLE), sa = Math.sin(RAKE_ANGLE);
const RAKE_PERIOD_PX = 130;                  // groove-to-groove spacing in texels
const rakeFreq = (2 * Math.PI) / RAKE_PERIOD_PX;
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;
    const across = -x * sa + y * ca;
    const bend = (drift(x * 0.5, y * 0.5) - 0.5) * 40;
    const groove = Math.sin((across + bend) * rakeFreq);
    const mask = Math.max(0, rakeMask(x, y) - 0.4) / 0.6;
    H[k] += groove * mask * 0.16;
  }
}

// --- AO: geometric occlusion measured from the height field ----------------
const AO = new Float32Array(size);
const AO_R = 3;
{
  const tmp = new Float32Array(size);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      let m = -Infinity;
      for (let o = -AO_R; o <= AO_R; o++) { const v = H[y * RES + wrap(x + o)]; if (v > m) m = v; }
      tmp[y * RES + x] = m;
    }
  }
  for (let x = 0; x < RES; x++) {
    for (let y = 0; y < RES; y++) {
      let m = -Infinity;
      for (let o = -AO_R; o <= AO_R; o++) { const v = tmp[wrap(y + o) * RES + x]; if (v > m) m = v; }
      const occ = Math.max(0, m - H[y * RES + x]);
      AO[y * RES + x] = Math.max(0.6, 1 - 0.55 * occ);
    }
  }
}

// --- normal from the height field (central differences) --------------------
const NX = new Float32Array(size), NY = new Float32Array(size);
const BUMP = 1.1;   // subordinate to the carved terrain geometry — texture, not relief
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;
    const hL = H[y * RES + wrap(x - 1)], hR = H[y * RES + wrap(x + 1)];
    const hD = H[wrap(y - 1) * RES + x], hU = H[wrap(y + 1) * RES + x];
    NX[k] = (hL - hR) * BUMP;
    NY[k] = (hD - hU) * BUMP;
  }
}

// --- encode ------------------------------------------------------------------
const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const alb = Buffer.alloc(size * 3);
const nrao = Buffer.alloc(size * 4);
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    const k = y * RES + x;
    alb[k * 3] = cl(R[k]); alb[k * 3 + 1] = cl(G[k]); alb[k * 3 + 2] = cl(B[k]);
    const nx = NX[k], ny = NY[k];
    const len2 = nx * nx + ny * ny;
    const nz = Math.sqrt(Math.max(0, 1 - Math.min(0.98, len2)));
    const invLen = 1 / Math.hypot(nx, ny, nz || 1);
    nrao[k * 4] = cl((nx * invLen * 0.5 + 0.5) * 255);
    nrao[k * 4 + 1] = cl((ny * invLen * 0.5 + 0.5) * 255);
    nrao[k * 4 + 2] = cl(Math.min(1, ROUGH[k]) * 255);
    nrao[k * 4 + 3] = cl(AO[k] * 255);
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures');
writeFileSync(join(out, 'bunker_sand_alb.png'), png(RES, RES, 3, alb));
writeFileSync(join(out, 'bunker_sand_nrao.png'), png(RES, RES, 4, nrao));
console.log('wrote bunker_sand_alb.png + bunker_sand_nrao.png to', out);
