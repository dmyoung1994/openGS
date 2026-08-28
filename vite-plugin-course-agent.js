import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CourseAgentService } from './scripts/course-agent-service.mjs';

// Local creator sidecar. Codex works inside an isolated read-only temporary
// directory and can only return structured proposal data. This service alone owns
// project/history persistence and compilation into the runtime course manifest.
export function courseAgent(opts = {}) {
  const courseFile = opts.courseFile || 'course.json';
  const projectFile = opts.projectFile || 'course.project.json';
  return {
    name: 'course-agent',
    configureServer(server) {
      const root = server.config.root;
      const coursePath = path.resolve(root, courseFile);
      const projectPath = path.resolve(root, projectFile);
      const notify = () => server.ws.send({ type: 'custom', event: 'course:changed' });
      const service = new CourseAgentService({ root, onRuntimeChanged: notify });

      server.watcher.add(coursePath);
      server.watcher.add(projectPath);
      server.watcher.on('change', (file) => { if (path.resolve(file) === coursePath) notify(); });

      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (url !== '/course.json' && url !== '/course.project.json') return next();
        const source = url === '/course.json' ? coursePath : projectPath;
        readFile(source, 'utf8').then(
          (text) => send(res, 200, JSON.parse(text)),
          () => send(res, 404, {}),
        );
      });

      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith('/api/course-agent')) return next();
        route(service, req, res, url).catch((error) => {
          const message = error?.message || String(error);
          const auth = /login|authentication|unauthorized|credential/i.test(message);
          send(res, auth ? 401 : 400, { ok: false, error: message });
        });
      });
    },
  };
}

async function route(service, req, res, url) {
  if (req.method === 'GET' && url === '/api/course-agent/state') {
    return send(res, 200, { ok: true, ...(await service.state()) });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST required' });
  const body = await jsonBody(req);
  if (url === '/api/course-agent/propose') return send(res, 200, { ok: true, ...(await service.propose(body)) });
  if (url === '/api/course-agent/review') return send(res, 200, { ok: true, ...(await service.review(body)) });
  if (url === '/api/course-agent/preview') return send(res, 200, { ok: true, ...(await service.preview(body)) });
  if (url === '/api/course-agent/revise') return send(res, 200, { ok: true, ...(await service.revise(body)) });
  if (url === '/api/course-agent/apply') return send(res, 200, { ok: true, ...(await service.apply(body)) });
  if (url === '/api/course-agent/reject') return send(res, 200, { ok: true, ...(await service.reject(body)) });
  if (url === '/api/course-agent/undo') return send(res, 200, { ok: true, ...(await service.undo(body)) });
  if (url === '/api/course-agent/redo') return send(res, 200, { ok: true, ...(await service.redo()) });
  return send(res, 404, { ok: false, error: 'unknown course-agent endpoint' });
}

function jsonBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) { reject(new Error('request body exceeds 32 MiB')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, value) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}
