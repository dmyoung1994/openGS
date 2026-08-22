import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const trees = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');
const viewer = await readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8');

test('v4 material branch is dormant, source-normal based, and shared-light only', () => {
  assert.match(trees, /const _isConiferV4Atlas = \(part\) => \/conifer_v4_authored_alpha_atlas/);
  assert.match(trees, /const coniferV4 = _isConiferV4Atlas\(part\)/);
  assert.match(trees, /const v4ParentOutward = vec3\(/);
  assert.match(trees, /normalLocal\.mul\(0\.46\)\.add\(v4ParentOutward\.mul\(0\.54\)\)/);
  assert.match(trees, /const v4BarkTile = v4AtlasUv\.x\.lessThan\(0\.25\)/);
  assert.match(trees, /const branchletAlbedo = needleTransmission\(/);
  assert.match(trees, /const atlasDaylightNormalization = \(coniferV4 \|\| coniferV5 \|\| coniferV6 \|\| coniferV7\) \? 1\.65 : 2\.85/);
  assert.match(trees, /const _isConiferV5Atlas = \(part\) => \/conifer_v5_authored_alpha_atlas/);
  assert.match(trees, /const _isConiferV6Atlas = \(part\) => \/conifer_v6_macro_alpha_atlas/);
  assert.match(trees, /const _isConiferV7Atlas = \(part\) => \/conifer_v7_macro_alpha_atlas/);
  assert.match(trees, /const macroClusterAtlas = coniferV4 \|\| coniferV6 \|\| coniferV7 \|\| coniferV8/);
  assert.match(trees, /material\.normalNode = shadingViewNormal/);
  assert.doesNotMatch(trees, /coniferV4[\s\S]{0,140}emissive/);
  assert.match(viewer, /buildTreeBeautyLod/);
  assert.match(viewer, /tree candidate: conifer v4 TreeBeauty/);
  assert.match(viewer, /trees_candidates\/conifer_v4\/conifer_v4/);
  assert.match(viewer, /impostorFile: 'conifer_v3_impostor\.png'/);
  assert.match(viewer, /tree candidate: conifer v5 TreeBeauty/);
  assert.match(viewer, /trees_candidates\/conifer_v5\/conifer_v5_impostor\.png/);
  assert.match(viewer, /tree candidate: conifer v6 TreeBeauty/);
  assert.match(viewer, /trees_candidates\/conifer_v6\/conifer_v6_impostor\.png/);
  assert.match(viewer, /tree candidate: conifer v7 TreeBeauty/);
  assert.match(viewer, /trees_candidates\/conifer_v7\/conifer_v7_impostor\.png/);
  assert.match(viewer, /tree candidate: conifer v8 TreeBeauty/);
  assert.match(viewer, /trees_candidates\/conifer_v8\/conifer_v8_impostor\.png/);
});
