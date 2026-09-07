import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FlagClothSystem, FLAG_COLUMNS, FLAG_ROWS, FLAG_WIDTH, FLAG_HEIGHT,
  FLAGSTICK_COLLISION_RADIUS,
} from '../src/scene/FlagCloth.js';

function environment(wind = { x: 0, y: 0, z: 0 }) {
  return {
    time: { value: 0 },
    sampleWindCpu(_position, _time, out) { out.x = wind.x; out.y = wind.y; out.z = wind.z; return out; },
  };
}

function run(system, env, frames = 480) {
  for (let frame = 0; frame < frames; frame++) { env.time.value += 1 / 120; system.update(); }
}

test('a new shot clock retires the previous epoch remainder without resetting cloth', () => {
  const env = environment({ x: 3, y: 0, z: 1 });
  const sample = env.sampleWindCpu;
  const times = [];
  env.sampleWindCpu = (position, time, out) => {
    assert.ok(Number.isFinite(time) && time >= 0, `invalid wind time ${time}`);
    times.push(time);
    return sample(position, time, out);
  };
  const cloth = new FlagClothSystem({ anchors: [{ x: 0, y: 2.3, z: 0 }], environment: env });
  env.time.value = 0.02;
  cloth.update();
  const shape = cloth.positions.slice();
  env.time.value = 0;
  cloth.update();
  assert.deepEqual(cloth.positions, shape);
  env.time.value = 1 / 120;
  cloth.update();
  assert.equal(times.at(-1), 0);
  assert.equal(cloth.diagnostics().finite, true);
  cloth.dispose();
});

test('cloth motion history retains the last presented shape across multiple physics steps', () => {
  const env = environment({ x: 8, y: 0.3, z: 3 });
  const cloth = new FlagClothSystem({ anchors: [{ x: 0, y: 2.3, z: 0 }], environment: env });
  const initial = cloth.positions.slice();
  env.time.value += 1 / 30;
  cloth.update();
  assert.deepEqual(cloth.renderPrevious.array, initial);
  assert.notDeepEqual(cloth.positions, initial);
  assert.notDeepEqual(cloth.renderPrevious.array, cloth.previous, 'solver history is not render history');
  const lastPresented = cloth.positions.slice();
  cloth.update();
  assert.deepEqual(cloth.renderPrevious.array, lastPresented, 'a frozen frame must retire old motion');
  assert.ok(cloth.material.positionNode);
  cloth.dispose();
});

test('merged flag cloth is deterministic, finite, pinned, and bounded in strong wind', () => {
  assert.equal(FLAGSTICK_COLLISION_RADIUS, 0.0075);
  const aEnv = environment({ x: 11, y: 0.4, z: 4 });
  const bEnv = environment({ x: 11, y: 0.4, z: 4 });
  const options = { anchors: [{ x: 0, y: 2.3, z: 0 }, { x: 12, y: 3, z: -30 }], colors: [0xffffff, 0xccddcc] };
  const a = new FlagClothSystem({ ...options, environment: aEnv });
  const b = new FlagClothSystem({ ...options, environment: bEnv });
  run(a, aEnv); run(b, bEnv);
  assert.deepEqual(a.positions, b.positions);
  const diagnostics = a.diagnostics();
  assert.equal(diagnostics.finite, true);
  assert.equal(diagnostics.pinnedDrift, 0);
  assert.ok(diagnostics.maxStretch < 1.4);
  assert.equal(diagnostics.verticesPerFlag, FLAG_COLUMNS * FLAG_ROWS);
  assert.equal(a.mesh.castShadow, false, 'moving cloth must not invalidate course-scale directional shadows');
  a.dispose(); b.dispose();
});

test('calm cloth settles without non-finite state', () => {
  const env = environment();
  const cloth = new FlagClothSystem({ anchors: [{ x: 0, y: 2.3, z: 0 }], environment: env });
  run(cloth, env, 900);
  assert.equal(cloth.diagnostics().finite, true);
  assert.equal(cloth.diagnostics().pinnedDrift, 0);
  cloth.dispose();
});

test('presentation cloth dimensions are explicit without changing production defaults', () => {
  const env = environment({ x: 3, y: 0, z: 1 });
  const standard = new FlagClothSystem({ anchors: [{ x: 0, y: 2.3, z: 0 }], environment: env });
  const presentation = new FlagClothSystem({
    anchors: [{ x: 0, y: 2.3, z: 0 }], environment: env, width: 1.45, height: 0.78,
  });
  assert.equal(standard.diagnostics().width, FLAG_WIDTH);
  assert.equal(standard.diagnostics().height, FLAG_HEIGHT);
  assert.equal(presentation.diagnostics().width, 1.45);
  assert.equal(presentation.diagnostics().height, 0.78);
  standard.dispose(); presentation.dispose();
});
