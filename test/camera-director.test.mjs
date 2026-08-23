import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { CameraDirector } from '../src/camera/CameraDirector.js';
import { readFile } from 'node:fs/promises';

function makeBall() {
  return {
    position: new Vector3(0, 0.021, 2),
    velocity: new Vector3(0, 28, -48),
    start: new Vector3(0, 0.021, 2),
    radius: 0.021,
    terrain: { heightAt: () => 0 },
  };
}

test('flight camera climbs through apex without ever pitching upward', () => {
  const camera = new PerspectiveCamera();
  const director = new CameraDirector(camera);
  const ball = makeBall();
  const aim = new Vector3(0, 0, -1);
  const forward = new Vector3();

  director.setAddress(ball.position, aim);
  director.onLaunch(ball);
  let previousY = camera.position.y;
  for (const [height, verticalSpeed] of [[3, 24], [9, 18], [17, 10], [23, 2]]) {
    ball.position.y = height;
    ball.position.z -= 10;
    ball.velocity.y = verticalSpeed;
    director.update(1 / 30, ball);
    camera.getWorldDirection(forward);
    assert.ok(camera.position.y >= previousY, 'camera must keep climbing before apex');
    assert.ok(forward.y <= 1e-8, `flight camera pitched upward by ${forward.y}`);
    previousY = camera.position.y;
  }

  ball.position.y = 22;
  ball.position.z -= 8;
  ball.velocity.y = -3;
  director.update(1 / 30, ball);
  camera.getWorldDirection(forward);
  assert.equal(director.phase, 'descent');
  assert.ok(forward.y < -0.05, `descent camera should reveal landing ground, got ${forward.y}`);
  assert.ok(director.look.y < ball.position.y, 'descent target must lead below the ball');
  const descentLead = Math.hypot(
    director.look.x - ball.position.x,
    director.look.z - ball.position.z,
  );
  assert.ok(descentLead < 12, `descent framing leads too far ahead of the ball: ${descentLead}`);
});

test('flight camera remains in a close responsive chase envelope', () => {
  const camera = new PerspectiveCamera();
  const director = new CameraDirector(camera);
  const ball = makeBall();
  director.setAddress(ball.position, new Vector3(0, 0, -1));
  director.onLaunch(ball);

  for (let frame = 0; frame < 120; frame++) {
    ball.position.z -= 48 / 60;
    ball.position.y = 8 + Math.sin(frame / 120 * Math.PI) * 18;
    ball.velocity.set(0, frame < 60 ? 8 : -8, -48);
    director.update(1 / 60, ball);
  }
  const horizontalSeparation = Math.hypot(
    camera.position.x - ball.position.x,
    camera.position.z - ball.position.z,
  );
  assert.ok(horizontalSeparation >= 7 && horizontalSeparation <= 21,
    `flight chase should stay close to the ball, got ${horizontalSeparation.toFixed(2)} m`);
});

test('address camera starts directly behind the ball looking down-range', () => {
  const camera = new PerspectiveCamera();
  const director = new CameraDirector(camera);
  const ball = new Vector3(6, 1, -4);
  const aim = new Vector3(0.6, 0, -0.8).normalize();
  const forward = new Vector3();

  director.setAddress(ball, aim);
  const offset = camera.position.clone().sub(ball);
  const horizontalOffset = new Vector3(offset.x, 0, offset.z);
  const expectedBack = aim.clone().multiplyScalar(-4.5);
  assert.ok(horizontalOffset.distanceTo(expectedBack) < 1e-8);
  assert.ok(Math.abs(offset.y - 1.45) < 1e-8);

  camera.getWorldDirection(forward);
  const horizontalForward = new Vector3(forward.x, 0, forward.z).normalize();
  assert.ok(horizontalForward.distanceTo(aim) < 1e-8);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const projectedBall = ball.clone().project(camera);
  assert.ok(projectedBall.y > -0.88 && projectedBall.y < -0.45,
    `ball must begin visible in the lower frame, got NDC y=${projectedBall.y}`);
});

test('result camera returns to address through a damped transition', () => {
  const camera = new PerspectiveCamera();
  const director = new CameraDirector(camera);
  const ball = makeBall();
  const aim = new Vector3(0, 0, -1);

  director.setAddress(ball.position, aim);
  ball.position.set(4, 0.021, -150);
  ball.velocity.set(0, 0, 0);
  director.onRest(ball);
  for (let i = 0; i < 60; i++) director.update(1 / 60, ball);

  const resultPosition = camera.position.clone();
  const resultQuaternion = camera.quaternion.clone();
  const addressBall = new Vector3(0, 0.021, 2);
  director.returnToAddress(addressBall, aim);
  assert.equal(director.phase, 'return');
  assert.ok(camera.position.equals(resultPosition), 'return must not snap on entry');

  director.update(1 / 60, ball);
  assert.ok(camera.position.distanceTo(resultPosition) > 0, 'return should begin moving immediately');
  assert.ok(camera.position.distanceTo(director.pos) > 1, 'first return frame must remain blended');
  assert.ok(camera.position.distanceTo(resultPosition) < 0.5,
    'first return frame must not create a resize-like multi-metre scale jump');
  assert.ok(camera.quaternion.angleTo(resultQuaternion) < 2 * Math.PI / 180,
    'first return frame must not create a resize-like angular jump');

  // The automatic return should finish in about five seconds, not linger for the
  // roughly seven seconds used by the original damped rate.
  for (let i = 0; i < 330; i++) director.update(1 / 60, ball);
  assert.equal(director.phase, 'address');
  assert.ok(camera.position.distanceTo(director.pos) < 0.06);
});

test('production capture harness exercises the real shot flight and return', async () => {
  const source = await readFile(new URL('../scripts/shot.mjs', import.meta.url), 'utf8');
  assert.match(source, /const shotFlightSequence = game && has\('shot-flight-seq'\)/);
  assert.match(source, /requestedSequenceFrames === true \? 180/,
    'bare sequence flags must retain the full default capture length');
  assert.match(source, /else window\.viewer\.setCamera\(position, lookAt\)/,
    'isolated foliage sweeps must exercise the production viewer camera');
  assert.match(source, /diagnostics: window\.viewer\.treeDiagnostics\(\)/,
    'isolated foliage sweeps must record local hierarchy selection');
  assert.doesNotMatch(source, /foliageCandidate/, 'capture harness must stay on the curated Poly Haven runtime lane');
  assert.match(source, /cameraPosition: window\.golf\.sm\.camera\.position\.toArray\(\)/);
  assert.match(source, /ballPosition: window\.golf\.ball\.position\.toArray\(\)/);
  assert.match(source, /shotFlightSequence \? state\.phase === 'result'/,
    'flight capture must span chase/descent until the real result transition');
  assert.match(source, /state\.phase === 'address'/,
    'return capture must span the real result/return/address transition');
});
