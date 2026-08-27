import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodePNG } from '../scripts/lib/png.mjs';

const ROOT = new URL('../', import.meta.url);

function coarseLumaCv({ width, height, channels, pixels }, blocks = 8) {
  assert.equal(width % blocks, 0);
  assert.equal(height % blocks, 0);
  const cellW = width / blocks;
  const cellH = height / blocks;
  const values = [];
  // A regular 32 × 32 sample inside each coarse cell is enough to measure the mip
  // footprint without making the unit suite scan every source texel.
  const stepX = Math.max(1, Math.floor(cellW / 32));
  const stepY = Math.max(1, Math.floor(cellH / 32));
  for (let cellY = 0; cellY < blocks; cellY++) {
    for (let cellX = 0; cellX < blocks; cellX++) {
      let sum = 0;
      let count = 0;
      for (let y = cellY * cellH; y < (cellY + 1) * cellH; y += stepY) {
        for (let x = cellX * cellW; x < (cellX + 1) * cellW; x += stepX) {
          const offset = (y * width + x) * channels;
          sum += 0.2126 * pixels[offset]
            + 0.7152 * pixels[offset + 1]
            + 0.0722 * pixels[offset + 2];
          count++;
        }
      }
      values.push(sum / count);
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

test('rough bake has no coarse tonal stamp for the distance mip chain', async () => {
  const bytes = await readFile(new URL('public/assets/textures/roughdetail_alb.png', ROOT));
  const cv = coarseLumaCv(decodePNG(bytes), 8);
  // Eight cells across a two-metre atlas measures the 25 cm footprint that exposed
  // the old five-lobe tuft field. Keep that footprint below 3% variation so its exact
  // arrangement cannot survive minification as a recognizable two-metre repeat.
  assert.ok(cv < 0.03, `rough 25 cm coarse-cell luminance CV ${(cv * 100).toFixed(2)}% must stay below 3%`);
});

test('distance turf resolves the native atlas instead of enlarging a repeated copy', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.doesNotMatch(source, /T\s*\*\s*4\.0/, 'an enlarged detail-map copy reintroduces a visible distance period');
  assert.match(source, /const unresolved = smoothstep\(4\.5, 7\.0, lod\)/);
  assert.match(source, /mix\(pigment, pigmentMean, unresolved\)/,
    'unresolved material must converge on its own physical pigment instead of a repeated atlas motif');
});
