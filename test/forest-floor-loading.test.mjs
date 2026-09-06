import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
// Match Vite's production Three alias when importing the terrain module in Node.
registerHooks({ resolve: (specifier, context, next) => next(specifier === 'three' ? 'three/webgpu' : specifier, context) });
const { loadForestFloorMaps } = await import('../src/terrain/Terrain.js');

test('forest-floor bitmaps preserve packed channels and close on normal or interrupted disposal', async t => {
  const previous = globalThis.createImageBitmap;
  t.after(() => { if (previous) globalThis.createImageBitmap = previous; else delete globalThis.createImageBitmap; });
  const bitmaps = [];
  globalThis.createImageBitmap = async (blob, options) => {
    assert.deepEqual(options, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const bitmap = { width: 2048, height: 2048, closes: 0, close() { this.closes++; } };
    bitmaps.push(bitmap);
    return bitmap;
  };
  let wait = Promise.resolve(), ok = true;
  t.mock.method(globalThis, 'fetch', async () => {
    await wait;
    return { ok, status: ok ? 200 : 404, blob: async () => new Blob() };
  });
  const loaded = loadForestFloorMaps();
  await loaded.ready;
  for (const map of [loaded.colorRoughness, loaded.normalHeightAo]) {
    assert.ok(map.version > 0);
    assert.equal(map.flipY, true);
    map.dispose(); map.dispose();
    assert.equal(map.image.closes, 1);
  }
  let resume;
  wait = new Promise(resolve => { resume = resolve; });
  const interrupted = loadForestFloorMaps();
  const rejection = assert.rejects(interrupted.ready, /disposed during load/);
  interrupted.colorRoughness.dispose(); interrupted.normalHeightAo.dispose();
  resume(); await rejection;
  assert.ok(bitmaps.every(bitmap => bitmap.closes === 1));
  ok = false;
  const failed = loadForestFloorMaps();
  await assert.rejects(failed.ready, /404/);
  assert.equal(failed.colorRoughness.image, null);
  assert.equal(failed.normalHeightAo.image, null);
});
