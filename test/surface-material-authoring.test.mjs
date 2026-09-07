import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SURFACE_MATERIALS, classifyCourseRuntimeChange, normalizeCourse,
  normalizeSurfaceMaterials,
} from '../src/course/course.js';
import { compileActiveCourse, normalizeCourseProject } from '../src/course/CourseProject.js';

const runtime = JSON.parse(await readFile(new URL('../course.json', import.meta.url), 'utf8'));
const projectSource = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));

test('surface material defaults are strict, versioned, frozen, and shared by project/runtime normalization', () => {
  const normalizedRuntime = normalizeCourse(runtime);
  const normalizedProject = normalizeCourseProject(projectSource);
  assert.deepEqual(normalizedRuntime.surfaceMaterials, normalizedProject.site.surfaceMaterials);
  const withoutAuthoredMaterials = structuredClone(runtime);
  delete withoutAuthoredMaterials.surfaceMaterials;
  assert.deepEqual(normalizeCourse(withoutAuthoredMaterials).surfaceMaterials, DEFAULT_SURFACE_MATERIALS);
  assert.ok(Object.isFrozen(normalizedRuntime.surfaceMaterials.turf));
  assert.ok(Object.isFrozen(normalizedRuntime.surfaceMaterials.forestFloor));
  assert.equal(DEFAULT_SURFACE_MATERIALS.forestFloor.crownFeatherMeters, 0.45,
    'maintained pine-straw beds use a tight organic turf cut by default');
  assert.equal(normalizedProject.site.forestFloorAreas.length, 6);
  assert.ok(normalizedRuntime.forestFloorAreas.every(({ shape }) => shape.length >= 24),
    'compact bed controls must compile into smooth bunker-quality runtime contours');

  for (const mutate of [
    (value) => { value.version = 2; },
    (value) => { value.turf.roughnessBase = 1.01; },
    (value) => { value.forestFloor.reliefDepthMeters = 0.051; },
    (value) => { value.forestFloor.crownFeatherMeters = 0; },
    (value) => { value.turf.unboundedTypo = 1; },
  ]) {
    const value = structuredClone(DEFAULT_SURFACE_MATERIALS);
    mutate(value);
    assert.throws(() => normalizeSurfaceMaterials(value), /surfaceMaterials/);
  }
});

test('project surface materials compile into the strict runtime contract', () => {
  const project = structuredClone(projectSource);
  // Keep this contract test isolated from whichever environment layout the live
  // authoring agents are currently staging in the shared fixture.
  project.site.environment = {
    ...project.site.environment,
    objectBudget: 0,
    placements: [], scatter: [], assembly: [], edgeDressing: [], exclusions: [],
    proceduralTreeDefinitions: [], proceduralTrees: [],
  };
  project.site.surfaceMaterials = structuredClone(DEFAULT_SURFACE_MATERIALS);
  project.site.surfaceMaterials.turf.value = 0.94;
  const compiled = compileActiveCourse(project);
  assert.equal(compiled.runtime.surfaceMaterials.turf.value, 0.94);
  assert.equal(compiled.normalized.surfaceMaterials.forestFloor.crownCoreGrassDensity, 0);
  const overlap = structuredClone(DEFAULT_SURFACE_MATERIALS);
  overlap.forestFloor.crownCoreGrassDensity = 0.04;
  assert.throws(() => normalizeSurfaceMaterials(overlap), /crownCoreGrassDensity/,
    'pine litter and blade geometry are exclusive surface classes');
});

test('runtime change classification isolates material-only edits from rebuilds', () => {
  const current = normalizeCourse(runtime);
  const materialEdit = structuredClone(current);
  materialEdit.surfaceMaterials.turf.detailNormal = 1.2;
  assert.equal(classifyCourseRuntimeChange(current, current), 'unchanged');
  assert.equal(classifyCourseRuntimeChange(current, materialEdit), 'surface-materials-only');

  const geometryEdit = structuredClone(materialEdit);
  geometryEdit.greens[0].r += 0.5;
  assert.equal(classifyCourseRuntimeChange(current, geometryEdit), 'rebuild');
});

test('live authoring wiring uses semantic snapshots and preserves the no-rebuild path', async () => {
  const [main, panel, scene, terrain] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/TurfPanel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/terrain/Terrain.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /classifyCourseRuntimeChange\(range\?\.course, nextCourse\)/);
  assert.match(main, /mode === 'surface-materials-only'/);
  assert.match(main, /range\.applySurfaceMaterials/);
  assert.match(main, /surfaceMaterials: Object\.freeze\(/);
  assert.match(panel, /snapshotSurfaceMaterials/);
  assert.match(panel, /applySurfaceMaterials/);
  assert.doesNotMatch(panel, /uNear0|uNear1|terrain\?\.\[r\.key\]/);
  assert.match(scene, /this\.terrain\.setCanopyPlacements\(canopyPlacements\)/);
  assert.match(scene, /applySurfaceMaterials\(surfaceMaterials\)[\s\S]*this\.terrain\.applySurfaceMaterials\(normalized\)/);
  assert.match(scene, /this\.course = Object\.freeze\(\{ \.\.\.this\.course, surfaceMaterials: snapshot \}\)/);
  assert.match(terrain, /assign\(this\.uCrownFeatherMeters, floor\.crownFeatherMeters\)/);
  assert.match(terrain, /smoothstep\(\s*0\.0, this\.uCrownFeatherMeters, canopyInwardMeters,\s*\)/,
    'persisted crown feathering must affect the live shader boundary');
});
