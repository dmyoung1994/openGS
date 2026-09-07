import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/catalog.json', import.meta.url), 'utf8'));
const required = [
  'polyhaven-pine-sapling-small',
  'polyhaven-fir-sapling-medium',
  'polyhaven-tree-small-02',
  'polyhaven-tree-small-02-hero',
  'polyhaven-pine-tree-01',
  'polyhaven-fir-tree-01',
  'polyhaven-island-tree-02',
  'polyhaven-island-tree-01',
  'blendkit-palm-tree-medium-dense',
];

function localUrl(assetUrl) {
  return new URL(`../public/assets${assetUrl.slice('/assets'.length)}`, import.meta.url);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function glbJson(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk');
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
}

function glbPayload(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryHeader = 20 + jsonLength;
  const binaryLength = bytes.readUInt32LE(binaryHeader);
  assert.equal(bytes.readUInt32LE(binaryHeader + 4), 0x004e4942, 'GLB BIN chunk');
  return { json, binary: bytes.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength) };
}

const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorReader(payload, accessorIndex) {
  const accessor = payload.json.accessors[accessorIndex];
  const view = payload.json.bufferViews[accessor.bufferView];
  const components = TYPE_SIZE[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  const elementBytes = components * componentBytes;
  const stride = view.byteStride ?? elementBytes;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const readComponent = (element, component = 0) => {
    const offset = start + element * stride + component * componentBytes;
    if (accessor.componentType === 5121) return payload.binary.readUInt8(offset);
    if (accessor.componentType === 5123) return payload.binary.readUInt16LE(offset);
    if (accessor.componentType === 5125) return payload.binary.readUInt32LE(offset);
    if (accessor.componentType === 5126) return payload.binary.readFloatLE(offset);
    throw new Error(`unsupported accessor component ${accessor.componentType}`);
  };
  return { accessor, components, readComponent };
}

function primitiveRecords(payload) {
  return payload.json.meshes.flatMap((mesh) => mesh.primitives.map((primitive) => ({
    primitive,
    material: payload.json.materials[primitive.material].name,
  })));
}

function trianglePositionMultiset(payload, materialPattern) {
  const records = primitiveRecords(payload).filter(({ material }) => materialPattern.test(material));
  assert.equal(records.length, 1, `one foliage primitive matching ${materialPattern}`);
  const { primitive } = records[0];
  const indices = accessorReader(payload, primitive.indices);
  const positions = accessorReader(payload, primitive.attributes.POSITION);
  const triangles = new Map();
  for (let index = 0; index < indices.accessor.count; index += 3) {
    const signature = [];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices.readComponent(index + corner);
      for (let axis = 0; axis < 3; axis++) signature.push(positions.readComponent(vertex, axis));
    }
    const key = signature.join(',');
    triangles.set(key, (triangles.get(key) ?? 0) + 1);
  }
  return triangles;
}

function actualBounds(payload) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { primitive } of primitiveRecords(payload)) {
    const positions = accessorReader(payload, primitive.attributes.POSITION);
    for (let vertex = 0; vertex < positions.accessor.count; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positions.readComponent(vertex, axis);
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  }
  return { min, max };
}

function structuralAttributeHashes(payload, foliagePattern) {
  return new Map(primitiveRecords(payload).filter(({ material }) => !foliagePattern.test(material)).map(({ material, primitive }) => {
    const attributes = Object.entries(primitive.attributes).sort(([a], [b]) => a.localeCompare(b));
    const digest = createHash('sha256');
    const indices = accessorReader(payload, primitive.indices);
    digest.update('INDICES');
    for (let element = 0; element < indices.accessor.count; element++) {
      digest.update(String(indices.readComponent(element))).update(',');
    }
    for (const [semantic, accessorIndex] of attributes) {
      digest.update(semantic);
      const values = accessorReader(payload, accessorIndex);
      for (let element = 0; element < values.accessor.count; element++) {
        for (let component = 0; component < values.components; component++) {
          digest.update(String(values.readComponent(element, component))).update(',');
        }
      }
    }
    return [material.replace(/\.\d+$/, ''), digest.digest('hex')];
  }));
}

