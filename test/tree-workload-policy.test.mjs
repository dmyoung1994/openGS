import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TREE_WORKLOAD_POLICIES,
  normalizeTreeWorkloadPolicy,
} from '../src/scene/Trees.js';

const source = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');

test('tree workload modes only scale the existing authored LOD policy', () => {
  const ultra = normalizeTreeWorkloadPolicy('ultra');
  assert.equal(ultra.fullFidelity, true);
  assert.equal(ultra.lodNearScale, 1);
  assert.equal(ultra.lodFarScale, 1);
  assert.equal(ultra.transitionScale, 1);
  assert.equal(ultra.projectedLod0Scale, 1);
  assert.equal(ultra.instanceBudgetSupported, false);
  assert.equal(ultra.maxDistanceCullingSupported, false);

  for (const mode of ['quality', 'balanced', 'battery']) {
    const policy = normalizeTreeWorkloadPolicy(mode);
    assert.equal(policy.fullFidelity, false);
    assert.ok(policy.lodNearScale < 1);
    assert.ok(policy.lodFarScale < 1);
    assert.ok(policy.transitionScale < 1);
    assert.ok(policy.projectedLod0Scale > 1,
      'a larger projected-height threshold promotes sources to authored LOD1 sooner');
    assert.equal(policy.instanceBudgetSupported, false);
    assert.equal(policy.maxDistanceCullingSupported, false);
  }

  // Generic controller fields cannot smuggle source deletion into tree
  // residency; the renderer intentionally ignores them.
  const attemptedBudget = normalizeTreeWorkloadPolicy({
    mode: 'battery',
    maxDistance: 1,
    lod0Budget: 0,
    lod1Budget: 0,
  });
  assert.equal('maxDistance' in attemptedBudget, false);
  assert.equal('lod0Budget' in attemptedBudget, false);
  assert.equal('lod1Budget' in attemptedBudget, false);
  assert.deepEqual(TREE_WORKLOAD_POLICIES.ultra, ultra);
});

test('production authored trees keep every source and promote through uniform LOD thresholds', () => {
  assert.match(source, /setWorkloadPolicy\(policy = undefined\)/);
  assert.match(source, /const lodNear = this\._baseLodNear \* policy\.lodNearScale/);
  assert.match(source, /const lodFar = this\._baseLodFar \* policy\.lodFarScale/);
  assert.match(source, /const transitionDistance = this\._baseLodTransitionDistance \* policy\.transitionScale/);
  assert.match(source, /this\.uLodNear\.value = lodNear/);
  assert.match(source, /this\.uLodFar\.value = lodFar/);
  assert.match(source, /this\.uLodTransitionDistance\.value = transitionDistance/);
  assert.match(source, /uPolicyProjectedLod0Scale/);
  assert.match(source, /const projectedLod0Threshold = float\(residency\.lod0\)\.mul\(projectedLod0Scale\)/);
  assert.match(source, /const lod0Visible = forceFull\.or\(/);
  assert.match(source, /const lod1Visible = lod0Visible\.not\(\)/);
  assert.doesNotMatch(source, /authoredMeshFade|transitionMask/);
  assert.doesNotMatch(source, /policyDistanceAllowed/);
  assert.doesNotMatch(source, /lod0BudgetDistance|lod1BudgetDistance/);
  assert.doesNotMatch(source, /_applyWorkloadSelection/);
});

test('LOD0-only authored species retain complete geometry and report unsupported reduction', () => {
  assert.match(source, /unsupportedReason: 'exact-authored-lod0-only'/);
  assert.match(source, /reductionSupported: false/);
  assert.match(source, /lod0: this\.sourceCount/);
  assert.match(source, /rejected: 0/);
  assert.match(source, /shadowResidency: 'complete-exact-authored-lod0'/);
});

test('authored shadow residency is complete and independent of beauty-camera compaction', () => {
  assert.match(source, /beauty\._shadowPolicyOwner = this/);
  assert.match(source, /shadowResidency: 'complete-authored-lod1'/);
  assert.match(source, /shadowResidency: this\.authoredMeshOnly/);
  assert.match(source, /new InstancedMesh\(part\.geometry, material, this\.sourceCount\)/);
  assert.match(source, /shadowMesh\.setMatrixAt\(index, matrix\)/);
  assert.match(source, /shadowMesh\.layers\.set\(1\)/);
  assert.match(source, /shadowMesh\.castShadow = true/);
  assert.match(source, /this\.beauty\.setWorkloadPolicy\(policy\)/);
});

test('workload policy does not replace authored geometry or PBR resources', () => {
  assert.match(source, /const geometry = part\.geometry/);
  assert.match(source, /geometry\.setIndirect\(this\._drawArgsAttr/);
  assert.match(source, /cloneLod0Material\(part\.material\)/);
  const productionPath = source.slice(source.indexOf('export function buildTreeBeautyMeshLod'));
  assert.match(productionPath, /authoredMeshOnly: true/);
  assert.doesNotMatch(productionPath, /loadTreeImpostor|baked-atlas/);
});
