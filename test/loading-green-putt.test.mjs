import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Vector3 } from 'three';
import { solveLoadingGreenPutt } from '../src/scene/LoadingGreenPutt.js';
import { createCreatorCanvasCourse } from '../src/course/CreatorCanvas.js';
import { normalizeCourse } from '../src/course/course.js';
import { semanticLandformHeight } from '../src/course/SemanticLandforms.js';
import { signedDistanceToFeature } from '../src/course/featureGeometry.js';
import { sampleHeightfield, sampleHeightfieldNormal } from '../src/terrain/Heightfield.js';

test('putt worker uses the exact transferred production heightfield and Ball trajectory', async () => {
  const course = normalizeCourse(createCreatorCanvasCourse({ seed: 42 }));
  const spacing = 0.6, bounds = course.bounds;
  const nx = Math.floor((bounds.maxX - bounds.minX) / spacing) + 1;
  const nz = Math.floor((bounds.maxZ - bounds.minZ) / spacing) + 1;
  const heights = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) heights[z * nx + x] = semanticLandformHeight(
    course.landforms, bounds.minX + x * spacing, bounds.minZ + z * spacing);
  const cup = course.greens[0], start = { x: cup.x + 4, z: cup.z };
  const snapshot = { bounds, spacing, nx, nz, heights };
  const terrain = { ...snapshot,
    heightAt(x, z) { return sampleHeightfield(this, x, z); },
    normalAt(x, z, out = new Vector3()) { return sampleHeightfieldNormal(this, x, z, out); },
    surfaceAt(x, z) { return signedDistanceToFeature(cup, x, z) > 0 ? 'green' : 'fringe'; },
  };
  const expected = solveLoadingGreenPutt(terrain, start, cup);
  assert.ok(expected);
  const workerUrl = new URL('../src/scene/LoadingGreenPutt.worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: value => parentPort.postMessage(value) };
    import(${JSON.stringify(workerUrl)}).then(() => parentPort.on('message', data => self.onmessage({ data })));
  `, { eval: true });
  try {
    const response = new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    const copy = heights.slice();
    worker.postMessage({ terrain: { ...snapshot, heights: copy }, green: cup }, [copy.buffer]);
    worker.postMessage({ requestId: 7, start, cup });
    const actual = await response;
    assert.equal(actual.requestId, 7);
    assert.equal(actual.error, undefined);
    assert.deepEqual(actual.putt, structuredClone(expected));
    assert.equal(copy.byteLength, 0, 'only the worker copy should be detached');
    assert.equal(heights.length, nx * nz, 'live terrain keeps its collision/GPU data');
  } finally { await worker.terminate(); }
});

test('loading putts follow the real slope, arrive slowly inside the cup, and are deterministic', () => {
  const terrain = {
    heightAt: (x, z) => 0.018 * x + 0.003 * z * z,
    normalAt: (x, z) => new Vector3(-0.018, 1, -0.006 * z).normalize(),
    surfaceAt: () => 'green',
  };
  const start = { x: 0, z: 4 }, cup = { x: 0, z: 0 };
  const putt = solveLoadingGreenPutt(terrain, start, cup);
  assert.ok(putt, 'a moderate cross-slope putt must be solvable');
  assert.deepEqual(putt, solveLoadingGreenPutt(terrain, start, cup));
  assert.ok(Math.max(...putt.samples.map(p => p.x)) > 0.04, 'ball must break, not follow a straight interpolated path');
  assert.ok(putt.arrivalSpeed < 0.85);
  const last = putt.samples.at(-1);
  assert.ok(Math.hypot(last.x, last.z) < 0.004);
  for (const p of putt.samples) assert.ok(Math.abs(p.y - terrain.heightAt(p.x, p.z) - 0.02135) < 0.0001);
  assert.equal(solveLoadingGreenPutt({ ...terrain, surfaceAt: () => 'fringe' }, start, cup), null);
  assert.throws(() => solveLoadingGreenPutt(terrain, { x: NaN, z: 0 }, cup), /finite/);
});

test('seeded creator contours provide verified makes from varied parts of the green', () => {
  for (const seed of [3, 42, 246813579]) {
    const course = normalizeCourse(createCreatorCanvasCourse({ seed }));
    const cup = course.greens[0];
    const heightAt = (x, z) => semanticLandformHeight(course.landforms, x, z);
    const terrain = {
      heightAt,
      normalAt: (x, z) => new Vector3(
        heightAt(x - 0.01, z) - heightAt(x + 0.01, z), 0.02,
        heightAt(x, z - 0.01) - heightAt(x, z + 0.01),
      ).normalize(),
      surfaceAt: (x, z) => signedDistanceToFeature(cup, x, z) > 0 ? 'green' : 'fringe',
    };
    let made = 0;
    for (let i = 0; i < 6; i++) {
      const angle = i / 6 * Math.PI * 2;
      const putt = solveLoadingGreenPutt(terrain,
        { x: cup.x + Math.cos(angle) * 4, z: cup.z + Math.sin(angle) * 4 }, cup);
      if (putt) {
        made++;
        const end = putt.samples.at(-1);
        assert.ok(Math.hypot(end.x - cup.x, end.z - cup.z) < 0.004);
      }
    }
    assert.ok(made >= 3, `seed ${seed}: insufficient solved positions (${made})`);
  }
});