test('Pine Sapling Small keeps source-faithful whole-spray course LODs', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'polyhaven-pine-sapling-small');
  assert.ok(asset);
  assert.equal(asset.license.sourceUrl, 'https://polyhaven.com/a/pine_sapling_small');
  assert.equal(asset.impostor.kind, 'none');
  assert.equal(asset.lods.length, 3);
  assert.equal(asset.derivativeLineage.pipelineVersion,
    'polyhaven-pine-sapling-small-whole-component-lods@3:three-tier-course-spray-budgets');
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `pine sapling LOD${lod.level} hash`);
  }
});

test('Fir Sapling Medium keeps a dense whole-component middle LOD', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'polyhaven-fir-sapling-medium');
  assert.ok(asset);
  assert.equal(asset.license.sourceUrl, 'https://polyhaven.com/a/fir_sapling_medium');
  assert.equal(asset.impostor.kind, 'none');
  assert.equal(asset.derivativeLineage.pipelineVersion,
    'polyhaven-fir-sapling-medium-whole-component-lods@4:three-tier-course-spray-budgets');
  const derivatives = [];
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `fir sapling LOD${lod.level} hash`);
    derivatives[lod.level] = glbJson(bytes);
  }
  const counts = (derivative) => new Map(derivative.meshes[0].primitives.map((primitive) => [
    derivative.materials[primitive.material].name,
    derivative.accessors[primitive.indices].count,
  ]));
  const near = counts(derivatives[0]);
  const middle = counts(derivatives[1]);
  const far = counts(derivatives[2]);
  assert.equal(middle.get('fir_sapling_medium_branches'), near.get('fir_sapling_medium_branches'));
  assert.equal(middle.get('fir_sapling_medium_branches_dead'), near.get('fir_sapling_medium_branches_dead'));
  assert.equal(far.get('fir_sapling_medium_branches'), near.get('fir_sapling_medium_branches'));
  assert.equal(far.get('fir_sapling_medium_branches_dead'), near.get('fir_sapling_medium_branches_dead'));
  assert.equal(near.get('fir_sapling_medium_twigs'), 660_006);
  assert.equal(middle.get('fir_sapling_medium_twigs'), 330_003);
  assert.ok(far.get('fir_sapling_medium_twigs') < middle.get('fir_sapling_medium_twigs'));
});

