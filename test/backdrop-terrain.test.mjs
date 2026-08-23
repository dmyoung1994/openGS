import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { alpineComposition, BackdropTerrain, sampleAlpineWorld } from '../src/scene/BackdropTerrain.js';
import { NORTH_CASCADES_DEM } from '../src/terrain/northCascadesDem.js';

const bounds = { minX: -110, maxX: 110, minZ: -340, maxZ: 30 };
const terrain = { heightAt: (x, z) => x * 0.002 + z * 0.001 };

test('bundled USGS ridge table is compact, deterministic, and bounded', async () => {
  assert.equal(NORTH_CASCADES_DEM.width, 128);
  assert.equal(NORTH_CASCADES_DEM.height, 128);
  assert.equal(NORTH_CASCADES_DEM.values.length, 128 * 128);
  assert.ok(NORTH_CASCADES_DEM.values.every((value) => value >= 0 && value <= 65535));
  const png = await readFile(new URL('../public/assets/terrain/north-cascades-pickets-128.png', import.meta.url));
  assert.equal(createHash('sha256').update(png).digest('hex'),
    '3e3f7bdb41c4d1d1b272cd9b25952e4319419e30d8cd09907c85b358055f7b42');
});

test('alpine geology uses licensed 90 m scan maps through the GPU material path', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /alpine_granite_albedo_v1\.png|loadGraniteAlbedo|graniteTexture/,
    'the retired granite image must not have runtime ownership');
  const diffuse = await readFile(new URL(
    '../public/assets/materials/rocky_terrain/rocky_terrain_diff_1k.jpg', import.meta.url,
  ));
  const normal = await readFile(new URL(
    '../public/assets/materials/rocky_terrain/rocky_terrain_nor_gl_1k.jpg', import.meta.url,
  ));
  assert.equal(createHash('sha256').update(diffuse).digest('hex'),
    '429315865fd89c150272592f6d93def174c6f69804a565ff08e53627a885579b');
  assert.equal(createHash('sha256').update(normal).digest('hex'),
    'a6556e1220c6e6c822e68ceeb9589719e4db8c87340199657cc705fea6ecf391');
  assert.match(source, /rocky_terrain_diff_1k\.jpg/);
  assert.match(source, /rocky_terrain_nor_gl_1k\.jpg/);
  assert.match(source, /\.mul\(1 \/ 90\)/,
    'the 90 m scan must retain its physical world scale in the shader');
  assert.match(source, /texture\(rockTexture, rockSideUv\)/);
  assert.match(source, /texture\(rockNormalTexture, rockTopUv\)/);
  const material = source.slice(source.indexOf('function biplanarField'), source.indexOf('function buildPatch'));
  assert.match(material, /function biplanarField\(/,
    'procedural mineral fields need a surface-safe biplanar domain');
  assert.match(material, /const top = mx_noise_float/);
  assert.match(material, /const side = mx_noise_float/,
    'vertical faces need a height-varying side basis');
  assert.match(material, /const worldFootprint = world\.x\.fwidth\(\)/,
    'detail octaves must be derivative-aware');
  assert.match(material, /cameraPosition\.sub\(world\)\.length\(\)/,
    'detail handoff must include view distance');
  assert.match(material, /const vertexStrataWarp = mx_noise_float/,
    'stratification must be evaluated in the vertex graph');
  assert.match(material, /const directWeathering = jointShoulder/,
    'weathering needs a shared scan/relief mask');
  assert.match(material, /const directMineral = directRock/,
    'one explicit rock substrate must own the scan contribution');
});

test('alpine backdrop keeps the rejected far-conifer derivative out of runtime', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /conifer_community_v1_impostor\.png/, 'experimental derivative must not load at runtime');
  assert.doesNotMatch(source, /InstancedMesh|buildFarConiferCommunity|farConiferMaterial/,
    'rejected forest layer must not leave a runtime draw path');
  assert.doesNotMatch(source, /_farConiferTexture|farConifer/, 'rejected atlas must not have runtime ownership');
});

