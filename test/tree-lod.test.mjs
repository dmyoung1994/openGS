import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/scene/Trees.js', import.meta.url), 'utf8');
const rangeSource = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');
const coniferBuild = await readFile(new URL('../scripts/build_conifer_v3.py', import.meta.url), 'utf8');

test('tree GPU classifier uses exclusive near, middle, and impostor bands', () => {
  assert.match(source, /const lodNear = this\.uLodNear/);
  assert.match(source, /const lodFar = this\.uLodFar/);
  assert.match(source, /const lodFarEffective = lodFar\.mul\(0\.9\)/);
  assert.match(source, /distance\.lessThan\(lodNear\)/);
  assert.match(source, /distance\.greaterThanEqual\(lodNear\)/);
  assert.match(source, /distance\.lessThan\(lodFarEffective\)/);
  assert.match(source, /distance\.greaterThanEqual\(lodFarEffective\)/);
  assert.match(source, /const projectedHeight = h\.mul\(projectionScale\.y\)/);
  assert.match(source, /TREE_LOD0_PROJECTED_HEIGHT/);
  assert.match(source, /TREE_LOD1_PROJECTED_HEIGHT/);
  assert.match(source, /const nearBand = uint\(this\.forceFullLod \? 1 : 0\)\.equal\(uint\(1\)\)/);
  assert.match(source, /const middleBand = nearBand\.not\(\)/);
  assert.match(source, /const impostorBand = nearBand\.not\(\)\.and\(middleBand\.not\(\)\)/);
  assert.match(source, /uint\(this\.useMiddleLod \? 0 : 1\)\.equal\(uint\(1\)\)/);
  assert.doesNotMatch(source, /uImpostorFar/);
});

