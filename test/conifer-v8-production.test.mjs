import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const productionDir = new URL('../public/assets/trees/', import.meta.url);
const trialDir = new URL('../public/assets/trees_candidates/conifer_v8/', import.meta.url);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonLength;
  return JSON.parse(bytes.toString('utf8', jsonStart, jsonEnd));
}

function binChunk(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const jsonEnd = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(jsonEnd);
  assert.equal(bytes.readUInt32LE(jsonEnd + 4), 0x004e4942);
  return bytes.subarray(jsonEnd + 8, jsonEnd + 8 + binLength);
}

function png(bytes) {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/catalog.json', import.meta.url), 'utf8'));
const tree = manifest.assets.find((asset) => asset.id === 'polyhaven-fir-sapling-medium');

test('catalog promotes v8 to durable production URLs and non-trial lineage', () => {
  assert.ok(tree);
  assert.equal(tree.derivativeLineage.pipelineVersion, 'source-macro-cluster-conifer-v8+alpha-hull+neutral-impostor@1');
  assert.deepEqual(tree.lods.map(({ url, sha256: hash }) => ({ url, sha256: hash })), [
    { url: '/assets/trees/conifer_v8_lod0.glb', sha256: 'a2557e64685bb3c4e1d0354c986e8724f84b4e91284877a170771251636dd925' },
    { url: '/assets/trees/conifer_v8_lod1.glb', sha256: '7d67ec2113b2eff760ec03648c903c630c5ce0854374f964b5c0dbe414fa9fac' },
  ]);
  assert.equal(tree.impostor.url, '/assets/trees/conifer_v8_impostor.png');
  assert.equal(tree.impostor.sha256, '029e6badad5b1983c16ab175928b991f3646054e220db580480b71957d67c593');
  assert.doesNotMatch(tree.derivativeLineage.pipelineVersion, /trial|candidate/i);
  assert.doesNotMatch(JSON.stringify(tree), /trees_candidates/);
});

for (const [lod, expectedHash, expectedTriangles, expectedVertices] of [
  [0, 'a2557e64685bb3c4e1d0354c986e8724f84b4e91284877a170771251636dd925', 6_234, 18_702],
  [1, '7d67ec2113b2eff760ec03648c903c630c5ce0854374f964b5c0dbe414fa9fac', 5_030, 15_090],
]) {
  test(`promoted v8 LOD${lod} clears trial metadata without changing geometry payload`, async () => {
    const production = await readFile(new URL(`conifer_v8_lod${lod}.glb`, productionDir));
    const trial = await readFile(new URL(`conifer_v8_lod${lod}.glb`, trialDir));
    const document = parseGlb(production);
    assert.equal(sha256(production), expectedHash);
    assert.equal(document.asset.generator, 'build_conifer_v8@1-alpha-footprint-hulls-production');
    assert.equal(document.extras.candidateOnly, false);
    assert.equal(document.extras.promotion, 'reviewed-v8-production');
    assert.equal(document.extras.lod, lod);
    assert.equal(document.extras.triangles, expectedTriangles);
    assert.equal(document.extras.vertices, expectedVertices);
    assert.equal(document.materials[0].name, 'conifer_v8_macro_alpha_atlas');
    assert.equal(document.materials[0].alphaMode, 'MASK');
    assert.equal(document.materials[0].alphaCutoff, 0.06);
    assert.deepEqual(binChunk(production), binChunk(trial));
  });
}

test('promoted v8 atlas/impostor retain exact reviewed bytes and runtime metadata', async () => {
  const trialAtlas = await readFile(new URL('conifer_v8_macro_atlas.png', trialDir));
  const productionAtlas = await readFile(new URL('conifer_v8_macro_atlas.png', productionDir));
  const trialImpostor = await readFile(new URL('conifer_v8_impostor.png', trialDir));
  const productionImpostor = await readFile(new URL('conifer_v8_impostor.png', productionDir));
  const metadata = JSON.parse(await readFile(new URL('conifer_v8_impostor.json', productionDir), 'utf8'));
  assert.equal(sha256(productionAtlas), '6c47363530004dc7585d0cc0d2ad131dcadbafdb281aaedeea36ed334b089d75');
  assert.equal(sha256(productionImpostor), '029e6badad5b1983c16ab175928b991f3646054e220db580480b71957d67c593');
  assert.deepEqual(productionAtlas, trialAtlas);
  assert.deepEqual(productionImpostor, trialImpostor);
  assert.deepEqual(png(productionAtlas), { width: 1024, height: 1024, colorType: 6 });
  assert.deepEqual(png(productionImpostor), { width: 2048, height: 1024, colorType: 6 });
  assert.equal(metadata.candidateOnly, false);
  assert.equal(metadata.generator, 'build_conifer_v8@1-alpha-footprint-hulls-production');
  assert.equal(metadata.promotion, 'reviewed-v8-production');
  assert.equal(metadata.runtimeLightingRequired, true);
});

test('runtime selects the promoted v8 material branch instead of a v3-v6 fallback', async () => {
  const trees = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');
  assert.match(trees, /const v8ProductionPhongAtlas = coniferV8 && part\.material\.map/);
  assert.match(trees, /const candidatePhongAtlas = \(coniferV7 && part\.material\.map\) \|\| v8ProductionPhongAtlas/);
  assert.match(trees, /v8 is now the reviewed production catalog derivative/);
  assert.match(trees, /if \(\(coniferV4 \|\| coniferV5 \|\| coniferV6 \|\| coniferV7\)\s+&& !candidatePhongAtlas/);
});