test('alpine runtime owns the horizon with a bounded two-band procedural shell', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  const alpineBuild = source.slice(source.indexOf('  _buildAlpine('), source.indexOf('  _buildMaritime('));
  assert.match(alpineBuild, /backdropSource = 'procedural-alpine-shell'/);
  assert.match(alpineBuild, /proceduralShell = true/);
  assert.doesNotMatch(alpineBuild, /weather-sky-hdr/,
    'the dropped photographic HDR must not come back as a horizon source');

  const backdrop = new BackdropTerrain({
    terrain,
    bounds,
    seed: 1128746828,
    biome: 'temperate-alpine',
  });
  await backdrop.assetsReady;
  assert.equal(backdrop.group.userData.proceduralShell, true);
  assert.equal(typeof backdrop.group.userData.authoringSampler, 'function');

  const bandA = backdrop.group.children.filter((mesh) => mesh.name === 'alpine-foothill-band');
  const bandB = backdrop.group.children.filter((mesh) => mesh.name === 'alpine-far-massif');
  assert.ok(bandA.length > 0 && bandA.length <= 4, `Band A draws must stay <= 4; got ${bandA.length}`);
  assert.ok(bandB.length > 0 && bandB.length <= 8, `Band B draws must stay <= 8; got ${bandB.length}`);
  assert.equal(bandA.length + bandB.length, backdrop.group.children.length,
    'the shell must not add unnamed meshes');

  let verts = 0;
  for (const mesh of backdrop.group.children) {
    verts += mesh.geometry.attributes.position.count;
    assert.equal(mesh.castShadow, false, `${mesh.name} must not cast shadows`);
    assert.equal(mesh.receiveShadow, false, `${mesh.name} must not receive shadows`);
    assert.ok(mesh.geometry.attributes.backdropGeology, `${mesh.name} needs the geology attribute`);
    assert.ok(mesh.geometry.boundingSphere, `${mesh.name} needs a bounding sphere to frustum-cull`);
  }
  assert.ok(verts <= 40000, `backdrop shell must stay within its ~40k vertex budget; got ${verts}`);

  // Both bands must share one material, or the join lights as two shells.
  const materials = new Set(backdrop.group.children.map((mesh) => mesh.material));
  assert.equal(materials.size, 1, 'both bands must share one material instance');
  backdrop.dispose();
});

test('alpine far massif stays inside the DEM extent and the camera far plane', async () => {
  const backdrop = new BackdropTerrain({
    terrain, bounds, seed: 1128746828, biome: 'temperate-alpine',
  });
  await backdrop.assetsReady;
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  let maxRadius = 0;
  for (const mesh of backdrop.group.children) {
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      maxRadius = Math.max(maxRadius, Math.hypot(
        position.getX(i) - centerX, position.getZ(i) - centerZ,
      ));
    }
  }
  // 3800 m is the baked DEM half-extent; beyond it the table clamps and tiles.
  assert.ok(maxRadius <= 3800, `shell must stay inside the DEM extent; reached ${maxRadius}`);
  // The runtime camera far plane is 6000 m.
  assert.ok(maxRadius < 6000, `shell must stay inside the camera far plane; reached ${maxRadius}`);
  backdrop.dispose();
});

test('alpine bands use a bounded depth-safe overlap rather than cracking', async () => {
  const backdrop = new BackdropTerrain({
    terrain, bounds, seed: 1128746828, biome: 'temperate-alpine',
  });
  await backdrop.assetsReady;
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const massif = backdrop.group.children.filter((mesh) => mesh.name === 'alpine-far-massif');
  assert.ok(massif.length > 0);
  const sampler = backdrop.group.userData.authoringSampler;
  for (const mesh of massif) {
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const radius = Math.hypot(x - centerX, z - centerZ);
      // The first ribbon row intentionally overlaps Band A by 72 m; ordered
      // depth ownership makes the overlap watertight at grazing angles.
      assert.ok(radius >= 1327, `ribbon vertex exceeds the bounded join overlap: ${radius}`);
      const height = position.getY(i);
      const truth = sampler.heightAt(x, z);
      // Vertices are either exactly on the shared sampler or on the hidden skirt.
      // Positions are stored as float32, so compare well inside the 40 m skirt
      // drop rather than at double precision.
      const onSurface = Math.abs(height - truth) < 0.01;
      const onSkirt = Math.abs(height - (truth - 40)) < 0.01;
      assert.ok(onSurface || onSkirt,
        `ribbon vertex must follow the shared sampler; got ${height} vs ${truth}`);
    }
  }
  backdrop.dispose();
});

test('alpine world composition is deterministic, seed-variable, and continuous at the playable edge', () => {
  const first = alpineComposition(1128746828);
  const second = alpineComposition(1128746828);
  const other = alpineComposition(1128746829);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
  const edge = sampleAlpineWorld({ terrain, bounds, seed: 1128746828, x: bounds.maxX, z: -120 });
  assert.ok(Math.abs(edge.height - terrain.heightAt(bounds.maxX, -120)) < 1e-10);
  const samplesA = [[500, -700], [-900, -1300], [1300, 400]].map(([x, z]) => (
    sampleAlpineWorld({ terrain, bounds, seed: 1128746828, x, z }).height
  ));
  const samplesB = [[500, -700], [-900, -1300], [1300, 400]].map(([x, z]) => (
    sampleAlpineWorld({ terrain, bounds, seed: 1128746828, x, z }).height
  ));
  assert.deepEqual(samplesA, samplesB);
});

