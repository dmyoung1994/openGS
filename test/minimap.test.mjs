import assert from 'node:assert/strict';
import test from 'node:test';
import { Minimap, createHoleMapTransform, createHoleShotPlan, resolveAimTarget } from '../src/ui/Minimap.js';
import { readFile } from 'node:fs/promises';

test('minimap yields during preparation and never installs an obsolete hole map', async (t) => {
  const oldDocument = globalThis.document, oldFrame = globalThis.requestAnimationFrame;
  let time = 0, yielded = false, installed = false;
  t.mock.method(performance, 'now', () => (time += 7));
  const context = {
    clearRect() {}, createImageData: () => ({ data: new Uint8ClampedArray(320 * 430 * 4) }),
    putImageData() { installed = true; },
  };
  const minimap = Object.assign(Object.create(Minimap.prototype), {
    terrain: { _zoneMap: { bounds: {} }, heightAt() { return 0; } },
    transform: {}, ctx: context, el: { width: 320, height: 430 },
  });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  globalThis.requestAnimationFrame = callback => {
    yielded = true;
    minimap.transform = {}; // A different hole takes ownership during the paint.
    callback();
  };
  try {
    await minimap._rasterise();
    assert.equal(yielded, true);
    assert.equal(installed, false);
    assert.equal(minimap._course, null);
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldFrame === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = oldFrame;
  }
});

test('active-hole map is target-up, round-trips dogleg points, and validates aim targets', () => {
  const hole = {
    route: {
      points: [{ x: 20, z: 100 }, { x: -5, z: 15 }, { x: 35, z: -90 }],
      c0: 18,
      rough: 9,
      k: 0.01,
    },
  };
  const transform = createHoleMapTransform(hole);
  const tee = transform.worldToMap(hole.route.points[0]);
  const green = transform.worldToMap(hole.route.points.at(-1));
  assert.ok(green.y < tee.y, 'the target end should be above the tee');
  for (const point of hole.route.points) {
    const mapped = transform.worldToMap(point);
    const roundTrip = transform.mapToWorld(mapped);
    assert.ok(mapped.x > 0 && mapped.x < transform.width && mapped.y > 0 && mapped.y < transform.height);
    assert.ok(Math.abs(roundTrip.x - point.x) < 1e-9);
    assert.ok(Math.abs(roundTrip.z - point.z) < 1e-9);
  }

  const aim = resolveAimTarget({ x: 20, z: 100 }, { x: 35, z: -90 }, { minX: -100, maxX: 100, minZ: -120, maxZ: 120 });
  assert.ok(Math.abs(Math.hypot(aim.direction.x, aim.direction.z) - 1) < 1e-12);
  assert.deepEqual(resolveAimTarget({ x: 0, z: 0 }, { x: 0.05, z: 0 }, null).direction, { x: 1, z: 0 });
  assert.throws(() => resolveAimTarget({ x: 0, z: 0 }, { x: 0.005, z: 0 }, null), /at least one centimetre/);
  assert.throws(() => resolveAimTarget({ x: 0, z: 0 }, { x: 101, z: 0 }, { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }), /inside/);
});

test('shot plan uses discrete golf legs instead of the curved survey centerline', () => {
  const route = { points: [{ x: 0, z: 0 }, { x: 0, z: -180 }, { x: 90, z: -300 }, { x: 90, z: -430 }] };
  const green = { x: 90, z: -430 };
  const par3 = createHoleShotPlan({ par: 3, route }, green);
  const par4 = createHoleShotPlan({ par: 4, route }, green);
  const par5 = createHoleShotPlan({ par: 5, route }, green);
  assert.deepEqual(par3.map(({ role }) => role), ['tee', 'green']);
  assert.deepEqual(par4.map(({ role }) => role), ['tee', 'landing', 'green']);
  assert.deepEqual(par5.map(({ role }) => role), ['tee', 'landing', 'layup', 'green']);
  assert.ok(par4[1].z > green.z && par4[1].z < 0, 'par-four tee shot should end in a fairway landing area');
  assert.ok(par5[2].z > green.z, 'par-five layup should remain short of the green');
});

test('map reuses world forest-floor and fairway mowing fields', async () => {
  const source = await readFile(new URL('../src/ui/Minimap.js', import.meta.url), 'utf8');
  assert.match(source, /terrain\.forestFloorWeightAt\?\.\(world\.x, world\.z, zone\)/);
  assert.match(source, /zone === 'fairway'[\s\S]*mowingStripLay\(world\.x, world\.z\)/);
  assert.doesNotMatch(source, /zone === 'fairway' \|\| zone === 'green' \|\| zone === 'tee'/,
    'map mowing cannot claim surfaces the world fairway shader does not mow');
});
