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
    const blend = geometry.branches.attributes.rootBlend.array;
    // The attribute must exist on every tier: one compiled material serves them all.
    assert.equal(blend.length, geometry.branches.attributes.position.count);
    return blend.reduce((n, value) => n + (value > 0 ? 1 : 0), 0);
  });
  assert.ok(blendCounts[0] > 0, 'the near tier carries seatable root vertices');
  assert.deepEqual(blendCounts.slice(1), [0, 0], 'reduced tiers, and so the shadow pass, carry none');
});

// Measured on one isolated root: across a whole flare the vertex bounds are set by
// where the roots are, not by the shape of their sections, which hides the effect.
test('the root section is a flanged hump rather than a symmetric knife', () => {
  const RADIAL = 12;
  const skeleton = {
    segments: [{
      start: [0, 0.3, 0], end: [1.2, 0, 0], radius0: 0.2, radius1: 0.1,
      level: 0, stem: -1, id: 'root-0-0', parent: null, role: 'root',
      rootBlend0: 0, rootBlend1: 1,
    }],
    leaves: [], blossoms: [],
  };
  const sectionFor = (blade) => {
    const plant = structuredClone(createTreePreset('tall-pine', 6).plant);
    plant.structure.rootBlade = blade;
    const geometry = compileTreeGeometry(skeleton, { radialSegments: RADIAL, plant, includeRoots: true });
    const position = geometry.branches.attributes.position.array;
    // The first ring is the stump end, where the thickening is strongest.
    let above = 0, below = 0, across = 0;
    for (let i = 0; i <= RADIAL; i++) {
      above = Math.max(above, position[i * 3 + 1] - 0.3);
      below = Math.max(below, 0.3 - position[i * 3 + 1]);
      across = Math.max(across, Math.abs(position[i * 3 + 2]));
    }
    return { above, below, across };
  };
  const round = sectionFor(1);
  assert.ok(Math.abs(round.above - round.below) < 1e-6, 'ratio 1 must be a round runner');
  assert.equal(PLANT_CONTROLS.structure.rootBlade[1], 1, 'the round runner is the floor');

  const humped = sectionFor(2.5);
  assert.ok(humped.above > round.above, 'a higher ratio must raise the crown');
  assert.ok(humped.below < round.below, 'and tuck the buried underside');
  // The flange does widen the silhouette a little - that is what a flange is - but
  // the section must gain height far faster than width, or it is just a bigger tube.
  assert.ok(humped.across / round.across < (humped.above / round.above) * 0.6,
    `height must outgrow width, got ${(humped.across / round.across).toFixed(2)}x across `
    + `vs ${(humped.above / round.above).toFixed(2)}x up`);
  assert.ok(humped.above > humped.below * 2,
    `the section must be asymmetric, got ${humped.above.toFixed(3)} over ${humped.below.toFixed(3)}`);
});
