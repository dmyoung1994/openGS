import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  PerspectiveCamera,
  Texture,
  WebGPUCoordinateSystem,
} from 'three';
import { TreeBeautyLod0, TreeShadowLod0 } from '../src/scene/Trees.js';

const renderer = {
  isWebGPURenderer: true,
  coordinateSystem: WebGPUCoordinateSystem,
  reversedDepthBuffer: false,
  _attributes: { delete() {} },
};

function makeFixture() {
  const geometry = new BoxGeometry(2, 4, 2);
  const colors = new Float32Array(geometry.getAttribute('position').count * 3);
  for (let index = 0; index < colors.length; index += 3) {
    colors[index] = 1;
    colors[index + 1] = 0.9;
    colors[index + 2] = 0.7;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const branchGeometry = new BoxGeometry(0.5, 4, 0.5);
  const authoredMap = new Texture();
  const branchMap = new Texture();
  const material = new MeshStandardMaterial({ color: 0x6d8f48, map: authoredMap, vertexColors: true });
  const branchMaterial = new MeshStandardMaterial({ color: 0x5a3a22, map: branchMap });
  const proto = {
    parts: [
      { geometry, material, sourceName: 'authored-canopy' },
      { geometry: branchGeometry, material: branchMaterial, sourceName: 'authored-branches' },
    ],
    height: 4,
    plantBaseY: -2,
  };
  const placements = [
    { x: 0, y: 0, z: -12, targetHeight: 4, rotationY: 0.15 },
    { x: 100, y: 0, z: -12, targetHeight: 4, rotationY: 0.35 },
    // This is deliberately far, but still inside the camera far plane.  A
    // visibility-only compactor must retain it.
    { x: 0, y: 0, z: -500, targetHeight: 4, rotationY: 0.55 },
    { x: 0, y: 0, z: 12, targetHeight: 4, rotationY: 0.75 },
  ];
  const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -1);
  camera.updateProjectionMatrix();
  const beauty = new TreeBeautyLod0({
    renderer,
    camera,
    motionHistory: { valid: false },
    proto,
    placements,
    assetId: 'fixture-lod0',
  });
  return { geometry, branchGeometry, authoredMap, branchMap, beauty, camera };
}

function cleanup(fixture, shadow = null) {
  shadow?.dispose();
  fixture.beauty.dispose();
}

function matrixAt(mesh, slot) {
  return Array.from(mesh.instanceMatrix.array.slice(slot * 16, slot * 16 + 16));
}

test('LOD0 compacts only camera-frustum-intersecting records and keeps exact transforms', () => {
  const fixture = makeFixture();
  try {
    const { beauty, camera, geometry, branchGeometry, authoredMap, branchMap } = fixture;
    const mesh = beauty.meshes[0];
    const branchMesh = beauty.meshes[1];
    assert.equal(beauty.sourceCount, 4);
    assert.equal(beauty.records.length, 4);
    assert.equal(beauty.meshes.length, 2, 'one InstancedMesh is used for each authored primitive');
    assert.equal(mesh.geometry, geometry);
    assert.equal(branchMesh.geometry, branchGeometry);
    assert.equal(mesh.material.map, authoredMap);
    assert.equal(branchMesh.material.map, branchMap);
    assert.equal(mesh.userData.treeSourceCount, 4);

    const frustumRef = beauty._frustum;
    const boundsRef = beauty._worldBounds;
    const activeIndicesRef = beauty._activeIndices;
    assert.equal(beauty.update(camera), true);
    assert.equal(beauty.activeCount, 2);
    assert.equal(mesh.count, 2);
    assert.equal(branchMesh.count, 2);
    assert.deepEqual(Array.from(beauty._activeIndices.slice(0, beauty.activeCount)), [0, 2]);
    assert.deepEqual(matrixAt(mesh, 0), Array.from(new Float32Array(beauty.records[0].matrix.elements)));
    assert.deepEqual(matrixAt(mesh, 1), Array.from(new Float32Array(beauty.records[2].matrix.elements)));
    assert.deepEqual(matrixAt(branchMesh, 0), Array.from(new Float32Array(beauty.records[0].matrix.elements)));
    assert.deepEqual(matrixAt(branchMesh, 1), Array.from(new Float32Array(beauty.records[2].matrix.elements)));

    // The visibility buffers and reusable math objects are stable across frames;
    // no per-frame active-list, bound, or frustum object is allocated.
    assert.equal(beauty.update(camera), false);
    assert.strictEqual(beauty._frustum, frustumRef);
    assert.strictEqual(beauty._worldBounds, boundsRef);
    assert.strictEqual(beauty._activeIndices, activeIndicesRef);
  } finally {
    cleanup(fixture);
  }
});

test('LOD0 keeps every source record and reports camera compaction separately from reduction', () => {
  const fixture = makeFixture();
  try {
    const { beauty, camera } = fixture;
    beauty.update(camera);
    beauty.setWorkloadPolicy('battery');
    const workload = beauty.workloadDiagnostics();
    const diagnostics = beauty._diagnostics();
    const residency = beauty.residencyEstimate(camera);

    assert.equal(beauty.records.length, 4, 'off-frustum records remain immutable source records');
    assert.equal(workload.sourceCount, 4);
    assert.equal(workload.activeCount, 2);
    assert.equal(workload.sourceRecordsKept, true);
    assert.equal(workload.reductionSupported, false);
    assert.equal(workload.state.sourceRecordsKept, true);
    assert.equal(workload.state.exactLod0, true);
    assert.equal(workload.unsupportedReason, 'exact-authored-lod0-only');
    assert.equal(workload.visibility, 'camera-frustum-instance-compaction');
    assert.equal(diagnostics.sourceCount, 4);
    assert.equal(diagnostics.activeCount, 2);
    assert.equal(residency.sourceCount, 4);
    assert.equal(residency.activeCount, 2);
    assert.equal(residency.counts.lod0, 4, 'frustum visibility never masquerades as LOD reduction');
    assert.equal(residency.counts.rejected, 0, 'there is no distance or budget hole');
  } finally {
    cleanup(fixture);
  }
});

test('LOD0 shadows retain the complete exact source list when beauty compacts', async () => {
  const fixture = makeFixture();
  const light = { castShadow: true, shadow: { needsUpdate: false } };
  let shadow;
  try {
    shadow = new TreeShadowLod0({ light, beauty: fixture.beauty });
    fixture.beauty.update(fixture.camera);
    assert.equal(fixture.beauty.activeCount, 2);
    assert.equal(shadow.meshes.length, 2);
    assert.equal(shadow.meshes[0].count, fixture.beauty.sourceCount);
    assert.equal(shadow.meshes[1].count, fixture.beauty.sourceCount);
    assert.deepEqual(
      matrixAt(shadow.meshes[0], 2),
      Array.from(new Float32Array(fixture.beauty.records[2].matrix.elements)),
    );
    assert.equal(shadow.update(), false, 'shadow update does not reuse the camera prefix');
    const diagnostics = await shadow.readDiagnostics();
    assert.equal(diagnostics.sourceCount, 4);
    assert.equal(diagnostics.activeCount, 4);
    assert.equal(diagnostics.beautyActiveCount, 2);
  } finally {
    cleanup(fixture, shadow);
  }
});
