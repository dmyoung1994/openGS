import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from 'three';
import { placementTint } from '../src/scene/EnvironmentProps.js';

test('dune and strand tints preserve source texture modulation with a dry ecological shift', () => {
  const managed = placementTint(new Color(), 'groundcover', 81, 'same-clump', 'managed-course');
  const strand = placementTint(new Color(), 'groundcover', 81, 'same-clump', 'strand-grass');
  const dune = placementTint(new Color(), 'groundcover', 81, 'same-clump', 'coastal-dune');

  assert.ok(managed.g > managed.b, 'managed clumps retain their authored green bias');
  assert.ok(strand.r > managed.r * 0.88 && strand.b < strand.g, 'strand grass is a restrained olive transition');
  assert.ok(dune.r > dune.g && dune.g > dune.b, 'dune grass becomes sun-bleached straw');
  assert.deepEqual(
    placementTint(new Color(), 'groundcover', 81, 'same-clump', 'coastal-dune'),
    dune,
    'habitat tint is deterministic',
  );
});
