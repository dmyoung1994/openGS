import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const builder = await readFile(new URL('../scripts/build_conifer_v6.py', import.meta.url), 'utf8');

function parseGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
}

function png(bytes) {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

test('v6 is a local macro-cluster bake, not a tiny-twig or whole-tree card path', () => {
  assert.match(builder, /one or two broad, tightly\s+fitted local branch\/whorl sprites/);
  assert.match(builder, /levels, branches = 36, 8/);
  assert.match(builder, /if lod == 0 or branch_index < 6/);
  assert.match(builder, /real primary branch/);
  assert.match(builder, /macro_atlas/);
  assert.match(builder, /no sun\/AO\/emission/);
  assert.match(builder, /v3\.impostor\(meshes\[0\]/);
});

for (const [lod, triangles, renderVertices, expectedSha, maxTriangles] of [
  [0, 4_460, 13_380, 'c4751492a0ec07fe18376b932bf18e76854d75538461a6f8a71844d9396c96f2', 6_000],
  [1, 2_472, 7_416, '2f03151cb4e0929725466736285864c0562572c4dbc26e545a649bd811589d16', 2_500],
]) {
  test(`v6 LOD${lod} is bounded, grounded, and one masked material`, async () => {
    const bytes = await readFile(new URL(`../public/assets/trees_candidates/conifer_v6/conifer_v6_lod${lod}.glb`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha);
    const document = parseGlb(bytes);
    assert.equal(document.asset.generator, 'build_conifer_v6@1-macro-cluster-cards');
    assert.equal(document.extras.candidateOnly, true);
    assert.equal(document.extras.lod, lod);
    assert.equal(document.extras.triangles, triangles);
    assert.equal(document.extras.vertices, renderVertices);
    assert.ok(triangles <= maxTriangles);
    assert.equal(document.meshes.length, 1);
    assert.equal(document.meshes[0].primitives.length, 1);
    assert.equal(document.materials.length, 1);
    assert.equal(document.materials[0].name, 'conifer_v6_macro_alpha_atlas');
    assert.equal(document.materials[0].alphaMode, 'MASK');
    assert.equal(document.materials[0].alphaCutoff, 0.06);
    assert.equal(document.extras.boundsMin[1], 0);
    assert.equal(document.extras.boundsMax[1], 18.895);
    assert.match(document.extras.bakeLighting, /neutral source RGB\/alpha only/);
    assert.equal(document.extras.macroAtlasCoverageAt16.min > 0.25, true);
  });
}

test('v6 macro atlas and eight-view impostor meet local neutral coverage contracts', async () => {
  const atlas = await readFile(new URL('../public/assets/trees_candidates/conifer_v6/conifer_v6_macro_atlas.png', import.meta.url));
  const impostor = await readFile(new URL('../public/assets/trees_candidates/conifer_v6/conifer_v6_impostor.png', import.meta.url));
  const metadata = JSON.parse(await readFile(new URL('../public/assets/trees_candidates/conifer_v6/conifer_v6_impostor.json', import.meta.url), 'utf8'));
  assert.deepEqual(png(atlas), { width: 1024, height: 1024, colorType: 6 });
  assert.deepEqual(png(impostor), { width: 2048, height: 1024, colorType: 6 });
  assert.equal(createHash('sha256').update(atlas).digest('hex'), '6c47363530004dc7585d0cc0d2ad131dcadbafdb281aaedeea36ed334b089d75');
  assert.equal(createHash('sha256').update(impostor).digest('hex'), 'c53a44dcffaf3e82a890826e9f4cb802d85e0e07a808df1c4189cb5da9a5b3c8');
  assert.ok(metadata.macroCoverage === undefined || metadata.alpha);
  assert.equal(metadata.candidateOnly, true);
  assert.equal(metadata.frames, 8);
  assert.equal(metadata.columns, 4);
  assert.equal(metadata.rows, 2);
  assert.equal(metadata.runtimeLightingRequired, true);
  assert.ok(metadata.alpha.coverageAt16 > 0.10);
});
