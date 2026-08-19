// Bake one small, seamless, lighting-neutral pond detail texture.
//
// R,G = signed capillary-wave slope encoded from [-1,1] to [0,255]
// B   = sparse crest breakup (used only to modulate shoreline/impact foam)
// A   = finer independent crest breakup for the rotated second sample
//
// Every source wave has an integer period across the tile, so opposite edges are
// identical. There is no albedo or baked light: the production material's shared
// sun/sky and analytic macro normal remain authoritative.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from './lib/png.mjs';

const RES = 256;
const TAU = Math.PI * 2;
const WAVES = [
  [1, 3, 0.34, 0.1], [2, -5, 0.24, 1.7], [4, 3, 0.18, 4.1],
  [5, -7, 0.13, 2.6], [8, 5, 0.09, 5.3], [11, -9, 0.06, 3.4],
];
const FINE = [
  [3, 7, 0.42, 0.8], [7, -4, 0.28, 3.7], [11, 8, 0.18, 5.8],
  [13, -11, 0.12, 2.1],
];

function field(u, v, waves) {
  let h = 0, dx = 0, dy = 0, weight = 0;
  for (const [kx, ky, amplitude, phase] of waves) {
    const angle = TAU * (kx * u + ky * v) + phase;
    h += Math.sin(angle) * amplitude;
    dx += Math.cos(angle) * amplitude * kx;
    dy += Math.cos(angle) * amplitude * ky;
    weight += amplitude;
  }
  return { h: h / weight, dx: dx * 0.075, dy: dy * 0.075 };
}

const bytes = Buffer.alloc(RES * RES * 4);
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    // Sample pixel centres. Repeat sampling joins at the mathematical tile edge;
    // mipmaps retain that continuity because all components are periodic.
    const u = (x + 0.5) / RES;
    const v = (y + 0.5) / RES;
    const broad = field(u, v, WAVES);
    const fine = field(u, v, FINE);
    const crest = Math.max(0, Math.min(1, (broad.h - 0.04) * 1.85));
    const fineCrest = Math.max(0, Math.min(1, (fine.h - 0.10) * 2.0));
    const i = (y * RES + x) * 4;
    bytes[i] = clampByte((Math.max(-1, Math.min(1, broad.dx)) * 0.5 + 0.5) * 255);
    bytes[i + 1] = clampByte((Math.max(-1, Math.min(1, broad.dy)) * 0.5 + 0.5) * 255);
    bytes[i + 2] = clampByte(Math.pow(crest, 1.45) * 255);
    bytes[i + 3] = clampByte(Math.pow(fineCrest, 1.65) * 255);
  }
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures');
const outPath = join(outDir, 'water_detail_rgba.png');
writeFileSync(outPath, png(RES, RES, 4, bytes));
console.log(`wrote ${outPath} (${RES}x${RES}, seamless RG slope + BA crest breakup)`);
