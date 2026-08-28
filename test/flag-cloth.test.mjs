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
