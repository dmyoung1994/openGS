import { legacyTreeDefinition, normalizeTreeDefinition } from './TreeDefinition.js';
import { normalizePlantControls } from './PlantControls.js';
export const TREE_PRESETS = Object.freeze(['spreading-oak', 'whorled-fir', 'tall-pine', 'palm', 'weeping-willow', 'multi-stem-shrub', 'flowering-shrub', 'clipped-hedge']);
export function createTreePreset(name = 'spreading-oak', seed = 1) {
  if (!TREE_PRESETS.includes(name)) throw new TypeError(`Unknown tree preset ${name}`);
  const d = structuredClone(legacyTreeDefinition(name === 'tall-pine' ? 'loblolly-pine' : name === 'whorled-fir' ? 'douglas-fir' : 'live-oak'));
  d.id = name; d.version = 2; d.seed = seed; d.plant = normalizePlantControls();
  const p = d.parameters;
  p.leaves.count = 14000; p.leaves.scale = 0.15;
  p.gScale = 10; p.gScaleV = 0.5; p.ratio = 0.027; p.flare = 0.85; p.levels = 4;
  Object.assign(p.levelsParameters[1], { branches: 12, baseSize: 0.28, downAngle: 65, length: 0.72, lengthV: 0.14, curve: 25 });
  Object.assign(p.levelsParameters[2], { branches: 8, length: 0.48, radiusMod: 0.32 });
  Object.assign(p.levelsParameters[3], { branches: 4, length: 0.45, radiusMod: 0.3 });
  d.plant.foliage.spread = 0.025;
  d.materials.bark.color = '#766654';
  d.materials.leaves.translucency = 0.25;
  // Oak base: the classic root flare. Broad, numerous, massive buttresses rather
  // than the hard blades a conifer sections into, so the blade ratio stays low and
  // the trunk itself carries a strong lobed swell between them.
  Object.assign(d.plant.structure, {
    rootCount: 7, rootSpread: 3.6, rootDepth: 0.7, rootRise: 0.45, rootFlatten: 2.4,
    buttress: 0.75, buttressCount: 7,
  });
  if (name === 'whorled-fir') {
    p.gScale = 19; p.ratio = 0.017; p.levels = 4;
    Object.assign(p.levelsParameters[1], { branches: 27, baseSize: 0.12, downAngle: 82, length: 0.4, curve: -12, branchPattern: 'whorled' });
    p.levelsParameters[2].branches = 6; p.levelsParameters[3].branches = 3;
    Object.assign(p.leaves, { shape: 'spray', count: 9000, scale: 0.5, scaleX: 0.8 });
    d.plant.foliage.leaflets = 7; d.plant.life.deciduous = 0;
    Object.assign(d.plant.structure, { rootCount: 5, rootSpread: 4.0, rootDepth: 0.8, rootRise: 0.45, rootFlatten: 1.9, buttress: 0.5, buttressCount: 5 });
  }
  if (name === 'tall-pine') {
    p.gScale = 25; p.gScaleV = 1.2; p.ratio = 0.016; p.levels = 3;
    Object.assign(p.levelsParameters[1], { branches: 26, baseSize: 0.38, downAngle: 76, downAngleV: 12, length: 0.16, lengthV: 0.025, curve: -18, branchPattern: 'whorled' });
    Object.assign(p.levelsParameters[2], { branches: 8, length: 0.38, lengthV: 0.04, downAngle: 48, curve: 16 });
    Object.assign(p.leaves, { shape: 'spray', count: 3200, scale: 0.55, scaleX: 0.8 });
    d.plant.foliage.leaflets = 5; d.plant.life.deciduous = 0;
    d.materials.bark.color = '#685344'; d.materials.leaves.color = '#385738';
    Object.assign(d.plant.structure, { rootCount: 6, rootSpread: 4.3, rootDepth: 0.85, rootRise: 0.45, rootFlatten: 2.0, buttress: 0.55, buttressCount: 6 });
  }
  if (name === 'palm') {
    p.gScale = 12; p.ratio = 0.018; p.levels = 2; p.flare = 0.3;
    Object.assign(p.levelsParameters[1], { baseSize: 0.94, branches: 15, length: 0.38, downAngle: 65, curve: 80, curveV: 8, radiusMod: 0.2 });
    Object.assign(p.leaves, { shape: 'pinnate', count: 80, scale: 0.8, scaleX: 0.65, bend: 0.15 }); d.plant.life.deciduous = 0; d.plant.foliage.leaflets = 18;
    Object.assign(d.plant.structure, { rootCount: 0, buttress: 0 });
  }
  if (name === 'weeping-willow') { p.gScale = 14; p.levels = 4; d.plant.structure.droop = 1.1;
    Object.assign(d.plant.structure, { rootCount: 8, rootSpread: 5.0, rootDepth: 0.4, rootRise: 0.45, rootFlatten: 2.5, buttress: 0.6, buttressCount: 8 }); p.leaves.shape = 'lanceolate'; p.leaves.scaleX = 0.22; p.leaves.count = 18000; }
  if (name.includes('shrub') || name === 'clipped-hedge') {
    p.levels = 3; p.gScale = name === 'clipped-hedge' ? 1.5 : 2.2; p.gScaleV = 0.15; p.ratio = 0.012;
    p.multipleTrunks = { count: 7, radius: 0.45 }; p.leaves.scale = 0.08; p.leaves.count = 6000;
    p.levelsParameters[1].baseSize = 0.05; p.levelsParameters[1].branches = 10; p.levelsParameters[2].branches = 5;
    d.plant.structure.crownX = 1.25;
    Object.assign(d.plant.structure, { rootCount: 3, rootSpread: 2.2, rootDepth: 0.45, rootRise: 0.45, rootFlatten: 1.6, buttress: 0.15, buttressCount: 3 });
  }
  if (name === 'flowering-shrub') { p.blossoms = { count: 180, shape: 'flower', scale: 0.09, rate: 1 }; d.materials.blossoms.color = '#e89aae'; }
  if (name === 'clipped-hedge') { p.shape = 'cylindrical'; d.plant.structure.rootCount = 0; d.plant.structure.crownX = 1; d.plant.life.deciduous = 0; d.plant.envelope = { shape: 'box', width: 3, depth: 1.6, height: 1.6, baseHeight: 0 }; }
  return normalizeTreeDefinition(d);
}
