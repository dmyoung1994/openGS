import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import config from '../vite.config.js';
import { TURF_PACK_SOURCE_URLS } from '../src/terrain/TurfSources.js';

test('putting-scene preloads cover real dependencies with matching Three request modes', async () => {
  const plugin = config.plugins.find((entry) => entry.name === 'loading-green-preloads');
  assert.ok(plugin);
  const tags = plugin.transformIndexHtml('', { path: '/range.html' });
  const urls = tags.map((tag) => tag.attrs.href);
  assert.equal(urls.length, 12);
  assert.equal(new Set(urls).size, urls.length);
  assert.deepEqual(urls.slice(0, 6), TURF_PACK_SOURCE_URLS);
  for (const path of ['/', '/index.html', '/range.html', '/creator.html', '/play.html']) {
    assert.deepEqual(plugin.transformIndexHtml('', { path }), tags);
  }
  assert.deepEqual(plugin.transformIndexHtml('', { path: '/viewer.html' }), []);
  const source = (await Promise.all([
    'src/terrain/Terrain.js', 'src/scene/CreatorCanvasFrame.js',
    'src/scene/PlayableCourseScene.js', 'src/scene/GolfBall.js',
  ].map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))).join('\n');
  for (const tag of tags) {
    const { href, as, crossorigin, rel } = tag.attrs;
    assert.equal(rel, 'preload');
    assert.equal(crossorigin, 'anonymous');
    assert.equal(as, href.endsWith('.glb') ? 'fetch' : 'image');
    assert.equal(tag.injectTo, 'head');
    assert.ok((await stat(new URL(`../public${href}`, import.meta.url))).size > 0, href);
    // Turf filenames are composed by the loader; all other URLs are literal.
    const turf = href.match(/\/([^/]+)_(alb|nrh)\.png$/);
    if (turf) assert.ok(source.includes(`set('${turf[1]}'`), href);
    else assert.ok(source.includes(href), href);
  }
});