test('runtime tree catalog exposes the reviewed CC0 source kit', () => {
  const assets = manifest.assets.filter(({ category }) => category === 'tree');
  assert.deepEqual(assets.map(({ id }) => id), [...required, 'polyhaven-jacaranda-tree']);
  for (const asset of assets) {
    assert.equal(asset.license.spdx, 'CC0-1.0');
  }
  assert.match(assets.find(({ id }) => id === 'blendkit-palm-tree-medium-dense').license.sourceUrl, /^https:\/\/www\.blendkit\.com\/asset-gallery-detail\//);
  assert.doesNotMatch(JSON.stringify(manifest), /conifer_v8/i);
});

test('promoted broadleaf derivatives match their catalog hashes', async () => {
  for (const id of ['polyhaven-tree-small-02-hero', 'polyhaven-island-tree-02', 'polyhaven-island-tree-01']) {
    const asset = manifest.assets.find((candidate) => candidate.id === id);
    assert.ok(asset, `${id} is present`);
    for (const lod of asset.lods) {
      const bytes = await readFile(localUrl(lod.url));
      assert.equal(hash(bytes), lod.sha256, `${id} LOD${lod.level} hash`);
    }
    for (const alphaMap of asset.alphaMaps) {
      const alphaBytes = await readFile(localUrl(alphaMap.url));
      assert.equal(hash(alphaBytes), alphaMap.sha256, `${id} ${alphaMap.material} alpha hash`);
    }
  }
});

test('promoted Pine Tree 01 uses its verified source-material geometry and no image fallback', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'polyhaven-pine-tree-01');
  assert.ok(asset);
  assert.equal(asset.license.sourceUrl, 'https://polyhaven.com/a/pine_tree_01');
  assert.equal(asset.impostor.kind, 'none');
  assert.equal(asset.lods.length, 3);
  assert.equal(asset.derivativeLineage.pipelineVersion,
    'process-pine-tree-blender-5.2-material-preserving-spray-lods@9-three-tier-course-spray-budgets');
  assert.deepEqual(asset.alphaMaps, [{
    material: 'pine_tree_01_twig.001',
    url: '/assets/trees/pine_tree_01_twig_alpha_1k.png',
    sha256: '6f91aa99f2c27108d6f817f874954aa7df8bfbb4dea2673e9322555a6ae79d99',
  }]);
  const alphaBytes = await readFile(localUrl(asset.alphaMaps[0].url));
  assert.equal(hash(alphaBytes), asset.alphaMaps[0].sha256, 'pine authored twig alpha hash');
  const derivatives = [];
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `pine LOD${lod.level} hash`);
    derivatives[lod.level] = glbJson(bytes);
  }
  const sourceMaterials = [
    'pine_tree_01_bark',
    'pine_tree_01_dead_branches',
    'pine_tree_01_trunk_b',
    'pine_tree_01_twig',
  ];
  for (const [level, derivative] of derivatives.entries()) {
    assert.equal(derivative.meshes.length, 4, `pine LOD${level} source material primitives`);
    assert.deepEqual(
      derivative.materials.map(({ name }) => name.replace(/\.\d+$/, '')).sort(),
      sourceMaterials,
      `pine LOD${level} preserves source material identity`,
    );
    assert.equal(derivative.images.length, 9, `pine LOD${level} embeds all source PBR images`);
    for (const mesh of derivative.meshes) {
      assert.equal(mesh.primitives.length, 1);
      assert.deepEqual(
        Object.keys(mesh.primitives[0].attributes).sort(),
        ['COLOR_0', 'COLOR_1', 'NORMAL', 'POSITION', 'TEXCOORD_0'],
        `pine LOD${level} preserves authored vertex streams`,
      );
    }
  }
  const indexCountsByMaterial = (derivative) => new Map(derivative.meshes.map((mesh) => {
    const primitive = mesh.primitives[0];
    const material = derivative.materials[primitive.material].name.replace(/\.\d+$/, '');
    return [material, derivative.accessors[primitive.indices].count];
  }));
  const nearCounts = indexCountsByMaterial(derivatives[0]);
  const farCounts = indexCountsByMaterial(derivatives[1]);
  const distanceCounts = indexCountsByMaterial(derivatives[2]);
  for (const material of sourceMaterials.filter((name) => name !== 'pine_tree_01_twig')) {
    assert.equal(farCounts.get(material), nearCounts.get(material), `${material} cannot collapse into LOD1 shards`);
    assert.equal(distanceCounts.get(material), nearCounts.get(material), `${material} cannot collapse into LOD2 shards`);
  }
  assert.equal(nearCounts.get('pine_tree_01_twig'), 600_288);
  assert.equal(farCounts.get('pine_tree_01_twig'), 240_198);
  assert.ok(distanceCounts.get('pine_tree_01_twig') < farCounts.get('pine_tree_01_twig'));
});

test('Island Tree 02 uses a whole-component authored mesh derivative', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'polyhaven-island-tree-02');
  assert.ok(asset);
  assert.equal(asset.impostor.kind, 'none');
  assert.equal(asset.lods.length, 2);
  assert.equal(asset.derivativeLineage.pipelineVersion, 'island-tree-02-blender-5.2-whole-component-lod@2');
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `island tree LOD${lod.level} hash`);
  }
});

test('Island Tree 01 keeps a dense whole-component authored distance mesh', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'polyhaven-island-tree-01');
  assert.ok(asset);
  assert.equal(asset.lods.length, 2);
  assert.equal(asset.derivativeLineage.pipelineVersion,
    'process-tree-multimaterial-blender-5.2@1+exact-gpu-lod-pair@1');
  assert.equal(asset.lods[0].url, asset.lods[1].url,
    'the exact authored mesh is retained across both GPU residency bands');
  assert.equal(asset.lods[0].sha256, asset.lods[1].sha256);
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `island tree 01 LOD${lod.level} hash`);
  }
});

