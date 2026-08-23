import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('environment benchmark enforces authored target prop draw buckets', async () => {
  const source = await readFile(new URL('../scripts/benchmark-environment.mjs', import.meta.url), 'utf8');
  assert.match(source, /targetPropDiagnostics = await page\.evaluate/);
  assert.match(source, /const targetCount = targetPropDiagnostics\.signDraws/);
  assert.match(source, /targetPropDiagnostics\.targetDraws !== targetCount \+ 5/);
  assert.match(source, /instances\?\.flagPoles !== targetCount/);
  assert.match(source, /instances\?\.flagCloth !== targetCount/);
  assert.match(source, /instances\?\.flagBases !== targetCount/);
  assert.match(source, /instances\?\.signPosts !== targetCount \* 2/);
  assert.match(source, /instances\?\.teeMarkers !== 2/);
});
