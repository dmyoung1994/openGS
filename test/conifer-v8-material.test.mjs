import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const trees = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');

test('v7/v8 candidate foliage uses shared-environment Phong with authored alpha roles', () => {
  assert.match(trees, /class SharedEnvironmentTreePhongMaterial extends MeshPhongNodeMaterial/);
  assert.match(trees, /treeEnvironment\.aerialPerspective\(/);
  assert.match(trees, /const toCamera = cameraPosition\.sub\(positionWorld\)/);
  assert.match(trees, /const aerialRgb = this\.treeEnvironment\.aerialPerspective/);
  assert.match(trees, /material\.treeEnvironment = this\.environment/);
  assert.match(trees, /material\.fog = false/);
  assert.match(trees, /class SharedEnvironmentTreePhongLightingModel extends PhongLightingModel/);
  assert.match(trees, /new EnvironmentNode\(environment\)/);
  assert.match(trees, /iblIrradiance\.mul\(BRDF_Lambert/);
  assert.match(trees, /reflectedLight\.indirectDiffuse\.addAssign/);
  assert.match(trees, /const _isConiferV8Atlas = \(part\) => \/conifer_v8_macro_alpha_atlas/);
  assert.match(trees, /const v8ProductionPhongAtlas = coniferV8 && part\.material\.map/);
  assert.match(trees, /const candidatePhongAtlas = \(coniferV7 && part\.material\.map\) \|\| v8ProductionPhongAtlas/);
  assert.match(trees, /const barkRole = atlasUv\.x\.lessThan\(0\.25\)\.and\(atlasUv\.y\.lessThan\(0\.25\)\)/);
  assert.match(trees, /const boundedTransmission = needleTransmission\(/);
  assert.match(trees, /material\.maskNode = texel\.a\.greaterThan\(TREE_ALPHA_CUTOFF\)/);
  assert.match(trees, /material\.colorNode = candidateAlbedo/);
  assert.match(trees, /material\.normalNode = shadingViewNormal/);
  assert.doesNotMatch(trees, /candidatePhongAtlas[\s\S]{0,300}emissive/);
});

test('candidate atlas grade is bounded by measured linear source/target ranges', () => {
  assert.match(trees, /CONIFER_CANDIDATE_BARK_SOURCE_LINEAR = Object\.freeze\(\[0\.0662, 0\.0551, 0\.0402\]\)/);
  assert.match(trees, /CONIFER_CANDIDATE_BARK_TARGET_LINEAR = Object\.freeze\(\[0\.080, 0\.065, 0\.048\]\)/);
  assert.match(trees, /CONIFER_CANDIDATE_NEEDLE_SOURCE_MEDIAN_LINEAR = Object\.freeze\(\[0\.0561, 0\.0762, 0\.0194\]\)/);
  assert.match(trees, /CONIFER_CANDIDATE_NEEDLE_TARGET_MEDIAN_LINEAR = Object\.freeze\(\[0\.124, 0\.168, 0\.042\]\)/);
  assert.match(trees, /CONIFER_CANDIDATE_BARK_LINEAR_NORMALIZATION = vec3\(1\.21, 1\.18, 1\.19\)/);
  assert.match(trees, /CONIFER_CANDIDATE_NEEDLE_LINEAR_NORMALIZATION = vec3\(2\.21, 2\.21, 2\.16\)/);
  assert.match(trees, /CONIFER_CANDIDATE_NEEDLE_CONTRAST = 0\.72/);
  assert.match(trees, /CONIFER_CANDIDATE_NEEDLE_SATURATION = 0\.82/);
  assert.match(trees, /mix\(\s*vec3\(0\.124, 0\.168, 0\.042\)/);
  assert.match(trees, /saturation\(\n\s*mix\(/);
  assert.match(trees, /sunToEye = viewDirectionWorld\.dot\(environment\.sunDirection\)/);
  assert.match(trees, /shininess: 2\.0/);
  assert.match(trees, /reflectivity: 0\.03/);
  assert.match(trees, /texel\.rgb\.mul\(CONIFER_CANDIDATE_BARK_LINEAR_NORMALIZATION\)/);
  assert.match(trees, /texel\.rgb\.mul\(CONIFER_CANDIDATE_NEEDLE_LINEAR_NORMALIZATION\)/);
});

test('promoted v8 keeps its authored Phong branch while v7 remains a trial fixture', () => {
  assert.match(trees, /const cheapMiddleAtlas = middleLod && _isAuthoredAlphaAtlas\(part\)\s+&& !candidatePhongAtlas/);
  assert.match(trees, /v8 is now the reviewed production catalog derivative/);
  assert.match(trees, /if \(candidatePhongAtlas\)/);
  assert.match(trees, /if \(\(coniferV4 \|\| coniferV5 \|\| coniferV6 \|\| coniferV7\)\s+&& !candidatePhongAtlas/);
  assert.doesNotMatch(trees, /coniferV8[\s\S]{0,180}catalog/);
});

test('only v8 receives the bounded earlier projected-size handoff', () => {
  assert.match(trees, /const TREE_LOD0_PROJECTED_HEIGHT = 0\.75;/);
  assert.match(trees, /const TREE_IMPOSTOR_PROJECTED_STRUCTURE = 0\.009;/);
  assert.match(trees, /const TREE_V8_LOD0_PROJECTED_HEIGHT = 1\.0;/);
  assert.match(trees, /const TREE_V8_IMPOSTOR_PROJECTED_STRUCTURE = 0\.011;/);
  assert.match(trees, /const _isConiferV8Prototype = \(proto\) => proto\?\.parts\?\.some\(_isConiferV8Atlas\) === true/);
  assert.match(trees, /candidateV8 \? 'conifer_v8' : 'production'/);
  assert.match(trees, /candidateV8 \? TREE_V8_LOD0_PROJECTED_HEIGHT : TREE_LOD0_PROJECTED_HEIGHT/);
  assert.match(trees, /candidateV8 \? TREE_V8_IMPOSTOR_PROJECTED_STRUCTURE : TREE_IMPOSTOR_PROJECTED_STRUCTURE/);
  assert.match(trees, /thresholds: \{ \.\.\.this\.residencyThresholds \}/);
  assert.match(trees, /distance\.lessThan\(lodNear\)/);
  assert.match(trees, /distance\.greaterThanEqual\(lodNear\)/);
});
