import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { Grass } from '../src/terrain/Grass.js';

test('grass state starts GPU-aligned without the native vec3 repacking allocation', () => {
  const grass = Object.assign(Object.create(Grass.prototype), { _tileCount: 1 });
  for (const name of ['Clear', 'Tile', 'TileFinalize', 'Candidate', 'RetainedMotion', 'DrawFinalize']) {
    grass[`_build${name}Compute`] = () => ({});
  }
  grass._makeGpuState();
  const state = grass._recordId.value;
  assert.equal(grass._recordId.nodeType, 'uvec4');
  assert.equal(state.itemSize, 4);
  assert.equal(state.count, grass._recordAnchor.value.count);
  assert.equal(state.array.byteLength, state.count * 16);
});

test('stationary grass retains its exact draw list while every camera, policy, and surface change recompacts', () => {
  const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 2000);
  const calls = [];
  const grass = Object.assign(Object.create(Grass.prototype), {
    camera, renderer: { compute(node) { calls.push(node); } },
    environment: { baseWind: { value: new Vector3() }, windProfile: { value: { w: 0 } } },
    radius: 30, workloadPolicy: { radiusScale: 1, densityScale: 1, farTierScale: 1 },
    _motionReady: false, _cameraForwardScratch: new Vector3(), _viewProjectionScratch: new Matrix4(),
    _const: Object.fromEntries(['heightTex', 'zoneTex', 'zoneAuxTex', 'dataTex', 'biomeLandTex', 'biomeWaterTex']
      .map(name => [name, { version: 1 }])),
  });
  for (const name of ['CameraPosition', 'PreviousCameraPosition']) grass[`u${name}`] = { value: new Vector3() };
  for (const name of ['CameraForwardXZ', 'PreviousCameraForwardXZ']) grass[`u${name}`] = { value: new Vector2() };
  for (const name of ['Radius', 'PreviousRadius', 'DensityScale', 'PreviousDensityScale', 'FarTierScale', 'PreviousFarTierScale']) {
    grass[`u${name}`] = { value: 1 };
  }
  grass.uViewProjection = { value: new Matrix4() };
  const full = ['_clearCompute', '_tileCompute', '_tileFinalizeCompute', '_candidateCompute', '_drawFinalizeCompute'];
  for (const name of [...full, '_retainedMotionCompute']) grass[name] = name;
  const update = () => { calls.length = 0; grass.update(0); return [...calls]; };
  assert.deepEqual(update(), full);
  assert.deepEqual(update(), ['_retainedMotionCompute']);
  assert.deepEqual(update(), []);
  for (const wind of [
    () => { grass.environment.baseWind.value.x = 1; },
    () => { grass.environment.baseWind.value.x = 0; grass.environment.windProfile.value.w = 0.1; },
  ]) {
    wind();
    assert.deepEqual(update(), ['_retainedMotionCompute']);
    assert.deepEqual(update(), ['_retainedMotionCompute']);
  }
  grass.environment.windProfile.value.w = 0;
  assert.deepEqual(update(), ['_retainedMotionCompute']);
  assert.deepEqual(update(), []);
  for (const change of [
    () => { camera.position.x += 1; },
    () => { camera.position.y += 1; },
    () => { camera.rotation.y += 0.2; },
    () => { camera.fov += 10; camera.updateProjectionMatrix(); },
    () => { camera.aspect = 0.75; camera.updateProjectionMatrix(); },
    () => { grass.workloadPolicy.radiusScale = 0.9; },
    () => { grass.workloadPolicy.densityScale = 0.8; },
    () => { grass.workloadPolicy.farTierScale = 0.7; },
    ...Object.values(grass._const).map(texture => () => { texture.version++; }),
  ]) {
    change();
    assert.deepEqual(update(), full);
    assert.deepEqual(update(), ['_retainedMotionCompute']);
    assert.deepEqual(update(), []);
    assert.ok(grass.uCameraPosition.value.equals(grass.uPreviousCameraPosition.value));
  }
});
