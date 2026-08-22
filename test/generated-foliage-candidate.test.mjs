import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { decodePNG } from '../scripts/lib/png.mjs';

const root = new URL('../public/assets/trees_candidates/generated_fir_clusters/', import.meta.url);

test('generated Douglas-fir source is processed into a bounded versioned foliage pack', async () => {
  const metadata = JSON.parse(await readFile(new URL('processed/v2/douglas-fir-cluster-atlas.json', root), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('processed/v2/foliage-pack.json', root), 'utf8'));
  const atlas = decodePNG(await readFile(new URL('processed/v2/douglas-fir-cluster-atlas.png', root)));
  const ktx2 = await readFile(new URL('processed/v2/douglas-fir-cluster-atlas.ktx2', root));
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.candidateOnly, true);
  assert.equal(metadata.foliageAlias, 'builtin.douglas-fir.pnw.v1');
  assert.equal(metadata.species, 'douglas-fir');
  assert.equal(metadata.clusters.length, 8);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.compatibilityVersion, 1);
  assert.equal(manifest.validation.state, 'candidate');
  assert.match(manifest.processor.configSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.processor.config, /^[a-z0-9.-]+\.json$/);
  assert.match(manifest.provenance.promptRecord, /^config-relative:/);
  assert.match(manifest.structuralMaterial.provenance, /^config-relative:/);
  assert.deepEqual(Object.keys(manifest.structuralMaterial.textures).sort(), ['albedo', 'arm', 'normal']);
  assert.equal(manifest.requiredFiles.length, 8);
  assert.deepEqual([...ktx2.subarray(0, 12)], [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([atlas.width, atlas.height, atlas.channels], [2048, 2048, 4]);
  for (const cluster of metadata.clusters) {
    assert.ok(cluster.aspect > 0.5 && cluster.aspect < 3.0, `${cluster.name} has implausible card aspect`);
    assert.ok(cluster.uv.u0 >= 0 && cluster.uv.v0 >= 0 && cluster.uv.u1 <= 1 && cluster.uv.v1 <= 1);
    assert.ok(cluster.uv.u1 > cluster.uv.u0 && cluster.uv.v1 > cluster.uv.v0);
    assert.ok(['left', 'right', 'bottom', 'top'].includes(cluster.baseEdge));
    assert.ok(cluster.lodUse.length >= 1);
    assert.ok(cluster.recommendedScaleMeters > 0.4 && cluster.recommendedScaleMeters < 4);
  }
  let covered = 0;
  for (let i = 3; i < atlas.pixels.length; i += 4) if (atlas.pixels[i] > 0) covered++;
  const coverage = covered / (atlas.width * atlas.height);
  assert.ok(coverage > 0.08 && coverage < 0.30, `atlas alpha coverage ${coverage} is not tightly bounded`);
  assert.ok(metadata.metrics.maximumMeasuredMipDrift < 0.002);
  assert.ok(metadata.metrics.transparentOverdrawEstimate < 0.60);
  assert.ok(metadata.metrics.compression.atlasKtx2Bytes < metadata.metrics.compression.atlasPngBytes);
});