test('alpine basin preserves the authored downrange valley opening', () => {
  const seed = 1128746828;
  const c = alpineComposition(seed);
  const radius = 2800;
  const sampleAt = (azimuth) => sampleAlpineWorld({
    terrain, bounds, seed,
    x: Math.sin(azimuth) * radius,
    z: -155 - Math.cos(azimuth) * radius,
    composition: c,
  }).height;
  const opening = sampleAt(c.openingAzimuth);
  const walls = [sampleAt(c.dominantAzimuth), sampleAt(c.secondaryAzimuth)];
  assert.ok(opening < Math.min(...walls), `opening ${opening} must remain below walls ${walls}`);
});

test('alpine composition exposes near and far ridge tiers on each authored bearing', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const sampleRay = (azimuth) => Array.from({ length: 33 }, (_, index) => {
    const radius = 200 + index * 100;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    }).height;
  });
  for (const [name, azimuth] of [
    ['dominant', composition.dominantAzimuth],
    ['secondary', composition.secondaryAzimuth],
    ['opening', composition.openingAzimuth],
  ]) {
    const heights = sampleRay(azimuth);
    const peaks = heights.filter((height, index) => index > 0 && index < heights.length - 1
      && height > heights[index - 1] && height >= heights[index + 1]
      && height - Math.min(heights[index - 1], heights[index + 1]) > 10);
    assert.ok(peaks.length >= 2, `${name} bearing needs near/far ridge tiers; found ${peaks.length}`);
  }
});

test('alpine ridge field bounds local slope and curvature across the visible massif', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const step = 32;
  let maxSlope = 0;
  let maxCurvature = 0;
  const heightAt = (x, z) => sampleAlpineWorld({ terrain, bounds, seed, composition, x, z }).height;
  for (let z = -3400; z <= -400; z += step) {
    for (let x = -3400; x <= 3400; x += step) {
      const center = heightAt(x, z);
      const left = heightAt(x - step, z);
      const right = heightAt(x + step, z);
      const near = heightAt(x, z - step);
      const far = heightAt(x, z + step);
      maxSlope = Math.max(maxSlope, Math.hypot((right - left) / (2 * step), (far - near) / (2 * step)));
      maxCurvature = Math.max(maxCurvature,
        Math.abs(right - 2 * center + left) / (step * step)
        + Math.abs(far - 2 * center + near) / (step * step));
    }
  }
  // These bounds exist to forbid NEEDLES: the failure this contract was written
  // against was isolated single-vertex towers and crushed black slots produced by
  // six independent erosion masks coinciding on a coarse grid. They were not
  // written to cap a real face angle, and 1.0 is only 45 degrees -- shallower
  // than the North Cascades walls the bundled DEM is sampled from, and shallower
  // than any alpine massif with 900 m of relief over ~1.3 km of half-wavelength
  // can possibly be. Holding 45 degrees meant the shell could only ever be a
  // smooth dome, which is what it was.
  //
  // Raised to 61 degrees, measured over a 32 m step. A needle still fails this
  // comfortably: the rejected towers measured above 3.0 here, and a one-vertex
  // spike shows curvature an order of magnitude over the bound below.
  assert.ok(maxSlope < 1.85, `visible alpine slopes must stay bounded; measured ${maxSlope}`);
  assert.ok(maxCurvature < 0.075, `visible alpine curvature must stay bounded; measured ${maxCurvature}`);
});

test('alpine foothills transition from meadow into broken mineral faces before the massif', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const radius = 1250;
  const samples = Array.from({ length: 32 }, (_, i) => {
    const azimuth = -Math.PI + (Math.PI * 2 * i) / 32;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    });
  });
  const heights = samples.map((sample) => sample.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 60, 'foothills need visible ridge/cliff relief');
  // Explicit cliff/scree fields carry the lower wall before the altitude-driven
  // mineral mix becomes dominant. Requiring a large rock mask at this radius
  // previously encouraged swollen, uniformly exposed foothills.
  assert.ok(Math.max(...samples.map((sample) => sample.rock)) > 0.005, 'lower wall needs emerging mineral geology');
  assert.ok(Math.max(...samples.map((sample) => sample.cliff)) > 0.1, 'lower wall needs geometry-scale cliff breakup');
  assert.ok(Math.max(...samples.map((sample) => sample.scree)) > 0.05, 'lower wall needs a readable talus/wash transition');
});

