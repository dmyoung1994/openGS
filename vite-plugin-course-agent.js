import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { CourseAgentService } from './scripts/course-agent-service.mjs';

// Local creator sidecar. Proposal review remains isolated, while live creator turns
// stream safe progress from a repository-scoped workspace writer. File watchers own
// browser rebuild notifications for course, geometry, catalog, and asset checkpoints.
export function courseAgent(opts = {}) {
  const courseFile = opts.courseFile || 'course.json';
  const projectFile = opts.projectFile || 'course.project.json';
  return {
    name: 'course-agent',
    configureServer(server) {
      const allowedOrigins = normalizeAllowedOrigins([
        ...(opts.allowedOrigins == null ? [] : Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : [opts.allowedOrigins]),
        server.config.server?.origin,
      ]);
      const root = server.config.root;
      const coursePath = path.resolve(root, courseFile);
      const projectPath = path.resolve(root, projectFile);
      const notifyStatus = (message, kind = 'file') => server.ws.send({ type: 'custom', event: 'course:agent-status', data: { message, kind } });
      let courseChangeSequence = 0;
      let service;
      const notify = async () => {
        const sequence = ++courseChangeSequence;
        try {
          const [projectRevision, renderRevision] = await Promise.all([
            service.currentProjectRevision(), service.currentRenderRevision(),
          ]);
          if (sequence !== courseChangeSequence) return;
          server.ws.send({ type: 'custom', event: 'course:changed', data: { projectRevision, renderRevision, sequence } });
        } catch (error) {
          if (sequence !== courseChangeSequence) return;
          notifyStatus(`Course changed, but its project revision could not be read: ${error?.message || String(error)}`, 'warning');
          server.ws.send({ type: 'custom', event: 'course:changed', data: { projectRevision: null, renderRevision: null, sequence } });
        }
      };
      service = new CourseAgentService({ root, onRuntimeChanged: notify });

      server.watcher.add(coursePath);
      server.watcher.add(projectPath);
      const watchedWorkspaceChange = (file) => {
        const absolute = path.resolve(file);
        const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
        if (absolute === coursePath) {
          notifyStatus('Compiled course geometry changed; rebuilding the WebGPU scene.');
          notify();
          return;
        }
        if (absolute === projectPath) {
          notifyStatus('Editable course project changed; waiting for its compiled runtime.');
          return;
        }
        if (relative === 'public/assets/environment/catalog.json') {
          notifyStatus('Environment catalog changed; preparing an atomic live asset swap.');
          server.ws.send({ type: 'custom', event: 'course:assets-changed', data: { path: relative } });
          return;
        }
        if (relative === 'public/assets/procedural-trees/catalog.json') {
          notifyStatus('Procedural tree asset kit changed; refreshing live authoring context.');
          server.ws.send({ type: 'custom', event: 'course:assets-changed', data: { path: relative } });
          return;
        }
        if (/^public\/assets\/.+\.(?:glb|gltf|bin|ktx2|png|jpe?g|webp|hdr)$/i.test(relative)) {
          notifyStatus(`Asset changed: ${relative}; decoding it in the background.`);
          server.ws.send({ type: 'custom', event: 'course:assets-changed', data: { path: relative } });
          return;
        }
        if (/^(?:src\/(?:course|terrain|scene)\/|scripts\/).+\.(?:js|mjs|json)$/i.test(relative)) {
          notifyStatus(`Geometry or build code changed: ${relative}.`);
        }
      };
      server.watcher.on('add', watchedWorkspaceChange);
      server.watcher.on('change', watchedWorkspaceChange);
      server.watcher.on('unlink', watchedWorkspaceChange);

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
        res.setHeader('Vary', 'Origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const denied = validateCourseAgentRequest(req, { allowedOrigins });
        if (denied) {
          send(res, denied.status, { ok: false, error: denied.error });
          return;
        }
        if (req.method === 'POST' && (url === '/api/course-agent/build/live' || url === '/api/course-agent/build/answer')) {
          streamLiveBuild(service, req, res, notifyStatus, { answer: url.endsWith('/answer') }).catch((error) => {
            if (!res.headersSent) send(res, 400, { ok: false, error: error?.message || String(error) });
            else { res.write(`${JSON.stringify({ type: 'fatal', message: error?.message || String(error) })}\n`); res.end(); }
          });
          return;
        }
        route(service, req, res, url, notifyStatus).catch((error) => {
          const message = error?.message || String(error);
          const auth = /login|authentication|unauthorized|credential/i.test(message);
          send(res, auth ? 401 : 400, { ok: false, error: message });
        });
      });
    },
  };
}

