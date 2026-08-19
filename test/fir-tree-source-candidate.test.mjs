import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../scripts/build_fir_tree_source_candidate.py', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf', import.meta.url));
const viewerAssets = await readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8');

function parseGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
}

test('source candidate builder preserves complete cards, UVs, and authored alpha', () => {
  assert.match(script, /def iter_components\(/);
  assert.match(script, /complete connected components/);
  assert.match(script, /TEXCOORD_0/);
  assert.match(script, /combined_twig_texture/);
  assert.match(script, /fir_tree_01_twig_alpha_1k\.png/);
  assert.match(script, /alphaMode.*MASK/);
  assert.match(script, /alphaCutoff.*0\.06/);
  assert.match(script, /candidateOnly/);
  assert.equal(createHash('sha256').update(source).digest('hex'),
    '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709');
  assert.match(viewerAssets, /firTreeSourceCandidatePatch/);
  assert.match(viewerAssets, /tree candidate: source PBR LOD0/);
  assert.match(viewerAssets, /tree candidate: source PBR LOD1/);
  assert.match(viewerAssets, /trees_candidates\/fir_tree_01/);
  assert.doesNotMatch(viewerAssets, /catalog\.json.*candidate/);
});

for (const [lod, maxVertices, expectedSha] of [
  [0, 120_000, null],
  [1, 35_000, null],
]) {
  test(`isolated source candidate LOD${lod} stays bounded and grounded`, async () => {
    const bytes = await readFile(new URL(`../public/assets/trees_candidates/fir_tree_01/fir_tree_01_source_candidate_lod${lod}.glb`, import.meta.url));
    if (expectedSha) assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha);
    const document = parseGlb(bytes);
    assert.ok(bytes.byteLength < 20_000_000, 'candidate GLB must remain bounded for isolated review');
    assert.equal(document.extras.candidateOnly, true);
    assert.equal(document.extras.lod, lod);
    assert.ok(document.extras.vertices <= maxVertices);
    assert.equal(document.meshes[0].primitives.length, 4, 'bark/trunk/foliage/branch roles remain separate');
    const renderVertexReferences = document.meshes[0].primitives.reduce((sum, primitive) => (
      sum + document.accessors[primitive.indices].count
    ), 0);
    assert.ok(renderVertexReferences <= (lod === 0 ? 120_000 : 35_000),
      `render vertex references must stay bounded (got ${renderVertexReferences})`);
    assert.equal(document.images.length, 12, 'source maps remain embedded and local');
    assert.equal(document.materials[2].alphaMode, 'MASK');
    assert.equal(document.materials[2].alphaCutoff, 0.06);
    assert.ok(document.extras.boundsMin[1] >= -1e-6, 'selected source minimum is grounded');
    assert.ok(document.extras.boundsMax[1] - document.extras.boundsMin[1] > 18.0, 'mature source height is retained');
    for (const primitive of document.meshes[0].primitives) {
      assert.ok(primitive.attributes.TEXCOORD_0 !== undefined, 'every foliage/structural role keeps source UVs');
      assert.ok(primitive.attributes.NORMAL !== undefined);
    }
  });
}