test('alpine near wall breaks the continuous forest shelf into hierarchical landforms', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const samples = Array.from({ length: 40 }, (_, i) => {
    const azimuth = -Math.PI + (Math.PI * 2 * i) / 40;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * 980,
      z: -155 - Math.cos(azimuth) * 980,
    });
  });
  const heights = samples.map((sample) => sample.height);
  const meadowCoverage = samples.map((sample) => 1 - sample.treeline);
  // Albedo is no longer sampled here: the shell classifies per pixel in
  // worldMaterial, so what this sampler owes the renderer is the BROAD gates that
  // vary around the wall, not a colour. Asserting on a baked luminance would now
  // be asserting on something nothing draws.
  const rock = samples.map((sample) => sample.rock);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 45,
    'near wall needs broad spur and saddle relief');
  assert.ok(Math.max(...meadowCoverage) - Math.min(...meadowCoverage) > 0.12,
    'near wall needs seeded meadow/conifer clearing variation');
  assert.ok(Math.max(...rock) - Math.min(...rock) > 0.10,
    'near wall mineral exposure must not collapse into one uniform shelf');
});

test('alpine middle wall exposes mixed forest, meadow, and mineral tiers', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const samples = Array.from({ length: 48 }, (_, i) => {
    const azimuth = -Math.PI + (Math.PI * 2 * i) / 48;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * 900,
      z: -155 - Math.cos(azimuth) * 900,
    });
  });
  // This ring is the first non-playable landform visible above the course edge.
  // It must be more than a low conifer shelf: the new tier lift and geology
  // signals should produce a readable mix before the distant granite massif.
  assert.ok(Math.max(...samples.map((sample) => sample.height)) > 135,
    'middle wall needs enough vertical scale to read above the course edge');
  assert.ok(Math.max(...samples.map((sample) => sample.rock)) > 0.35,
    'middle wall needs exposed mineral breaks before the far massif');
  assert.ok(Math.min(...samples.map((sample) => sample.treeline)) < 0.2,
    'middle wall needs meadow/outcrop clearings within the forest transition');
  assert.ok(Math.max(...samples.map((sample) => sample.treeline)) > 0.45,
    'middle wall must retain conifer toes rather than becoming a uniform rock band');
});

test('alpine wall bearings carry classification, rock, and height variation through the first 1400 m', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const radii = [520, 640, 760, 880, 1000, 1120, 1240, 1360];
  for (const [name, azimuth] of [
    ['dominant', composition.dominantAzimuth],
    ['secondary', composition.secondaryAzimuth],
    ['opening', composition.openingAzimuth],
  ]) {
    const samples = radii.map((radius) => sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    }));
    const heights = samples.map((sample) => sample.height);
    assert.ok(Math.max(...samples.map((sample) => sample.rock))
      - Math.min(...samples.map((sample) => sample.rock)) > 0.12,
    `${name} wall needs material variation along exact wall radii`);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 70,
      `${name} wall needs landform variation along exact wall radii`);
    assert.ok(Math.min(...samples.map((sample) => sample.rock)) < 0.16,
      `${name} wall needs non-rock meadow/conifer pockets`);
    assert.ok(Math.max(...samples.map((sample) => sample.rock)) > 0.45,
      `${name} wall needs exposed rock faces before the massif`);
    assert.ok(Math.max(...samples.map((sample) => sample.treeline)) > 0.45,
      `${name} wall needs retained conifer toes`);
    assert.ok(Math.max(...samples.map((sample) => sample.bench)) > 0.04,
      `${name} wall needs a distinct glacial bench plane`);
    assert.ok(Math.max(...samples.map((sample) => sample.outcrop)) > 0.06,
      `${name} wall needs a distinct broken outcrop plane`);
    assert.ok(samples.every((sample) => Number.isFinite(sample.wash)),
      `${name} wall wash field must remain deterministic and finite`);
  }
});

test('alpine address wall keeps oblique shoulders, bench, and drainage planes distinct', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.match(source, /const hierarchyShoulderA = Math\.exp/);
  assert.match(source, /const hierarchyShoulderB = Math\.exp/);
  assert.match(source, /const hierarchyDrain = Math\.exp/);
  assert.match(source, /const hierarchyRelief = hierarchyRib \* 28 \+ hierarchyBenchPlane \* 20 - hierarchyDrainage \* 24/);
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const bearings = [composition.dominantAzimuth, composition.secondaryAzimuth, composition.openingAzimuth];
  const samples = bearings.flatMap((azimuth) => [640, 880, 1120].map((radius) => sampleAlpineWorld({
    terrain, bounds, seed, composition,
    x: Math.sin(azimuth) * radius,
    z: -155 - Math.cos(azimuth) * radius,
  })));
  assert.ok(Math.max(...samples.map((sample) => sample.hierarchyRib)) > 0.08,
    'address wall needs raised resistant shoulder ribs');
  assert.ok(Math.max(...samples.map((sample) => sample.hierarchyBenchPlane)) > 0.025,
    'address wall needs a distinct meadow bench plane');
  assert.ok(Math.max(...samples.map((sample) => sample.hierarchyDrainage)) > 0.015,
    'address wall needs a coupled drainage incision');
  assert.ok(Math.max(...samples.map((sample) => sample.hierarchyRib))
    - Math.min(...samples.map((sample) => sample.hierarchyRib)) > 0.05,
  'oblique shoulder field must remain asymmetric across exact wall bearings');
});

