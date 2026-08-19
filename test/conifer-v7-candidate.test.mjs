import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const builder = await readFile(new URL('../scripts/build_conifer_v7.py', import.meta.url), 'utf8');

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

test('v7 uses shared whorl authority and volumetric local cluster planes', () => {
  assert.match(builder, /steps, levels, branches = 26, 36, 8/);
  assert.match(builder, /same random sequence and centers/);
  assert.match(builder, /for plane in range\(3\)/);
  assert.match(builder, /Low\/interior clusters are also volumetric/);
  assert.match(builder, /def projected_mask/);
  assert.match(builder, /ALPHA_CUTOFF = 16/);
  assert.match(builder, /def silhouette_metrics/);
  assert.match(builder, /v3\.impostor\(meshes\[0\]/);
  assert.match(builder, /no sun\/AO\/emission/);
});

for (const [lod, triangles, renderVertices, expectedSha, maxTriangles] of [
  [0, 5_116, 15_348, 'd2b4eed793a301ddbee08c848da774372feaeebd72f39bea21534a1bf26e6ec9', 10_000],
  [1, 3_912, 11_736, 'b1b962d0eaa0064345ad9bcbf66e6f818777419576ba4b05c634124234da5dfa', 6_000],
]) {
  test(`v7 LOD${lod} is bounded, grounded, and one masked material`, async () => {
    const bytes = await readFile(new URL(`../public/assets/trees_candidates/conifer_v7/conifer_v7_lod${lod}.glb`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha);
    const document = parseGlb(bytes);
    assert.equal(document.asset.generator, 'build_conifer_v7@1-volumetric-macro-clusters');
    assert.equal(document.extras.candidateOnly, true);
    assert.equal(document.extras.lod, lod);
    assert.equal(document.extras.triangles, triangles);
    assert.equal(document.extras.vertices, renderVertices);
    assert.ok(triangles <= maxTriangles);
    assert.equal(document.meshes.length, 1);
    assert.equal(document.meshes[0].primitives.length, 1);
    assert.equal(document.materials.length, 1);
    assert.equal(document.materials[0].name, 'conifer_v7_macro_alpha_atlas');
    assert.equal(document.materials[0].alphaMode, 'MASK');
    assert.equal(document.materials[0].alphaCutoff, 0.06);
    assert.equal(document.extras.boundsMin[1], 0);
    assert.equal(document.extras.boundsMax[1], 18.895);
    assert.match(document.extras.bakeLighting, /neutral source RGB\/alpha only/);
    assert.equal(document.extras.geometry, 'volumetric-three-plane-local-clusters-v7');
    assert.equal(document.extras.selection, 'same 36 crown layers/8 branches, three local planes per cluster');
    assert.ok(document.extras.macroAtlasCoverageAt16.min > 0.25);
    for (const angle of ['0', '45', '90', '135']) {
      const [hero, handoff] = document.extras.silhouetteMetrics[angle];
      assert.ok(hero.pixels > 0);
      assert.ok(hero.leftRightBalance >= 0.55, `${angle}° hero balance`);
      assert.ok(handoff.leftRightBalance >= 0.55, `${angle}° LOD1 balance`);
      assert.ok(handoff.lodRatio >= 0.55, `${angle}° LOD ratio`);
    }
  });
}

test('v7 macro atlas and eight-view impostor are neutral alpha assets', async () => {
  const atlas = await readFile(new URL('../public/assets/trees_candidates/conifer_v7/conifer_v7_macro_atlas.png', import.meta.url));
  const impostor = await readFile(new URL('../public/assets/trees_candidates/conifer_v7/conifer_v7_impostor.png', import.meta.url));
  const metadata = JSON.parse(await readFile(new URL('../public/assets/trees_candidates/conifer_v7/conifer_v7_impostor.json', import.meta.url), 'utf8'));
  assert.deepEqual(png(atlas), { width: 1024, height: 1024, colorType: 6 });
  assert.deepEqual(png(impostor), { width: 2048, height: 1024, colorType: 6 });
  assert.equal(createHash('sha256').update(atlas).digest('hex'), '6c47363530004dc7585d0cc0d2ad131dcadbafdb281aaedeea36ed334b089d75');
  assert.equal(createHash('sha256').update(impostor).digest('hex'), '7b85e2d8b063d76c2c27e6cfc8038b9c0639f641402579b0fdf50d1dfba81c32');
  assert.equal(metadata.candidateOnly, true);
  assert.equal(metadata.frames, 8);
  assert.equal(metadata.columns, 4);
  assert.equal(metadata.rows, 2);
  assert.equal(metadata.runtimeLightingRequired, true);
  assert.match(metadata.bakeMethod, /neutral.*no sun\/AO\/emission/);
  assert.ok(metadata.alpha.coverageAt16 > 0.10);
});
