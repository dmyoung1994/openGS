import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('shot tracer persists until the next actual launch boundary', async () => {
  const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
  const hitStart = main.indexOf('function hit()');
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

test('tracer uses stable blue flight and white historical GPU ribbons', async () => {
  const tracer = await readFile(new URL('src/scene/Tracer.js', ROOT), 'utf8');
  assert.match(tracer, /const SUBDIVISIONS = 8/,
    'the persistent curve needs a smooth bounded longitudinal tessellation');
  assert.match(tracer, /tangentScreenLength\.greaterThan\(0\.0001\)\.select\([\s\S]*?vec2\(1\.0, 0\.0\)/,
    'near-end-on chase views need a finite screen-space width fallback');
  assert.match(tracer, /uRibbonPixels = uniform\(6\.4\)/,
    'the broadcast ribbon must remain narrow at native output');
  assert.match(tracer, /deepBroadcastBlue[\s\S]*?flightBlue/,
    'the ribbon must progress from deep to vivid Foresight-style blue');
  assert.match(tracer, /headProfile[\s\S]*?smoothstep\(0\.62, 0\.96, along\)/,
    'the trajectory must narrow gradually toward the ball instead of ending as a blunt laser');
  assert.match(tracer, /edgeCoverage = smoothstep\(0\.0, 0\.30, edge\)/,
    'only the ribbon silhouette should receive a restrained antialiased edge');
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
  assert.doesNotMatch(tracer, /AdditiveBlending|fade\(dt\)|HaloPixels|CorePixels|warmIvory|flightGold/,
    'the tracer must have no bloom stack, pale core, or automatic expiry path');
});