test('generated foliage stays isolated in the viewer and retains its processing contract', async () => {
  const [viewer, processor, goal, html, robustness] = await Promise.all([
    readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8'),
    readFile(new URL('../tools/foliage-pipeline/process-source.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../GOAL.md', import.meta.url), 'utf8'),
    readFile(new URL('../viewer.html', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/benchmark-environment-robustness.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(viewer, /tree candidate: generated Douglas-fir clusters/);
  assert.match(viewer, /generatedTreePatch/);
  assert.match(viewer, /tree candidate: generated Italian cypress/);
  assert.match(viewer, /tree candidate: generated Monterey cypress/);
  assert.match(viewer, /tree candidate: generated valley oak/);
  assert.match(viewer, /tree candidate: generated sugar maple/);
  assert.doesNotMatch(viewer, /img2threejs|reference sequoia/i,
    'the rejected reference-tree experiment must not remain selectable');
  assert.match(viewer, /tree candidate: generated Douglas-fir far parent/);
  assert.match(viewer, /tree candidate: generated Italian cypress far parent/);
  assert.match(viewer, /tree candidate: generated Monterey cypress far parent/);
  assert.match(viewer, /forceBand: 2/);
  assert.match(viewer, /textureMode.*texture.*png.*ktx2/);
  assert.doesNotMatch(viewer, /catalog\.json.*generated-douglas/i);
  assert.match(processor, /encodeToKTX2/);
  assert.match(processor, /dilateTransparentRgb/);
  assert.match(processor, /buildMaterialMask/);
  assert.match(processor, /encodeToKTX2/);
  assert.match(processor, /extractSheetComponents/);
  assert.match(goal, /Status: \*\*active\*\*/);
  assert.match(goal, /Generated-course foliage aliases/);
  assert.match(html, /#app canvas \{ display: block; width: 100%; height: 100%; \}/);
  assert.match(robustness, /url\.searchParams\.set\('foliageCandidate', String\(foliageCandidate\)\)/,
    'robustness certification must be able to exercise generated production foliage');
});

test('cypress and broadleaf cards preserve their authored stem-root to tip attachment axis', async () => {
  const species = [
    ['italian-cypress', new URL('../public/assets/trees_candidates/generated_italian_cypress/processed/v1/italian-cypress-cluster-atlas.json', import.meta.url)],
    ['monterey-cypress', new URL('../public/assets/trees_candidates/generated_monterey_cypress/processed/v1/monterey-cypress-cluster-atlas.json', import.meta.url)],
    ['valley-oak', new URL('../public/assets/trees_candidates/generated_valley_oak/processed/v1/valley-oak-cluster-atlas.json', import.meta.url)],
    ['sugar-maple', new URL('../public/assets/trees_candidates/generated_sugar_maple/processed/v1/sugar-maple-cluster-atlas.json', import.meta.url)],
  ];

  for (const [name, url] of species) {
    const metadata = JSON.parse(await readFile(url, 'utf8'));
    assert.equal(metadata.species, name);
    for (const cluster of metadata.clusters) {
      const frame = cluster.attachmentFrame;
      assert.ok(frame, `${name}/${cluster.name} is missing its attachment frame`);
      assert.equal(frame.baseUv.length, 2);
      assert.equal(frame.axisUv.length, 2);
      assert.ok(Math.abs(Math.hypot(...frame.axisUv) - 1) < 0.00001, `${name}/${cluster.name} attachment axis is not normalized`);
      assert.ok(frame.growthExtent > 0.5, `${name}/${cluster.name} has too little root-to-tip growth extent`);
      assert.ok(frame.lateralHalfExtent > 0.05, `${name}/${cluster.name} has a collapsed lateral span`);
    }
  }
});

test('generated foliage camera-facing bias preserves the rooted branch axis', async () => {
  const source = await readFile(new URL('../src/scene/GeneratedFoliageTree.js', import.meta.url), 'utf8');
  assert.match(source, /geometry\.setAttribute\('foliageAxis'/,
    'every card needs its authored branch axis in the GPU vertex stream');
  assert.match(source, /geometry\.setAttribute\('foliageCardUp'/,
    'every card needs a stable authored lateral axis');
  assert.match(source, /const axialOffset = cardAxis\.mul\(sourceRelative\.dot\(cardAxis\)\)/,
    'camera-facing rotation must retain root-to-tip displacement');
  assert.match(source, /projectedView\.normalize\(\)\.cross\(cardAxis\)\.normalize\(\)/,
    'the lateral card axis must face the camera around the rooted growth axis');
  assert.match(source, /speciesId === 'valley-oak' \|\| speciesId === 'sugar-maple' \? 0\.88 : 0\.76/,
    'broadleaf cards need a stronger bias while crossed conifer sprays retain volume');
  assert.match(source, /previousCameraNode/,
    'camera-facing deformation must participate in temporal velocity history');
  assert.doesNotMatch(source, /cameraPosition\.sub\(sourcePosition\)/,
    'whole-card spherical billboarding would detach the authored branch base');
});

test('generated foliage beauty cards use real shared lighting while debug views stay unlit', async () => {
  const source = await readFile(new URL('../src/scene/GeneratedFoliageTree.js', import.meta.url), 'utf8');
  assert.match(source, /class SharedEnvironmentGeneratedFoliageLambertMaterial extends MeshLambertNodeMaterial/,
    'beauty foliage must use a lit material rather than remain self-lit beside its shadow');
  assert.match(source, /builder\.environmentNode \? new EnvironmentNode\(builder\.environmentNode\)/,
    'generated foliage must consume SceneManager shared environment lighting');
  assert.match(source, /iblIrradiance\.mul\(BRDF_Lambert\(\{ diffuseColor: diffuseColor\.rgb \}\)\)/,
    'Lambert foliage must bridge the shared PMREM irradiance into indirect diffuse fill');
  assert.match(source, /debugMode === 'beauty'[\s\S]*new SharedEnvironmentGeneratedFoliageLambertMaterial/,
    'the production beauty path must select shared-light diffuse shading');
  assert.match(source, /super\(false\)/,
    'matte foliage must not pay the alpha-overdraw cost of a per-pixel specular lobe');
  assert.match(source, /material\.normalNode = transformNormalToView\(shapedNormalWorld\)/,
    'camera-facing cards must provide their deformed normal to the lighting model');
  assert.match(source, /: new MeshBasicNodeMaterial/,
    'diagnostic alpha, mask, normal, LOD, and hull colors must remain exact and unlit');
  assert.doesNotMatch(source, /const sharedDaylight|const diffuseSun/,
    'a hand-painted daylight multiplier must not bypass the renderer lighting model');
});

test('free-camera drag release invalidates temporal history once the view settles', async () => {
  const [camera, viewer, main, sceneManager] = await Promise.all([
    readFile(new URL('../src/camera/FreeCamera.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewer/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8'),
  ]);
  assert.match(camera, /constructor\(camera, domElement, terrain, \{ onDragEnd = null \} = \{\}\)/);
  assert.match(camera, /this\.onDragEnd\?\.\(\)/,
    'mouse-up must discard motion-contaminated TRAA history at the settled camera pose');
  assert.match(viewer, /invalidateTemporalHistory\('viewer free-camera drag settled'\)/);
  assert.match(main, /invalidateTemporalHistory\('free-camera drag settled'\)/);
  assert.match(sceneManager, /invalidateTemporalHistory[\s\S]*this\._cloudTemporal\?\.reset\(\)[\s\S]*this\._traa\.reset\(\)/,
    'one temporal invalidation must clear both cloud reprojection and full-resolution TRAA');
});

test('generated structural cylinders face outward so scanned bark remains visible', async () => {
  const source = await readFile(new URL('../src/scene/GeneratedFoliageTree.js', import.meta.url), 'utf8');
  assert.match(source, /builder\.indices\.push\(a, b, c, b, d, c\)/,
    'tapered segment triangles must agree with their outward radial vertex normals');
  assert.doesNotMatch(source, /builder\.indices\.push\(a, c, b, b, c, d\)/,
    'the old inward winding made open Monterey structure render through its dark interior');
  assert.match(source, /function appendTaperedTrunk\(builder, points, radii, sides = 9\)/,
    'the main trunk must be one smooth ring mesh rather than stacked capped cylinders');
  assert.match(source, /const barkAlbedo = texture\(bark\.albedo\)\.rgb/);
  assert.match(source, /barkAlbedo\.mul\(vec3\(4\.40, 4\.10, 3\.80\)\)/,
    'the darker Monterey scan must be source-normalized before shared lighting');
  assert.match(source, /barkAlbedo\.mul\(vec3\(1\.55, 1\.50, 1\.45\)\)/,
    'broadleaf bark scans must share a bounded matte reflectance target');
  assert.match(source, /normalizedBark\.min\(vec3\(0\.46, 0\.40, 0\.34\)\)/,
    'scan exposure outliers must not draw near-white contours around branch silhouettes');
  assert.doesNotMatch(source, /normalMap: bark\.normal/,
    'a tangent-space scan cannot be used until its TBN follows storage-authored yaw');
  assert.doesNotMatch(source, /roughnessMap: bark\.arm/,
    'scan exposure must not make nominally identical trunks alternate between polished and matte');
  assert.match(source, /roughness: 0\.94, metalness: 0/);
  assert.match(source, /const structureNormalWorld = rotateYaw\(normalLocal\)\.normalize\(\)/,
    'structure normals must rotate with storage-authored placement yaw');
  assert.doesNotMatch(source, /emissiveMap:\s*bark|emissiveNode[\s\S]*bark/);
  assert.match(source, /this\.structure\.receiveShadow = true/,
    'the lab structure must be judged under the production shadow field');
  assert.match(source, /this\.foliage\.receiveShadow = true/,
    'lab foliage must respond to the same direct-light occlusion as production');
  assert.match(source, /mesh\.receiveShadow = command !== 3/,
    'every beauty draw must receive shared production shadows');
  assert.match(source, /startRadius \* 0\.62/,
    'branch starts must bury into their parent instead of exposing an open ring');
  assert.match(source, /endRadius \* 0\.72/,
    'crooked segment elbows need bounded overlap across differently oriented rings');
  assert.match(source, /builder\.indices\.push\(startCap, b, a, endCap, c, d\)/,
    'any exposed joint ring must show closed bark rather than sky or dark interior');
  assert.match(source, /const trunkPoint = \(y\) =>/,
    'broadleaf leaders must sample the same crooked trunk curve as structural geometry');
  assert.match(source, /const start = trunkPoint\(trunkHeight \* spec\.attach\)/,
    'oak and maple primary forks must begin inside the real trunk centerline');
  assert.match(source, /manifest\.candidateOnly !== \(validationState === 'candidate'\)/,
    'direct lab loads must reject a manifest whose candidate flag disagrees with validation state');
  assert.doesNotMatch(source, /return \{ candidateOnly: true, generatedSource: true/,
    'runtime diagnostics must not remain candidate-only after approval');
  assert.match(source, /candidateOnly: pack\.manifest\.candidateOnly/);
  assert.match(source, /validationState: pack\.manifest\.validation\.state/);
});

test('processed foliage cards contain one connected alpha silhouette without floating source fragments', async () => {
  const clusterDirectories = [
    new URL('../public/assets/trees_candidates/generated_fir_clusters/processed/v2/clusters/', import.meta.url),
    new URL('../public/assets/trees_candidates/generated_italian_cypress/processed/v1/clusters/', import.meta.url),
    new URL('../public/assets/trees_candidates/generated_monterey_cypress/processed/v1/clusters/', import.meta.url),
    new URL('../public/assets/trees_candidates/generated_valley_oak/processed/v1/clusters/', import.meta.url),
    new URL('../public/assets/trees_candidates/generated_sugar_maple/processed/v1/clusters/', import.meta.url),
  ];
  for (const directory of clusterDirectories) {
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.png'))) {
      const image = decodePNG(await readFile(new URL(file, directory)));
      const seen = new Uint8Array(image.width * image.height);
      let components = 0;
      for (let start = 0; start < seen.length; start++) {
        if (seen[start] || image.pixels[start * 4 + 3] === 0) continue;
        components++;
        const queue = [start]; seen[start] = 1;
        for (let cursor = 0; cursor < queue.length; cursor++) {
          const index = queue[cursor], x = index % image.width, y = Math.floor(index / image.width);
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
            const neighbor = ny * image.width + nx;
            if (seen[neighbor] || image.pixels[neighbor * 4 + 3] === 0) continue;
            seen[neighbor] = 1; queue.push(neighbor);
          }
        }
      }
      assert.equal(components, 1, `${file} contains ${components} disconnected alpha islands`);
    }
  }
});
