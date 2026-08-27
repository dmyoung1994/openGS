// Bake the one seamless, lighting-neutral water detail shared by ponds and ocean.
//
// R,G = signed capillary-wave slope encoded from [-1,1] to [0,255]
// B   = broad sediment/depth variation (never a crest mask)
// A   = restrained crest breakup for foam/transient response only
//
// Every source wave has an integer period across the tile, so opposite edges are
// identical. There is no albedo or baked light: the production material's shared
// sun/sky and analytic macro normal remain authoritative.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from './lib/png.mjs';

const RES = 1024;
const TAU = Math.PI * 2;

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function modes(seed, count, minFrequency, maxFrequency, falloff) {
  const random = rng(seed);
  const result = [];
  const used = new Set();
  while (result.length < count) {
    const kx = Math.floor(minFrequency + random() * (maxFrequency - minFrequency + 1));
    const kyMagnitude = Math.floor(minFrequency + random() * (maxFrequency - minFrequency + 1));
    const ky = random() < 0.5 ? -kyMagnitude : kyMagnitude;
    const key = `${kx},${ky}`;
    // Every train is oblique. Distinct integer vectors keep the tile seamless
    // while preventing a repeated horizontal/vertical or single-angle family.
    if (kx === Math.abs(ky) || used.has(key)) continue;
    used.add(key);
    const frequency = Math.hypot(kx, ky);
    result.push([kx, ky, Math.pow(frequency, -falloff) * (0.78 + random() * 0.44), random() * TAU]);
  }
  return result;
}

const CAPILLARY = modes(0x77617665, 36, 2, 47, 1.05);
const CRESTS = modes(0x63726573, 18, 5, 31, 0.92);
const SEDIMENT = modes(0x73656469, 14, 1, 9, 1.32);

function field(u, v, waves) {
  let h = 0, dx = 0, dy = 0, weight = 0;
  for (const [kx, ky, amplitude, phase] of waves) {
    const angle = TAU * (kx * u + ky * v) + phase;
    h += Math.sin(angle) * amplitude;
    dx += Math.cos(angle) * amplitude * kx;
    dy += Math.cos(angle) * amplitude * ky;
    weight += amplitude;
  }
  return { h: h / weight, dx: dx / weight, dy: dy / weight };
}

const bytes = Buffer.alloc(RES * RES * 4);
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
for (let y = 0; y < RES; y++) {
  for (let x = 0; x < RES; x++) {
    // Sample pixel centres. Repeat sampling joins at the mathematical tile edge;
    // mipmaps retain that continuity because all components are periodic.
    const u = (x + 0.5) / RES;
    const v = (y + 0.5) / RES;
    const capillary = field(u, v, CAPILLARY);
    const crestField = field(u, v, CRESTS);
    const sedimentField = field(u, v, SEDIMENT);
    const slopeScale = 0.052;
    const sediment = Math.max(0, Math.min(1,
      0.5 + sedimentField.h * 0.28 + capillary.h * 0.035));
    const crest = Math.max(0, Math.min(1, (crestField.h - 0.22) * 1.38));
    const i = (y * RES + x) * 4;
    bytes[i] = clampByte((Math.max(-1, Math.min(1, capillary.dx * slopeScale)) * 0.5 + 0.5) * 255);
    bytes[i + 1] = clampByte((Math.max(-1, Math.min(1, capillary.dy * slopeScale)) * 0.5 + 0.5) * 255);
    bytes[i + 2] = clampByte(sediment * 255);
    bytes[i + 3] = clampByte(Math.pow(crest, 1.7) * 160);
  }
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures');
const outPath = join(outDir, 'water_detail_rgba.png');
writeFileSync(outPath, png(RES, RES, 4, bytes));
console.log(`wrote ${outPath} (${RES}x${RES}, seamless RG slope + B sediment + A crest breakup)`);