export function validateCourseAgentRequest(req, { allowedOrigins = new Set() } = {}) {
  const host = parseHostHeader(singleHeader(req?.headers?.host));
  if (!host) return deniedRequest(403, 'course-agent API requires a valid local Host header');
  const accepted = isLocalDevelopmentHostname(host.hostname) || originSetHasHost(allowedOrigins, host.host);
  if (!accepted) return deniedRequest(403, 'course-agent API is available only from an accepted local development origin');

  const method = String(req?.method ?? '').toUpperCase();
  const originValue = singleHeader(req?.headers?.origin);
  if (!originValue) {
    if (method === 'POST') return deniedRequest(403, 'course-agent POST requests require a same-origin Origin header');
  } else {
    const origin = parseOrigin(originValue);
    if (!origin || origin.host.toLowerCase() !== host.host) {
      return deniedRequest(403, 'course-agent request Origin must exactly match the request Host');
    }
    if (!isLocalDevelopmentHostname(origin.hostname) && !allowedOrigins.has(origin.origin)) {
      return deniedRequest(403, 'course-agent request Origin is not an accepted local development origin');
    }
  }

  if (method === 'POST' && !isApplicationJson(singleHeader(req?.headers?.['content-type']))) {
    return deniedRequest(415, 'course-agent POST requests require Content-Type: application/json');
  }
  return null;
}

function normalizeAllowedOrigins(values) {
  const origins = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const parsed = new URL(value.trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
      origins.add(parsed.origin);
    } catch { throw new Error(`invalid course-agent allowed origin: ${value}`); }
  }
  return origins;
}

function parseHostHeader(value) {
  if (!value || /[\s/@,]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return { host: value.toLowerCase(), hostname: stripIpv6Brackets(parsed.hostname.toLowerCase()) };
  } catch { return null; }
}

function parseOrigin(value) {
  if (!value || value === 'null') return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) return null;
    return {
      origin: parsed.origin,
      host: parsed.host,
      hostname: stripIpv6Brackets(parsed.hostname.toLowerCase()),
    };
  } catch { return null; }
}

function isLocalDevelopmentHostname(hostname) {
  const value = stripIpv6Brackets(String(hostname).toLowerCase());
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || (!value.includes('.') && isIP(value) === 0)) return true;
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254)
      || value === '0.0.0.0';
  }
  if (version === 6) {
    return value === '::1'
      || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value)
      || (value.startsWith('::ffff:') && isLocalDevelopmentHostname(value.slice(7)));
  }
  return false;
}

function originSetHasHost(origins, host) {
  for (const value of origins) if (new URL(value).host.toLowerCase() === host) return true;
  return false;
}

function isApplicationJson(value) {
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function singleHeader(value) {
  return typeof value === 'string' ? value.trim() : null;
}

function stripIpv6Brackets(value) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function deniedRequest(status, error) { return { status, error }; }

async function streamLiveBuild(service, req, res, notifyStatus = () => {}, { answer = false } = {}) {
  const body = await jsonBody(req);
  if (url.startsWith('/api/course-agent/plants/')) return send(res, 200, { ok: true, ...(await service.plantAction(url.split('/').at(-1), body)) });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders?.();
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });
  const emit = (event) => {
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    if (event?.message) notifyStatus(event.message, event.type === 'fatal' ? 'error' : event.type);
  };
  try {
    const result = await (answer
      ? service.answerLiveBuild(body, { onEvent: emit, signal: controller.signal })
      : service.liveBuild(body, { onEvent: emit, signal: controller.signal }));
    emit({ type: 'done', ...result });
    finished = true;
    res.end();
  } catch (error) {
    emit({ type: 'fatal', message: error?.message || String(error) });
    finished = true;
    res.end();
  }
}

async function route(service, req, res, url, notifyStatus = () => {}) {
  if (req.method === 'GET' && url === '/api/course-agent/state') {
    return send(res, 200, { ok: true, ...(await service.state()) });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST required' });
  const body = await jsonBody(req);
  if (url.startsWith('/api/course-agent/plants/')) return send(res, 200, { ok: true, ...(await service.plantAction(url.split('/').at(-1), body)) });
  if (url === '/api/course-agent/build/reset') return send(res, 200, { ok: true, ...(await service.resetLiveThread()) });
  if (url === '/api/course-agent/build/observation') {
    const observation = await service.recordLiveObservation(body);
    notifyStatus(observation.message, 'observation');
    return send(res, 200, { ok: true, ...observation });
  }
  if (url === '/api/course-agent/build/start') return send(res, 200, { ok: true, ...(await service.startBuild(body)) });
  if (url === '/api/course-agent/build/next') return send(res, 200, { ok: true, ...(await service.nextBuild(body)) });
  if (url === '/api/course-agent/build/abort') return send(res, 200, { ok: true, ...(await service.abortBuild(body)) });
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
