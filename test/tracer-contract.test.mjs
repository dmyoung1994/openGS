import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('shot tracer persists until the next actual launch boundary', async () => {
  const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
  const hitStart = main.indexOf('function hit(');
  const hitEnd = main.indexOf('// Main update.', hitStart);
  const hit = main.slice(hitStart, hitEnd);
  assert.match(hit, /tracer\.promoteActiveToWhite\(\);[\s\S]*?tracer\.reset\(\);[\s\S]*?ball\.launch\(worldParams\);/,
    'the completed shot must become white immediately before the next real launch');
  assert.match(hit, /ball\.launch\(worldParams\);[\s\S]*?tracer\.push\(ball\.start\);/,
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

test('tracer uses solid white flight and history ribbons with antialiased edges', async () => {
  const tracer = await readFile(new URL('src/scene/Tracer.js', ROOT), 'utf8');
  assert.match(tracer, /const SUBDIVISIONS = 8/,
    'the persistent curve needs a smooth bounded longitudinal tessellation');
  assert.match(tracer, /tangentScreenLength\.greaterThan\(0\.0001\)\.select\([\s\S]*?vec2\(1\.0, 0\.0\)/,
    'near-end-on chase views need a finite screen-space width fallback');
  assert.match(tracer, /clipTangent\.xy\.mul\(clip\.w\)\.sub\(clip\.xy\.mul\(clipTangent\.w\)\)/,
    'ribbon orientation must include perspective projection at oblique camera angles');
  assert.match(tracer, /const LIVE_TRACER_WIDTH_PIXELS = 5\.2/);
  assert.match(tracer, /liveWidthPixels = LIVE_TRACER_WIDTH_PIXELS/,
    'the live broadcast ribbon must remain narrow at native output by default');
  assert.match(tracer, /const color = ribbonColor \?\? vec3\(1\.0, 1\.0, 1\.0\)/,
    'ribbons must be solid white without a colored head unless a tint is supplied');
  assert.match(tracer, /const LIVE_TRACER_OPACITY = 1\.0/);
  assert.match(tracer, /const HISTORY_TRACER_OPACITY = 1\.0/);
  assert.match(tracer, /uOpacity = uniform\(LIVE_TRACER_OPACITY\)/,
    'the live tracer body must remain opaque');
  assert.match(tracer, /const HISTORY_TRACER_WIDTH_PIXELS = 2\.2/);
  assert.match(tracer, /uRibbonPixels = uniform\(ribbonPixels \?\? HISTORY_TRACER_WIDTH_PIXELS\)/,
    'historical ribbons must recede below the active tracer width by default');
  assert.match(tracer, /reset\(\)[\s\S]*?this\.uOpacity\.value = LIVE_TRACER_OPACITY/,
    'the actual launch reset must not override the filtered result-ribbon opacity');
  assert.match(tracer, /headProfile[\s\S]*?smoothstep\(0\.62, 0\.96, along\)/,
    'the trajectory must narrow gradually toward the ball instead of ending as a blunt laser');
  assert.match(tracer, /vOffsetPx = varying\(side\.mul\(geometryHalfPx\)[\s\S]*?setInterpolation\('linear', 'centroid'\)/,
    'screen-space coverage coordinates must not perspective-warp across oblique triangles');
  assert.match(tracer, /alongFootprint = vAlong\.fwidth\(\)\.abs\(\)[\s\S]*?tailFeather[\s\S]*?headFeather/,
    'tail and head tapers must expand to the current pixel footprint under minification');
  assert.match(tracer, /const COVERAGE_SKIRT_PIXELS = 1\.0/);
  assert.match(tracer, /geometryHalfPx = visualHalfPx\.add\(COVERAGE_SKIRT_PIXELS\)/,
    'the ribbon must rasterize past the drawn width so its coverage ramp is interior; '
    + 'a quad ending where coverage ends can only produce a hard rasterized silhouette');
  assert.match(tracer, /edgeCoverage = vHalfPx\.add\(0\.5\)\.sub\(vOffsetPx\.abs\(\)\)[\s\S]*?\.min\(vHalfPx\.mul\(2\.0\)\)/,
    'silhouette coverage must be an exact pixel-space box filter, capped so a sub-pixel '
    + 'ribbon dims rather than dropping out of the raster');
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

test('shot tracers keep the shipped white broadcast styling; only the loading mural tints', async () => {
  const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
  const construction = main.match(/new Tracer\([\s\S]{0,200}?\)/)[0];
  for (const option of ['liveColor', 'liveWidthPixels', 'historyWidthPixels', 'historySamples', 'alongFade']) {
    assert.doesNotMatch(construction, new RegExp(option),
      `the play tracer must inherit the default ${option}`);
  }
  assert.doesNotMatch(main, /promoteActiveToHistory|restyleHistory/,
    'the play path must promote through the white helper, never with a tint');
  const loading = await readFile(new URL('src/scene/LoadingGreen.js', ROOT), 'utf8');
  assert.match(loading, /promoteActiveToHistory\(\{ color: this\._tracerColor \}\)/,
    'each holed loading putt must leave its own coloured line in the mural');
  assert.match(loading, /historySamples: 96/,
    'a fixed promoted length keeps every mural line on one compiled pipeline');
});

test('promoted history lines resample to one fixed length without moving their ends', async () => {
  const source = await readFile(new URL('src/scene/Tracer.js', ROOT), 'utf8');
  const start = source.indexOf('function resamplePolyline');
  const { resamplePolyline } = await import(`data:text/javascript;base64,${Buffer.from(
    `export ${source.slice(start, source.indexOf('\nclass HistoricalTracer'))}`,
  ).toString('base64')}`);

  // A putt rolls at wildly varying speed, so raw playback samples bunch up near the
  // cup. Uniform arc-length spacing is what the ribbon's Catmull-Rom expects.
  const points = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    points.push(t * t * 10, 0, Math.sin(t * 2) * 3);
  }
  const resampled = resamplePolyline(Float32Array.from(points), 96);
  assert.equal(resampled.length, 96 * 3);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(resampled[axis] - points[axis]) < 1e-5, 'the start must be preserved');
    assert.ok(Math.abs(resampled[95 * 3 + axis] - points[40 * 3 + axis]) < 1e-4,
      'the terminal sample at the cup must be preserved');
  }
  const spans = [];
  for (let i = 1; i < 96; i++) {
    spans.push(Math.hypot(resampled[i * 3] - resampled[(i - 1) * 3],
      resampled[i * 3 + 2] - resampled[(i - 1) * 3 + 2]));
  }
  assert.ok(Math.max(...spans) - Math.min(...spans) < 0.02 * Math.max(...spans),
    'resampled spacing must be uniform along the arc');
  assert.throws(() => resamplePolyline(Float32Array.from([0, 0, 0]), 96), /source samples/);
  assert.throws(() => resamplePolyline(Float32Array.from(points), 1), /at least two samples/);
});
