import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { courseAgent, validateCourseAgentRequest } from '../vite-plugin-course-agent.js';

test('workspace-writing course agent server is loopback-only', async () => {
  const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /host:\s*'127\.0\.0\.1'/);
  assert.doesNotMatch(vite, /host:\s*true/);
});

function request({
  method = 'POST',
  host = 'localhost:5173',
  origin = `http://${host}`,
  contentType = 'application/json',
} = {}) {
  return {
    method,
    headers: {
      ...(host == null ? {} : { host }),
      ...(origin == null ? {} : { origin }),
      ...(contentType == null ? {} : { 'content-type': contentType }),
    },
  };
}

test('course-agent permits same-origin JSON from loopback and private LAN development hosts', () => {
  assert.equal(validateCourseAgentRequest(request()), null);
  assert.equal(validateCourseAgentRequest(request({
    host: '192.168.20.45:5173',
    origin: 'http://192.168.20.45:5173',
    contentType: 'application/json; charset=utf-8',
  })), null);
  assert.equal(validateCourseAgentRequest(request({
    host: '[::1]:5173',
    origin: 'http://[::1]:5173',
  })), null);
  assert.equal(validateCourseAgentRequest(request({
    host: 'golf-studio.local:5173',
    origin: 'https://golf-studio.local:5173',
  })), null);
});

test('course-agent rejects missing, null, malformed, and foreign POST origins', () => {
  assert.deepEqual(validateCourseAgentRequest(request({ origin: null })), {
    status: 403,
    error: 'course-agent POST requests require a same-origin Origin header',
  });
  assert.equal(validateCourseAgentRequest(request({ origin: 'null' })).status, 403);
  assert.equal(validateCourseAgentRequest(request({ origin: 'https://attacker.example' })).status, 403);
  assert.equal(validateCourseAgentRequest(request({ origin: 'http://localhost:5173/' })).status, 403);
  assert.equal(validateCourseAgentRequest(request({ host: null })).status, 403);
  assert.equal(validateCourseAgentRequest(request({ host: 'localhost:5173/evil' })).status, 403);
});

test('course-agent rejects DNS-rebinding hosts even when Origin and Host agree', () => {
  const denied = validateCourseAgentRequest(request({
    host: 'attacker.example:5173',
    origin: 'http://attacker.example:5173',
  }));
  assert.equal(denied.status, 403);
  assert.match(denied.error, /accepted local development origin/);

  assert.equal(validateCourseAgentRequest(request({
    host: 'trusted-dev.example:5173',
    origin: 'https://trusted-dev.example:5173',
  }), { allowedOrigins: new Set(['https://trusted-dev.example:5173']) }), null);
});

test('course-agent requires application/json before parsing any POST body', () => {
  assert.equal(validateCourseAgentRequest(request({ contentType: null })).status, 415);
  assert.equal(validateCourseAgentRequest(request({ contentType: 'text/plain' })).status, 415);
  assert.equal(validateCourseAgentRequest(request({ contentType: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal(validateCourseAgentRequest(request({ contentType: 'application/problem+json' })).status, 415);
  assert.equal(validateCourseAgentRequest(request({ contentType: 'Application/JSON ; Charset=UTF-8' })), null);
});

test('read-only GET may omit Origin but rejects a supplied foreign Origin or public Host', () => {
  assert.equal(validateCourseAgentRequest(request({ method: 'GET', origin: null, contentType: null })), null);
  assert.equal(validateCourseAgentRequest(request({ method: 'GET', origin: 'https://attacker.example', contentType: null })).status, 403);
  assert.equal(validateCourseAgentRequest(request({
    method: 'GET', host: 'attacker.example:5173', origin: null, contentType: null,
  })).status, 403);
});

test('plugin middleware blocks cross-origin LAN live builds before body parsing or Codex streaming', () => {
  const middlewares = [];
  const server = {
    config: { root: new URL('..', import.meta.url).pathname, server: { host: true } },
    watcher: { add() {}, on() {} },
    ws: { send() {} },
    middlewares: { use(handler) { middlewares.push(handler); } },
  };
  courseAgent().configureServer(server);
  const apiMiddleware = middlewares.at(-1);
  const headers = new Map();
  let responseBody = '';
  let nextCalled = false;
  const response = {
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(value) { responseBody = value; },
  };
  apiMiddleware({
    method: 'POST',
    url: '/api/course-agent/build/live',
    headers: {
      host: '192.168.1.40:5173',
      origin: 'https://attacker.example',
      'content-type': 'application/json',
    },
  }, response, () => { nextCalled = true; });

  assert.equal(response.statusCode, 403);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('vary'), 'Origin');
  assert.equal(JSON.parse(responseBody).ok, false);
  assert.equal(nextCalled, false);
  assert.doesNotMatch(headers.get('content-type'), /x-ndjson/);
});

test('plugin middleware preserves same-origin browser JSON requests', async () => {
  const middlewares = [];
  const server = {
    config: { root: new URL('..', import.meta.url).pathname, server: { origin: 'http://localhost:5173/' } },
    watcher: { add() {}, on() {} },
    ws: { send() {} },
    middlewares: { use(handler) { middlewares.push(handler); } },
  };
  courseAgent().configureServer(server);
  const apiMiddleware = middlewares.at(-1);
  const requestStream = Readable.from(['{}']);
  Object.assign(requestStream, {
    method: 'POST',
    url: '/api/course-agent/not-a-route',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
    },
  });
  let nextCalled = false;
  const response = {
    setHeader() {},
    end(value) { this.body = value; this.finished?.(); },
  };
  const finished = new Promise((resolve) => { response.finished = resolve; });
  apiMiddleware(requestStream, response, () => { nextCalled = true; });
  await finished;
  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'unknown course-agent endpoint' });
  assert.equal(nextCalled, false);
});
