import test from 'node:test';
import assert from 'node:assert/strict';
import { createGreenReadingGrid, GRID_FLOW_SCALE } from '../src/scene/GreenReadingGrid.js';

test('grid lines carry signed slope-proportional flow on the physical surface', () => {
  for (const slope of [0, 0.03, -0.03, 0.06]) {
    const terrain = {
      heightAt: x => slope * x,
      surfaceAt: (x, z) => Math.hypot(x, z) <= 2 ? 'green' : 'fringe',
      normalAt: (x, z, out) => out.set(-slope, 1, 0).normalize(),
    };
    const grid = createGreenReadingGrid(terrain, { x: 0, z: 0, r: 2 });
    assert.equal(grid.children.length, 1, 'one grid draw, no separate arrows');
    const { position:p, gridFlow:f, gridSlope:s } = grid.children[0].geometry.attributes;
    for (let i = 0; i < p.count; i += 2) {
      const alongX = p.getX(i + 1) !== p.getX(i);
      for (const j of [i, i + 1]) {
        assert.equal(terrain.surfaceAt(p.getX(j), p.getZ(j)), 'green');
        assert.ok(Math.abs(p.getY(j) - terrain.heightAt(p.getX(j)) - 0.025) < 1e-6);
        assert.ok(Math.abs(f.getY(j) - (alongX ? -slope * GRID_FLOW_SCALE : 0)) < 1e-6);
        assert.ok(Math.abs(s.getX(j) - Math.abs(slope)) < 1e-6);
      }
    }
    grid.update(10);
    grid.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  }
});