test('projected-size thresholds are conservative and shared by GPU and residency estimate', () => {
  assert.match(source, /const TREE_LOD0_PROJECTED_HEIGHT = 0\.75;/);
  assert.match(source, /const TREE_LOD1_PROJECTED_HEIGHT = 0\.20;/);
  assert.match(source, /const TREE_PROJECTED_STRUCTURE_RATIO = 0\.03;/);
  assert.match(source, /const TREE_IMPOSTOR_PROJECTED_STRUCTURE = 0\.009;/);
  assert.match(source, /const TREE_V8_LOD0_PROJECTED_HEIGHT = 1\.0;/);
  assert.match(source, /const TREE_V8_IMPOSTOR_PROJECTED_STRUCTURE = 0\.011;/);
  assert.match(source, /const residency = this\.residencyThresholds/);
  assert.match(source, /56\.2% of LOD0's indexed triangles/);
  assert.match(source, /this is about 270 px of full-tree height/);
  assert.match(source, /projectedHeight\.greaterThan\(projectedLod0Threshold\)/);
  assert.match(source, /projectedHeight\.greaterThan\(float\(residency\.lod1\)\)/);
  assert.match(source, /projectedHeight > projectedLod0Threshold/);
  assert.match(source, /projectedLod0Scale/);
  assert.match(source, /projectedStructure <= thresholds\.impostorStructure/);
  assert.match(source, /thresholds:\s*\{\s*\.\.\.this\.residencyThresholds,\s*lod0ProjectedHeight:/);
  assert.match(source, /lodFar\.mul\(0\.9\)/);
  assert.match(source, /const cardEligible = distance\.greaterThanEqual\(lodNear\)/);
});

test('tree frustum pad is derived from the measured v3 bounds', () => {
  assert.match(source, /const TREE_V3_BOUND_RADIUS = 6\.118;/);
  assert.match(source, /const TREE_V3_REFERENCE_HEIGHT = 18\.833;/);
  assert.match(source, /0\.5 \+ 0\.032 \+ 0\.01/);
  assert.match(source, /const radius = h\.mul\(TREE_FRUSTUM_RADIUS_RATIO\)/);
  assert.doesNotMatch(source, /const radius = h\.mul\(0\.78\)/);
});

test('tree LOD loading validates indexed canonical topology', () => {
  assert.match(source, /assertCompatibleTreeLods\(proto, midProto\)/);
  assert.match(source, /middleLodUsable\(near, middle\)/);
  assert.match(source, /\.filter\(\(\{ near \}\) => near\.isFoliage\)/);
  assert.match(source, /middleIndices \/ nearIndices >= 0\.08/);
  assert.match(source, /part\.isFoliage !== other\.isFoliage/);
  assert.match(source, /geometry\.index\?\.count/);
  assert.match(source, /near\.parts\.length === 1 && middle\.parts\.length === 1/);
});

test('explicit tree roles map indirect commands trunk, branches, foliage', () => {
  assert.match(source, /const TREE_ROLE_ORDER = \['trunk', 'branches', 'foliage'\]/);
  assert.match(source, /parts\.sort\(\(a, b\) => TREE_ROLE_ORDER\.indexOf\(a\.role\)/);
  assert.match(source, /role,\n      \/\/ Keep a stable semantic tag/);
});

test('tree beauty path isolates one indirect command per role primitive and band', () => {
  // A prototype is either one combined authored-alpha atlas primitive or a set of
  // semantic role primitives. Either way the indirect layout is LOD0 parts, LOD1
  // parts, then exactly one impostor card — never a per-band mesh soup.
  assert.match(source, /this\.partCount = proto\.parts\.length/);
  assert.match(source, /this\._commandCount = this\.partCount \* 2 \+ 1/);
  assert.match(source, /this\._lod1CountWord = this\.partCount \* 5 \+ 1/);
  assert.match(source, /this\._impostorCountWord = this\.partCount \* 10 \+ 1/);
  assert.match(source, /new Uint32Array\(drawArgWords\)/);
  assert.match(source, /lod0Draws: this\.partCount/);
  assert.match(source, /lod1Draws: this\.partCount/);
  assert.match(source, /impostorDraws: 1/);
  assert.match(source, /beautyDraws: this\._commandCount/);
  assert.match(source, /setIndirect\(this\._drawArgsAttr, this\.partCount \* 2 \* 20\)/);
  // Sibling role commands share one band counter, so finalize must broadcast it
  // and readDiagnostics must actually verify the broadcast happened.
  assert.match(source, /const bandCount = command < parts \?/);
  assert.doesNotMatch(source, /const siblingCountsEqual = true/);
});

test('LOD1 authored atlas uses shared daylight mask path while LOD0 stays PBR', () => {
  assert.match(source, /const middleLod = label === 'lod1'/);
  assert.match(source, /const cheapMiddleAtlas = middleLod && _isAuthoredAlphaAtlas\(part\)/);
  assert.match(source, /new MeshBasicNodeMaterial\(\)/);
  assert.match(source, /const barkTile = atlasUv\.x\.lessThan\(0\.25\)\.and\(atlasUv\.y\.lessThan\(0\.25\)\)/);
  assert.match(source, /const barkRole = barkTile\.select\(float\(1\), float\(0\)\)/);
  assert.match(source, /vTreeLod1AtlasBarkRole/);
  assert.match(source, /vTreeLod1SharedDaylight/);
  assert.match(source, /useStableFoliageCoverage\(material, texel\.a\)/);
  assert.doesNotMatch(source, /receivedShadowNode =/);
  assert.match(source, /LOD0\s+\/\/\s+keeps the full MeshStandard response/);
});

test('authored-alpha atlas remains one canonical draw without foliage-only transforms', () => {
  assert.match(source, /const _isAuthoredAlphaAtlas = \(part\) => \/authored_alpha_atlas\/i/);
  assert.match(source, /combined-authored-alpha/);
  assert.match(source, /_isAuthoredAlphaAtlas\(part\) && material\.map/);
  assert.match(source, /material\.opacityNode = texel\.a;/);
  assert.match(source, /material\.map && part\.usesAlphaCutout && !part\.isFoliage && !_isAuthoredAlphaAtlas\(part\)/);
  assert.match(source, /\/canopy\/i\.test\(o\.material\?\.name \|\| ''\)/,
    'leaf-card canopies keep source alpha without applying cutout to bark');
});

test('tree classifier clears diagnostics for batches smaller than the header', () => {
  assert.match(source, /compute\(Math\.max\(this\.sourceCount, 16\)\)/);
  assert.match(source, /id\.lessThan\(uint\(this\.sourceCount\)\)/);
});

test('tree impostor view phase is deterministic and runtime-lit', () => {
  assert.match(source, /style\.x\.mul\(0\.61803398875\)\.fract\(\)/);
  assert.match(source, /const framePhase = relativeAngle\.div\(tau\)\.mul\(this\.impostor\.azimuthFrames\)/);
  assert.match(source, /const frame = framePhase\.add\(0\.5\)\.floor\(\)\.mod\(this\.impostor\.azimuthFrames\)/);
  assert.match(source, /const baked = texture\(this\.impostorTexture, atlasUvForFrame\(frame\)\)/);
  assert.doesNotMatch(source, /const nextFrame/);
  assert.doesNotMatch(source, /const frameBlend/);
  assert.doesNotMatch(source, /bakedCurrent|bakedNext/);
  assert.match(source, /runtimeDiffuse.*mul\(2\.65\)/);
  assert.match(source, /environment\.zenithColor/);
  assert.match(source, /environment\.horizonColor/);
  assert.match(source, /vec3\(0\.50, 0\.60, 0\.46\)/);
  assert.match(source, /material\.colorNode = pineAlbedo/);
});

test('LOD1 branchlet cards tighten only to measured source-alpha bounds', () => {
  assert.match(coniferBuild, /def alpha_tile_bounds\(atlas_image, tile_size=256, threshold=16\)/);
  assert.match(coniferBuild, /tight = planes == 2/);
  assert.match(coniferBuild, /card_length = length \* \(bounds\[3\] - bounds\[1\] if tight else 1\.0\)/);
  assert.match(coniferBuild, /card_width = width \* \(bounds\[2\] - bounds\[0\] if tight else 1\.0\)/);
  assert.match(coniferBuild, /uv=tile_uv\(tile, bounds=bounds\)/);
  assert.match(coniferBuild, /LOD1 retains every source-derived cluster centre/);
  assert.match(coniferBuild, /for lod in \(0,1\):/);
});

test('conifer foliage uses bounded, sun-oriented two-sided transmission', () => {
  assert.match(source, /function needleTransmissionFactor\(/);
  assert.match(source, /function needleTransmission\(/);
  assert.match(source, /sunFacingBack = needleNormalWorld\.dot\(environment\.keyDirection\)/);
  assert.match(source, /sunToEye = viewDirectionWorld\.dot\(environment\.keyDirection\)/);
  assert.match(source, /environment\.keyIlluminanceScale\.max\(0\)/);
  assert.match(source, /\.clamp\(0, 0\.12\)/);
  assert.match(source, /\.toVarying\('vTreeNeedleTransmission'\)/);
  assert.match(source, /const needleNormalWorld = rotateYaw\(normalLocal\)\.normalize\(\)/);
  assert.match(source, /const viewNormal = needleNormalWorld\.transformDirection\(cameraViewMatrix\)/);
  assert.match(source, /needleTransmission\(gradedColor, transmissionFactor\(foliageMask\)/);
  assert.match(source, /const foliageBaseColor = foliageColorNode\(part\.material, tint\)/);
  assert.doesNotMatch(source, /material\.emissiveNode\s*=/);
});

test('foliage coverage rejects low-alpha hairs without temporal stipple', () => {
  assert.match(source, /const TREE_FOLIAGE_ALPHA_CUTOFF = 0\.05/);
  assert.match(source, /function useStableFoliageCoverage\(material, alphaNode\)/);
  assert.match(source, /material\.opacityNode = alphaNode/);
  assert.match(source, /material\.alphaTest = TREE_FOLIAGE_ALPHA_CUTOFF/);
  assert.match(source, /material\.alphaHash = false/);
  assert.match(source, /material\.transparent = false/);
  assert.match(source, /material\.depthWrite = true/);
  assert.match(source, /material\.alphaTest = TREE_IMPOSTOR_ALPHA_CUTOFF/,
    'far impostors retain their lower measured cutoff so thin grounded silhouettes survive');
});

test('tree geometry keeps all semantic parts grounded under one rigid source transform', () => {
  assert.match(source, /part\.offsetY = -height \* 0\.075/);
  assert.match(source, /const leanX = 0/);
  assert.match(source, /const leanZ = 0/);
  assert.match(source, /const localPosition = positionGeometry/);
  assert.doesNotMatch(source, /positionGeometry\.x\.mul\(1\.16\)/);
  assert.match(source, /const plantBaseY = structuralY\.length/,
    'tree loading must ignore sparse scan fragments when resolving ground contact');
  assert.match(source, /const baseY = p\.y - proto\.plantBaseY \* scale - h \* 0\.032/,
    'every representation must bury the robust opaque structural base');
});

test('tree motion uses authored hierarchy and one root wind sample per history frame', () => {
  assert.match(source, /const rotateYaw = \(v\) => vec3\(/);
  assert.doesNotMatch(source, /const rotateXYZ/);
  assert.match(rangeSource, /wind: asset\.wind/,
    'the renderer must consume each catalog species wind contract');
  assert.match(source, /\['none', 'hierarchical-tree-v1'\]/);
  assert.match(source, /this\.wind = wind/);
  assert.match(source, /wind\.trunkStiffness/);
  assert.match(source, /wind\.branchStiffness/);
  assert.match(source, /wind\.leafStiffness/);
  assert.match(source, /wind\.gustResponse/);
  assert.match(source, /function treeWindResponses\(wind\)/);
  assert.match(source, /wind\.trunkStiffness - wind\.branchStiffness/);
  assert.match(source, /wind\.branchStiffness - wind\.leafStiffness/);
  assert.match(source, /const atlasFoliageMask = _isAuthoredAlphaAtlas\(part\)/,
    'combined tree atlases must distinguish structural bark from foliage motion');
  assert.match(source, /new StorageBufferAttribute\(new Float32Array\(this\.sourceCount \* 4\), 4\)/,
    'wind history is one packed vec4 per immutable source record');
  assert.match(source, /this\._sourceWind = storage\(windAttribute, 'vec4', this\.sourceCount\)/);
  assert.match(source, /this\._sourceWindReadOnly = storage\(windAttribute, 'vec4', this\.sourceCount\)\.toReadOnly\(\)/);
  assert.match(source, /_buildWindCompute\(\)/);
  assert.match(source, /this\._windCompute\.name = 'Tree beauty source wind precompute'/);
  assert.match(source, /wind\.element\(id\)\.assign\(vec4\(/);
  assert.match(source, /currentWind\.x,\s*currentWind\.z,\s*previousWind\.x,\s*previousWind\.z/);
  assert.match(source, /const packedWind = this\._sourceWindReadOnly\.element\(sourceId\)\.toVar\(\)/);
  assert.match(source, /const currentWind = vec3\(packedWind\.x, 0, packedWind\.y\)/);
  assert.match(source, /const previousWind = vec3\(packedWind\.z, 0, packedWind\.w\)/);
  const geometryMaterialSource = source.slice(
    source.indexOf('  _geometryMaterial('),
    source.indexOf('  _addImpostorMesh()'),
  );
  assert.doesNotMatch(geometryMaterialSource, /environment\.windAt\(/,
    'LOD0/LOD1 vertex materials consume the packed source wind stream');
  assert.equal((source.match(/this\.environment\.windAt\(/g) || []).length, 2,
    'only the current and previous samples in the per-source precompute remain');
  const windDispatch = source.indexOf('this.renderer.compute(this._windCompute)');
  const clearDispatch = source.indexOf('this.renderer.compute(this._clearCompute)');
  assert.ok(windDispatch >= 0 && windDispatch < clearDispatch,
    'source wind must be written before the existing beauty compute queue');
  assert.match(source, /const windMotionAt = \(sample\) =>/);
  assert.doesNotMatch(source, /const flutterMask|const flutterAmplitude|const transverse/,
    'alpha-cut foliage must not shear under independent per-vertex flutter');
  assert.match(source, /const arcDrop = horizontal\.length\(\)\.pow\(2\)/);
  assert.match(source, /const packedWind = this\._sourceWindReadOnly\.element\(sourceId\)/);
  assert.match(source, /windMotionAt\(currentWind\)/);
  assert.match(source, /windMotionAt\(previousWind\)/);
  assert.doesNotMatch(source, /windAt\(staticWorld/);
  assert.doesNotMatch(source, /windAt\(world/);
  assert.match(source, /const bendWeight = heightFraction\.pow\(1\.7\)/);
  assert.match(source, /const cardResponse = branchResponse \* 0\.42 \+ leafResponse \* 0\.58/,
    'far cards retain an aggregate of branch and leaf response at the LOD handoff');
});

test('mixed range compatibility accessor covers every catalog species', () => {
  assert.match(rangeSource, /assetId: asset\.id/);
  assert.match(rangeSource, /this\._treeBeautyCollection\.source !== this\.treeBeauties/);
  assert.match(rangeSource, /for \(const beauty of beauties\) beauty\.update\(camera\)/);
  assert.match(rangeSource, /Promise\.all\(beauties\.map\(\(beauty\) => beauty\.readDiagnostics\(\)\)\)/);
  assert.doesNotMatch(rangeSource, /get treeBeauty\(\) \{ return this\.treeBeauties\?\.\[0\]/);
});

test('LOD0 tree instances compact one authored-part mesh by camera frustum', () => {
  assert.doesNotMatch(source, /TREE_LOD0_BATCH_CELL_SIZE|partitionLod0Records/);
  assert.match(source, /makeLod0WorldBounds\(proto, this\.records\)/);
  assert.match(source, /this\._frustum\.intersectsBox\(this\._frustumBox\)/);
  assert.match(source, /new InstancedMesh\(part\.geometry, material, this\.sourceCount\)/);
  assert.match(source, /mesh\.instanceMatrix\.setUsage\(DynamicDrawUsage\)/);
  assert.match(source, /mesh\.count = activeCount/);
  assert.match(source, /this\._activeIndices = new Uint32Array\(this\.sourceCount\)/);
  assert.match(source, /target\.set\(sourceMatrix, slot \* 16\)/);
  assert.match(source, /mesh\.frustumCulled = true/);
  assert.match(source, /mesh\.computeBoundingSphere\(\)/);
  assert.match(source, /shadowMesh\.frustumCulled = true/);
  assert.match(source, /new InstancedMesh\(sourceMesh\.geometry, sourceMesh\.material, this\.sourceCount\)/);
  assert.match(source, /shadowMesh\.setMatrixAt\(index, beauty\.records\[index\]\.matrix\)/);
  assert.doesNotMatch(source, /sourceMesh\.instanceMatrix\.array\.set/);
  assert.match(source, /shadowBatchDraws: this\.meshes\.length/);
  assert.match(source, /activeCount: this\._activeCount/);
  assert.match(source, /beautyActiveCount: this\.beauty\.activeCount/);
});

test('tree impostor cards preserve grounded deterministic age classes', () => {
  assert.match(source, /const ageScale = style\.x\.mul\(0\.754877666\)\.fract\(\)/);
  assert.match(source, /const centre = transform\.xyz\.add\(vec3\(0, height\.mul\(0\.46\), 0\)\)/);
  assert.match(source, /const width = height\.mul\(this\.impostor\.cardAspect \?\? 1\)/,
    'each atlas declares its own card aspect instead of inheriting another species');
  assert.match(source, /const frameCrop = this\.impostor\.frameUv \?\?/,
    'each atlas may declare its measured frame crop');
  assert.match(source, /offsetU: 0\.015625, offsetV: 0\.015625, scaleU: 0\.96875, scaleV: 0\.96875/,
    'new square bakes default to their full frame inside the fixed gutter');
  assert.doesNotMatch(source, /6\.467 \/ 18\.895/,
    'runtime impostors must not retain a hard-coded prototype aspect');
});

test('tree beauty records and crowns carry stable age/orientation/volume variation', () => {
  assert.match(source, /const rotY = authoredYaw \+ \(random\(\) - 0\.5\) \* 0\.18/);
  assert.match(source, /const mature = smoothstep\(float\(8\.0\), float\(15\.0\), transform\.w\)/);
  assert.match(source, /const crownMiddle = smoothstep/);
  assert.match(source, /const heightClass = mix\(float\(0\.94\), float\(1\.08\), style\.w\)/);
  assert.match(source, /const cardWidth = width\.mul\(mix\(float\(0\.93\), float\(1\.10\), style\.z\)\)/);
  assert.match(source, /const centre = transform\.xyz\.add\(vec3\(0, height\.mul\(0\.46\), 0\)\)/);
  // Textured branchlet-card derivatives own their authored crown envelope;
  // expanding every card at runtime creates triangular shelves. Legacy
  // untextured/color-only derivatives retain the bounded authored variation.
  assert.match(source, /const crownWidth = part\.material\?\.map\s*\n\s*\? float\(1\.0\)\s*\n\s*: mix\(float\(2\.15\), float\(2\.85\), style\.z\)/);
  assert.match(source, /const radialScale = mix\(float\(1\), crownWidth, crownProfile\)/);
});

test('tree lab exposes JSON-safe projected residency diagnostics', () => {
  assert.match(source, /residencyEstimate\(camera = this\.camera\)/);
  assert.match(source, /if \(this\.forceFullLod \|\| distance < this\.uLodNear\.value/);
  assert.match(source, /forcedFullLod: this\.forceFullLod/);
  assert.match(source, /projectedHeights/);
  assert.match(source, /classificationComplete:/);
});
