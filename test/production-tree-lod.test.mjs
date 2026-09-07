import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BoxGeometry, MeshStandardMaterial, DirectionalLight } from 'three';
import {
  classifyAuthoredTreeLod,
  getVerifiedTreeLodPair,
  getVerifiedTreeLods,
  TreeShadowLod,
  TreeBeautyLod,
} from '../src/scene/Trees.js';

const treesSource = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');
const rangeSource = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');

const derivative = (level, maxDistance) => ({
  level,
  url: `/assets/trees/tree_lod${level}.glb`,
  sha256: `${String(level).repeat(64)}`,
  maxDistance,
  geometry: 'glb',
});

test('shadow instances never inherit camera-compacted indirect draw commands', () => {
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();
  const command = { cameraOnly: true };
  geometry.setIndirect(command);
  const beauty = Object.create(TreeBeautyLod.prototype);
  Object.assign(beauty, {
    authoredMeshOnly: true, sourceCount: 2, partCount: 1,
    useFarLod: false, useMiddleLod: false,
    wind: { model: 'none' }, environment: { time: { value: 0 } },
    shadowPrototype: { parts: [{ geometry, material, offsetY: 0 }] },
    shadowTransforms: new Float32Array([10, 0, 0, 0, 1, 30, 0, 0, 0, 1]),
  });
  const light = new DirectionalLight();
  light.castShadow = true;
  const shadow = new TreeShadowLod({ light, beauty });
  const caster = shadow.meshes[0];
  assert.equal(caster.count, 2);
  assert.equal(caster.geometry.getIndirect(), null);
  assert.equal(geometry.getIndirect(), command, 'beauty keeps its own command');
  assert.deepEqual(caster.geometry.attributes.position.array, geometry.attributes.position.array);
  let disposed = false;
  caster.geometry.addEventListener('dispose', () => { disposed = true; });
  shadow.dispose();
  assert.equal(disposed, true);
  geometry.dispose();
  material.dispose();
});

