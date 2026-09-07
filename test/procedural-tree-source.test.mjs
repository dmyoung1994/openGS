import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { ProceduralTreeForest, proceduralTreeCanopyRadius } from '../src/scene/ProceduralTrees.js';
import { legacyTreeDefinition } from '../src/trees/TreeDefinition.js';

const definition = legacyTreeDefinition('live-oak');
const placement = Object.freeze({
  id: 'tree-oak-1', definitionId: definition.id, x: 12, z: -40,
  rotationY: 0.4, scale: 1.1, seed: 91, age: 0.8, health: 0.95, windExposure: 0.5,
});

test('procedural tree source is deterministic geometry with stable shadow residency', () => {
  const camera = new PerspectiveCamera(); camera.position.set(12, 2, -35);
  const forest = new ProceduralTreeForest({ definitions: [definition], placements: [placement], camera, terrain: { heightAt: () => 3 }, seed: 7 });
  const diagnostics = forest.workloadDiagnostics();
  assert.equal(diagnostics.generatedSource, true); assert.equal(diagnostics.proceduralMaterials, true);
  assert.ok(diagnostics.branches > 100); assert.ok(diagnostics.leaves > 100);
  assert.equal(forest.shadow.mesh.children.length, 2);
  assert.ok(proceduralTreeCanopyRadius(placement, [definition]) > 5);
  const shadowCounts = forest.shadow.mesh.children.map((mesh) => mesh.count);
  camera.position.set(1000, 50, 1000); forest.update(camera, true);
  assert.deepEqual(forest.shadow.mesh.children.map((mesh) => mesh.count), shadowCounts,
    'camera LOD changes must not compact the light-owned shadow caster list');
  const residency = forest.residencyEstimate();
  assert.equal(residency.counts.lod0, 1);
  assert.equal(residency.counts.lod1, 0);
  assert.equal(residency.completeTreeResidency, true);
  assert.equal(residency.forcedFullLod, true);
  forest.dispose();
});

test('catalog placement accounting excludes the explicit procedural source', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/environment/EnvironmentPlacement.js', import.meta.url), 'utf8'));
  assert.match(source, /objectCount - course\.environment\.proceduralTrees\.length/);
});

test('calm tree wind gates current and previous motion independently', () => {
  let currentSpeed = 0, previousSpeed = 0;
  const environment = {
    time: { value: 1 }, previousTime: { value: 0 }, baseWind: { value: new Vector3() },
    sampleWindCpu(_position, time, out) { return out.set(time === this.time.value ? currentSpeed : previousSpeed, 0, 0); },
  };
  const camera = new PerspectiveCamera();
  const released = [];
  const forest = new ProceduralTreeForest({ definitions: [definition], placements: [placement], camera,
    terrain: { heightAt: () => 0 }, environment,
    renderer: { isWebGPURenderer: true, _attributes: { delete: attribute => released.push(attribute) } } });
  try {
    assert.equal(forest.windActive.value, 0);
    for (const [current, previous] of [[2, 0], [0, 2], [0, 0]]) {
      currentSpeed = current; previousSpeed = previous;
      environment.time.value++; environment.previousTime.value++;
      forest.update(camera);
      assert.equal(forest.windActive.value, Number(current > 0));
      assert.equal(forest.previousWindActive.value, Number(previous > 0));
      assert.equal(forest.windBuffer.getX(0), current);
      assert.equal(forest.windBuffer.getX(1), previous);
    }
  } finally { forest.dispose(); }
  assert.deepEqual(released, [forest.windBuffer]);
});
