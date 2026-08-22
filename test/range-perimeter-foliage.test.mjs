import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRangePerimeterFoliage, RANGE_PERIMETER_FOLIAGE_COUNT } from '../src/foliage/RangePerimeterFoliage.js';

const bounds = { minX: -110, maxX: 110, minZ: -340, maxZ: 30 };

test('generated range foliage forms deterministic irregular perimeter groves', () => {
  const first = buildRangePerimeterFoliage({ bounds, seed: 1128746828 });
  const second = buildRangePerimeterFoliage({ bounds, seed: 1128746828 });
  assert.deepEqual(first, second);
  assert.equal(first.length, RANGE_PERIMETER_FOLIAGE_COUNT);
  assert.equal(RANGE_PERIMETER_FOLIAGE_COUNT, 136, 'range sides should carry 100 more trees than the reviewed 36-tree draft');
  assert.ok(first.every(({ x }) => Math.abs(x) > 68), 'central hitting corridor remains open');
  assert.ok(first.some(({ z }) => z > -55) && first.some(({ z }) => z < -285), 'perimeter spans tee through back range');
  assert.ok(new Set(first.map(({ scale }) => scale < 0.68 ? 'young' : scale > 0.95 ? 'mature' : 'middle')).size === 3);
  assert.deepEqual(Object.fromEntries([...new Set(first.map(({ foliageAlias }) => foliageAlias))]
    .map((alias) => [alias, first.filter((placement) => placement.foliageAlias === alias).length])), {
    'builtin.douglas-fir.pnw.v1': 44,
    'builtin.italian-cypress.mediterranean.v1': 47,
    'builtin.monterey-cypress.coastal.v1': 45,
  });
  assert.ok(first.every(({ targetHeight, canopyRadius }) => targetHeight > 8 && canopyRadius > 0.8));
  for (let index = 0; index < first.length; index++) for (let prior = 0; prior < index; prior++) {
    assert.ok(Math.hypot(first[index].x - first[prior].x, first[index].z - first[prior].z) >= 5.8 - 1e-9);
  }
});

test('every generated range species uses multiple structural identities', async () => {
  const rangeSource = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');
  assert.match(rangeSource, /identityCount:\s*5/);
  assert.doesNotMatch(rangeSource, /identityCount:\s*alias\s*===/,
    'cypress species must not collapse back to one cloned skeleton');
  assert.match(rangeSource, /local:\s*this\.localFoliagePackRegistry/,
    'course local.* aliases must reach the explicit runtime registry');
});

test('broadleaf identities vary architecture rather than only yaw and scale', async () => {
  const source = await readFile(new URL('../src/scene/GeneratedFoliageTree.js', import.meta.url), 'utf8');
  assert.match(source, /const spreadScale = oak \? 0\.82 \+ random\(\) \* 0\.38/);
  assert.match(source, /const trunkLeanScaleX = 0\.72 \+ random\(\) \* 0\.62/);
  assert.match(source, /const scaffoldCount = oak \? 13 \+ Math\.floor\(random\(\) \* 7\)/);
  assert.match(source, /const shoots = oak \? 7 \+ Math\.floor\(random\(\) \* 4\)/);
  assert.match(source, /foliageGapPhase/,
    'seeded identities need different negative-space gaps as well as different branch endpoints');
});

test('generated tree beauty uses only the shared environment lighting authority', async () => {
  const source = await readFile(new URL('../src/scene/GeneratedFoliageTree.js', import.meta.url), 'utf8');
  assert.match(source, /this\.treeEnvironment\.aerialPerspective\(/,
    'generated bark and foliage must share the environment aerial integration');
  assert.match(source, /setupEnvironment\(builder\)[\s\S]*?new EnvironmentNode\(builder\.environmentNode\)/,
    'generated tree materials must consume the scene PMREM');
  assert.match(source, /mesh\.receiveShadow = command !== 3/,
    'all generated beauty geometry must receive the real directional shadow');
  assert.doesNotMatch(source, /material\.colorNode = neutralized\.mul\(roughnessResponse\)\.mul/,
    'foliage albedo must not carry a pre-lit sun or transmission multiplier');
  assert.match(source, /roughness: 0\.94, metalness: 0/,
    'generated bark must remain uniformly rough and non-metallic under shared light');
  assert.match(source, /const structureNormalWorld = rotateYaw\(normalLocal\)\.normalize\(\)/,
    'instanced trunk normals must rotate in the same placement frame as geometry');
  assert.doesNotMatch(source, /normalMap: bark\.normal/,
    'a tangent-space bark normal may not ship until its TBN follows instanced yaw');
  assert.match(source, /barkAlbedo\.mul\(vec3\(4\.40, 4\.10, 3\.80\)\)/,
    'the darker Monterey scan needs measured source normalization');
  assert.match(source, /barkAlbedo\.mul\(vec3\(1\.55, 1\.50, 1\.45\)\)/,
    'deciduous bark must use the same bounded reflectance target');
  assert.match(source, /function appendTaperedTrunk\(/);
  assert.match(source, /appendTaperedTrunk\(builder, trunkPoints, trunkRadii, 9\)/,
    'main trunks must use one continuous smooth mesh rather than overlapping lit cylinders');
});

test('authored foliage alias lists drive every perimeter slot without silent substitution', () => {
  const single = buildRangePerimeterFoliage({
    bounds, seed: 1128746828, foliageAliases: ['local.coastal-pine.private.v1'],
  });
  assert.deepEqual([...new Set(single.map(({ foliageAlias }) => foliageAlias))], [
    'local.coastal-pine.private.v1',
  ]);

  const mixedAliases = ['local.coastal-pine.private.v1', 'local.monterey.private.v1'];
  const mixed = buildRangePerimeterFoliage({ bounds, seed: 1128746828, foliageAliases: mixedAliases });
  assert.deepEqual([...new Set(mixed.map(({ foliageAlias }) => foliageAlias))].sort(), [...mixedAliases].sort());
  assert.ok(mixed.every(({ foliageAlias }) => mixedAliases.includes(foliageAlias)));
  assert.throws(() => buildRangePerimeterFoliage({ bounds, seed: 1, foliageAliases: [] }), /one to three unique aliases/);
  assert.throws(() => buildRangePerimeterFoliage({
    bounds, seed: 1, foliageAliases: ['local.a.v1', 'local.b.v1', 'local.c.v1', 'local.d.v1'],
  }), /one to three unique aliases/);
});

test('production generated-foliage evaluation uses the reviewed oak, maple, and Monterey replacements', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const candidateBlock = source.match(/foliageCandidateAlias:[\s\S]*?\] : null,/u)?.[0] ?? '';
  assert.match(candidateBlock, /builtin\.valley-oak\.california\.v1/);
  assert.match(candidateBlock, /builtin\.sugar-maple\.northeastern\.v1/);
  assert.match(candidateBlock, /builtin\.monterey-cypress\.coastal\.v1/);
  assert.doesNotMatch(candidateBlock, /builtin\.douglas-fir|builtin\.italian-cypress/,
    'replacement-tree acceptance must not silently time the earlier conifer fixture');
});
