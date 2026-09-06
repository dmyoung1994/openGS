import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCourseContext } from '../src/course/CourseSelection.js';

const project = {
  activeHoleId: 'one',
  site: { forestFloorAreas: [{ id: 'pine-straw-west', shape: [
    { x: -50, z: -120 }, { x: -20, z: -120 }, { x: -20, z: -95 }, { x: -50, z: -95 },
  ] }], environment: {
    placements: [{ id: 'oak-left', x: -30, z: -80 }],
    syntheticTrees: [], scatter: [{ id: 'fern-bed', region: { kind: 'bounds', minX: 30, maxX: 40, minZ: -90, maxZ: -70 } }],
    assembly: [], edgeDressing: [],
  } },
  holes: [{
    id: 'one', tees: [{ id: 'one-tee', label: 'Back', x: 0, z: 2, boxHalfX: 3, z0: -2, z1: 6 }],
    greens: [{ id: 'one-green', x: 8, z: -140, r: 10 }],
    bunkers: [{ id: 'one-bunker', x: -8, z: -130, r: 5 }],
    ponds: [{ id: 'one-pond', x: 20, z: -100, r: 12 }], landforms: [],
  }],
};

test('selectCourseContext resolves stable playable feature IDs', () => {
  assert.equal(selectCourseContext(project, 7, -141).entityId, 'one-green');
  assert.equal(selectCourseContext(project, -8, -130).entityType, 'bunker');
  assert.equal(selectCourseContext(project, 20, -100).entityType, 'pond');
  assert.equal(selectCourseContext(project, 1, 2).entityType, 'tee');
});

test('selectCourseContext resolves explicit objects and bounded environment records', () => {
  assert.equal(selectCourseContext(project, -29, -80).entityId, 'oak-left');
  assert.equal(selectCourseContext(project, 35, -80).entityId, 'fern-bed');
});

test('selectCourseContext resolves a pine-straw bed as an editable stable entity', () => {
  const selected = selectCourseContext(project, -35, -108);
  assert.equal(selected.entityType, 'forest-floor-area');
  assert.equal(selected.entityId, 'pine-straw-west');
  assert.equal(selected.parentId, 'forestFloorAreas');
});

test('selectCourseContext falls back to terrain with surface and biome context', () => {
  const selected = selectCourseContext(project, 0, -60, { surface: 'fairway', biome: { primaryBiome: 'parkland' } });
  assert.equal(selected.entityType, 'terrain');
  assert.equal(selected.surface, 'fairway');
  assert.equal(selected.biome, 'parkland');
  assert.deepEqual(selected.point, { x: 0, z: -60 });
});

test('routed-site selection maps world clicks back to the owning local hole entity', () => {
  const routed = structuredClone(project);
  routed.site.routing = { placements: [{ holeId: 'one', origin: { x: 100, z: 0 }, bearingDegrees: 90 }] };
  routed.holes[0].route = { points: [{ x: 0, z: 2 }, { x: 8, z: -140 }] };
  const selected = selectCourseContext(routed, 240, 8);
  assert.equal(selected.entityId, 'one-green');
  assert.equal(selected.holeId, 'one');
  assert.deepEqual(selected.point, { x: 240, z: 8 });
});
