import test from 'node:test';
import assert from 'node:assert/strict';
import { TREE_PRESETS, createTreePreset } from '../src/trees/TreePresets.js';
import { generateTreeSkeleton } from '../src/trees/TreeGenerator.js';
import { compileTreeGeometry } from '../src/trees/TreeGeometry.js';
import { TREE_LIMITS } from '../src/trees/TreeDefinition.js';
import { PLANT_CONTROLS } from '../src/trees/PlantControls.js';

const skeletonFor = (name, seed = 5) => generateTreeSkeleton(createTreePreset(name, seed), { seed });
const rootsOf = (skeleton) => skeleton.segments.filter((segment) => segment.role === 'root');

test('every preset produces roots proportioned to its own trunk, and none where wood cannot flare', () => {
  for (const name of TREE_PRESETS) {
    const definition = createTreePreset(name, 11);
    const skeleton = skeletonFor(name, 11);
    const roots = rootsOf(skeleton);
    const expected = Math.round(definition.plant.structure.rootCount)
      * definition.parameters.multipleTrunks.count;

    if (expected === 0) {
      // A palm is a monocot with no secondary thickening, and a clipped hedge hides
      // its own base: both would be inventing wood that the plant cannot grow.
      assert.equal(roots.length, 0, `${name} must not grow woody buttresses`);
      continue;
    }
    assert.ok(roots.length > 0, `${name} should carry surface roots`);

    // Roots belong to the flare, so they must leave the trunk thick and shed it.
    const first = roots[0], last = roots.at(-1);
    assert.ok(first.radius0 > last.radius1 * 2,
      `${name} roots must taper rapidly, got ${first.radius0} to ${last.radius1}`);

    // Every root has to finish below grade or it terminates in mid air.
    const trunkStems = new Set(roots.map((segment) => segment.stem));
    for (const stem of trunkStems) {
      const run = roots.filter((segment) => segment.stem === stem);
      assert.ok(run.at(-1).end[1] < 0, `${name} root ${stem} must end below grade`);
      assert.ok(run[0].start[1] > 0, `${name} root ${stem} must leave the trunk above grade`);
    }
  }
});

test('root reach scales with the trunk rather than with world units', () => {
  // Same species, very different sizes: the flare has to stay in proportion.
  const small = createTreePreset('tall-pine', 3);
  const large = structuredClone(small);
  large.parameters.gScale = small.parameters.gScale * 3;
  const spread = (definition) => {
    const roots = rootsOf(generateTreeSkeleton(definition, { seed: 3 }));
    return Math.max(...roots.map((segment) => Math.hypot(segment.end[0], segment.end[2])));
  };
  const ratio = spread(large) / spread(small);
  assert.ok(ratio > 2.4 && ratio < 3.6, `reach should track trunk size, got ${ratio.toFixed(2)}x`);
});

test('a multi-stem clump keeps its roots in open ground and inside the segment budget', () => {
  const skeleton = skeletonFor('multi-stem-shrub', 9);
  const roots = rootsOf(skeleton);
  assert.ok(skeleton.segments.length <= TREE_LIMITS.maxSegments);

  // Each stem sits off-centre; its roots should reach further outward than inward.
  const byStem = new Map();
  for (const segment of roots) {
    if (!byStem.has(segment.stem)) byStem.set(segment.stem, []);
    byStem.get(segment.stem).push(segment);
  }
  let outwardWins = 0, compared = 0;
  for (const run of byStem.values()) {
    const origin = run[0].start;
    const clump = Math.hypot(origin[0], origin[2]);
    if (clump < 1e-3) continue;
    const tip = run.at(-1).end;
    const reach = Math.hypot(tip[0] - origin[0], tip[2] - origin[2]);
    const outward = ((tip[0] - origin[0]) * origin[0] + (tip[2] - origin[2]) * origin[2]) / (clump * reach);
    compared++;
    if (outward > 0) outwardWins += reach;
    else outwardWins -= reach;
  }
  assert.ok(compared > 0, 'the shrub should have off-centre stems to test');
  assert.ok(outwardWins > 0, 'clump roots must favour open ground over their neighbours');
});

test('roots are compiled into the near tier only, and never reach the shadow tier', () => {
  const definition = createTreePreset('spreading-oak', 4);
  const skeleton = generateTreeSkeleton(definition, { seed: 4 });
  const blendCounts = [0, 1, 2].map((tier) => {
    const geometry = compileTreeGeometry(skeleton, {
      radialSegments: Math.max(3, 9 - tier * 3), leafStride: [1, 2, 4][tier],
      plant: definition.plant, includeRoots: tier === 0,
    });
    const attribute = geometry.branches.attributes.rootBlend;
    // The attribute must exist on every tier: one compiled material serves them all.
    // It carries (seat weight, emergence offset) per vertex.
    assert.equal(attribute.itemSize, 2);
    assert.equal(attribute.count, geometry.branches.attributes.position.count);
    let seatable = 0;
    for (let i = 0; i < attribute.count; i++) if (attribute.getX(i) > 0) seatable++;
    return seatable;
  });
  assert.ok(blendCounts[0] > 0, 'the near tier carries seatable root vertices');
  assert.deepEqual(blendCounts.slice(1), [0, 0], 'reduced tiers, and so the shadow pass, carry none');
});

