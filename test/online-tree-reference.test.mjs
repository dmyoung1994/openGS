import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('Poly Haven tree references stay local, explicit, and isolated from runtime foliage aliases', async () => {
  const assets = await readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8');
  const provenance = await readFile(new URL('../docs/polyhaven-tree-reference-provenance.md', import.meta.url), 'utf8');
  const references = [
    ['reference: Poly Haven Tree Small 02 (CC0)', '/assets/trees/tree_small_02_lod0.glb'],
    ['reference: Poly Haven Island Tree 01 (CC0)', '/assets/trees/island_tree_01.glb'],
  ];
  for (const [label, file] of references) {
    assert.match(assets, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(assets, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await access(new URL(`../public${file}`, import.meta.url));
  }
  assert.match(provenance, /https:\/\/polyhaven\.com\/a\/tree_small_02/);
  assert.match(provenance, /https:\/\/polyhaven\.com\/a\/island_tree_01/);
  assert.match(provenance, /CC0/);
  assert.match(provenance, /reference-only/);
  assert.doesNotMatch(assets, /local\.polyhaven/);
});