test('Fir Tree 01 keeps source PBR maps and whole connected foliage components', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'polyhaven-fir-tree-01');
  assert.ok(asset);
  assert.equal(asset.license.sourceUrl, 'https://polyhaven.com/a/fir_tree_01');
  assert.equal(asset.impostor.kind, 'none');
  assert.equal(asset.lods.length, 3);
  assert.equal(asset.derivativeLineage.pipelineVersion,
    'build_fir_tree_source_candidate@7-nested-source-faithful-three-tier-course-spray-budgets:variant-b');
  const derivatives = [];
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `fir LOD${lod.level} hash`);
    derivatives[lod.level] = glbJson(bytes);
  }
  const near = derivatives[0].extras;
  const middle = derivatives[1].extras;
  const far = derivatives[2].extras;
  assert.equal(near.baseY, middle.baseY, 'fir LODs share one authored grounding plane');
  assert.deepEqual(near.boundsMin, middle.boundsMin, 'fir LODs share exact lower bounds');
  assert.deepEqual(near.boundsMax, middle.boundsMax, 'fir LODs share exact upper bounds');
  assert.equal(near.baseY, far.baseY, 'fir LOD2 shares one authored grounding plane');
  assert.deepEqual(near.boundsMin, far.boundsMin, 'fir LOD2 shares exact lower bounds');
  assert.deepEqual(near.boundsMax, far.boundsMax, 'fir LOD2 shares exact upper bounds');
  const indexCounts = (derivative) => new Map(derivative.meshes[0].primitives.map((primitive) => [
    derivative.materials[primitive.material].name,
    derivative.accessors[primitive.indices].count,
  ]));
  const nearIndices = indexCounts(derivatives[0]);
  const middleIndices = indexCounts(derivatives[1]);
  const farIndices = indexCounts(derivatives[2]);
  for (const role of ['fir_source_bark', 'fir_source_trunk_a', 'fir_source_dead_branches']) {
    assert.equal(middleIndices.get(role), nearIndices.get(role), `${role} index count`);
    assert.equal(farIndices.get(role), nearIndices.get(role), `${role} LOD2 index count`);
  }
  assert.ok(middleIndices.get('fir_source_twig_authored_alpha')
    < nearIndices.get('fir_source_twig_authored_alpha'));
  assert.ok(farIndices.get('fir_source_twig_authored_alpha')
    < middleIndices.get('fir_source_twig_authored_alpha'));
});

test('promoted palm LODs match their catalog hashes', async () => {
  const asset = manifest.assets.find(({ id }) => id === 'blendkit-palm-tree-medium-dense');
  assert.ok(asset);
  assert.equal(asset.lods.length, 2);
  for (const lod of asset.lods) {
    const bytes = await readFile(localUrl(lod.url));
    assert.equal(hash(bytes), lod.sha256, `palm LOD${lod.level} hash`);
  }
});

test('course tree LOD1 geometry is a strict nested subset with identical structure and bounds', async () => {
  for (const [assetId, foliagePattern] of [
    ['polyhaven-pine-sapling-small', /pine_sapling_small_twig/i],
    ['polyhaven-fir-sapling-medium', /fir_sapling_medium_twigs/i],
    ['polyhaven-pine-tree-01', /pine_tree_01_twig/i],
    ['polyhaven-fir-tree-01', /fir_source_twig_authored_alpha/i],
  ]) {
    const asset = manifest.assets.find(({ id }) => id === assetId);
    const payloads = await Promise.all(asset.lods.map(async ({ url }) => glbPayload(await readFile(localUrl(url)))));
    const nearTriangles = trianglePositionMultiset(payloads[0], foliagePattern);
    const middleTriangles = trianglePositionMultiset(payloads[1], foliagePattern);
    assert.ok(middleTriangles.size < nearTriangles.size, `${assetId} LOD1 reduces foliage`);
    for (const [triangle, count] of middleTriangles) {
      assert.ok((nearTriangles.get(triangle) ?? 0) >= count,
        `${assetId} LOD1 foliage triangle multiplicity must be a strict LOD0 subset`);
    }
    assert.deepEqual(structuralAttributeHashes(payloads[1], foliagePattern),
      structuralAttributeHashes(payloads[0], foliagePattern), `${assetId} structural attributes`);
    assert.deepEqual(actualBounds(payloads[1]), actualBounds(payloads[0]), `${assetId} actual accessor bounds`);
    for (const payload of payloads) {
      assert.equal(payload.json.extras?.coursePerformanceDerivative?.pipelineVersion,
        'whole-authored-spray-thinner@2');
      assert.deepEqual(payload.json.extras.boundsMin, actualBounds(payload).min);
      assert.deepEqual(payload.json.extras.boundsMax, actualBounds(payload).max);
    }
  }
});