// Measured on one isolated root: across a whole flare the vertex bounds are set by
// where the roots are, not by the shape of their sections, which hides the effect.
test('the root section spreads flat against the soil rather than standing on edge', () => {
  const RADIAL = 12;
  // Roots ring denser than the wood they grow from, so the first ring is wider.
  const ROOT_RING = RADIAL + 6;
  const skeleton = {
    segments: [{
      start: [0, 0.3, 0], end: [1.2, 0, 0], radius0: 0.2, radius1: 0.1,
      level: 0, stem: -1, id: 'root-0-0', parent: null, role: 'root',
      rootBlend0: 0, rootBlend1: 1,
    }],
    leaves: [], blossoms: [],
  };
  const sectionFor = (flatten) => {
    const plant = structuredClone(createTreePreset('tall-pine', 6).plant);
    plant.structure.rootFlatten = flatten;
    const geometry = compileTreeGeometry(skeleton, { radialSegments: RADIAL, plant, includeRoots: true });
    const position = geometry.branches.attributes.position.array;
    // The first ring is the stump end, where the thickening is strongest.
    let above = 0, below = 0, across = 0;
    for (let i = 0; i <= ROOT_RING; i++) {
      above = Math.max(above, position[i * 3 + 1] - 0.3);
      below = Math.max(below, 0.3 - position[i * 3 + 1]);
      across = Math.max(across, Math.abs(position[i * 3 + 2]));
    }
    return { above, below, across };
  };
  const round = sectionFor(1);
  assert.ok(Math.abs(round.above - round.below) < 1e-6, 'ratio 1 must be a round runner');
  assert.equal(PLANT_CONTROLS.structure.rootFlatten[1], 1, 'the round runner is the floor');

  // Photographed oak flares are broad masses lying in the soil: wide across, low
  // over the top, flat beneath. A section that grows upward is the knife-on-edge
  // failure this replaced.
  const spread = sectionFor(2.5);
  assert.ok(spread.across > round.across * 1.5, 'a higher ratio must spread it wider');
  assert.ok(spread.above < round.above, 'and dome it lower, not raise it');
  assert.ok(spread.below < round.below, 'with the buried underside flattened');
  assert.ok(spread.across > spread.above * 2,
    `the section must lie flat, got ${spread.across.toFixed(3)} across `
    + `by ${spread.above.toFixed(3)} up`);
});

// Grass has no knowledge of a trunk, so without an explicit footprint it sprouts
// straight through the flare and its roots.
test('the trunk footprint clears grass exactly where the flare stands', async () => {
  const { clearTrunkFootprints, GRASS_GROWABLE_BIT } = await import('../src/terrain/CanopyField.js');
  const nx = 41, nz = 41, spacing = 0.5, grid = { minX: -10, minZ: -10, spacing };
  const data = new Uint8Array(nx * nz).fill(GRASS_GROWABLE_BIT);
  clearTrunkFootprints(data, nx, nz, grid, [{ x: 0, z: 0, flareRadius: 1.5 }]);

  const growable = (x, z) => {
    const i = Math.round((x - grid.minX) / spacing), j = Math.round((z - grid.minZ) / spacing);
    return (data[j * nx + i] & GRASS_GROWABLE_BIT) !== 0;
  };
  assert.equal(growable(0, 0), false, 'no grass at the trunk itself');
  assert.equal(growable(1.0, 0), false, 'nor inside the flare');
  assert.equal(growable(0, -1.0), false, 'in every direction');
  assert.equal(growable(3, 0), true, 'but turf resumes outside the footprint');
  assert.equal(growable(-6, 4), true, 'and is untouched far away');

  // A placement without a flare radius (a catalog GLB, which bakes its own base)
  // must not silently clear ground.
  const untouched = new Uint8Array(nx * nz).fill(GRASS_GROWABLE_BIT);
  clearTrunkFootprints(untouched, nx, nz, grid, [{ x: 0, z: 0 }, { x: 1, z: 1, flareRadius: 0 }]);
  assert.ok(untouched.every((value) => value === GRASS_GROWABLE_BIT));
  assert.throws(() => clearTrunkFootprints(new Uint8Array(4), nx, nz, grid, []), /one byte per/);
});

test('the cleared footprint is derived from the same numbers that build the flare', async () => {
  const { proceduralTreeFlareRadius } = await import('../src/scene/ProceduralTrees.js');
  const definition = createTreePreset('tall-pine', 2);
  const trunkRadius = definition.parameters.gScale * definition.parameters.ratio;
  const record = { definitionId: definition.id, scale: 1 };
  const radius = proceduralTreeFlareRadius(record, [definition]);

  // It has to cover whichever reaches further: the flared trunk or its roots.
  const roots = trunkRadius * definition.plant.structure.rootSpread;
  const flare = trunkRadius * (1 + definition.parameters.flare);
  assert.ok(Math.abs(radius - Math.max(roots, flare)) < 1e-9,
    `footprint must cover the wider of flare and roots, got ${radius}`);
  assert.ok(radius > trunkRadius, 'and always exceed the bare trunk');

  // Scale is a placement property, so the footprint has to follow it.
  const doubled = proceduralTreeFlareRadius({ ...record, scale: 2 }, [definition]);
  assert.ok(Math.abs(doubled - radius * 2) < 1e-9, 'footprint must scale with the placement');
  assert.throws(() => proceduralTreeFlareRadius({ definitionId: 'nope' }, [definition]), /Missing/);
});