test('wind shadow updates follow live environment time and stop in calm or frozen scenes', () => {
  const state = {
    beauty: { wind: { model: 'hierarchical-tree-v1' }, environment: {
      time: { value: 1 }, baseWind: { value: { lengthSq: () => 4 } }, windProfile: { value: { w: 0 } },
    } },
    light: { shadow: { needsUpdate: false } }, _lastWindShadowTime: 0,
  };
  assert.equal(TreeShadowLod.prototype.update.call(state), true);
  assert.equal(state.light.shadow.needsUpdate, true);
  state.light.shadow.needsUpdate = false;
  assert.equal(TreeShadowLod.prototype.update.call(state), false);
  state.beauty.environment.time.value = 2;
  state.beauty.environment.baseWind.value.lengthSq = () => 0;
  assert.equal(TreeShadowLod.prototype.update.call(state), false);
  assert.equal(state.light.shadow.needsUpdate, false);
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

test('production tree catalog accepts one optional ascending authored LOD2', () => {
  const asset = { id: 'catalog-tree', category: 'tree', lods: [
    derivative(0, 70), derivative(1, 400), derivative(2, 800),
  ] };
  assert.deepEqual(getVerifiedTreeLods(asset), {
    lod0: asset.lods[0], lod1: asset.lods[1], lod2: asset.lods[2],
  });
  assert.throws(() => getVerifiedTreeLods({ ...asset, lods: [
    derivative(0, 70), derivative(1, 400), derivative(2, 300),
  ] }), /invalid authored catalog LOD2/);
});

test('Range requires authored GPU mesh pairs for every production tree', () => {
  assert.match(rangeSource, /getVerifiedTreeLods\(asset\)/);
  assert.match(rangeSource, /loadTreePrototype\(versionedUrl\(lod0\.url\)/);
  assert.match(rangeSource, /loadTreePrototype\(versionedUrl\(lod1\.url\)/);
  assert.match(rangeSource, /lod2 \? loadTreePrototype\(versionedUrl\(lod2\.url\)/);
  assert.match(rangeSource, /async reloadTreeAssets\(catalog/);
  assert.match(rangeSource, /this\.group\.add\(this\.trees\)[\s\S]+this\.group\.remove\(previous\.trees\)/);
  assert.match(rangeSource, /buildTreeBeautyMeshLod\(lod0, lod1, lod2, assetPlacements/);
  assert.match(rangeSource, /lodNear: treeBudget\.lodNear/);
  assert.match(rangeSource, /lodFar: treeBudget\.lodFar/);
  assert.match(rangeSource, /new TreeShadowLod\(/);
  assert.doesNotMatch(rangeSource, /getVerifiedTreeLod0|buildTreeBeautyLod0|TreeShadowLod0/);
  assert.doesNotMatch(rangeSource, /loadTreeImpostor|baked-atlas/);
});

test('production tree renderer uses GPU frustum compaction and exclusive projected-size mesh ownership', () => {
  assert.match(treesSource, /export function buildTreeBeautyMeshLod\(/);
  assert.match(treesSource, /authoredMeshOnly: true/);
  assert.match(treesSource, /if \(!this\.authoredMeshOnly\) this\._addImpostorMesh\(\)/);
  assert.match(treesSource, /_buildAuthoredMeshCompactCompute\(\)/);
  assert.match(treesSource, /distance\.lessThan\(lodNear\)\s*\.or\(projectedHeight\.greaterThan\(projectedLod0Threshold\)\)/,
    'visual certification, not an arbitrary far-distance ring, owns the handoff');
  assert.match(treesSource, /const lod0Visible = forceFull\.or\(/);
  assert.match(treesSource, /const lod2Visible = this\.useFarLod/);
  assert.match(treesSource, /lod0Visible\.not\(\)\.and\(lod2Visible\.not\(\)\)/);
  assert.match(treesSource, /atomicOr\(diagnostics\.element\(uint\(16\)\.add\(id\)\), uint\(1\)\)/);
  assert.match(treesSource, /atomicOr\(diagnostics\.element\(uint\(16\)\.add\(id\)\), uint\(2\)\)/);
  assert.doesNotMatch(treesSource, /const transition = lod0Visible\.and\(lod1Visible\)/);
  assert.doesNotMatch(treesSource, /authoredMeshFade|transitionMask/);
  assert.match(treesSource, /mesh\.castShadow = false/);
  assert.match(treesSource, /tree-shadow-complete-authored-lod\$\{this\.shadowLod\}/);
  assert.match(treesSource, /complete-authored-lod2/);
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
  assert.equal(classifyAuthoredTreeLod({ ...base, distance: 180, projectedHeight: 0.1, projectedLod2Threshold: 0.2 }), 2);
});

test('the palm handoff waits until its full silhouette is small', () => {
  assert.match(treesSource, /const PALM_LOD0_PROJECTED_HEIGHT = 0\.24;/);
  assert.match(treesSource, /treeResidencyThresholds\(proto, assetId\)/);
});

test('production mesh mode fails closed to complete LOD0 without visual certification', () => {
  assert.match(treesSource, /this\.visualLodCertification\.lod1 > 0 && authoredMeshLodUsable/);
  assert.match(treesSource, /this\.forceFullLod = forceFullLod === true \|\| \(this\.authoredMeshOnly && !this\.useMiddleLod\)/);
  assert.match(rangeSource, /visualLodCertification: Object\.fromEntries/);
  assert.match(treesSource, /completeTreeResidency: true/,
    'every source placement must retain one complete authored tree representation');
  assert.match(treesSource, /fullSourceTopologyResidency: this\.forceFullLod/);
  assert.match(treesSource, /this\.authoredMeshOnly\s*\n\s*\? null/);
  assert.match(treesSource, /this\._visibleImpostor\?\.value/);
  assert.match(treesSource, /this\.impostorTexture\?\.dispose\(\)/);
});