test('alpine address opening keeps separated foothills before the far massif', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const bearing = composition.openingAzimuth;
  const sampleAt = (radius, cross = 0) => {
    const alongX = Math.sin(bearing);
    const alongZ = -Math.cos(bearing);
    const crossX = alongZ;
    const crossZ = -alongX;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: alongX * radius + crossX * cross,
      z: -155 + alongZ * radius + crossZ * cross,
    });
  };
  const center = sampleAt(820, 0);
  const left = sampleAt(820, -260);
  const right = sampleAt(820, 260);
  const far = sampleAt(2400, 0);
  assert.ok(left.height > center.height + 18 && right.height > center.height + 18,
    'foothill shoulders must flank a lower central address opening');
  assert.ok(far.height > center.height + 70,
    'the delayed massif must rise behind the opening as a depth-separated tier');
  assert.ok(center.height < 150, 'central opening must remain materially lower than the walls');
});

test('alpine first wall carries structural spur and drainage cuts, not one smooth ramp', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const radii = [420, 540, 660, 780, 900, 1020, 1140, 1260, 1380];
  let maxDrainageCut = 0;
  for (const [name, azimuth] of [
    ['dominant', composition.dominantAzimuth],
    ['secondary', composition.secondaryAzimuth],
    ['opening', composition.openingAzimuth],
  ]) {
    const samples = radii.map((radius) => sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    }));
    const structural = samples.map((sample) => sample.structuralSpur);
    const cuts = samples.map((sample) => sample.drainageCut);
    maxDrainageCut = Math.max(maxDrainageCut, ...cuts);
    assert.ok(Math.max(...structural) - Math.min(...structural) > 18,
      `${name} wall needs depth-separated structural spurs`);
    assert.ok(samples.some((sample, index) => index > 0
      && sample.height < samples[index - 1].height - 8),
    `${name} wall needs a visible glacial saddle, not a monotone ramp`);
  }
  assert.ok(maxDrainageCut > 0.05,
    'the authored wall bearings need at least one incised drainage cut');
});

test('alpine first wall carries bounded meso ribs, incisions, and talus at exact wall radii', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const radii = [360, 440, 560, 680, 820, 980, 1140, 1280];
  for (const [name, azimuth] of [
    ['dominant', composition.dominantAzimuth],
    ['secondary', composition.secondaryAzimuth],
    ['opening', composition.openingAzimuth],
  ]) {
    const samples = radii.map((radius) => sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    }));
    const mesoValues = samples.flatMap((sample) => [sample.mesoRib, sample.mesoIncision, sample.mesoTalus]);
    assert.ok(Math.max(...mesoValues) > 0.12, `${name} wall needs visible meso geology fields`);
    assert.ok(Math.max(...samples.map((sample) => sample.mesoRib)) > 0.05,
      `${name} wall needs resistant meso ribs`);
    assert.ok(Math.max(...samples.map((sample) => sample.mesoIncision)) > 0.05,
      `${name} wall needs meso drainage incisions`);
    assert.ok(Math.max(...samples.map((sample) => sample.mesoTalus)) > 0.04,
      `${name} wall needs meso talus pockets`);
    assert.ok(Math.max(...samples.map((sample) => sample.height))
      - Math.min(...samples.map((sample) => sample.height)) > 55,
    `${name} wall meso field must remain subordinate to broad landform relief`);
  }
});

test('alpine first wall keeps valley shoulders mineral and drainage-aware without filling the opening', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const sampleAt = (azimuth, radius) => sampleAlpineWorld({
    terrain, bounds, seed, composition,
    x: Math.sin(azimuth) * radius,
    z: -155 - Math.cos(azimuth) * radius,
  });
  const opening = sampleAt(composition.openingAzimuth, 760);
  const shoulder = sampleAt(composition.openingAzimuth + 0.48, 760);
  assert.ok(shoulder.shoulderPlane > 0.08,
    'opening shoulders need a resistant glacial plane');
  assert.ok(shoulder.shoulderDrain > 0.04,
    'opening shoulders need a lower drainage pocket');
  assert.ok(opening.height < shoulder.height,
    'the authored downrange opening must remain lower than its shoulders');
  assert.ok(opening.shoulderPlane < shoulder.shoulderPlane,
    'the valley centre must not be filled by the shoulder plane');
});

