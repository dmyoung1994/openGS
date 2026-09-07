import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { CameraDirector } from '../src/camera/CameraDirector.js';
import { EvaluatorCamera } from '../src/camera/EvaluatorCamera.js';

function fixture({ freeActive = false } = {}) {
  const camera = new PerspectiveCamera(40, 1, 0.1, 1000);
  camera.position.set(1, 2, 8);
  camera.lookAt(1, 2, 0);
  const director = new CameraDirector(camera);
  director.setAddress(new Vector3(0, 0, 2), new Vector3(0, 0, -1));
  const reasons = [];
  const sceneManager = {
    freezeSimulation: false,
    invalidateTemporalHistory(reason) { reasons.push(reason); },
    renderer: { info: { frame: 0 } },
  };
  const freeCamera = {
    active: freeActive,
    yaw: 0.4,
    pitch: -0.2,
    groundClearance: 0.5,
    enter() { this.active = true; },
    exit() { this.active = false; },
  };
  return { camera, director, sceneManager, freeCamera, reasons,
    evaluator: new EvaluatorCamera({ camera, sceneManager, director, freeCamera }) };
}

test('evaluator exact pose resolves position/lookAt and FOV without director fighting', () => {
  const f = fixture();
  f.evaluator.enter();
  f.evaluator.setPose({ position: [3, 4, 5], lookAt: [3, 4, 0], fov: 55 });
  const state = f.evaluator.getState();
  assert.equal(state.version, '1.0');
  assert.equal(state.namespace, 'evaluatorCamera');
  assert.equal(state.owned, true);
  assert.deepEqual(state.position, [3, 4, 5]);
  assert.deepEqual(state.lookAt, [3, 4, 0]);
  assert.equal(state.fov, 55);
  // A director update is not called by the evaluator loop; this explicit update
  // slot is a no-op and therefore leaves the resolved pose exact.
  f.evaluator.update(1 / 60);
  assert.deepEqual(f.evaluator.getState().position, [3, 4, 5]);
  assert.deepEqual(f.reasons, ['evaluator camera cut']);
});

test('orbit resolves a target/radius and ownership restores director/free camera state', () => {
  const f = fixture({ freeActive: true });
  const before = f.evaluator.getState();
  const phase = f.director.phase;
  f.evaluator.enter();
  assert.equal(f.freeCamera.active, false);
  f.evaluator.orbit({ target: [10, 2, -4], radius: 10, azimuth: 0, elevation: 0 });
  assert.deepEqual(f.evaluator.getState().position, [10, 2, 6]);
  assert.deepEqual(f.evaluator.getState().lookAt, [10, 2, -4]);
  f.evaluator.freeze();
  assert.equal(f.sceneManager.freezeSimulation, true);
  f.evaluator.exit();
  assert.equal(f.evaluator.owned, false);
  assert.equal(f.freeCamera.active, true);
  assert.deepEqual(f.camera.position.toArray(), before.position);
  assert.equal(f.camera.fov, before.fov);
  assert.equal(f.director.phase, phase);
  assert.equal(f.sceneManager.freezeSimulation, false);
  assert.deepEqual(f.reasons, ['evaluator camera cut', 'evaluator camera restore']);
});

test('temporal cuts invalidate history and waitForFrames uses deterministic notifications', async () => {
  const f = fixture();
  f.evaluator.enter();
  const settled = f.evaluator.waitForFrames(2);
  f.evaluator.notifyFrame(10);
  let resolved = false;
  settled.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  f.evaluator.notifyFrame(11);
  const state = await settled;
  assert.equal(state.frame, 11);
  f.evaluator.setFov(48);
  assert.deepEqual(f.reasons, ['evaluator camera cut']);
});

test('movePose preserves temporal history for continuous editor-camera motion', () => {
  const f = fixture();
  f.evaluator.enter();
  f.evaluator.setPose({ position: [3, 4, 5], lookAt: [3, 4, 0], fov: 50 });
  assert.deepEqual(f.reasons, ['evaluator camera cut']);

  f.evaluator.movePose({ position: [3.5, 4, 4.5], lookAt: [3, 4, 0], fov: 50 });
  assert.equal(f.evaluator.continuousMotionActive, true);
  f.evaluator.notifyFrame(1);
  assert.equal(f.evaluator.continuousMotionActive, true);
  f.evaluator.movePose({ position: [4, 4, 4], lookAt: [3, 4, 0], fov: 50 });
  f.evaluator.notifyFrame(2);
  assert.equal(f.evaluator.continuousMotionActive, true);
  f.evaluator.notifyFrame(3);
  assert.equal(f.evaluator.continuousMotionActive, false);

  assert.deepEqual(f.evaluator.getState().position, [4, 4, 4]);
  assert.deepEqual(f.evaluator.getState().lookAt, [3, 4, 0]);
  assert.deepEqual(f.reasons, ['evaluator camera cut']);
});
