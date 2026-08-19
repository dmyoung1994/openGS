import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const builder = await readFile(new URL('../scripts/build_conifer_v5.py', import.meta.url), 'utf8');

function parseGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  return { json, jsonLength };
}

function pngHeader(bytes) {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

test('v5 builder keeps the v4 hierarchy, bakes branchlet normals, and stays candidate-only', () => {
  assert.match(builder, /same 36-layer\/8-branch hierarchy/);
  assert.match(builder, /retained_clusters = hierarchy_clusters if lod == 0 else 6/);
  assert.match(builder, /retained_volumes = volume_hierarchy if lod == 0 else 167/);
  assert.match(builder, /bake_parent_normals/);
  assert.match(builder, /sourceWeight.*0\.64/);
  assert.match(builder, /parentWeight.*0\.36/);
  assert.match(builder, /barkTileUnchanged.*True/);
  assert.match(builder, /v3\.impostor\(meshes\[0\]/);
  assert.match(builder, /frames.*8.*columns.*4.*rows.*2/s);
  assert.match(builder, /no sun\/AO\/emission/);
});

for (const [lod, triangles, renderVertices, expectedSha] of [
  [0, 20_724, 62_172, '63d4ba1293fa86a487498a75f1c41f9a4da8505cded1c4bf2a90e0560453bb22'],
  [1, 12_000, 36_000, 'e6100d890a4f3c2b5bf0643dae59d53a20dbc13d91d601b70952b458b5af1ddb'],
]) {
  test(`v5 LOD${lod} has strict topology/material/bounds metadata`, async () => {
    const bytes = await readFile(new URL(`../public/assets/trees_candidates/conifer_v5/conifer_v5_lod${lod}.glb`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha);
    const { json } = parseGlb(bytes);
    assert.equal(json.asset.generator, 'build_conifer_v5@1-registered-cross-pair');
    assert.equal(json.extras.candidateOnly, true);
    assert.equal(json.extras.lod, lod);
    assert.equal(json.extras.sourceAsset, 'conifer_v4_exact_hierarchy_and_atlas');
    assert.equal(json.extras.triangles, triangles);
    assert.equal(json.extras.vertices, renderVertices);
    assert.equal(json.meshes.length, 1);
    assert.equal(json.meshes[0].primitives.length, 1);
    assert.equal(json.materials.length, 1);
    assert.equal(json.materials[0].name, 'conifer_v5_authored_alpha_atlas');
    assert.equal(json.materials[0].alphaMode, 'MASK');
    assert.equal(json.materials[0].alphaCutoff, 0.06);
    assert.equal(json.accessors[json.meshes[0].primitives[0].attributes.NORMAL].count, renderVertices);
    assert.equal(json.accessors[json.meshes[0].primitives[0].attributes.TEXCOORD_0].count, renderVertices);
    assert.equal(json.extras.boundsMin[1], 0);
    assert.equal(json.extras.boundsMax[1], 18.895);
    assert.equal(json.extras.normalBake.barkTileUnchanged, true);
    assert.equal(json.extras.normalBake.sourceWeight, 0.64);
    assert.equal(json.extras.normalBake.parentWeight, 0.36);
  });
}

test('v5 atlas and eight-view impostor are local RGBA neutral assets with coverage', async () => {
  const atlas = await readFile(new URL('../public/assets/trees_candidates/conifer_v5/conifer_v5_branchlet_atlas.png', import.meta.url));
  const impostor = await readFile(new URL('../public/assets/trees_candidates/conifer_v5/conifer_v5_impostor.png', import.meta.url));
  const metadata = JSON.parse(await readFile(new URL('../public/assets/trees_candidates/conifer_v5/conifer_v5_impostor.json', import.meta.url), 'utf8'));
  assert.deepEqual(pngHeader(atlas), { width: 1024, height: 1024, colorType: 6 });
  assert.deepEqual(pngHeader(impostor), { width: 2048, height: 1024, colorType: 6 });
  assert.equal(createHash('sha256').update(atlas).digest('hex'), '4a0770c24e9eb6a92d66cc2f0dd0c0a2233215ddbbb49f81b2264551fb5d01e6');
  assert.equal(createHash('sha256').update(impostor).digest('hex'), '105e9de0d50cd0c97d298e354b4b07a07e968a0ba15883c517932695c7410ee6');
  assert.equal(metadata.candidateOnly, true);
  assert.equal(metadata.frames, 8);
  assert.equal(metadata.columns, 4);
  assert.equal(metadata.rows, 2);
  assert.equal(metadata.runtimeLightingRequired, true);
  assert.match(metadata.bakeMethod, /no sun\/AO\/emission/);
  assert.ok(metadata.alpha.coverageAt16 > 0.10 && metadata.alpha.coverageAt16 < 0.30);
  assert.equal(metadata.sha256, '105e9de0d50cd0c97d298e354b4b07a07e968a0ba15883c517932695c7410ee6');
});
