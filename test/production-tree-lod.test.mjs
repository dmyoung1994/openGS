import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  classifyAuthoredTreeLod,
  getVerifiedTreeLod0,
  getVerifiedTreeLodPair,
} from '../src/scene/Trees.js';

const treesSource = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');
const rangeSource = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');

const derivative = (level, maxDistance) => ({
  level,
  url: `/assets/trees/tree_lod${level}.glb`,
  sha256: `${String(level).repeat(64)}`,
  maxDistance,
  geometry: 'glb',
});

test('production tree catalog contract requires an authored verified LOD1 pair', () => {
  const asset = { id: 'catalog-tree', category: 'tree', lods: [derivative(0, 70), derivative(1, 400)] };
  assert.deepEqual(getVerifiedTreeLodPair(asset), { lod0: asset.lods[0], lod1: asset.lods[1] });

  assert.throws(
    () => getVerifiedTreeLodPair({ ...asset, lods: [asset.lods[0]] }),
    /verified authored catalog LOD1 derivative.*LOD0-only fallback is disabled/,
  );
  assert.throws(
    () => getVerifiedTreeLodPair({ ...asset, lods: [derivative(0, 400), derivative(1, 70)] }),
    /distances in ascending order/,
  );
  assert.throws(
    () => getVerifiedTreeLodPair({ ...asset, lods: [{ ...asset.lods[0], sha256: 'not-a-digest' }, asset.lods[1]] }),
    /verified catalog LOD0 derivative/,
  );
});

test('an exact catalog LOD0 remains valid when no authored lower mesh exists', () => {
  const lod0 = derivative(0, 70);
  assert.equal(getVerifiedTreeLod0({ id: 'lod0-tree', category: 'tree', lods: [lod0] }), lod0);
  assert.throws(() => getVerifiedTreeLod0({ id: 'broken', category: 'tree', lods: [] }), /verified catalog LOD0/);
});

test('Range uses authored mesh LOD when available and exact authored LOD0 otherwise', () => {
  assert.match(rangeSource, /getVerifiedTreeLodPair\(asset\)/);
  assert.match(rangeSource, /loadTreePrototype\(lod0\.url, asset\)/);
  assert.match(rangeSource, /loadTreePrototype\(lod1\.url, asset\)/);
  assert.match(rangeSource, /buildTreeBeautyMeshLod\(lod0, lod1, assetPlacements/);
  assert.match(rangeSource, /lodNear: treeBudget\.lodNear/);
  assert.match(rangeSource, /lodFar: treeBudget\.lodFar/);
  assert.match(rangeSource, /new TreeShadowLod\(/);
  assert.match(rangeSource, /buildTreeBeautyLod0/);
  assert.match(rangeSource, /TreeShadowLod0/);
  assert.doesNotMatch(rangeSource, /loadTreeImpostor|baked-atlas/);
});

test('production tree renderer uses GPU frustum compaction and exclusive projected-size mesh ownership', () => {
  assert.match(treesSource, /export function buildTreeBeautyMeshLod\(/);
  assert.match(treesSource, /authoredMeshOnly: true/);
  assert.match(treesSource, /if \(!this\.authoredMeshOnly\) this\._addImpostorMesh\(\)/);
  assert.match(treesSource, /_buildAuthoredMeshCompactCompute\(\)/);
  assert.match(treesSource, /distance\.lessThan\(lodFar\)\.and\(/);
  assert.match(treesSource, /const lod0Visible = forceFull\.or\(/);
  assert.match(treesSource, /const lod1Visible = lod0Visible\.not\(\)/);
  assert.match(treesSource, /atomicOr\(diagnostics\.element\(uint\(16\)\.add\(id\)\), uint\(1\)\)/);
  assert.match(treesSource, /atomicOr\(diagnostics\.element\(uint\(16\)\.add\(id\)\), uint\(2\)\)/);
  assert.doesNotMatch(treesSource, /const transition = lod0Visible\.and\(lod1Visible\)/);
  assert.doesNotMatch(treesSource, /authoredMeshFade|transitionMask/);
  assert.match(treesSource, /mesh\.castShadow = false/);
  assert.match(treesSource, /tree-shadow-complete-authored-lod1/);
  assert.match(treesSource, /shadowResidency: 'complete-authored-lod1'/);
  assert.match(treesSource, /visibleCount: this\.sourceCount/);
});

test('exclusive authored-mesh classification keeps exactly one solid representation', () => {
  const base = {
    lodNear: 70,
    lodFar: 140,
    projectedLod0Threshold: 0.24,
    forceFullLod: false,
  };
  assert.equal(classifyAuthoredTreeLod({ ...base, distance: 40, projectedHeight: 0.1 }), 0,
    'distance keeps genuinely near trees on LOD0');
  assert.equal(classifyAuthoredTreeLod({ ...base, distance: 100, projectedHeight: 0.4 }), 0,
    'projected silhouette keeps readable midground palms on LOD0');
  assert.equal(classifyAuthoredTreeLod({ ...base, distance: 100, projectedHeight: 0.12 }), 1,
    'small distant silhouettes may use the authored derivative');
  assert.equal(classifyAuthoredTreeLod({ ...base, distance: 180, projectedHeight: 0.9 }), 1,
    'the device-tier far bound remains authoritative');
  assert.equal(classifyAuthoredTreeLod({ ...base, distance: 180, projectedHeight: 0.9, forceFullLod: true }), 0);
});

test('the palm handoff waits until its full silhouette is small', () => {
  assert.match(treesSource, /const PALM_LOD0_PROJECTED_HEIGHT = 0\.24;/);
  assert.match(treesSource, /treeResidencyThresholds\(proto, assetId\)/);
});

test('production mesh mode fails closed on unusable authored topology instead of falling back', () => {
  assert.match(treesSource, /if \(this\.authoredMeshOnly && !this\.useMiddleLod\)/);
  assert.match(treesSource, /requires a verified authored LOD1 with retained indexed canopy topology/);
  assert.match(treesSource, /this\.authoredMeshOnly\s*\n\s*\? null/);
  assert.match(treesSource, /this\._visibleImpostor\?\.value/);
  assert.match(treesSource, /this\.impostorTexture\?\.dispose\(\)/);
});
