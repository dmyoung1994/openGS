import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const builder = await readFile(new URL('../scripts/build_conifer_v4.py', import.meta.url), 'utf8');
const viewerAssets = await readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8');

function parseGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
}

test('conifer v4 is a deterministic local-cluster candidate, not source triangle sampling', () => {
  assert.match(builder, /dense local-cluster conifer v4 candidate/);
  assert.match(builder, /full-crown volume\/whorl cluster bake/);
  assert.match(builder, /no source triangle sampling/);
  assert.match(builder, /mesh\.p = \[\(p\[0\], \(p\[1\] - min_y\)/);
  assert.match(builder, /candidateOnly/);
  assert.match(viewerAssets, /coniferV4CandidatePatch/);
  assert.match(viewerAssets, /tree candidate: conifer v4 LOD0/);
  assert.match(viewerAssets, /tree candidate: conifer v4 LOD1/);
  assert.match(viewerAssets, /trees_candidates\/conifer_v4/);
  assert.doesNotMatch(viewerAssets, /catalog\.json.*conifer v4/);
});

for (const [lod, maxRenderVertices, maxTriangles, expectedSha] of [
  [0, 120_000, 40_000, 'badaf1385f2f63c385f9379e1cdf216e701d3b69b1e34e7064b9dda79502cda1'],
  [1, 70_000, 22_000, '39b1893edd6cb87d31e3f05eba92551dff56f1c6c1522877aa090cb90c5c9170'],
]) {
  test(`conifer v4 LOD${lod} stays render-bounded, grounded, and single-material`, async () => {
    const bytes = await readFile(new URL(`../public/assets/trees_candidates/conifer_v4/conifer_v4_lod${lod}.glb`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha);
    assert.ok(bytes.byteLength < 8_000_000, 'candidate GLB must remain bounded for isolated review');
    const document = parseGlb(bytes);
    assert.equal(document.asset.generator, 'build_conifer_v4@1-dense-local-clusters');
    assert.equal(document.extras.candidateOnly, true);
    assert.equal(document.extras.lod, lod);
    assert.equal(document.extras.geometry, 'dense-local-source-branch-clusters-v4');
    assert.match(document.extras.selection, /no source triangle sampling/);
    assert.equal(document.meshes.length, 1);
    assert.equal(document.meshes[0].name, `conifer_v4_lod${lod}`);
    assert.equal(document.meshes[0].primitives.length, 1);
    assert.equal(document.materials.length, 1);
    assert.equal(document.materials[0].name, 'conifer_v4_authored_alpha_atlas');
    assert.equal(document.materials[0].alphaMode, 'MASK');
    assert.equal(document.materials[0].alphaCutoff, 0.06);
    const renderVertexReferences = document.meshes[0].primitives.reduce((sum, primitive) => (
      sum + document.accessors[primitive.indices].count
    ), 0);
    const triangles = renderVertexReferences / 3;
    assert.ok(renderVertexReferences <= maxRenderVertices,
      `glTF-Transform render vertex references must stay bounded (got ${renderVertexReferences})`);
    assert.ok(triangles <= maxTriangles, `triangle budget must stay bounded (got ${triangles})`);
    assert.equal(document.extras.vertices, renderVertexReferences);
    assert.equal(document.extras.triangles, triangles);
    assert.ok(Math.abs(document.extras.boundsMin[1]) <= 1e-6, 'candidate must be grounded at y=0');
    assert.ok(Math.abs(document.extras.boundsMax[1] - 18.895) <= 1e-5, 'source mature height must be registered');
    assert.ok(document.meshes[0].primitives[0].attributes.TEXCOORD_0 !== undefined);
    assert.ok(document.meshes[0].primitives[0].attributes.NORMAL !== undefined);
  });
}

test('v4 atlas is local, RGBA, and has transparent gutters', async () => {
  const bytes = await readFile(new URL('../public/assets/trees_candidates/conifer_v4/conifer_v4_branchlet_atlas.png', import.meta.url));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 1024);
  assert.equal(bytes.readUInt32BE(20), 1024);
  assert.equal(bytes[25], 6, 'RGBA atlas');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '4a0770c24e9eb6a92d66cc2f0dd0c0a2233215ddbbb49f81b2264551fb5d01e6');
});

test('LOD1 retains the LOD0 crown envelope for a continuous handoff', async () => {
  const load = async (lod) => parseGlb(await readFile(
    new URL(`../public/assets/trees_candidates/conifer_v4/conifer_v4_lod${lod}.glb`, import.meta.url),
  ));
  const near = await load(0);
  const middle = await load(1);
  for (const axis of [0, 2]) {
    const nearSpan = near.extras.boundsMax[axis] - near.extras.boundsMin[axis];
    const middleSpan = middle.extras.boundsMax[axis] - middle.extras.boundsMin[axis];
    assert.ok(middleSpan / nearSpan >= 0.85,
      `LOD1 crown envelope must retain at least 85% of LOD0 on axis ${axis}`);
  }
  assert.ok(Math.abs(middle.extras.boundsMax[1] - near.extras.boundsMax[1]) <= 1e-5);
});
