import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COURSE_PROJECT_SCHEMA_VERSION, applyCourseMutations, compileActiveCourse,
  migrateCourseV3, normalizeCourseProject, projectRevision,
} from '../src/course/CourseProject.js';

const runtime = JSON.parse(await readFile(new URL('../course.json', import.meta.url), 'utf8'));
const shipped = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));

test('shipped v4 project validates and compiles to the existing strict runtime contract', () => {
  const project = normalizeCourseProject(shipped);
  const compiled = compileActiveCourse(project);
  assert.equal(project.meta.schema, COURSE_PROJECT_SCHEMA_VERSION);
  assert.equal(compiled.runtime.meta.schema, 3);
  assert.equal(compiled.runtime.greens.length, runtime.greens.length);
  assert.deepEqual(compiled.runtime.landforms, []);
  assert.equal(compiled.normalized.environment.objectCount, 509);
});

test('v3 migration is deterministic and gives every authorable feature a stable ID', () => {
  const first = migrateCourseV3(runtime);
  const second = migrateCourseV3(runtime);
  assert.equal(projectRevision(first), projectRevision(second));
  const ids = [
    ...first.holes.map(({ id }) => id), ...first.holes.flatMap(({ tees }) => tees.map(({ id }) => id)),
    ...first.holes.flatMap(({ greens }) => greens.map(({ id }) => id)),
    ...first.holes.flatMap(({ bunkers }) => bunkers.map(({ id }) => id)),
    ...first.holes.flatMap(({ ponds }) => ponds.map(({ id }) => id)),
  ];
  assert.equal(new Set(ids).size, ids.length);
});

test('typed mutations replace exactly one entity and reject stale free-form paths', () => {
  const project = normalizeCourseProject(shipped);
  const green = structuredClone(project.holes[0].greens[0]);
  green.r += 0.5;
  const changed = applyCourseMutations(project, [{
    op: 'replace', entityType: 'green', entityId: green.id, parentId: project.holes[0].id, value: green,
  }]);
  assert.equal(changed.holes[0].greens[0].r, green.r);
  assert.equal(changed.holes[0].greens[1].r, project.holes[0].greens[1].r);
  assert.throws(() => applyCourseMutations(project, [{ op: 'patch', entityType: 'green', entityId: green.id, value: green }]), /unsupported/);
});

test('singleton mutations require their canonical stable target IDs', () => {
  const project = normalizeCourseProject(shipped);
  assert.throws(() => applyCourseMutations(project, [{
    op: 'replace', entityType: 'atmosphere', entityId: 'site-atmosphere', value: project.site.atmosphere,
  }]), /must target "atmosphere"/);
});

test('one schema supports both single-hole and full-course project sizes', () => {
  const project = structuredClone(normalizeCourseProject(shipped));
  const template = project.holes[0];
  project.holes = Array.from({ length: 18 }, (_, index) => {
    const hole = structuredClone(template); const suffix = index + 1;
    const remap = (id) => `${id.slice(0, Math.min(id.length, 48))}-${suffix}`;
    hole.id = `hole-${suffix}`; hole.name = `Hole ${suffix}`; hole.number = suffix; hole.kind = 'hole'; hole.route.id = `hole-${suffix}-route`;
    for (const key of ['tees', 'greens', 'bunkers', 'ponds', 'landforms']) for (const entry of hole[key]) entry.id = remap(entry.id);
    return hole;
  });
  project.activeHoleId = 'hole-1';
  assert.equal(normalizeCourseProject(project).holes.length, 18);
});
