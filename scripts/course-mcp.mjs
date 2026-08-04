#!/usr/bin/env node
// Course-engine MCP server (stdio) for the Claude GolfSim course builder.
//
// Exposes the SAME course as the in-app builder — it reads/writes the repo-root
// course.json (the single source of truth). A terminal claude/codex agent can drive
// the running sim through these tools: any set_course write lands on disk, the Vite
// course-agent plugin's watcher sees it and live-reloads the browser. So authoring
// works two ways — the in-app prompt box (/api/build) or a terminal agent over MCP —
// against one spec, with NO terrain editing (features only; the engine bakes terrain).
//
// Register it with your agent, e.g.:
//   claude mcp add course-engine -- node scripts/course-mcp.mjs
//   codex  mcp add course-engine -- node scripts/course-mcp.mjs
//
// Dependency-free: implements the MCP stdio transport (newline-delimited JSON-RPC
// 2.0) directly. Protocol chatter goes on stdout; all logging goes on stderr so it
// never corrupts the stream.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCourse, CONTOURS } from '../src/course/course.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const COURSE_PATH = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'course.json');
const log = (...a) => process.stderr.write(`[course-mcp] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- course I/O ---

async function readCourse() {
  const txt = await readFile(COURSE_PATH, 'utf8');
  return { raw: txt, course: JSON.parse(txt) };
}

async function writeCourse(course) {
  await writeFile(COURSE_PATH, JSON.stringify(course, null, 2) + '\n');
}

// Analytic surface classifier — mirrors Range._surface so an agent can ask "what is
// at (x,z)?" without the 3D engine. (Elevation needs the full noise+feature bake and
// is intentionally not exposed; author by features, not by height.)
function classify(x, z, c) {
  const near = [];
  if (Math.abs(x - c.tee.x) < c.tee.boxHalfX && z < c.tee.z1 && z > c.tee.z0) near.push('tee');
  const feats = [];
  for (const g of c.greens) {
    const d = Math.hypot(x - g.x, z - g.z);
    if (d < g.r + c.fringeW + 2) feats.push({ kind: 'green', d: +d.toFixed(1), green: g });
  }
  for (const b of c.bunkers) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (d < b.r + 3) feats.push({ kind: b.pot ? 'pot-bunker' : 'bunker', d: +d.toFixed(1), bunker: b });
  }
  for (const p of c.ponds) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r + 3) feats.push({ kind: 'water', d: +d.toFixed(1), pond: p });
  }
  let surface = 'fairway';
  if (Math.abs(x - c.tee.x) < c.tee.boxHalfX && z < c.tee.z1 && z > c.tee.z0) surface = 'tee';
  else {
    for (const g of c.greens) { const d = Math.hypot(x - g.x, z - g.z); if (d < g.r) { surface = 'green'; break; } if (d < g.r + c.fringeW) surface = 'fringe'; }
    if (surface === 'fairway') for (const p of c.ponds) { if (Math.hypot(x - p.x, z - p.z) < p.r) { surface = 'water'; break; } }
    if (surface === 'fairway') for (const b of c.bunkers) { const sr = b.pot ? b.r * 0.72 : b.r; if (Math.hypot(x - b.x, z - b.z) < sr) { surface = 'sand'; break; } }
    if (surface === 'fairway') {
      const half = c.corridor.c0 + (-z) * c.corridor.k, ax = Math.abs(x);
      if (ax > half + c.corridor.rough) surface = 'deepRough';
      else if (ax > half) surface = 'rough';
    }
  }
  const half = c.corridor.c0 + (-z) * c.corridor.k;
  return { x, z, surface, fairwayHalfWidthM: +half.toFixed(1), nearby: feats.sort((a, b) => a.d - b.d) };
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

const SCHEMA_DOC = `course.json — FEATURE spec (the engine bakes all terrain from these; there is no heightfield to edit).

Coordinate system: metres. x = lateral (right is +x). z = down-range: the tee sits near z≈2 and the course runs toward NEGATIVE z. A 150-yard green is at z ≈ -137 (yards * -0.9144). y (elevation) is computed automatically.

Fields:
- bounds {minX,maxX,minZ,maxZ}
- tee {x,z,boxHalfX,z0,z1}
- corridor {c0,k,rough}: fairway half-width(m) = c0 + (-z)*k; then a rough band of width \`rough\`; beyond that deep rough.
- fringeW: green collar width (m).
- greens[]: {yards (z auto-derived as -yards*0.9144 if z omitted), x, r (~6-12 m), contour}. contour ∈ [${CONTOURS.join(', ')}]. One legible contour per green; vary them across the set.
- bunkers[]: {x, z, r (m), depth (m below grade), pot (bool)}. Cut INTO grade, no raised rim. pot = small (r≲4), deep (depth≳1.5), steep revetted links pit.
- ponds[]: {x, z, r, depth}.

Not authorable here yet: individual trees/props (the tree line is procedural), raw terrain height, materials.`;

// ---------------------------------------------------------------- tools ---

const TOOLS = [
  {
    name: 'describe_schema',
    description: 'Return the course.json feature schema, coordinate system, and contour vocabulary. Read this before authoring.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => text(SCHEMA_DOC),
  },
  {
    name: 'get_course',
    description: 'Return the current course.json (parsed) plus a summary of its features.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const { course } = await readCourse();
      const n = normalizeCourse(course);
      return text(JSON.stringify({
        summary: `${n.meta.name || 'Course'} — ${n.greens.length} greens, ${n.bunkers.length} bunkers, ${n.ponds.length} water`,
        course,
      }, null, 2));
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
    description: 'Validate a course object (or the current course.json if omitted) against the schema and design sanity checks. Returns normalized features + warnings; does NOT write.',
    inputSchema: { type: 'object', properties: { course: { type: 'object' } } },
    run: async ({ course }) => {
      const raw = course || (await readCourse()).course;
      const n = normalizeCourse(raw);
      return text(JSON.stringify({ ok: true, warnings: courseWarnings(n), normalized: n }, null, 2));
    },
  },
  {
    name: 'set_course',
    description: 'Replace course.json with a full new course object (features only). Validates first; writes to disk, which live-reloads the running sim. Returns warnings. This is the mutation tool — read get_course, edit, then set_course.',
    inputSchema: { type: 'object', properties: { course: { type: 'object' } }, required: ['course'] },
    run: async ({ course }) => {
      if (!course || typeof course !== 'object') return text(JSON.stringify({ ok: false, error: 'course must be an object' }), true);
      const n = normalizeCourse(course);
      if (!n.greens.length && !n.bunkers.length && !n.ponds.length) return text(JSON.stringify({ ok: false, error: 'refusing to write an empty course (no features parsed)' }), true);
      await writeCourse(course);
      return text(JSON.stringify({ ok: true, warnings: courseWarnings(n), wrote: COURSE_PATH }, null, 2));
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
log(`ready — course at ${COURSE_PATH}`);