test('alpine U-saddle lowers the center while retaining asymmetric toe mouths', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const sampleAt = (azimuth, radius) => sampleAlpineWorld({
    terrain, bounds, seed, composition,
    x: Math.sin(azimuth) * radius,
    z: -155 - Math.cos(azimuth) * radius,
  });
  const center = sampleAt(composition.openingAzimuth, 900);
  const left = sampleAt(composition.openingAzimuth - 0.48, 760);
  const right = sampleAt(composition.openingAzimuth + 0.48, 760);
  assert.ok(center.height < Math.min(left.height, right.height) - 24,
    'the widened saddle center must sit materially below both shoulders');
  assert.ok(Math.abs(left.height - right.height) > 8,
    'the two near-toe shoulders must remain asymmetric');
  assert.ok(left.nearSpurA + left.nearSpurB > 0.005 && right.nearSpurA + right.nearSpurB > 0.005,
    'both toe mouths need existing glacial spur support');
  assert.ok(center.height > -120,
    'the lowered saddle must retain a bounded foreground horizon, not expose a void');
});

test('alpine central floor separates the two first-wall shoulders without a void', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const sampleAt = (offset, radius = 900) => {
    const azimuth = composition.openingAzimuth + offset;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    });
  };
  const center = sampleAt(0);
  const left = sampleAt(-0.48);
  const right = sampleAt(0.48);
  assert.ok(center.height >= 0 && center.height <= 30,
    `central floor should sit low but grounded; got ${center.height}`);
  assert.ok(center.openingFloorWindow > 0.90,
    'central floor must be driven by the authored opening lobe');
  assert.ok(left.height > 100 && right.height > 100,
    'both offset shoulders must remain above the low central floor');
  assert.ok(Math.abs(left.height - right.height) > 12,
    'offset shoulders must remain materially asymmetric');
  assert.ok(left.openingFloorWindow < 0.20 && right.openingFloorWindow < 0.20,
    'the floor cut must not connect across the two shoulder mouths');
});

test('alpine low floor and its mineral shoulder stay classified apart', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const sampleAt = (offset) => {
    const azimuth = composition.openingAzimuth + offset;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * 900,
      z: -155 - Math.cos(azimuth) * 900,
    });
  };
  const center = sampleAt(0);
  const shoulder = sampleAt(0.48);
  // This used to compare baked vertex colours. Nothing draws those any more, so
  // it now pins the classification the shader reads: the valley floor must stay
  // vegetated ground while its shoulder carries exposed mineral, which is what
  // makes the two render as different surfaces.
  assert.ok(center.treeline > shoulder.treeline,
    'the low saddle must retain more vegetated cover than its mineral shoulder');
  assert.ok(shoulder.rock > center.rock + 0.08,
    'the shoulder must carry materially more exposed rock than the floor');
  assert.ok(shoulder.height > center.height + 24,
    'the shoulder must stand above the floor for the two to read as distinct planes');
  assert.ok(Number.isFinite(center.scree) && Number.isFinite(shoulder.scree),
    'the talus channel must remain deterministic and finite across the opening');
});

