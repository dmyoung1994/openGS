import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Noise } from '../src/util/noise.js';

const source = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');
const landformStart = source.indexOf('export function courseLandformHeight');
const landformEnd = source.indexOf('function featureBounds', landformStart);
assert.ok(landformStart >= 0 && landformEnd > landformStart, 'Range must expose its structural landform for physics tests');
const landformModule = await import(`data:text/javascript;base64,${Buffer.from(source.slice(landformStart, landformEnd)).toString('base64')}`);
const noise = new Noise(1128746828);
const height = (x, z) => landformModule.courseLandformHeight(noise, x, z);

test('course landform is deterministic, aperiodic, and collision-authoritative', () => {
  for (const point of [[0, 2], [-30, -80], [22, -137], [40, -220], [-55, -305]]) {
    assert.equal(height(...point), height(...point));
  }
  assert.match(source, /let h = courseLandformHeight\(this\.noise, x, z\)/,
    'Range physics/render height must consume the structural form directly');
  const structural = source.slice(landformStart, landformEnd);
  assert.doesNotMatch(structural, /Math\.sin\(\s*[xz]|Math\.tan\(\s*[xz]|%/,
    'structural terrain must not become periodic sine ridges or a repeating modulo pattern');
});

test('lateral drainage and offset benches produce legible meso relief', () => {
  const mid = [-50, -30, -10, 10, 22, 35, 55].map((x) => height(x, -110));
  assert.ok(Math.max(...mid) - Math.min(...mid) > 1.5,
    'mid-fairway crossfall needs more than 1.5m of broad structural relief');
  assert.ok(height(22, -110) < height(-30, -110) - 1.5,
    'the offset drainage basin must sit visibly below the left bench');
  assert.ok(height(55, -190) > height(10, -190) + 1.2,
    'the down-range right bench must reverse the earlier left-side hierarchy');
});

test('maintained corridor slope and curvature remain playable', () => {
  const step = 0.6;
  let maxSlope = 0;
  let maxCurvature = 0;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let z = -324; z <= -18; z += 3) {
    const halfWidth = Math.min(64, 32 + (-z) * 0.11);
    for (let x = -halfWidth; x <= halfWidth; x += 3) {
      const center = height(x, z);
      const dx = (height(x + step, z) - height(x - step, z)) / (2 * step);
      const dz = (height(x, z + step) - height(x, z - step)) / (2 * step);
      const curvature = Math.abs(height(x + step, z) + height(x - step, z)
        + height(x, z + step) + height(x, z - step) - 4 * center) / (step * step);
      maxSlope = Math.max(maxSlope, Math.hypot(dx, dz));
      maxCurvature = Math.max(maxCurvature, curvature);
      minHeight = Math.min(minHeight, center);
      maxHeight = Math.max(maxHeight, center);
    }
  }
  assert.ok(maxHeight - minHeight > 3.0, 'course needs several metres of coherent playable relief');
  assert.ok(maxSlope < 0.085, `maintained slope must stay below 8.5%; measured ${(maxSlope * 100).toFixed(2)}%`);
  assert.ok(maxCurvature < 0.016, `landform curvature must avoid ball-deflecting kinks; measured ${maxCurvature}`);
});

test('tee remains level and greens receive no independent pads', () => {
  assert.match(source, /const teeFlat = Math\.exp[\s\S]*?h = h \* \(1 - teeFlat\) \+ 0\.02 \* teeFlat/,
    'the hitting area must still blend to one level datum');
  const greenStart = source.indexOf('// Greens inherit the continuous course landform');
  const greenEnd = source.indexOf('// Carve each bunker', greenStart);
  assert.doesNotMatch(source.slice(greenStart, greenEnd), /signedDistanceToFeature|Math\.hypot|smoothstep/,
    'greens must inherit the shared landform without radial pads or rings');
});
