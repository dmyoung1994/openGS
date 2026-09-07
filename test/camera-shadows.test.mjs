import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectionalLight, PerspectiveCamera, Scene, WebGPUCoordinateSystem } from 'three';
import { CameraShadows } from '../src/scene/CameraShadows.js';
import { Lighting } from '../src/scene/Lighting.js';

test('native cascades follow the camera, blend, retain caster layers, and resize for lens changes', () => {
  const scene = new Scene();
  const sun = new DirectionalLight();
  sun.shadow.mapSize.set(2048, 2048);
  sun.position.set(-80, 60, -10);
  scene.add(sun, sun.target);
  const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 2000);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const csm = new CameraShadows(sun, camera, {
    coordinateSystem: WebGPUCoordinateSystem, reversedDepthBuffer: false,
  });
  csm.setWorkloadPolicy('battery');
  assert.equal(csm.maxFar, 500);
  assert.ok(csm.lights.every(l => l.shadow.mapSize.x === 1024 && l.shadow.radius === 2));
  csm.cameraClearance = 540;
  csm.updateBefore({});
  assert.equal(csm.maxFar, 950, 'overview coverage reaches the ground without allocating larger maps');
  assert.ok(csm.lights.every(l => l.shadow.mapSize.x === 1024));
  csm.cameraClearance = 2;
  csm.updateBefore({});
  assert.equal(csm.maxFar, 500, 'returning to gameplay restores the tighter shadow footprint');
  csm.setWorkloadPolicy('balanced');
  assert.equal(csm.maxFar, 750);
  assert.ok(csm.lights.every(l => l.shadow.mapSize.x === 1536 && l.shadow.radius === 1.5));
  csm.setWorkloadPolicy('quality');
  assert.equal(csm.maxFar, 1000);
  assert.ok(csm.lights.every(l => l.shadow.mapSize.x === 2048 && l.shadow.radius === 1));
  csm.updateBefore({});
  assert.equal(csm.fade, true);
  assert.equal(csm.lights.length, 3);
  const initial = csm.lights.map(light => light.position.clone());
  for (const light of csm.lights) {
    assert.equal(light.shadow.autoUpdate, true);
    assert.ok(light.shadow.camera.layers.mask & 2);
    assert.equal(light.parent, scene);
  }
  camera.position.x = 100;
  camera.updateMatrixWorld();
  csm.updateBefore({});
  assert.ok(csm.lights.every((light, i) => light.position.distanceTo(initial[i]) > 90));
  const width = csm.lights[0].shadow.camera.right;
  camera.fov = 65;
  csm.updateBefore({});
  assert.ok(csm.lights[0].shadow.camera.right > width);
  scene.updateMatrixWorld(true);
  csm.lights.forEach((light, i) => {
    light.shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
    light.shadow.camera.updateProjectionMatrix();
    light.shadow.updateMatrices(light);
    for (const corner of [...csm.frustums[i].vertices.near, ...csm.frustums[i].vertices.far]) {
      const projected = corner.clone().applyMatrix4(camera.matrixWorld).project(light.shadow.camera);
      assert.ok(Math.abs(projected.x) <= 1.001 && Math.abs(projected.y) <= 1.001,
        `cascade ${i} must cover its actual camera-frustum receivers`);
      assert.ok(projected.z >= 0 && projected.z <= 1,
        `cascade ${i} receiver depth must not be clipped`);
    }
  });
  let released = 0;
  for (const node of csm._shadowNodes) node.shadowMap = { dispose() { released++; } };
  csm.dispose();
  assert.equal(released, 3, 'each cascade owns and releases its shadow render target');
  assert.ok(csm.lights.every(light => light.parent === null));
});

test('lighting reports the active cascade coverage instead of only the legacy map', () => {
  const light = new Lighting(new Scene(), new DirectionalLight().position, { shadowMapSize: 1024 });
  assert.equal(light.diagnostics().mode, 'single-map');
  const camera = new PerspectiveCamera(40, 1.5, 0.1, 2000);
  light.enableCameraShadows(camera, { coordinateSystem: WebGPUCoordinateSystem });
  const report = light.diagnostics();
  assert.equal(report.mode, 'camera-cascades');
  assert.equal(report.cascades.cameraId, camera.uuid);
  assert.equal(report.cascades.maxDistanceMeters, 1000);
  assert.equal(report.cascades.fade, true);
  assert.equal(report.cascades.maps.length, 3);
  assert.ok(report.cascades.maps.every(map => map.size[0] === 1024 && (map.casterLayers & 2)));
  light.dispose();
});

test('cascade receiver coverage survives low sun, elevated cameras, and portrait views', () => {
  for (const elevation of [0.02, 0.1, 0.6, 1]) for (const aspect of [0.75, 16 / 9]) for (const yaw of [0, 1.5, 3]) {
    const scene = new Scene(), sun = new DirectionalLight();
    sun.position.set(-1, elevation, -0.4);
    scene.add(sun, sun.target);
    const camera = new PerspectiveCamera(65, aspect, 0.1, 2000);
    camera.coordinateSystem = WebGPUCoordinateSystem;
    camera.position.set(300, 180, -200);
    camera.rotation.set(-0.2, yaw, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const csm = new CameraShadows(sun, camera, { coordinateSystem: WebGPUCoordinateSystem });
    try {
      csm.updateBefore({});
      scene.updateMatrixWorld(true);
      csm.lights.forEach((light, i) => {
        light.shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
        light.shadow.camera.updateProjectionMatrix();
        light.shadow.updateMatrices(light);
        for (const corner of [...csm.frustums[i].vertices.near, ...csm.frustums[i].vertices.far]) {
          const p = corner.clone().applyMatrix4(camera.matrixWorld).project(light.shadow.camera);
          assert.ok(Math.abs(p.x) <= 1.001 && Math.abs(p.y) <= 1.001 && p.z >= 0 && p.z <= 1,
            `clipped receiver: cascade=${i}, elevation=${elevation}, aspect=${aspect}, yaw=${yaw}`);
        }
      });
    } finally { csm.dispose(); }
  }
});
