import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCourse } from '../src/course/course.js';
import { compileActiveCourse } from '../src/course/CourseProject.js';
import { transformLocalPoint } from '../src/course/RouteGeometry.js';
import { createHoleShotPlan } from '../src/ui/Minimap.js';

const raw = JSON.parse(await readFile(new URL('../course.json', import.meta.url), 'utf8'));
const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));

test('moving the pin preserves green geometry and changes the final aim target', () => {
  const baseline = normalizeCourse(raw);
  const changed = structuredClone(raw);
  changed.greens[0].pin = { x: changed.greens[0].x + 3, z: changed.greens[0].z - 2 };
  const normalized = normalizeCourse(changed);
  const { pin, ...geometry } = normalized.greens[0];
  assert.deepEqual(geometry, baseline.greens[0]);
  assert.deepEqual(pin, changed.greens[0].pin);
  assert.deepEqual(createHoleShotPlan(normalized.routing.holes[0], normalized.greens[0]).at(-1), { ...pin, role: 'green' });
  assert.deepEqual(normalized.greens.slice(1), baseline.greens.slice(1));
});

test('pin validation rejects malformed positions and openings outside the green', () => {
  for (const pin of [null, { x: NaN, z: 0 }, { x: 0, z: Infinity }, { x: 0 }, { x: raw.greens[0].x + 30, z: raw.greens[0].z }]) {
    const changed = structuredClone(raw); changed.greens[0].pin = pin;
    assert.throws(() => normalizeCourse(changed), /pin/);
  }
  const circular = structuredClone(raw); delete circular.greens[0].shape;
  circular.greens[0].pin = { x: circular.greens[0].x + circular.greens[0].r - .02, z: circular.greens[0].z };
  assert.throws(() => normalizeCourse(circular), /pin must fit/);
});

test('course compilation transforms the independent local pin with its routed hole', () => {
  const changed = structuredClone(project), hole = changed.holes[2], green = hole.greens[0];
  green.pin = { x: green.x + 2, z: green.z - 1 };
  const placement = changed.site.routing.placements.find(entry => entry.holeId === hole.id);
  const expected = transformLocalPoint(green.pin, placement);
  const baseline = compileActiveCourse(project), compiled = compileActiveCourse(changed);
  const index = compiled.runtime.routing.holes[2].greenStart;
  const { pin, ...geometry } = compiled.runtime.greens[index];
  assert.deepEqual(pin, expected);
  assert.deepEqual(geometry, baseline.runtime.greens[index]);
  assert.deepEqual(compiled.normalized.greens[index].pin, expected);
});
