import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('viewer exposes procedural variants, structure modes, diagnostics, and shared sun inspection', async () => {
  const [html, viewer, assets, procedural] = await Promise.all([
    readFile(new URL('../viewer.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewer/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scene/ProceduralTrees.js', import.meta.url), 'utf8'),
  ]);
  for (const variant of [0, 1, 2, 3]) assert.match(html, new RegExp(`data-variant="${variant}"`));
  for (const mode of ['beauty', 'structure', 'foliage', 'silhouette', 'lod']) assert.match(viewer, new RegExp(`['"]${mode}['"]`));
  assert.match(html, /data-sun="fixed"/); assert.match(html, /data-sun="moving"/);
  assert.match(viewer, /environment\.sunDirection\.value\.copy\(labSunDirection\)/);
  assert.match(viewer, /lighting\.sun\.shadow\.needsUpdate = true/);
  assert.match(viewer, /branches: diagnostics\.branches, leaves: diagnostics\.leaves/);
  assert.match(assets, /ProceduralTreeForest\.create/);
  assert.match(assets, /procedural: stochastic l-system/);
  assert.match(assets, /procedural: ImageGen live oak/);
  assert.match(procedural, /procedural-tree-stable-shadow/);
  assert.doesNotMatch(html, /data-subject="atlas"|data-subject="cards"|__GOLF_LOCAL_FOLIAGE_PACKS__/);
});
