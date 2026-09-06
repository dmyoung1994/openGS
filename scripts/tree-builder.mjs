#!/usr/bin/env node
import { TREE_PRESETS, createTreePreset } from '../src/trees/TreePresets.js';
import { PLANT_CONTROLS, PLANT_PROFILES } from '../src/trees/PlantControls.js';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  DEFAULT_PARAMETRIC_TREE, legacyTreeDefinition, normalizeTreeDefinition,
} from '../src/trees/TreeDefinition.js';
import { generateTreeSkeleton } from '../src/trees/TreeGenerator.js';
import {
  analyzeTreeSpace, blendTreeDefinitions, fitTreeToSilhouettes,
} from '../src/trees/TreeFitting.js';
import { imageGenTreePrompts, loadOrthographicMasks, prepareLeafTexture } from './lib/tree-image.mjs';
import { promoteProceduralTreeAsset } from './lib/course-authoring-kernel.mjs';

const [command = 'help', ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

if (command === 'help') print({ usage: 'tree-builder.mjs <presets|preset|schema|prompts|validate|diagnose|fit|pca|blend|leaf|promote> [options]' });
else if (command === 'presets') print({ presets: TREE_PRESETS });
else if (command === 'schema') print({ version: 2, controls: PLANT_CONTROLS, profiles: PLANT_PROFILES, defaults: createTreePreset() });
else if (command === 'preset') { const definition = createTreePreset(args.name, number(args.seed, 1)); if (args.id) { const copy = structuredClone(definition); copy.id = args.id; if (args.output) await writeJson(args.output, normalizeTreeDefinition(copy)); print(copy); } else { if (args.output) await writeJson(args.output, definition); print(definition); } }
else if (command === 'prompts') print(imageGenTreePrompts(required(args.description, '--description')));
else if (command === 'validate') print({ ok: true, definition: normalizeTreeDefinition(await readJson(required(args.definition, '--definition'))) });
else if (command === 'diagnose') {
  const definition = normalizeTreeDefinition(await readJson(required(args.definition, '--definition')));
  print({ ok: true, diagnostics: generateTreeSkeleton(definition, { seed: number(args.seed, 0) }).diagnostics });
} else if (command === 'fit') {
  const base = args.definition ? normalizeTreeDefinition(await readJson(args.definition)) : legacyTreeDefinition(args.archetype || 'broadleaf-oak');
  const sheets = required(args.sheets || args.sheet, '--sheets').split(',').map((value) => value.trim()).filter(Boolean);
  if (sheets.length < 1 || sheets.length > 3) throw new Error('--sheets must contain one to three PNG paths.');
  const results = [];
  for (let index = 0; index < sheets.length; index++) {
    const target = await loadOrthographicMasks(sheets[index], { size: number(args.size, 96) });
    const fitted = fitTreeToSilhouettes(base, target.masks, {
      seed: number(args.seed, 1) + index,
      locked: args.locked?.split(',') ?? [], population: number(args.population, 12), generations: number(args.generations, 24),
    });
    results.push({ ...fitted, sheet: target });
  }
  results.sort((a, b) => b.fitness - a.fitness);
  const winner = results[0], definition = structuredClone(winner.definition);
  if (args.id) definition.id = args.id;
  if (args.referenceUrl) definition.source = {
    kind: 'imagegen', referenceUrl: args.referenceUrl,
    promptHash: createHash('sha256').update(args.prompt || winner.sheet.sha256).digest('hex'), fitness: winner.fitness,
  };
  const normalized = normalizeTreeDefinition(definition);
  if (args.output) await writeJson(args.output, normalized);
  if (args.referenceOutput) { await mkdir(dirname(resolve(args.referenceOutput)), { recursive: true }); await copyFile(winner.sheet.path, resolve(args.referenceOutput)); }
  print({ ok: true, selected: basename(winner.sheet.path), fitness: winner.fitness, candidateFitness: results.map((result) => ({ sheet: basename(result.sheet.path), fitness: result.fitness })), definition: normalized });
} else if (command === 'pca') {
  const paths = required(args.definitions, '--definitions').split(',');
  print({ ok: true, analysis: analyzeTreeSpace(await Promise.all(paths.map(readJson))) });
} else if (command === 'blend') {
  const definition = blendTreeDefinitions(await readJson(required(args.first, '--first')), await readJson(required(args.second, '--second')), number(args.amount, 0.5));
  if (args.output) await writeJson(args.output, definition); print({ ok: true, definition });
} else if (command === 'leaf') {
  print({ ok: true, manifest: await prepareLeafTexture(required(args.input, '--input'), { id: required(args.id, '--id'), outputDirectory: args.output, prompt: args.prompt }) });
} else if (command === 'promote') {
  print({ ok: true, asset: await promoteProceduralTreeAsset(process.cwd(), {
    id: required(args.id, '--id'), label: required(args.label, '--label'),
    biomes: required(args.biomes, '--biomes').split(',').map((value) => value.trim()).filter(Boolean),
    form: required(args.form, '--form'), provenance: args.provenance,
  }) });
} else if (command === 'example') {
  const definition = normalizeTreeDefinition({ id: args.id || 'new-tree', generator: 'parametric', seed: number(args.seed, 1), variantCount: 3, parameters: DEFAULT_PARAMETRIC_TREE, materials: { bark: { color: '#513c2a', roughness: 0.96 }, leaves: { color: '#315b31', roughness: 0.9, alphaCutoff: 0.32, doubleSided: true }, blossoms: { color: '#efd5d7', roughness: 0.8 } } });
  if (args.output) await writeJson(args.output, definition); print(definition);
} else throw new Error(`Unknown tree-builder command "${command}".`);

function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index += 2) { const key = values[index]?.replace(/^--/, ''), value = values[index + 1]; if (!key || value === undefined) throw new Error(`Malformed argument ${values[index] ?? '<empty>'}.`); result[key] = value; } return result; }
function required(value, label) { if (!value) throw new Error(`${label} is required.`); return value; }
function number(value, fallback) { if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`Expected a finite number, received "${value}".`); return parsed; }
async function readJson(path) { return JSON.parse(await readFile(resolve(path), 'utf8')); }
async function writeJson(path, value) { const target = resolve(path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
