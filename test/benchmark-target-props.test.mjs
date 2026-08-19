import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('environment benchmark enforces shipped target prop draw buckets', async () => {
  const source = await readFile(new URL('../scripts/benchmark-environment.mjs', import.meta.url), 'utf8');
  assert.match(source, /targetPropDiagnostics = await page\.evaluate/);
  assert.match(source, /targetPropDiagnostics\.targetDraws !== 11/);
  assert.match(source, /targetPropDiagnostics\.signDraws !== 6/);
  assert.match(source, /instances\?\.flagPoles !== 6/);
  assert.match(source, /instances\?\.flagCloth !== 6/);
  assert.match(source, /instances\?\.flagBases !== 6/);
  assert.match(source, /instances\?\.signPosts !== 12/);
  assert.match(source, /instances\?\.teeMarkers !== 2/);
});
