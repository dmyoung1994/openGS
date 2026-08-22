import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('shot tracer persists until the next actual launch boundary', async () => {
  const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
  const hitStart = main.indexOf('function hit()');
  const hitEnd = main.indexOf('// Main update.', hitStart);
  const hit = main.slice(hitStart, hitEnd);
  assert.match(hit, /tracer\.reset\(\);[\s\S]*?ball\.launch\(params\);/,
    'the next shot must clear the old tracer immediately before its real launch');
  assert.equal((main.match(/tracer\.reset\(\)/g) || []).length, 1,
    'address return, rest, and camera transitions must never clear the completed tracer');
  assert.doesNotMatch(main, /tracer\.fade\(/,
    'completed shot history must not fade while waiting for the next shot');
});

test('tracer uses one stable Foresight-style GPU ribbon', async () => {
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
  assert.doesNotMatch(tracer, /AdditiveBlending|fade\(dt\)|HaloPixels|CorePixels|warmIvory|flightGold/,
    'the tracer must have no bloom stack, pale core, or automatic expiry path');
});
