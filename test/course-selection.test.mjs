import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCourseContext } from '../src/course/CourseSelection.js';

const project = {
  activeHoleId: 'one',
  site: { environment: {
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

test('selectCourseContext falls back to terrain with surface and biome context', () => {
  const selected = selectCourseContext(project, 0, -60, { surface: 'fairway', biome: { primaryBiome: 'parkland' } });
  assert.equal(selected.entityType, 'terrain');
  assert.equal(selected.surface, 'fairway');
  assert.equal(selected.biome, 'parkland');
  assert.deepEqual(selected.point, { x: 0, z: -60 });
});
