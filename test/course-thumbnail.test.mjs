import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('async actual-canvas thumbnails discard stale completions and release replaced images', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('let thumbRequest = 0;') < source.indexOf('function requestThumb()'));
  assert.ok(source.indexOf('let thumbRequest = 0;') < source.indexOf('const shell ='));
  const body = source.slice(source.indexOf('function requestThumb()'), source.indexOf('// Live rebuild:'));
  const callbacks = [], revoked = [], installed = [];
  let pagehide;
  const canvas = { toBlob(callback, type, quality) {
    assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.75); callbacks.push(callback);
  } };
  let id = 0;
  const api = new Function('sm', 'shell', 'URL', 'window', `let range={},_thumbCountdown=0,thumbRequest=0,thumbObjectUrl=null;${body}
    return {requestThumb,thumbCapture,replaceCourse(){range={};}}`)(
    { renderer: { domElement: canvas } }, { setCourseThumb: url => installed.push(url) },
    { createObjectURL: () => `blob:${++id}`, revokeObjectURL: url => revoked.push(url) },
    { addEventListener: (name, callback) => { assert.equal(name, 'pagehide'); pagehide = callback; } },
  );
  api.requestThumb(); api.thumbCapture();
  api.requestThumb(); api.thumbCapture();
  callbacks.shift()({}); assert.equal(installed.length, 0);
  callbacks.shift()({}); assert.deepEqual(installed, ['blob:1']);
  api.thumbCapture(); callbacks.shift()({}); assert.deepEqual(revoked, ['blob:1']);
  api.thumbCapture(); api.replaceCourse(); callbacks.shift()({}); assert.equal(installed.length, 2);
  api.thumbCapture(); pagehide(); callbacks.shift()({});
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  api.requestThumb(); api.thumbCapture(); callbacks.shift()(null); assert.equal(installed.length, 2);
});
