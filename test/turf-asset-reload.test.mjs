import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TURF_PACK_SOURCE_URLS } from '../src/terrain/TurfSources.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const normalize = source.slice(source.indexOf('const normalizedPublicAssetPath ='),
  source.indexOf('const catalogTreeOwnsPath ='));
const queue = source.slice(source.indexOf('function queueLiveAssetReload(event = {})'),
  source.indexOf('\nif (import.meta.hot)', source.indexOf('function queueLiveAssetReload(event = {})')));

function harness() {
  const timers = [], result = { reloads: 0, rebuilds: 0 };
  const create = new Function('TURF_PACK_SOURCE_URLS', 'window', 'setTimeout', 'clearTimeout',
    'queueLiveSceneMutation', 'loadEnvironmentCatalog', 'rebuildCourseFromDisk', `
      let liveAssetReloadSerial = 0, liveAssetReloadTimer, liveTurfPackReloadPending = false;
      let environmentCatalog = { assets: [] };
      const builder = { onAgentStatus() {}, onCourseReloadFailed(error) { throw error; } };
      const catalogCategorySignature = () => '', catalogNonTreeSignature = () => '';
      const catalogTreeOwnsPath = () => false;
      ${normalize}
      ${queue}
      return queueLiveAssetReload;
    `);
  const enqueue = create(TURF_PACK_SOURCE_URLS, { location: { reload: () => result.reloads++ } },
    callback => { timers.push(callback); return timers.length; }, () => {},
    task => Promise.resolve().then(task), async () => ({ assets: [] }), async () => result.rebuilds++);
  return { enqueue, result, flush: () => timers.at(-1)(), flushFirst: () => timers[0]() };
}

test('only the six exact immutable turf source paths require a developer full reload', async () => {
  assert.equal(TURF_PACK_SOURCE_URLS.length, 6);
  for (const path of TURF_PACK_SOURCE_URLS) {
    const run = harness();
    run.enqueue({ path: `public${path}` });
    await run.flush();
    assert.deepEqual(run.result, { reloads: 1, rebuilds: 0 }, path);
  }
  for (const path of ['public/assets/textures/dirt_diff.jpg', 'public/assets/textures/blendkit_green_alb.png.backup',
    'public/assets/environment/catalog.json', 'course.json']) {
    const run = harness();
    run.enqueue({ path });
    await run.flush();
    assert.deepEqual(run.result, { reloads: 0, rebuilds: 1 }, path);
  }
});

test('a later catalog event cannot hide a turf change in the existing debounce batch', async () => {
  const run = harness();
  run.enqueue({ path: TURF_PACK_SOURCE_URLS[0] });
  run.enqueue({ path: 'public/assets/environment/catalog.json' });
  run.enqueue({ path: 'public/assets/visual-quality-manifest.json' });
  await run.flushFirst();
  assert.equal(run.result.reloads, 0, 'superseded event must not clear the sticky pack change');
  await run.flush();
  assert.deepEqual(run.result, { reloads: 1, rebuilds: 0 });
});
