#!/usr/bin/env node
// Course-engine MCP server (stdio) for the Claude GolfSim course builder.
//
// Exposes the same project-v5 authoring kernel as the in-app builder. The editable
// source is course.project.json; course.json is compiled output only.
//
// Register it with your agent, e.g.:
//   claude mcp add course-engine -- node scripts/course-mcp.mjs
//   codex  mcp add course-engine -- node scripts/course-mcp.mjs
//
// Dependency-free: implements the MCP stdio transport (newline-delimited JSON-RPC
// 2.0) directly. Protocol chatter goes on stdout; all logging goes on stderr so it
// never corrupts the stream.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCourse, CONTOURS } from '../src/course/course.js';
import { compileActiveCourse, normalizeCourseProject, projectRevision } from '../src/course/CourseProject.js';
import {
  BIOME_TRANSITION_PROFILE_IDS, classifyBiomeAt,
} from '../src/course/BiomeRegistry.js';
import { signedDistanceToFeature } from '../src/course/featureGeometry.js';
import {
  applyAuthoringMutations, buildAuthoringContext, queryTreeAssets,
} from './lib/course-authoring-kernel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROJECT_PATH = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'course.project.json');
const AUTHORING_ROOT = dirname(PROJECT_PATH);
const log = (...a) => process.stderr.write(`[course-mcp] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- course I/O ---

async function readCourse() {
  const raw = await readFile(PROJECT_PATH, 'utf8');
  const project = normalizeCourseProject(JSON.parse(raw));
  return { raw, project, course: compileActiveCourse(project).runtime };
}

// Analytic surface classifier — mirrors Range._surface so an agent can ask "what is
// at (x,z)?" without the 3D engine. (Elevation needs the full noise+feature bake and
// is intentionally not exposed; author by features, not by height.)
function classify(x, z, c) {
  const near = [];
  if (Math.abs(x - c.tee.x) < c.tee.boxHalfX && z < c.tee.z1 && z > c.tee.z0) near.push('tee');
  const feats = [];
  for (const g of c.greens) {
    const d = Math.max(0, -signedDistanceToFeature(g, x, z));
    if (d < g.r + c.fringeW + 2) feats.push({ kind: 'green', d: +d.toFixed(1), green: g });
  }
  for (const b of c.bunkers) {
    const d = Math.max(0, -signedDistanceToFeature(b, x, z));
    if (d < b.r + 3) feats.push({ kind: b.pot ? 'pot-bunker' : 'bunker', d: +d.toFixed(1), bunker: b });
  }
  for (const p of c.ponds) {
    const d = Math.max(0, -signedDistanceToFeature(p, x, z));
    if (d < p.r + 3) feats.push({ kind: 'water', d: +d.toFixed(1), pond: p });
  }
  let surface = 'fairway';
  if (Math.abs(x - c.tee.x) < c.tee.boxHalfX && z < c.tee.z1 && z > c.tee.z0) surface = 'tee';
  else {
    for (const g of c.greens) { const d = signedDistanceToFeature(g, x, z); if (d > 0) { surface = 'green'; break; } if (d + c.fringeW > 0) surface = 'fringe'; }
    if (surface === 'fairway') for (const p of c.ponds) { if (signedDistanceToFeature(p, x, z) > 0) { surface = 'water'; break; } }
    if (surface === 'fairway') for (const b of c.bunkers) { const inset = b.pot ? b.r * 0.28 : 0; if (signedDistanceToFeature(b, x, z) - inset > 0) { surface = 'sand'; break; } }
    if (surface === 'fairway') {
      const half = c.corridor.c0 + (-z) * c.corridor.k, ax = Math.abs(x);
      if (ax > half + c.corridor.rough) surface = 'deepRough';
      else if (ax > half) surface = 'rough';
    }
  }
  const half = c.corridor.c0 + (-z) * c.corridor.k;
  return { x, z, surface, fairwayHalfWidthM: +half.toFixed(1), biome: classifyBiomeAt(c, x, z), nearby: feats.sort((a, b) => a.d - b.d) };
}

// Design sanity checks used by validate/set. These are warnings, not hard errors —
// the engine will render whatever it's given; these just flag likely mistakes.
function courseWarnings(c) {
  const w = [];
  const inB = (x, z) => x >= c.bounds.minX && x <= c.bounds.maxX && z >= c.bounds.minZ && z <= c.bounds.maxZ;
  for (const g of c.greens) if (!inB(g.x, g.z)) w.push(`green at (${g.x},${g.z}) is outside course bounds`);
  for (const b of c.bunkers) if (!inB(b.x, b.z)) w.push(`bunker at (${b.x},${b.z}) is outside course bounds`);
  for (const p of c.ponds) if (!inB(p.x, p.z)) w.push(`pond at (${p.x},${p.z}) is outside course bounds`);
  // Bunkers sitting fully inside a green/water read wrong.
  for (const b of c.bunkers) {
    for (const g of c.greens) if (Math.hypot(b.x - g.x, b.z - g.z) + b.r < g.r) w.push(`bunker at (${b.x},${b.z}) is entirely inside the green at (${g.x},${g.z})`);
    for (const p of c.ponds) if (Math.hypot(b.x - p.x, b.z - p.z) + b.r < p.r) w.push(`bunker at (${b.x},${b.z}) is entirely inside water at (${p.x},${p.z})`);
  }
  // Pots should be small+deep; flag a "pot" that isn't.
  for (const b of c.bunkers) if (b.pot && (b.r > 4.5 || b.depth < 1.3)) w.push(`pot bunker at (${b.x},${b.z}) is not small+deep (r=${b.r}, depth=${b.depth}); pots are ~r<=4, depth>=1.5`);
  return w;
}

const SCHEMA_DOC = `course.project.json schema v5 — the only editable course source. course.json is deterministic compiled output.

Coordinate system: metres. x = lateral (right is +x). z = down-range: the tee sits near z≈2 and the course runs toward NEGATIVE z. A 150-yard green is at z ≈ -137 (yards * -0.9144). y (elevation) is computed automatically.

Mutation contract: call get_context, inspect stable IDs, then apply_mutations with the exact baseRevision. Each mutation is {op,entityType,entityId,parentId?,value?}. Supported entity types are project, site, atmosphere, surface-materials, hole, route, tee, green, bunker, pond, landform, forest-floor-area, environment-object, procedural-tree-definition, and procedural-tree.

Compiled runtime fields:
- biome: primary registered biome. biomeTransitions[]: semantic visual/ecological transitions that never change playable surface physics.
- biomeTransitions[]: {id,from,to,boundary,profile,seed,widthScale,priority}. boundary is {kind:"course-edge",sides:[min-x|max-x|min-z|max-z]} or a validated inland {kind:"polygon-region",points:[{x,z},...]}. profile ∈ [${BIOME_TRANSITION_PROFILE_IDS.join(', ')}].
- bounds {minX,maxX,minZ,maxZ}
- tee {x,z,boxHalfX,z0,z1}
- corridor {c0,k,rough}: fairway half-width(m) = c0 + (-z)*k; then a rough band of width \`rough\`; beyond that deep rough.
- fringeW: green collar width (m).
- greens[]: {yards (z auto-derived as -yards*0.9144 if z omitted), x, r (~6-12 m), contour}. contour ∈ [${CONTOURS.join(', ')}]. The contour label is intent only. Optional shape uses 6–48 smooth spline controls with concave bays and unequal lobes. Optional grade:{slopeX,slopeZ,blend} establishes the underlying plane at the site centre elevation (signed slopes in m/m, total at most 6%, outer blend 2..40 m). Optional contours[] owns physical relief: up to 12 {kind,points,width,height,falloff} semantic landforms, with height -3..3 m, width 1..80 m and falloff 1..60 m. Points transform with the green. Use ridge, shelf, plateau, swale and drainage-channel for varied pin regions and connected recovery ground.
- bunkers[]: {x, z, r (m), depth (m below grade), pot (bool)}. Cut INTO grade, no raised rim. pot = small (r≲4), deep (depth≳1.5), steep revetted links pit.
- ponds[]: {x, z, r, depth}.
- site.forestFloorAreas[]: {id,shape:[{x,z},...]}. Four to 32 sparse world-space controls compile into a smooth pine-straw-bed SDF; author broad woodland beds, never crown circles or scatter rectangles.
- site.surfaceMaterials: replace through the singleton surface-materials entity ID to tune validated turf and forest-floor relief, macro variation, grass exclusion, and edge feathering without replacing the whole site.
- environment: catalog-backed placements/scatter/assemblies/edge dressing plus reusable proceduralTreeDefinitions and proceduralTrees placements. Procedural trees are explicit sources and never catalog fallbacks.

Not authorable: raw terrain height or materials.`;

// ---------------------------------------------------------------- tools ---

const TOOLS = [
  {
    name: 'describe_schema',
    description: 'Return the project-v5 authoring contract, coordinate system, and compiled contour vocabulary.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => text(SCHEMA_DOC),
  },
  {
    name: 'get_context',
    description: 'Return the compact, revision-tagged project-v5 AuthoringContext used by the in-app agent.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => text(JSON.stringify(await buildAuthoringContext(AUTHORING_ROOT), null, 2)),
  },
  {
    name: 'get_course',
    description: 'Return the authoritative project-v5 source, its revision, and compiled runtime.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const { project, course } = await readCourse();
      const n = normalizeCourse(course);
      return text(JSON.stringify({
        summary: `${n.meta.name || 'Course'} — ${n.greens.length} greens, ${n.bunkers.length} bunkers, ${n.ponds.length} water, ${n.biomeTransitions.length} biome transitions`,
        revision: projectRevision(project), project, runtime: course,
      }, null, 2));
    },
  },
  {
    name: 'classify_biome',
    description: 'Classify semantic biome/profile/habitat weights at a world point without changing its playable surface physics.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'] },
    run: async ({ x, z }) => {
      const { course } = await readCourse();
      return text(JSON.stringify(classifyBiomeAt(normalizeCourse(course), x, z), null, 2));
    },
  },
  {
    name: 'classify_point',
    description: 'What is at a world point (x,z)? Returns the playing surface (tee/green/fringe/fairway/rough/deepRough/sand/water), the fairway half-width at that z, and nearby features. Use this to place features precisely.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'] },
    run: async ({ x, z }) => {
      const { course } = await readCourse();
      return text(JSON.stringify(classify(x, z, normalizeCourse(course)), null, 2));
    },
  },
  {
    name: 'validate_course',
    description: 'Validate a project-v5 object (or the current source), compile it, and return runtime warnings without writing.',
    inputSchema: { type: 'object', properties: { project: { type: 'object' } } },
    run: async ({ project }) => {
      const source = project ? normalizeCourseProject(project) : (await readCourse()).project;
      const runtime = compileActiveCourse(source).runtime;
      const n = normalizeCourse(runtime);
      return text(JSON.stringify({ ok: true, revision: projectRevision(source), warnings: courseWarnings(n), runtime }, null, 2));
    },
  },
  {
    name: 'query_tree_assets',
    description: 'Query authored catalog trees and approved reusable procedural trees without loading full catalogs.',
    inputSchema: { type: 'object', properties: { biome: { type: 'string' }, source: { type: 'string', enum: ['catalog', 'procedural'] } } },
    run: async (args) => text(JSON.stringify(await queryTreeAssets(AUTHORING_ROOT, args), null, 2)),
  },
  {
    name: 'apply_mutations',
    description: 'Apply validated semantic mutations to project v5, record one undoable history checkpoint, and compile course.json.',
    inputSchema: {
      type: 'object',
      properties: {
        baseRevision: { type: 'string' }, intent: { type: 'string' },
        mutations: { type: 'array', minItems: 1, items: { type: 'object' } },
      },
      required: ['baseRevision', 'mutations'],
    },
    run: async ({ baseRevision, mutations, intent }) => {
      const result = await applyAuthoringMutations(AUTHORING_ROOT, { baseRevision, mutations, intent });
      return text(JSON.stringify({ ok: true, revision: result.revision, runtimeSchema: result.runtime.meta.schema }, null, 2));
    },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

// ---------------------------------------------------------------- MCP loop ---

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'course-engine', version: '0.1.0' },
    });
  } else if (method === 'notifications/initialized' || method === 'initialized') {
    /* notification, no reply */
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  } else if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      reply(id, await tool.run(params.arguments || {}));
    } catch (e) {
      reply(id, text(JSON.stringify({ ok: false, error: String(e && e.message || e) }), true));
    }
  } else if (id != null) {
    replyError(id, -32601, `method not found: ${method}`);
  }
}

let buf = '';
let pending = 0;
let ended = false;
const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('bad JSON line'); continue; }
    pending++;
    handle(msg).catch((e) => log('handler error:', e)).finally(() => { pending--; maybeExit(); });
  }
});
// Drain any in-flight tool calls before exiting (a piped stdin ends immediately;
// a real MCP client keeps it open until disconnect — either way, finish replies first).
process.stdin.on('end', () => { ended = true; maybeExit(); });
log(`ready — project source at ${PROJECT_PATH}`);
