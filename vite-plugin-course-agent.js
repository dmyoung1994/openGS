import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeCourse } from './src/course/course.js';

// Dev-server sidecar for the in-app Course Builder. It does three things:
//   1. GET  /course.json  — serve the root course spec (the single source of truth).
//   2. POST /api/build     — hand a natural-language prompt to the LOCAL agent CLI
//      (claude / codex), which uses the course-design skills to rewrite course.json.
//   3. watch course.json   — on any change (agent edit or hand edit) push a custom
//      'course:changed' HMR event so the app soft-rebuilds the course, no page reload.
//
// The agent only ever edits course.json (features), never terrain or code — that is
// the "prompt only, no terrain editing" contract, enforced by the instruction below
// and by the engine baking terrain from features.
//
// Agent command is configurable via env COURSE_AGENT_CMD (space-separated); defaults
// to Claude Code in headless print mode with edit auto-accept. Examples:
//   COURSE_AGENT_CMD="claude -p --permission-mode acceptEdits"   (default)
//   COURSE_AGENT_CMD="codex exec"
export function courseAgent(opts = {}) {
  const courseFile = opts.courseFile || 'course.json';

  return {
    name: 'course-agent',
    configureServer(server) {
      const root = server.config.root;
      const coursePath = path.resolve(root, courseFile);

      // --- live reload ---
      server.watcher.add(coursePath);
      const notify = (f) => {
        if (path.resolve(f) === coursePath) {
          server.ws.send({ type: 'custom', event: 'course:changed' });
        }
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);

      // --- serve the spec ---
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (url !== '/course.json') return next();
        readFile(coursePath, 'utf8').then(
          (txt) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(txt); },
          () => { res.statusCode = 404; res.end('{}'); },
        );
      });

      // --- build endpoint ---
      server.middlewares.use('/api/build', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return void res.end('POST only'); }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          let prompt = '';
          try { prompt = String(JSON.parse(body).prompt || ''); } catch { /* ignore */ }
          if (!prompt.trim()) return sendJSON(res, 400, { ok: false, error: 'empty prompt' });

          const priorCourse = await readFile(coursePath, 'utf8');
          const result = await runAgent({ root, prompt });
          // Agent edits are one transaction. Run the same complete normalizer used
          // by runtime/MCP; restore the exact prior bytes if schema or transitions
          // are invalid so a failed authoring turn cannot strand the live course.
          try {
            normalizeCourse(JSON.parse(await readFile(coursePath, 'utf8')));
          } catch (error) {
            await writeFile(coursePath, priorCourse);
            result.ok = false;
            result.error = `agent course transaction rolled back: ${error.message}`;
            result.restoredPriorCourse = true;
          }
          sendJSON(res, result.ok ? 200 : 500, result);
        });
      });
    },
  };
}

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function runAgent({ root, prompt, timeoutMs = 240000 }) {
  const cmd = (process.env.COURSE_AGENT_CMD || 'claude -p --permission-mode acceptEdits')
    .split(' ').filter(Boolean);
  const [bin, ...args] = cmd;
  return new Promise((resolve) => {
    let log = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `agent timed out after ${timeoutMs / 1000}s`, log }); }, timeoutMs);

    let child;
    try {
      child = spawn(bin, args, { cwd: root, env: process.env });
    } catch (e) {
      return finish({ ok: false, error: `could not launch agent (${bin}): ${e.message}`, log });
    }
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', (e) => finish({ ok: false, error: `could not launch agent (${bin}): ${e.message}. Set COURSE_AGENT_CMD.`, log }));
    child.on('close', (code) => finish({ ok: code === 0, code, log, error: code === 0 ? undefined : `agent exited with code ${code}` }));
    child.stdin.write(instruction(prompt));
    child.stdin.end();
  });
}

// The full instruction handed to the agent. It points at the reusable design skills,
// pins the schema + coordinate system, and forbids everything except editing
// course.json. (The skills' MCP/analyzer/apps-web references belong to a different
// engine and are explicitly disregarded.)
function instruction(prompt) {
  return `You are the course-design agent for a Three.js golf simulator. You edit exactly ONE file: course.json (repo root). Do NOT edit any other file, run scripts, run analyzers, or touch code or terrain.

Design principles: FIRST read .agents/skills/golf-course-authoring/references/engine.md (it describes THIS engine and its schema authoritatively), then .agents/skills/golf-course-authoring/SKILL.md and the design references. For biome, coastline, ecological-region, or course-edge work, also use .agents/skills/golf-biome-transitions/SKILL.md. Your only action is editing course.json.

This engine bakes all terrain from FEATURES; there is no heightfield to edit. course.json schema v3 requires meta.schema=3 and biomeTransitions (use [] when no transition is intended):
- biomeTransitions[]: {id,from,to,boundary,profile,seed,widthScale,priority}. course-edge boundaries declare sides from min-x|max-x|min-z|max-z. polygon-region boundaries declare valid non-self-intersecting points. Profiles: natural-resort-beach, narrow-wild-shore, broad-pristine-beach, maritime-alpine-ecotone. Water profiles are course-edge only and never change playable-surface physics.
- bounds {minX,maxX,minZ,maxZ} in metres.
- Coordinate system: x = lateral (right is +x). z = down-range: the tee sits near z≈2 and the course runs toward NEGATIVE z (a 150-yard green is at z ≈ -137). y is up and is computed automatically.
- tee {x,z,boxHalfX,z0,z1}.
- corridor {c0,k,rough}: fairway half-width(m) = c0 + (-z)*k; then a rough band of width \`rough\`; beyond that is deep rough.
- fringeW: green collar width (m).
- greens[]: {yards (distance from tee — z is auto-derived as -yards*0.9144 when omitted), x, r (radius m, ~6-12), contour}. contour is ONE of: tilt, punchbowl, spine, tier, crown, saddle. Give each green a single legible contour and vary them across the set.
- bunkers[]: {x, z, r (m), depth (m below grade), pot (boolean)}. Bunkers are cut INTO grade with no raised rim. pot = a small, deep, steep, revetted links pit (small r, larger depth).
- ponds[]: {x, z, r, depth}.

Keep metre scale, keep the tee reachable, keep greens and landing areas on playable ground, keep features inside bounds. Read the current course.json first, apply the user's request as a minimal, coherent edit (don't gratuitously rewrite unrelated features), and write the FULL updated course.json back as valid JSON.

User request:
${prompt}
`;
}
