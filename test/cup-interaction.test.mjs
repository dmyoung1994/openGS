import assert from 'node:assert/strict';
import test from 'node:test';
import { cupCaptureSpeed, intersectCupEntry } from '../src/physics/cupInteraction.js';
import { Vector3 } from 'three';
import { Ball } from '../src/physics/Ball.js';
import { makeEnv } from '../src/physics/ballistics.js';

test('published capture envelope narrows with offset and adjusts for uphill/downhill entry', () => {
  assert.equal(cupCaptureSpeed(0, .054), 1.63);
  assert.equal(cupCaptureSpeed(.054, .054), 0);
  assert.equal(cupCaptureSpeed(.027, .054), 1.2225);
  assert.ok(Math.abs(cupCaptureSpeed(0, .054, Math.sin(Math.PI / 36)) - 1.71) < .01);
  assert.ok(Math.abs(cupCaptureSpeed(0, .054, -Math.sin(Math.PI / 36)) - 1.56) < .01);
  const cup = { x: 0, z: 0, radius: .054 };
  const entry = intersectCupEntry({ x: 0, z: .1 }, { x: 0, z: -.1 }, cup);
  assert.ok(Math.abs(entry.t - .23) < 1e-12);
  assert.equal(entry.offset, 0);
  assert.equal(intersectCupEntry({ x: .055, z: .1 }, { x: .055, z: -.1 }, cup), null);
  assert.equal(intersectCupEntry({ x: 0, z: .1 }, { x: 0, z: .08 }, cup), null);
  assert.equal(intersectCupEntry({ x: 0, z: 0 }, { x: 0, z: -.1 }, cup), null);
});

test('production Ball captures a paced putt once, rejects a fast crossing, and preserves misses', () => {
  const terrain = { heightAt: () => 0, normalAt: () => new Vector3(0, 1, 0), surfaceAt: () => 'green' };
  const run = (speed, x = 0, dt = 1 / 60) => {
    const ball = new Ball(terrain, makeEnv({ sampleWind: (_p, _t, out) => out.set(0, 0, 0) }));
    ball.setCup({ x: 0, y: 0, z: 0, radius: .054, depth: .12 });
    ball.placeAt(x, .15);
    ball.start.copy(ball.position);
    ball.velocity.set(0, 0, -speed);
    ball.angularVelocity.set(-speed / ball.radius, 0, 0);
    ball.state = 'rolling';
    const events = [];
    ball.on('holed', () => events.push('holed')).on('rest', result => events.push(result));
    for (let i = 0; i < 1200 && ball.state !== 'rest'; i++) ball.update(dt);
    return { ball, events };
  };
  const made = run(.8), slowerFrames = run(.8, 0, 1 / 30);
  assert.equal(made.ball.holed, true);
  assert.equal(made.events.length, 2);
  assert.equal(made.events[0], 'holed');
  assert.equal(made.events[1].holed, true);
  assert.equal(made.ball.position.y, -.12 + made.ball.radius);
  assert.deepEqual(made.ball.position.toArray(), slowerFrames.ball.position.toArray());
  assert.throws(() => made.ball.launch({ ballSpeed: 2, launchAngle: 0, spinRate: 0 }), /holed/);
  made.ball.placeAt(0, 1);
  assert.equal(made.ball.holed, false);
  assert.equal(run(3).ball.holed, false);
  assert.equal(run(.8, .06).ball.holed, false);
});

test('offline feedback uses the aimed shot line on rotated holes', () => {
  const terrain = { heightAt: () => 0, normalAt: () => new Vector3(0, 1, 0), surfaceAt: () => 'green' };
  const ball = new Ball(terrain, makeEnv({ sampleWind: (_p, _t, out) => out.set(0, 0, 0) }));
  let result;
  ball.on('rest', value => { result = value; });
  ball.placeAt(0, 0);
  ball.launch({ ballSpeed: 5, launchAngle: 0, spinRate: 0, azimuth: 90, aimAzimuth: 90 });
  for (let i = 0; i < 1200 && ball.state !== 'rest'; i++) ball.update(1 / 60);
  assert.ok(result.totalYards > 1);
  assert.ok(Math.abs(result.offlineYards) < 1e-8, 'a straight eastward putt is on line, not right of a northward line');
});
