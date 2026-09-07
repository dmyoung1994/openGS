import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COURSE_PROJECT_SCHEMA_VERSION, applyCourseMutations, compileActiveCourse,
  migrateCourseProjectV4, migrateCourseV3, normalizeCourseProject, projectRevision,
} from '../src/course/CourseProject.js';

const runtime = JSON.parse(await readFile(new URL('../course.json', import.meta.url), 'utf8'));
const shipped = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));

test('shipped v5 project validates and compiles to the existing strict runtime contract', () => {
  const project = normalizeCourseProject(shipped);
  const compiled = compileActiveCourse(project);
  assert.equal(project.meta.schema, COURSE_PROJECT_SCHEMA_VERSION);
  assert.equal(compiled.runtime.meta.schema, 4);
  assert.deepEqual(compiled.runtime, runtime);
  assert.equal(compiled.runtime.routing.holes.length, 3);
  assert.equal(compiled.runtime.landforms.length, 17);
  assert.equal(compiled.normalized.environment.objectCount, 421);
});

test('v4 synthetic records migrate to reusable v5 definitions and placements', () => {
  const legacy = structuredClone(shipped);
  legacy.meta.schema = 4;
  delete legacy.site.environment.proceduralTreeDefinitions;
  delete legacy.site.environment.proceduralTrees;
  legacy.site.environment.syntheticTrees = [{
    id: 'legacy-oak', archetype: 'live-oak', x: 100, z: 300,
    rotationY: 0.4, scale: 1, seed: 4, age: 0.8, health: 0.9, windExposure: 0.5,
  }];
  const migrated = migrateCourseProjectV4(legacy);
  assert.equal(migrated.meta.schema, 5);
  assert.equal(migrated.site.environment.proceduralTreeDefinitions[0].id, 'builtin-live-oak');
  assert.equal(migrated.site.environment.proceduralTrees[0].definitionId, 'builtin-live-oak');
  assert.equal('syntheticTrees' in migrated.site.environment, false);
});

test('v3 migration is deterministic and gives every authorable feature a stable ID', () => {
  const legacy = legacyActiveHoleRuntime(runtime);
  const first = migrateCourseV3(legacy);
  const second = migrateCourseV3(legacy);
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
  assert.equal(changed.holes[1].greens[0].r, project.holes[1].greens[0].r);
  assert.throws(() => applyCourseMutations(project, [{ op: 'patch', entityType: 'green', entityId: green.id, value: green }]), /unsupported/);
});

test('course agent can create, revise, and delete one forest-floor-area entity', () => {
  const project = normalizeCourseProject(shipped);
  const area = {
    id: 'agent-pine-straw-bed',
    shape: [
      { x: -420, z: -220 }, { x: -390, z: -220 },
      { x: -386, z: -190 }, { x: -420, z: -188 },
    ],
  };
  const created = applyCourseMutations(project, [{
    op: 'create', entityType: 'forest-floor-area', entityId: area.id,
    parentId: 'forestFloorAreas', value: area,
  }]);
  assert.equal(created.site.forestFloorAreas.at(-1).id, area.id);
  const revised = structuredClone(area);
  revised.shape[1].x = -388;
  const replaced = applyCourseMutations(created, [{
    op: 'replace', entityType: 'forest-floor-area', entityId: area.id,
    parentId: 'forestFloorAreas', value: revised,
  }]);
  assert.equal(replaced.site.forestFloorAreas.at(-1).shape[1].x, -388);
  const deleted = applyCourseMutations(replaced, [{
    op: 'delete', entityType: 'forest-floor-area', entityId: area.id,
    parentId: 'forestFloorAreas',
  }]);
  assert.equal(deleted.site.forestFloorAreas.some(({ id }) => id === area.id), false);
});

test('course agent can tune surface materials without replacing the site', () => {
  const project = normalizeCourseProject(shipped);
  const materials = structuredClone(project.site.surfaceMaterials);
  materials.forestFloor.crownFeatherMeters = 0.25;
  const changed = applyCourseMutations(project, [{
    op: 'replace', entityType: 'surface-materials', entityId: 'surface-materials', value: materials,
  }]);
  assert.equal(changed.site.surfaceMaterials.forestFloor.crownFeatherMeters, 0.25);
  assert.deepEqual(changed.site.bounds, project.site.bounds);
});

test('singleton mutations require their canonical stable target IDs', () => {
  const project = normalizeCourseProject(shipped);
  assert.throws(() => applyCourseMutations(project, [{
    op: 'replace', entityType: 'atmosphere', entityId: 'site-atmosphere', value: project.site.atmosphere,
  }]), /must target "atmosphere"/);
  assert.throws(() => applyCourseMutations(project, [{
    op: 'replace', entityType: 'surface-materials', entityId: 'materials', value: project.site.surfaceMaterials,
  }]), /must target "surface-materials"/);
});

test('adjacent-hole routing rejects a next tee inside the previous green miss zone', () => {
  const unsafe = structuredClone(shipped);
  const targetTee = { x: -27, z: -128 };
  const placement = unsafe.site.routing.placements.find(({ holeId }) => holeId === 'pineglass-hole-3');
  const radians = placement.bearingDegrees * Math.PI / 180;
  placement.origin = {
    x: targetTee.x + Math.sin(radians) * 2,
    z: targetTee.z - Math.cos(radians) * 2,
  };
  const transition = unsafe.site.routing.transitions.find(({ toHoleId }) => toHoleId === 'pineglass-hole-3');
  transition.points = [transition.points[0], { x: -45, z: -127 }, targetTee];
  assert.throws(() => normalizeCourseProject(unsafe), /adjacent tees require|long-shot miss cone/);
});

test('one schema supports both single-hole and full-course project sizes', () => {
  const project = structuredClone(normalizeCourseProject(shipped));
  delete project.site.routing;
  project.site.bounds = { minX: -500, maxX: 500, minZ: -800, maxZ: 120 };
  project.site.forestFloorAreas = [];
  project.site.environment.proceduralTrees = [];
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

function legacyActiveHoleRuntime(course) {
  const legacy = structuredClone(course);
  const hole = legacy.routing.holes.find((entry) => entry.holeId === legacy.routing.activeHoleId);
  legacy.meta.schema = 3;
  legacy.meta.name = 'Legacy migration fixture';
  legacy.tee = structuredClone(hole.tees[0]);
  delete legacy.tee.shape; delete legacy.tee.holeId;
  legacy.corridor = { c0: hole.route.c0, k: hole.route.k, rough: hole.route.rough };
  legacy.fringeW = hole.fringeWidth;
  legacy.greens = legacy.greens.slice(hole.greenStart, hole.greenStart + hole.greenCount);
  legacy.bunkers = legacy.bunkers.slice(hole.bunkerStart, hole.bunkerStart + hole.bunkerCount);
  legacy.ponds = legacy.ponds.slice(hole.pondStart, hole.pondStart + hole.pondCount);
  legacy.landforms = legacy.landforms.slice(hole.landformStart, hole.landformStart + hole.landformCount);
  legacy.environment = { ...legacy.environment, objectBudget: 0, placements: [], scatter: [], assembly: [], edgeDressing: [], exclusions: [], syntheticTrees: [], proceduralTrees: [] };
  delete legacy.routing;
  return legacy;
}
