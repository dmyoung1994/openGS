import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('shot tracer persists until the next actual launch boundary', async () => {
  const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
  const hitStart = main.indexOf('function hit(');
  const hitEnd = main.indexOf('// Main update.', hitStart);
  const hit = main.slice(hitStart, hitEnd);
  assert.match(hit, /tracer\.promoteActiveToWhite\(\);[\s\S]*?tracer\.reset\(\);[\s\S]*?ball\.launch\(params\);/,
    'the completed shot must become white immediately before the next real launch');
  assert.match(hit, /ball\.launch\(params\);[\s\S]*?tracer\.push\(ball\.start\);/,
    'the new active tracer must begin at the launch point');
  assert.equal((main.match(/tracer\.reset\(\)/g) || []).length, 1,
    'address return, rest, and camera transitions must never clear the completed tracer');
  assert.match(main, /tracer\.clearHistory\(\)/,
    'course rebuilds must clear shot history so paths cannot cross course lifetimes');
  assert.match(main, /if \(tracer\.count < tracer\.max\) tracer\.push\(b\.position\)/,
    'the terminal rest sample must be captured before the active stream is hidden');
  assert.doesNotMatch(main, /tracer\.fade\(/,
    'completed shot history must not expire while waiting for the next shot');
});

test('tracer uses a restrained neutral-green flight ribbon and white history', async () => {
  const tracer = await readFile(new URL('src/scene/Tracer.js', ROOT), 'utf8');
  assert.match(tracer, /const SUBDIVISIONS = 8/,
    'the persistent curve needs a smooth bounded longitudinal tessellation');
  assert.match(tracer, /tangentScreenLength\.greaterThan\(0\.0001\)\.select\([\s\S]*?vec2\(1\.0, 0\.0\)/,
    'near-end-on chase views need a finite screen-space width fallback');
  assert.match(tracer, /clipTangent\.xy\.mul\(clip\.w\)\.sub\(clip\.xy\.mul\(clipTangent\.w\)\)/,
    'ribbon orientation must include perspective projection at oblique camera angles');
  assert.match(tracer, /const LIVE_TRACER_WIDTH_PIXELS = 5\.2/);
  assert.match(tracer, /uRibbonPixels = uniform\(LIVE_TRACER_WIDTH_PIXELS\)/,
    'the live broadcast ribbon must remain narrow at native output');
  assert.match(tracer, /trailNeutral[\s\S]*?flightGreen/,
    'the live ribbon must move from a quiet neutral trail into one restrained green leading edge');
  assert.match(tracer, /const LIVE_TRACER_OPACITY = 0\.78/);
  assert.match(tracer, /uOpacity = uniform\(LIVE_TRACER_OPACITY\)/,
    'the live tracer must remain translucent instead of reading as a luminous arcade beam');
  assert.match(tracer, /const HISTORY_TRACER_WIDTH_PIXELS = 2\.2/);
  assert.match(tracer, /uRibbonPixels = uniform\(HISTORY_TRACER_WIDTH_PIXELS\)/,
    'historical ribbons must recede below the active tracer width');
  assert.match(tracer, /reset\(\)[\s\S]*?this\.uOpacity\.value = LIVE_TRACER_OPACITY/,
    'the actual launch reset must not override the filtered result-ribbon opacity');
  assert.match(tracer, /headProfile[\s\S]*?smoothstep\(0\.62, 0\.96, along\)/,
    'the trajectory must narrow gradually toward the ball instead of ending as a blunt laser');
  assert.match(tracer, /vSide[\s\S]*?setInterpolation\('linear', 'centroid'\)/,
    'screen-space coverage coordinates must not perspective-warp across oblique triangles');
  assert.match(tracer, /alongFootprint = vAlong\.fwidth\(\)\.abs\(\)[\s\S]*?tailFeather[\s\S]*?headFeather/,
    'tail and head tapers must expand to the current pixel footprint under minification');
  assert.match(tracer, /edgeFeather = vSide\.fwidth\(\)\.abs\(\)\.mul\(0\.75\)\.clamp\(0\.08, 1\.0\)/,
    'the ribbon silhouette must use derivative-aware analytic coverage under rotation');
  assert.match(tracer, /edgeCoverage = smoothstep\(0\.0, edgeFeather, edge\)/,
    'analytic coverage must replace the former fixed-width edge threshold');
  assert.match(tracer, /class HistoricalTracer/,
    'completed shots must use a separate static stream instead of resetting the active buffer');
  assert.match(tracer, /this\._history = \[\]/,
    'the tracer must retain explicit completed-shot history');
  assert.match(tracer, /maxHistory = 16/,
    'historical shots must have a bounded lifetime by count rather than an opacity timer');
  assert.match(tracer, /promoteActiveToWhite\(\)/,
    'the launch boundary must promote the previous active shot to white');
  assert.match(tracer, /vec3\(1\.0, 1\.0, 1\.0\)/,
    'historical shot paths must render white');
  assert.match(tracer, /while \(this\._history\.length > this\.maxHistory\)/,
    'oldest historical paths must be evicted deterministically at the cap');
  assert.doesNotMatch(tracer, /AdditiveBlending|fade\(dt\)|HaloPixels|CorePixels|warmIvory|flightGold|deepBroadcastBlue/,
    'the tracer must have no bloom stack, pale core, or automatic expiry path');
});
