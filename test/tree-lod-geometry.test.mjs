import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTreeGeometry } from '../src/trees/TreeGeometry.js';
import { PerspectiveCamera, Vector3 } from 'three';
import { ProceduralTreeForest } from '../src/scene/ProceduralTrees.js';
import { createTreePreset } from '../src/trees/TreePresets.js';

test('branch LOD removes straight rings but preserves bends, taper, endpoints and bark length', () => {
  const compile = (points, radii, tolerance = 0) => compileTreeGeometry({
    leaves: [], blossoms: [], segments: points.slice(1).map((end, i) => ({
      stem: 0, level: 1, start: points[i], end, radius0: radii[i], radius1: radii[i + 1],
    })),
  }, { radialSegments: 3, branchTolerance: tolerance });
  const meshes = [];
  const wood = (...args) => { const parts = compile(...args); meshes.push(...Object.values(parts)); return parts.branches; };
  try {
    const points = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
    const full = wood(points, [1, .75, .5]), reduced = wood(points, [1, .75, .5], .01);
    assert.equal(reduced.attributes.position.count, 8);
    assert.equal(full.attributes.position.count, 12);
    assert.deepEqual([...reduced.attributes.position.array.slice(0, 12)], [...full.attributes.position.array.slice(0, 12)]);
    assert.deepEqual([...reduced.attributes.position.array.slice(-12)], [...full.attributes.position.array.slice(-12)]);
    assert.equal(wood(points, [1, 1, .5], .01).attributes.position.count, 12);
    assert.equal(wood([[0, 0, 0], [1, 1, 0], [0, 2, 0]], [1, .75, .5], .01).attributes.position.count, 12);
    assert.equal(wood([[0, 0, 0], [0, 1, 0], [0, 0, 0]], [1, .75, .5], .01).attributes.position.count, 12);
    const bent = [[0, 0, 0], [.01, 1, 0], [0, 2, 0]];
    const originalUv = wood(bent, [1, .75, .5]).attributes.uv.array;
    const reducedUv = wood(bent, [1, .75, .5], .02).attributes.uv.array;
    assert.equal(reducedUv.at(-1), originalUv.at(-1));
    assert.throws(() => compile(points, [1, .75, .5], NaN), RangeError);
  } finally { meshes.forEach(mesh => mesh.dispose()); }
});

test('forest visibility bounds enclose the coverage-expanded foliage in every tier', () => {
  const definition = createTreePreset('tall-pine', 1);
  const forest = new ProceduralTreeForest({ definitions: [definition], camera: new PerspectiveCamera(),
    terrain: { heightAt: () => 0 }, placements: [{ id: 'pine', definitionId: definition.id,
      x: 0, z: 0, rotationY: 0, scale: 1, seed: 1, age: 1, health: 1, windExposure: 1 }] });
  const point = new Vector3();
  try {
    for (const batch of forest.batches) for (const tier of batch.tiers) for (const mesh of Object.values(tier)) {
      const positions = mesh.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        assert.ok(batch.cullingSphere.containsPoint(point.fromBufferAttribute(positions, i)));
      }
    }
  } finally { forest.dispose(); }
});
