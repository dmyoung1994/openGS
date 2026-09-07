import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('production renderer has one strict hardware-WebGPU backend', async () => {
  const [sceneManager, backend] = await Promise.all([
    source('src/scene/SceneManager.js'),
    source('src/scene/StrictWebGPUBackend.js'),
  ]);
  assert.match(sceneManager, /new Renderer\(new StrictWebGPUBackend\(/);
  assert.doesNotMatch(sceneManager, /new WebGLRenderer|WebGLBackend/);
  assert.match(backend, /forceFallbackAdapter:\s*false/);
  assert.match(backend, /Software\/fallback WebGPU adapters are not supported/);
  assert.match(backend, /maxSampledTexturesPerShaderStage:\s*24/,
    'the complete terrain + biome-transition graph must request more than the 16-texture compatibility baseline');
  assert.match(backend, /adapter\.limits\[name\]/);
  assert.match(backend, /below the simulator requirement/,
    'unsupported hardware must fail before shader bind-group creation');
});

test('required environment assets fail closed before rendering', async () => {
  const [main, range, terrain, bunkers, course, ball, backdrop] = await Promise.all([
    source('src/main.js'),
    source('src/scene/PlayableCourseScene.js'),
    source('src/terrain/Terrain.js'),
    source('src/scene/Bunkers.js'),
    source('src/course/course.js'),
    source('src/scene/GolfBall.js'),
    source('src/scene/BackdropTerrain.js'),
  ]);
  assert.match(main, /environmentCatalog = await environmentCatalogReady/);
  assert.match(main, /verifyEnvironmentCatalogAssets\(environmentCatalog/);
  assert.match(main, /collectEnvironmentAssetIds\(initialCourse\)/);
  assert.match(main, /get environmentReady\(\) \{ return Promise\.all\(\[environmentCatalogReady, environmentAssetIntegrityReady/);
  assert.match(main, /window\.golfBootstrap = Object\.freeze/);
  assert.match(main, /bootstrapDiagnostics\.stage === 'ready'/);
  assert.match(main, /await range\.assetsReady/);
  assert.match(main, /loadCourse\(coursePath, \{ catalogAssetIds: environmentCatalog\.byId \}\)/);
  assert.doesNotMatch(main, /e\.code === 'Digit[12]'/);
  assert.match(range, /const backdropReady = this\.creatorCanvas \? Promise\.resolve\(\) : this\.backdrop\.assetsReady/,
    'the blank creator canvas may omit backdrop assets while authored courses still fail closed');
  assert.match(range, /const waterReflectionReady = this\.creatorCanvas \? Promise\.resolve\(\) : this\.waterReflection\.assetsReady/,
    'the blank creator canvas may omit water while authored-course reflection readiness stays required');
  assert.match(range, /const creatorFrameReady = this\.creatorCanvasFrame\?\.userData\?\.assetsReady \|\| Promise\.resolve\(\)[\s\S]*?const targetPropsReady = this\._targetPropsReady \|\| Promise\.resolve\(\)[\s\S]*?Promise\.all\(\[\s*this\.terrain\.assetsReady, backdropReady,\s*treesReady, environmentPropsReady, ballReady, waterReady,\s*waterReflectionReady, creatorFrameReady, targetPropsReady,\s*\]\)/,
    'every asset present in the selected runtime must gate the ready state');
  assert.match(range, /this\.backdrop\?\.dispose\(\)/,
    'range rebuilds must explicitly release backdrop node textures and geometry');
  assert.match(range, /backdropOwned\.has\(o\)/,
    'generic disposal must not double-release explicitly owned backdrop resources');
  assert.match(range, /new BackdropTerrain\([\s\S]*?renderer,/);
  assert.match(backdrop, /disposeWebGPUGeometries\(this\.renderer, \[\.\.\.geometries\]\)/,
    'backdrop attributes must leave the WebGPU backend during range rebuilds');
  assert.doesNotMatch(range, /\bbuildBunkers\b/);
  assert.match(terrain, /Bunker sand belongs to the terrain itself/);
  assert.match(terrain, /renderedZoneAt\(x, z\)/);
  assert.doesNotMatch(terrain, /function placeholder\s*\(|keeps its placeholder/);
  assert.doesNotMatch(bunkers, /placeholderSandMaterial|return new Group\(\)/);
  assert.doesNotMatch(course, /return normalizeCourse\(\{\}\)/);
  assert.doesNotMatch(ball, /new\s+SphereGeometry\b/);
  assert.match(ball, /mesh\.visible = false/);
  assert.match(ball, /mesh\.userData\.assetsReady/);
});

test('grass compaction and motion history preserve GPU safety and temporal identity', async () => {
  const grass = await source('src/terrain/Grass.js');
  // The work-efficient Blelloch scan must guard every computed tree index before
  // shared-memory access. Its minimum left-child index is `offset - 1`, so no
  // unsigned local-id subtraction or eager WGSL select can read out of bounds.
  assert.match(grass, /for \( let offset = 1; offset < WORKGROUP; offset <<= 1 \)/);
  assert.match(grass, /If\( index\.lessThan\( uint\( WORKGROUP \) \), \(\) => \{/);
  assert.match(grass, /scan\.element\( index \)\.addAssign\( scan\.element\( index\.sub\( uint\( offset \) \) \) \)/);
  assert.doesNotMatch(grass, /scan\.element\( lid\.sub\( uint\( offset \) \) \)/);
  // Stable anchors remain camera-independent. Current and previous wind/LOD state
  // are evaluated once per surviving blade, packed into the existing identity
  // stream, and decoded independently for the two motion-history positions.
  assert.match(grass, /recordAnchor\.element\( dst \)\.assign\( vec4\( worldX, groundY, worldZ, baseHeight \) \)/);
  assert.match(grass, /packUnorm4x8\( vec4\( currentWind, previousWind \)\.div\( 32\.0 \)\.add\( 0\.5 \) \)/);
  assert.match(grass, /packUnorm4x8\( vec4\( currentLod, previousLod \) \)/);
  assert.match(grass, /const current = bladePosition\( packedWind\.xy, packedLod\.x, packedLod\.y \)/);
  assert.match(grass, /const previous = bladePosition\( packedWind\.zw, packedLod\.z, packedLod\.w \)/);
  // Distance LOD is one world-stable stochastic curve, not discrete density shelves
  // or a second radial multiplier that can reveal a camera-centred annulus. The
  // same function owns the tile's conservative upper bound, exact compaction, and
  // surviving-blade vertex LOD; counting the declaration gives four references.
  assert.match(grass, /function densityAtDistance\( radius, distance \)/);
  assert.equal((grass.match(/densityAtDistance\(/g) || []).length, 4);
  assert.match(grass, /recordColor\.element\( dst \)\.assign\( vec4\( colour, hC \) \)/);
  assert.doesNotMatch(grass, /survives[24]|morph[24]|keepMorph|radialFade/);
});

test('continuous grass LOD keeps its near carpet and fits the fixed record buffer', async () => {
  const grass = await source('src/terrain/Grass.js');
  const scalar = (name) => {
    const match = grass.match(new RegExp(`const ${name} = ([\\d._]+)`));
    assert.ok(match, `missing ${name}`);
    return Number(match[1].replaceAll('_', ''));
  };
  const near = scalar('DENSITY_NEAR_RADIUS');
  const far = scalar('DENSITY_FAR_RADIUS');
  const power = scalar('DENSITY_CURVE_POWER');
  const feather = scalar('DENSITY_FEATHER');
  const capacity = scalar('MAX_VISIBLE_BLADE_RECORDS');
  const triangleBudget = scalar('GRASS_TRIANGLE_BUDGET');
  const radius = 46;
  const keep = (distance) => {
    const progress = Math.max(0, Math.min(1,
      (distance - radius * near) / (radius * (far - near))));
    return (1 - progress) ** power * (1.08 + feather) - feather;
  };

  assert.equal(keep(0), 1.08);
  assert.ok(keep(10) > 0.65, 'high-tier grass must still read as a near carpet at 10 m');
  assert.ok(keep(10) > keep(15) && keep(15) > keep(20));
  assert.ok(keep(radius * far) <= -feather);

  // Conservative all-rough bound: keep+feather counts every blade with any non-zero
  // morph, so the real >.001 compute cutoff can only allocate fewer records.
  const candidateDensity = (192 / 8) ** 2;
  const steps = 20_000;
  const dr = radius * far / steps;
  let records = 0;
  for (let i = 0; i < steps; i++) {
    const r = (i + 0.5) * dr;
    const aliveProbability = Math.max(0, Math.min(1, keep(r) + feather));
    records += 2 * Math.PI * r * dr * candidateDensity * aliveProbability;
  }
  assert.ok(records < capacity, `${Math.ceil(records)} worst-case records exceed ${capacity}`);
  assert.equal(triangleBudget, 11_534_336,
    'grass workload must be bounded by submitted triangles rather than one full-detail blade count');
});

test('tree rendering exposes no legacy CPU alternate path', async () => {
  const [trees, vegetation] = await Promise.all([
    source('src/scene/Trees.js'),
    source('src/scene/Vegetation.js'),
  ]);
  assert.doesNotMatch(trees, /export function (?:instanceTrees|buildForest)\b/);
  assert.doesNotMatch(vegetation, /export function (?:instanceBillboards|createBillboardMaterial)\b/);
  assert.doesNotMatch(vegetation, /\bInstancedMesh\b|\bInstancedBufferAttribute\b/);
  assert.doesNotMatch(vegetation, /makeShadowCanopyTexture/);
  assert.match(trees, /new GLTFLoader\(\)\.setMeshoptDecoder\(MeshoptDecoder\)/);
  assert.match(trees, /impostorTexture\.clone\(\)/);
  assert.match(trees, /tree-shadow-source-impostor-frame/);
});

test('strict benchmark cannot alter the renderer workload', async () => {
  const benchmark = await source('scripts/benchmark-environment.mjs');
  assert.match(benchmark, /value\.startsWith\('--diagnose-'\)/);
  assert.match(benchmark, /does not permit renderer-altering diagnostic flags/);
  assert.doesNotMatch(benchmark, /grass\.update\s*=|range\.trees\.visible\s*=|range\.grass\.mesh\.visible\s*=/);
  assert.match(benchmark, /expected-device-tier/);
  assert.match(benchmark, /execFileSync\('\/usr\/bin\/pmset', args/);
  assert.match(benchmark, /canonicalTimingContract/);
  assert.match(benchmark, /Strict Metal performance evidence requires AC power/);
  assert.match(benchmark, /goalEligibility/);
  assert.match(benchmark, /Environment device tier mismatch/);
  assert.match(benchmark, /evaluatorCamera\.setPose/);
  assert.match(benchmark, /evaluatorCamera\.freeze\(\)/);
  assert.match(benchmark, /bootstrap\?\.diagnostics\?\.stages/);
  assert.match(benchmark, /elapsedMs: bootstrap\?\.elapsedMs/);
  assert.match(benchmark, /evaluatorCamera\?\.exit\(\)/);
  assert.match(benchmark, /quality\.acquirePresentationLock\(\{ mode, renderScale \}\)/);
  assert.match(benchmark, /quality\.releasePresentationLock\(lockId\)/);
  assert.match(benchmark, /presentationQualityMode = 'quality'/);
  assert.match(benchmark, /presentationRenderScale = 1\.0/);
  assert.match(benchmark, /qualityDiagnostics\.presentationLock\?\.active !== true/,
    'every scenario must prove that the quality lock remains active');
  assert.match(benchmark, /function viewportDimensionSignature\(viewport\)/);
  assert.match(benchmark, /temporalStability\.viewportSignatureCount = new Set\(viewportSignatures\)\.size/);
  assert.doesNotMatch(benchmark, /map\(\(\{ viewport \}\) => JSON\.stringify\(viewport\)\)/,
    'advancing temporal counters are not viewport dimensions');
  assert.match(benchmark, /await waitFrames\(4\)/,
    'the fixed quality resize must settle before production-view prewarm');
  assert.match(benchmark, /waterReflectionDiagnostics\(\)/);
  assert.match(benchmark, /entry\.mode !== 'quality'/);
  assert.match(benchmark, /entry\.source !== 'planar'/);
  assert.match(benchmark, /entry\.planarReady !== true/);
  assert.match(benchmark, /entry\.planarPass\?\.allocatedTargets !== 2/);
  assert.match(benchmark, /entry\.planarPass\?\.strictWebGPU !== true/);
  assert.match(benchmark, /entry\.renderTargetChurn !== false/);
  assert.match(benchmark, /entry\.fixedCanvas !== false/);
  assert.match(benchmark, /treeShadowDiagnostics\.workload\?\.authoredSourceRecordsKept/);
  assert.match(benchmark, /beauty\.workload\?\.authoredGeometry !== true/);
  assert.match(benchmark, /beauty\.impostorCount !== 0 \|\| beauty\.impostorDraws !== 0/);
  assert.match(benchmark, /tree shadow residency does not match authored beauty geometry/);
  assert.doesNotMatch(benchmark, /two-triangle indirect proxy|runtime-lit impostor/);
  assert.doesNotMatch(benchmark, /freeCam\.yaw|freeCam\.pitch|camera\.position\.set/);
});

test('environment benchmark keeps full-suite default and safe single-scenario filtering', async () => {
  const benchmark = await source('scripts/benchmark-environment.mjs');
  assert.match(benchmark, /const requestedScenario = arg\('scenario', null\)/);
  assert.match(benchmark, /const selectedScenarios = requestedScenario\s*\? scenarios\.filter\(\(scenario\) => scenario\.id === requestedScenario\)\s*:\s*scenarios\.filter\(\(scenario\) => !scenario\.stressOnly\)/);
  assert.match(benchmark, /Unknown --scenario/);
  assert.match(benchmark, /for \(const scenario of selectedScenarios\)/);
});

test('environment benchmark distinguishes clear-weather zero work from cloud distribution', async () => {
  const benchmark = await source('scripts/benchmark-environment.mjs');
  assert.match(benchmark, /usesVolumetricClouds: sm\.weatherSky\.usesVolumetricClouds === true/);
  assert.match(benchmark, /hasCloudTemporalPass: sm\._cloudTemporal !== null/);
  assert.match(benchmark, /const cloudsEnabled = weatherDiagnostics\.usesVolumetricClouds === true/);
  assert.match(benchmark, /clear weather unexpectedly allocated volumetric cloud work/);
  assert.match(benchmark, /one bounded fused raymarch\/history pass/);
  assert.match(benchmark, /ping-pong resolve/);
  assert.match(benchmark, /fused raymarch/);
  assert.match(benchmark, /temporal resolve/);
  assert.doesNotMatch(benchmark, /skyScene|_skyPass|Dynamic atmosphere and volumetric clouds/);
});

test('robustness memory accounting deduplicates shared interleaved GPU buffers', async () => {
  const source = await readFile(new URL('../scripts/benchmark-environment-robustness.mjs', import.meta.url), 'utf8');
  assert.match(source, /const seenInterleavedBuffers = new WeakSet\(\)/,
    'shared foliage attribute views need backing-allocation identity accounting');
  assert.match(source, /resource\?\.isInterleavedBufferAttribute \? resource\.data : null/,
    'interleaved attributes must normalize to their one GPU backing buffer');
  assert.match(source, /if \(seenInterleavedBuffers\.has\(interleavedBuffer\)\) continue/,
    'the memory cap must not charge a shared allocation once per semantic view');
  assert.match(source, /return \{ frame: renderer\.info\.frame, memory, rawMemory, multiset \}/,
    'reports must preserve raw Three diagnostics alongside corrected allocation totals');
});

test('local evaluation uses one observable canonical range endpoint', async () => {
  const [vite, shot] = await Promise.all([
    source('vite.config.js'),
    source('scripts/shot.mjs'),
  ]);
  assert.match(vite, /server:\s*\{\s*port:\s*5173,\s*host:\s*'127\.0\.0\.1',\s*strictPort:\s*true\s*\}/,
    'Vite must stay loopback-only and fail rather than silently create stale 5174/5175 range servers');
  assert.match(shot, /const evaluation = await page\.evaluate\(arg\('eval'\)\)/,
    'the engine capture hook must retain the evaluated diagnostic result');
  assert.match(shot, /console\.log\(`eval \$\{JSON\.stringify\(evaluation\)\}`\)/,
    'engine state returned from --eval must be visible in capture evidence');
  assert.match(shot, /if \(!game && has\('subject-mask'\)\)/,
    'isolated tree evaluation needs a production-lit silhouette measurement');
  assert.match(shot, /current\?\.treeBeauty\?\.group/,
    'the silhouette probe must isolate the actual tree subject, not colour-key the scene');
  assert.match(shot, /fillPct:/,
    'the silhouette probe must report crown occupancy, not only a loose bounding box');
});
