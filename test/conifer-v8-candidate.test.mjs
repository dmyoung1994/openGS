import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const builder = await readFile(new URL('../scripts/build_conifer_v8.py', import.meta.url), 'utf8');

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

test('v8 trims alpha footprints with guarded low-vertex hulls over v7 authority', () => {
  assert.match(builder, /36x8 whorl\/plane authority/);
  assert.match(builder, /def alpha_hulls/);
  assert.match(builder, /HULL_EPSILON = 0\.11/);
  assert.match(builder, /HULL_GUARD_PIXELS = 4\.0/);
  assert.match(builder, /def trimmed_card/);
  assert.match(builder, /three local planes per cluster/);
  assert.match(builder, /no sun\/AO\/emission/);
  assert.match(builder, /v3\.impostor\(meshes\[0\]/);
});

for (const [lod, triangles, renderVertices, expectedSha, maxTriangles] of [
  [0, 6_234, 18_702, '65e03c0c753a0b25873285009cd9c081e18f9f411c7902a83fb762b7065ca7a2', 8_000],
  [1, 5_030, 15_090, '90ae3d0f9d1879d830188ccaa6d442ca47e054dbfb6118c9846ac5027529442c', 6_000],
]) {
  test(`v8 LOD${lod} is bounded and one masked material`, async () => {
    const bytes = await readFile(new URL(`../public/assets/trees_candidates/conifer_v8/conifer_v8_lod${lod}.glb`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha);
    const document = parseGlb(bytes);
    assert.equal(document.asset.generator, 'build_conifer_v8@1-alpha-footprint-hulls');
    assert.equal(document.extras.candidateOnly, true);
    assert.equal(document.extras.lod, lod);
    assert.equal(document.extras.triangles, triangles);
    assert.equal(document.extras.vertices, renderVertices);
    assert.ok(triangles <= maxTriangles);
    assert.equal(document.meshes.length, 1);
    assert.equal(document.meshes[0].primitives.length, 1);
    assert.equal(document.materials.length, 1);
    assert.equal(document.materials[0].name, 'conifer_v8_macro_alpha_atlas');
    assert.equal(document.materials[0].alphaMode, 'MASK');
    assert.equal(document.materials[0].alphaCutoff, 0.06);
    assert.equal(document.extras.boundsMin[1], 0);
    assert.equal(document.extras.boundsMax[1], 18.895);
    assert.match(document.extras.bakeLighting, /neutral source RGB\/alpha only/);
    assert.equal(document.extras.alphaHull.maxVertices, 6);
    assert.ok(document.extras.cardArea.reduction >= 0.30);
    assert.ok(document.extras.cardArea.trimmed < document.extras.cardArea.baseline);
    for (const angle of ['0', '45', '90', '135']) {
      const [hero, handoff] = document.extras.silhouetteMetrics[angle];
      const retained = document.extras.retainedVsV7[angle];
      assert.ok(hero.leftRightBalance >= 0.95, `${angle}° hero balance`);
      assert.ok(handoff.leftRightBalance >= 0.95, `${angle}° handoff balance`);
      assert.ok(handoff.lodRatio >= 0.95, `${angle}° LOD1 retention`);
      assert.ok(retained[0] >= 0.98, `${angle}° LOD1 vs v7`);
      assert.ok(retained[1] >= 0.98, `${angle}° LOD0 vs v7`);
    }
  });
}

test('v8 neutral macro atlas and eight-view impostor are valid alpha assets', async () => {
  const atlas = await readFile(new URL('../public/assets/trees_candidates/conifer_v8/conifer_v8_macro_atlas.png', import.meta.url));
  const impostor = await readFile(new URL('../public/assets/trees_candidates/conifer_v8/conifer_v8_impostor.png', import.meta.url));
  const metadata = JSON.parse(await readFile(new URL('../public/assets/trees_candidates/conifer_v8/conifer_v8_impostor.json', import.meta.url), 'utf8'));
  assert.deepEqual(png(atlas), { width: 1024, height: 1024, colorType: 6 });
  assert.deepEqual(png(impostor), { width: 2048, height: 1024, colorType: 6 });
  assert.equal(createHash('sha256').update(atlas).digest('hex'), '6c47363530004dc7585d0cc0d2ad131dcadbafdb281aaedeea36ed334b089d75');
  assert.equal(createHash('sha256').update(impostor).digest('hex'), '029e6badad5b1983c16ab175928b991f3646054e220db580480b71957d67c593');
  assert.equal(metadata.candidateOnly, true);
  assert.equal(metadata.frames, 8);
  assert.equal(metadata.columns, 4);
  assert.equal(metadata.rows, 2);
  assert.equal(metadata.runtimeLightingRequired, true);
  assert.match(metadata.bakeMethod, /alpha-footprint-hull.*no sun\/AO\/emission/);
  assert.ok(metadata.alpha.coverageAt16 > 0.10);
});
