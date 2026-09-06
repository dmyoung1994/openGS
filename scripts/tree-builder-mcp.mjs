#!/usr/bin/env node
import { TREE_PRESETS, createTreePreset } from '../src/trees/TreePresets.js';
import { PLANT_CONTROLS, PLANT_PROFILES } from '../src/trees/PlantControls.js';
import { savePlantAsset } from './lib/plant-library.mjs';
import {
  DEFAULT_PARAMETRIC_TREE, TREE_LIMITS, legacyTreeDefinition, normalizeTreeDefinition,
} from '../src/trees/TreeDefinition.js';
import { generateTreeSkeleton } from '../src/trees/TreeGenerator.js';
import { analyzeTreeSpace, blendTreeDefinitions, fitTreeToSilhouettes } from '../src/trees/TreeFitting.js';
import { imageGenTreePrompts, loadOrthographicMasks } from './lib/tree-image.mjs';
import { promoteProceduralTreeAsset } from './lib/course-authoring-kernel.mjs';

const log = (...values) => process.stderr.write(`[tree-builder-mcp] ${values.join(' ')}\n`);
const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError });
const TOOLS = [
  { name: 'create_tree_preset', description: 'Generate a fully procedural editable plant definition; no reference image or modeling required.', inputSchema: { type: 'object', properties: { name: { type: 'string', enum: TREE_PRESETS }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 } }, required: ['name'] }, run: async ({ name, seed = 1 }) => text({ definition: createTreePreset(name, seed) }) },
  { name: 'save_plant_asset', description: 'Save an explicitly accepted plant definition and production PNG thumbnail to the procedural library.', inputSchema: { type: 'object', properties: { definition: { type: 'object' }, thumbnail: { type: 'string' } }, required: ['definition', 'thumbnail'] }, run: async args => text({ asset: await savePlantAsset(process.cwd(), args) }) },
  {
    name: 'describe_tree_schema', description: 'Describe reusable procedural tree definitions, limits, and the ImageGen-to-geometry workflow.', inputSchema: { type: 'object', properties: {} },
    run: async () => text({ version: 2, presets: TREE_PRESETS, controls: PLANT_CONTROLS, profiles: PLANT_PROFILES, generators: ['parametric', 'l-system'], limits: TREE_LIMITS, parametricDefaults: DEFAULT_PARAMETRIC_TREE, workflow: ['generate three transparent front/right/top sheets with create_imagegen_prompts', 'fit all candidates', 'auto-select highest score', 'generate and process one leaf texture', 'create a procedural-tree-definition then procedural-tree placements'] }),
  },
  {
    name: 'create_imagegen_prompts', description: 'Create the exact transparent orthographic-sheet and leaf-texture prompts for ImageGen.', inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
    run: async ({ description }) => text(imageGenTreePrompts(description)),
  },
  {
    name: 'validate_tree_definition', description: 'Strictly validate one procedural tree definition without writing files.', inputSchema: { type: 'object', properties: { definition: { type: 'object' } }, required: ['definition'] },
    run: async ({ definition }) => text({ ok: true, definition: normalizeTreeDefinition(definition) }),
  },
  {
    name: 'generate_tree_diagnostics', description: 'Generate a deterministic skeleton and report its stem, segment, leaf, blossom, and bounds workload.', inputSchema: { type: 'object', properties: { definition: { type: 'object' }, seed: { type: 'integer' } }, required: ['definition'] },
    run: async ({ definition, seed = 0 }) => text({ ok: true, diagnostics: generateTreeSkeleton(definition, { seed }).diagnostics }),
  },
  {
    name: 'analyze_tree_space', description: 'Project at least three parametric definitions into the dissertation two-component PCA space.', inputSchema: { type: 'object', properties: { definitions: { type: 'array', minItems: 3, items: { type: 'object' } } }, required: ['definitions'] },
    run: async ({ definitions }) => text({ ok: true, analysis: analyzeTreeSpace(definitions) }),
  },
  {
    name: 'blend_tree_definitions', description: 'Interpolate continuous parameters between two parametric definitions.', inputSchema: { type: 'object', properties: { first: { type: 'object' }, second: { type: 'object' }, amount: { type: 'number', minimum: 0, maximum: 1 } }, required: ['first', 'second'] },
    run: async ({ first, second, amount = 0.5 }) => text({ ok: true, definition: blendTreeDefinitions(first, second, amount) }),
  },
  {
    name: 'fit_tree_silhouettes', description: 'Fit a parametric definition to a local transparent front/right/top PNG sheet. The path must be in the workspace or OS temp directory.', inputSchema: { type: 'object', properties: { sheetPath: { type: 'string' }, definition: { type: 'object' }, archetype: { type: 'string' }, seed: { type: 'integer' }, population: { type: 'integer', minimum: 4, maximum: 64 }, generations: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['sheetPath'] },
    run: async ({ sheetPath, definition, archetype = 'broadleaf-oak', seed = 1, population = 12, generations = 24 }) => { const target = await loadOrthographicMasks(sheetPath); const fitted = fitTreeToSilhouettes(definition ?? legacyTreeDefinition(archetype), target.masks, { seed, population, generations }); return text({ ok: true, fitness: fitted.fitness, history: fitted.history, definition: fitted.definition, sourceSha256: target.sha256 }); },
  },
  {
    name: 'promote_tree_asset', description: 'Validate an approved procedural tree directory and add it to the shared asset-kit catalog.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, biomes: { type: 'array', minItems: 1, items: { type: 'string' } }, form: { type: 'string' }, provenance: { type: 'string' } }, required: ['id', 'label', 'biomes', 'form'] },
    run: async (args) => text({ ok: true, asset: await promoteProceduralTreeAsset(process.cwd(), args) }),
  },
];

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
async function handle(message) { const { id, method, params } = message; if (method === 'initialize') reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'procedural-tree-builder', version: '1.0.0' } }); else if (method === 'notifications/initialized' || method === 'initialized') {} else if (method === 'ping') reply(id, {}); else if (method === 'tools/list') reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }); else if (method === 'tools/call') { const tool = TOOLS.find(({ name }) => name === params?.name); if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`); try { reply(id, await tool.run(params.arguments || {})); } catch (error) { reply(id, text({ ok: false, error: String(error?.message || error) }, true)); } } else if (id != null) replyError(id, -32601, `method not found: ${method}`); }
let buffer = '', pending = 0, ended = false; const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { buffer += chunk; let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch { log('bad JSON line'); continue; } pending++; handle(message).catch((error) => log(error)).finally(() => { pending--; maybeExit(); }); } });
process.stdin.on('end', () => { ended = true; maybeExit(); }); log('ready');
