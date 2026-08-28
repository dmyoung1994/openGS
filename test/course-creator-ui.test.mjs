import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('range, creator, and play are first-class Vite pages', async () => {
  const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  for (const page of ['range.html', 'creator.html', 'play.html']) {
    assert.match(vite, new RegExp(`\\./${page.replace('.', '\\.')}`));
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(html, /src="\/src\/main\.js"/);
  }
});

test('creator chrome preserves the world and exposes prompt, history, cameras, and semantic selection', async () => {
  const source = await readFile(new URL('../src/ui/BuilderPanel.js', import.meta.url), 'utf8');
  assert.match(source, /id="gb-menu-trigger"/);
  assert.match(source, /id="gb-menu-trigger"[^>]*>\$\{icon\('menu'\)\}<\/button>/);
  assert.match(source, /\.gb-menu-trigger\{position:absolute;top:16px;right:16px/);
  assert.match(source, /id="gb-destination-menu"/);
  assert.match(source, /id="gb-side-tab"/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /Chat history/);
  assert.match(source, /Action history/);
  assert.match(source, /id="gb-prompt"/);
  assert.match(source, /id="gb-select"/);
  assert.match(source, /id="gb-fly"/);
  assert.match(source, /data-view="overview"/);
  assert.match(source, /selectCourseContext/);
  assert.match(source, /Current view is attached automatically/);
  assert.doesNotMatch(source, /class="gb-nav/);
  assert.doesNotMatch(source, /What should we build\?/);
  assert.doesNotMatch(source, /background:\s*(?:#fff|white)/i);
});

test('creator route opens on a disposable organic green showcase instead of the practice range', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const range = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/ui/BuilderPanel.js', import.meta.url), 'utf8');
  assert.match(main, /createCreatorCanvasCourse/);
  assert.match(main, /creatorCanvasActive = isCreatorPage/);
  assert.match(main, /let creatorCanvasVariant = 0/);
  assert.match(main, /if \(reroll\) creatorCanvasVariant \+= 1/);
  assert.match(main, /creatorCanvasCameraPose/);
  assert.match(range, /this\.creatorCanvas = creatorCanvas === true/);
  assert.match(range, /semanticLandformHeight\(this\.landforms, x, z\)/);
  assert.match(range, /createCreatorCanvasOutline\(course\)/);
  assert.match(range, /if \(this\.creatorCanvas\) mesh\.visible = false/);
  assert.match(range, /finiteCanvas: this\.creatorCanvas/);
  assert.match(range, /finiteOutline: this\.creatorCanvasOutline/);
  assert.match(range, /finiteCutout: this\.creatorCanvas \? \{/);
  assert.match(range, /radius: GOLF_HOLE_RADIUS_M/);
  assert.match(range, /createCreatorCup\(\{ x, z, surfaceY: y \}\)/);
  assert.match(range, /this\._buildCreatorPin\(\)/);
  assert.match(range, /pin\.name = 'creator-center-pin'/);
  assert.match(range, /environment: this\.environment/);
  assert.match(range, /colors: \[0xf24a3d\]/);
  assert.match(range, /pole\.position\.set\(x, y \+ 1\.16, z\)/);
  assert.match(range, /anchors: \[\{ x, y: y \+ 2\.34, z \}\]/);
  assert.doesNotMatch(range, /pole\.scale\.y = 1\.6/);
  assert.match(range, /windSource = 'environment-frame-state'/);
  const terrain = await readFile(new URL('../src/terrain/Terrain.js', import.meta.url), 'utf8');
  assert.match(terrain, /_buildFiniteCanvasMesh\(\)/);
  assert.match(terrain, /_buildFiniteOutlineMesh\(\)/);
  assert.match(terrain, /terrain-creator-organic-outline/);
  assert.match(panel, /A fresh green is ready to shape\./);
  assert.match(panel, /gb-status-copy">A fresh green is ready to shape\.<\/span>/);
  assert.match(panel, /showCreatorCanvas\?\.\(\{ reroll: true \}\)/);
  assert.match(panel, /Generated green/);
  assert.doesNotMatch(panel, /blank canvas/i);
});

test('selected stable object context crosses the isolated course-agent boundary', async () => {
  const source = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  assert.match(source, /selectedContext: sanitizeSelection\(selection\)/);
  assert.match(source, /selection\.point is invalid/);
  assert.match(source, /treat that stable entity and clicked world point/);
});
