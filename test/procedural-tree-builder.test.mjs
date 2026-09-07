import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  legacyTreeDefinition, normalizeTreeDefinition,
} from '../src/trees/TreeDefinition.js';
import { generateTreeSkeleton } from '../src/trees/TreeGenerator.js';
import {
  analyzeTreeSpace, fitTreeToSilhouettes, rasterizeTreeSilhouette,
} from '../src/trees/TreeFitting.js';
import { imageGenTreePrompts, loadOrthographicMasks } from '../scripts/lib/tree-image.mjs';
import { png } from '../scripts/lib/png.mjs';

test('parametric generator is deterministic and covers splits, helices, multiple trunks, leaves, and blossoms', () => {
  const definition = structuredClone(legacyTreeDefinition('live-oak'));
  definition.parameters.multipleTrunks = { count: 3, radius: 0.8 };
  definition.parameters.levelsParameters[1].helixTurns = 0.7;
  definition.parameters.levelsParameters[1].segSplits = 0.4;
  definition.parameters.blossoms = { count: 40, shape: 'oval', scale: 0.12, rate: 1 };
  definition.parameters.pruning = { ratio: 0.5, width: 0.7, peak: 0.55, powerLow: 0.8, powerHigh: 0.8 };
  const normalized = normalizeTreeDefinition(definition);
  const first = generateTreeSkeleton(normalized, { seed: 44 });
  const second = generateTreeSkeleton(normalized, { seed: 44 });
  assert.deepEqual(first, second);
  assert.ok(first.stemCount > 3); assert.ok(first.segments.length > 100);
  assert.equal(first.leaves.length, normalized.parameters.leaves.count);
  assert.equal(first.blossoms.length, 40);
});

test('safe stochastic parametric L-system expands without eval and rejects broken stacks', () => {
  const definition = normalizeTreeDefinition({
    id: 'test-l-system', generator: 'l-system', seed: 9, variantCount: 2,
    grammar: {
      axiom: ['F'], iterations: 3, angle: 25, step: 0.8, radius: 0.16, tropism: [0, 0.1, 0],
      productions: { F: [{ weight: 0.7, successor: ['F', '[', '+', 'F', 'L', ']', 'F'] }, { weight: 0.3, successor: ['F', '[', '-', 'F', ']', 'F'] }] },
    },
    materials: { bark: { color: '#523b29', roughness: 0.96 }, leaves: { color: '#315b31', roughness: 0.9, alphaCutoff: 0.3, doubleSided: true }, blossoms: { color: '#efd5d7', roughness: 0.8 } },
  });
  const skeleton = generateTreeSkeleton(definition, { seed: 2 });
  assert.ok(skeleton.symbolCount > 1); assert.ok(skeleton.segments.length > 3); assert.ok(skeleton.leaves.length > 0);
  const broken = structuredClone(definition); broken.grammar.axiom = [']']; broken.grammar.iterations = 0;
  assert.throws(() => generateTreeSkeleton(broken), /unmatched closing/);
});

test('PCA is deterministic and bounded genetic fitting never loses its best silhouette', () => {
  const definitions = ['live-oak', 'maple', 'broadleaf-oak', 'douglas-fir'].map(legacyTreeDefinition);
  assert.deepEqual(analyzeTreeSpace(definitions), analyzeTreeSpace(definitions));
  const targetSkeleton = generateTreeSkeleton(definitions[0], { seed: 5 });
  const targets = Object.fromEntries(['front', 'side', 'top'].map((view) => [view, rasterizeTreeSilhouette(targetSkeleton, { view, width: 40, height: 40 })]));
  const result = fitTreeToSilhouettes(definitions[2], targets, { seed: 7, population: 6, generations: 4 });
  for (let index = 1; index < result.history.length; index++) assert.ok(result.history[index] >= result.history[index - 1]);
  assert.ok(result.fitness > 0.5);
});

test('ImageGen contract produces three transparent masks from a bounded local sheet', async () => {
  const prompts = imageGenTreePrompts('windswept coastal oak');
  assert.match(prompts.orthographic, /FRONT then RIGHT SIDE then TOP/);
  assert.match(prompts.leaf, /explicit procedural leaf meshes/);
  const width = 288, height = 96, pixels = Buffer.alloc(width * height * 4);
  for (let panel = 0; panel < 3; panel++) for (let y = 10; y < 88; y++) {
    const half = panel === 2 ? 28 : Math.max(4, Math.round((y - 10) * 0.28));
    for (let x = 48 - half; x <= 48 + half; x++) {
      const at = (y * width + panel * 96 + x) * 4;
      pixels[at] = 35; pixels[at + 1] = 92; pixels[at + 2] = 42; pixels[at + 3] = 255;
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'tree-sheet-'));
  const path = join(directory, 'sheet.png'); await writeFile(path, png(width, height, 4, pixels));
  const loaded = await loadOrthographicMasks(path, { size: 48 });
  for (const view of ['front', 'side', 'top']) assert.ok(loaded.masks[view].some(Boolean));
});

test('shipped ImageGen tree keeps its fitted silhouette and compressed leaf texture together', async () => {
  const directory = join(import.meta.dirname, '..', 'public', 'assets', 'procedural-trees', 'imagegen-live-oak');
  const definition = normalizeTreeDefinition(JSON.parse(await readFile(join(directory, 'definition.json'), 'utf8')));
  const manifest = JSON.parse(await readFile(join(directory, 'leaf-manifest.json'), 'utf8'));
  assert.equal(definition.source.kind, 'imagegen');
  assert.equal(definition.parameters.gScale, 15);
  assert.equal(definition.materials.leaves.textureUrl, '/assets/procedural-trees/imagegen-live-oak/leaf.ktx2');
  assert.ok(manifest.alphaCoverage > 0.05 && manifest.alphaCoverage < 0.8);
  assert.equal((await readFile(join(directory, 'leaf.ktx2'))).subarray(0, 12).toString('hex'), 'ab4b5458203230bb0d0a1a0a');
});