test('alpine toe geometry uses overlapping oblique glacial planes', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.match(source, /const nearSpurA = Math\.exp/);
  assert.match(source, /const nearSpurB = Math\.exp/);
  assert.match(source, /const glacialChute = Math\.exp/);
  assert.match(source, /const glacialPlaneRelief = \(landformRib \* 46 - landformDrain \* 29\) \* openingLandformFade/);
  assert.match(source, /rock: clamp\(rockExposure \+ \(landformRib/);
  assert.match(source, /scree: scree \+ gullyMask/);
});

test('alpine surface response is classified per pixel, not baked per vertex', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  // Three scales of world-anchored relief, each sampled with its own gradient so
  // the normal perturbation is a property of the terrain rather than of the
  // projection. The previous version derived every bump from dFdx/dFdy.
  assert.match(source, /const broadGradientsVarying = varying\(/);
  assert.doesNotMatch(source, /const macro = worldField\(|const meso = worldField\(|const strataWarp = mx_noise_float/,
    'broad macro/meso/bedding fields must not be reconstructed per fragment');
  assert.doesNotMatch(source, /dFdx\(|dFdy\(/,
    'screen-space derivatives scale with pixel footprint, not with the ground');
  assert.match(source, /const directMineral = directRock\.mul\(float\(1\.0\)\.sub\(directScree\)\)/,
    'rock and deposited talus must be an explicit substrate partition');
  // Snow is deposited after every base substrate and remains world-jittered.
  assert.match(source, /const directSnow = smoothstep\(0\.54, 0\.76, directSnowAccumulation\)/);
  assert.match(source, /const directBandJitter = macroValue\.sub\(0\.5\)\.mul\(150\.0\)/,
    'altitude bands must wander in world space or they read as contour stripes');
  assert.match(source, /material\.roughnessNode = mix\(mineralRough, float\(0\.88\), directSnow\)/);
});

test('alpine first wall uses depth-separated signed-distance buttresses', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.match(source, /const buttressCross = spurFrame - foothillTrack \* 0\.35/);
  assert.match(source, /const toeButtress = \(1 - smootherstep\(0, 300/);
  assert.match(source, /const benchButtress = \(1 - smootherstep\(0, 280/);
  assert.match(source, /const outcropButtress = \(1 - smootherstep\(0, 250/);
  assert.match(source, /const toeSaddle = \(1 - smootherstep\(0, 92/);
  assert.match(source, /const buttressRelief = \(toeButtress \* 25 \+ benchButtress \* 25/);
  assert.match(source, /buttressDrain \* 0\.22/);
});

test('alpine opening reveals a smooth near-wall U-shaped saddle', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  // Coefficients retuned with the landform model. The window is narrower so the
  // shoulders that frame the U survive it, and the cut is shallower because the
  // surrounding wall is no longer 880 m of radial ramp it had to fight.
  assert.match(source, /const openingWindow = angularLobe\(azimuth, composition\.openingAzimuth, 0\.60\)/);
  assert.match(source, /const openingSaddle = openingWindow \* \(68 \+ smootherstep\(500, 1220, radial\) \* 14\)/);
  assert.match(source, /const openingShoulderFade = 1 - openingWindow \* 0\.50/);
  assert.match(source, /const openingLandformFade = 1 - openingWindow \* 0\.40/);
  assert.match(source, /- openingSaddle/);
  assert.match(source, /\) \* openingShoulderFade;/);
});

test('alpine ridge hierarchy carries chutes, bedding, and talus into the far massif', () => {
  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const radius = 1750;
  const samples = Array.from({ length: 48 }, (_, i) => {
    const azimuth = -Math.PI + (Math.PI * 2 * i) / 48;
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: Math.sin(azimuth) * radius,
      z: -155 - Math.cos(azimuth) * radius,
    });
  });
  assert.ok(samples.every((sample) => Number.isFinite(sample.bedding)), 'bedding signal must stay deterministic and finite');
  assert.ok(Math.max(...samples.map((sample) => sample.chute)) > 0.1, 'far faces need elongated erosion chutes');
  assert.ok(Math.max(...samples.map((sample) => sample.talus)) > 0.1, 'far faces need a distinct talus toe');
  assert.ok(Math.max(...samples.map((sample) => sample.rock)) > 0.25, 'far ridge hierarchy needs exposed mineral faces');
});

test('alpine high faces carry oriented fault blocks, chutes, and coupled PBR structure', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.match(source, /const massifStructureBand = smootherstep\(1080, 1380/);
  assert.match(source, /const structuralBlocks = clamp\(\(dominantBlocks \+ flankBlocks\) \* 1\.42/);
  assert.match(source, /const structuralChutes = clamp\(\(dominantChutes \+ flankChutes\) \* 1\.26/);
  assert.match(source, /const structuralRelief = structuralBlocks \* 118 - structuralChutes \* 74/);
  assert.match(source, /const vertexStructuralFace = strikeRelief\.max\(0\.0\)\.mul\(0\.64\)/);
  assert.match(source, /const vertexStructuralCavity = float\(0\.0\)\.sub\(strikeRelief\)/);
  assert.match(source, /const structuralFaceVarying = varying\(vertexStructuralFace, 'vAlpineStructuralFace'\)/);
  assert.match(source, /const structuralCavityVarying = varying\(vertexStructuralCavity, 'vAlpineStructuralCavity'\)/);
  assert.match(source, /const vertexStructuralRelief = vertexStructuralFace\.mul\(36\.0\)/);
  assert.match(source, /return face\.mul\(36\.0\)\.sub\(cavity\.mul\(24\.0\)\)/,
    'vertex displacement and finite-difference structural gradient must share amplitudes');
  assert.match(source, /geometry\.boundingSphere\.radius \+= 72/,
    'frustum bounds must include the maximum shader-only structural displacement');
  assert.match(source, /smoothstep\(72\.0, 162\.0, shellEdgeDistance\.sub\(ALPINE_BAND_A_OUTER\)\.abs\(\)\)/,
    'structural displacement must be zero throughout the 72 m overlap belt');
  assert.match(source, /smoothstep\(72\.0, 162\.0, worldEdgeDistance\.sub\(ALPINE_BAND_A_OUTER\)\.abs\(\)\)/,
    'structural gradient lighting must share the same dead belt');
  assert.equal((source.match(/geometry\.boundingSphere\.radius \+= 72/g) || []).length, 2,
    'both Band A and Band B bounds must include shader displacement');
  assert.match(source, /const vertexDisplacement[\s\S]*vertexStructuralRelief/);
  assert.match(source, /const structuralFace = structuralFaceVarying/);
  assert.match(source, /const structuralCavity = structuralCavityVarying/);
  assert.match(source, /const directSlab = structuralFace\.mul\(0\.62\)/);
  assert.match(source, /const directCavity = structuralCavity\.mul\(0\.72\)/);
  assert.match(source, /mix\(directGraniteBase, directGraniteFresh/);
  assert.match(source, /mix\(directRockColor, directGraniteCavity, directCavity/);
  assert.match(source, /const structuralAt = \(x, z\) =>/);
  assert.doesNotMatch(source, /const blockField|const fractureField|const structuralWarp|const secondaryStrikeField|const strikeAt =|const secondaryAt =/,
    'broad structural fields must be owned by the vertex graph');
  assert.match(source, /const strikeRelief = smoothstep\(0\.56, 0\.82, strikeSignal\)\s*\.sub\(float\(1\.0\)\.sub\(smoothstep\(0\.18, 0\.42, strikeSignal\)\)\)/,
    'the primary structural field must contain both positive and negative lobes');
  const bipolar = (signal) => {
    const ramp = (value, lo, hi) => Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    return ramp(signal, 0.56, 0.82) - (1 - ramp(signal, 0.18, 0.42));
  };
  assert.ok(bipolar(0.05) < 0 && bipolar(0.95) > 0,
    'the structural strike remap must span chute-negative to buttress-positive');
  assert.doesNotMatch(source, /const structuralNormal = vec3\(/,
    'normal relief must use spatial gradients rather than mask values');

  const seed = 1128746828;
  const composition = alpineComposition(seed);
  const sampleAt = (radius, cross) => {
    const azimuth = composition.dominantAzimuth;
    const alongX = Math.sin(azimuth);
    const alongZ = -Math.cos(azimuth);
    return sampleAlpineWorld({
      terrain, bounds, seed, composition,
      x: alongX * radius + alongZ * cross,
      z: -155 + alongZ * radius - alongX * cross,
    });
  };
  const samples = [
    sampleAt(1500, 20), sampleAt(1500, 240), sampleAt(1480, -260),
    sampleAt(1800, 160), sampleAt(2100, -220), sampleAt(2500, 360),
  ];
  assert.ok(Math.max(...samples.map((sample) => sample.structuralBlocks)) > 0.20,
    'high massif needs resistant fault blocks at 50–300 m scale');
  assert.ok(Math.max(...samples.map((sample) => sample.structuralChutes)) > 0.08,
    'high massif needs incised drainage chutes between blocks');
  assert.ok(Math.max(...samples.map((sample) => sample.structuralRelief))
    - Math.min(...samples.map((sample) => sample.structuralRelief)) > 16,
    'fault blocks and chutes must carry signed landform contrast');
});

test('alpine structural material couples snow scour, hollow loading, and bounded toe exposure', async () => {
  const source = await readFile(new URL('../src/scene/BackdropTerrain.js', import.meta.url), 'utf8');
  assert.match(source, /const directSnowAccumulation[\s\S]*sub\(structuralFace\.mul\(0\.20\)\)/,
    'proud faces must scour snow while cavities load it');
  assert.match(source, /directScreeSource = screeGate\.mul\(0\.62\).*structuralCavity\.mul\(0\.16\)/s,
    'structural cavities must route into the deposited talus source');
  assert.match(source, /directScree.*float\(1\.0\)\.sub\(directRock\.mul\(0\.72\)\)/s,
    'talus must remain subordinate to intact rock ownership');
  const snowResponse = (base, face, cavity) => Math.max(0, Math.min(1, base - face * 0.20 + cavity * 0.38));
  assert.ok(snowResponse(0.7, 1, 0) < snowResponse(0.7, 0, 1),
    'the same base accumulation must favor cavities over proud faces');
});
