import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { ProceduralTreeForest, proceduralTreeCanopyRadius } from '../src/scene/ProceduralTrees.js';

const placement = Object.freeze({
  id: 'tree-oak-1', archetype: 'live-oak', x: 12, z: -40,
  rotationY: 0.4, scale: 1.1, seed: 91, age: 0.8, health: 0.95, windExposure: 0.5,
});

test('synthetic tree source is deterministic geometry with stable shadow residency', () => {
  const camera = new PerspectiveCamera();
  camera.position.set(12, 2, -35);
  const forest = new ProceduralTreeForest({ placements: [placement], camera, terrain: { heightAt: () => 3 }, seed: 7 });
  assert.equal(forest.workloadDiagnostics().generatedSource, true);
  assert.equal(forest.workloadDiagnostics().proceduralMaterials, true);
  assert.equal(forest.shadow.mesh.children.length, 2);
  assert.ok(proceduralTreeCanopyRadius(placement) > 8);
  const shadowCounts = forest.shadow.mesh.children.map((mesh) => mesh.count);
  camera.position.set(1000, 50, 1000);
  forest.update(camera, true);
  assert.deepEqual(forest.shadow.mesh.children.map((mesh) => mesh.count), shadowCounts,
    'camera LOD changes must not compact the light-owned shadow caster list');
  assert.equal(forest.residencyEstimate().counts.lod1, 1);
  forest.dispose();
});

test('catalog placement accounting excludes the explicit synthetic source', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/environment/EnvironmentPlacement.js', import.meta.url), 'utf8'));
  assert.match(source, /objectCount - course\.environment\.syntheticTrees\.length/);
});
