import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BuilderPanel, deriveRouteReviewPlan } from '../src/ui/BuilderPanel.js';

test('range, creator, and play are first-class Vite pages', async () => {
  const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  for (const page of ['range.html', 'creator.html', 'play.html']) {
    assert.match(vite, new RegExp(`\\./${page.replace('.', '\\.')}`));
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(html, /src="\/src\/main\.js"/);
  }
});

test('range, creator, and play own distinct runtime scenes over shared course primitives', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const creator = await readFile(new URL('../src/scene/CreatorScene.js', import.meta.url), 'utf8');
  const play = await readFile(new URL('../src/scene/PlayScene.js', import.meta.url), 'utf8');
  assert.match(main, /isRangePage[\s\S]+\? Range/);
  assert.match(main, /isCreatorPage[\s\S]+\? CreatorScene/);
  assert.match(main, /isPlayPage[\s\S]+\? PlayScene/);
  assert.match(main, /!hasDirectScenePage && startupView === 'creator'/);
  assert.match(main, /isRangePage \? '\/beach-range\.json' : '\/course\.json'/);
  assert.match(main, /savedCoursePath\(await loadCourseLibrary\(\), startupQuery.get\('course'\)\)/);
  assert.doesNotMatch(main, /document.querySelector\('#gs-play \.gp-/);
  assert.doesNotMatch(main, /premium-range|requestedCourse/);
  assert.match(creator, /class CreatorScene extends CourseScene/);
  assert.match(creator, /sceneKind: 'creator'/);
  assert.match(play, /class PlayScene extends CourseScene/);
  assert.match(play, /sceneKind: 'play'/);
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
  assert.match(source, /id="gb-holes"/);
  assert.match(source, /golf\.selectHole\(hole\.holeId\)/);
  assert.match(source, /id="gb-build-progress"/);
  assert.match(source, /id="gb-status-panel"/);
  assert.match(source, /id="gb-status-details"/);
  assert.match(source, /id="gb-status-details"[\s\S]*id="gb-prompt"/);
  assert.doesNotMatch(source, /id="gb-updates"|>Updates</);
  assert.match(source, /\/api\/course-agent\/build\/live/);
  assert.match(source, /clientBuildId: this\.liveBuildId/);
  assert.match(source, /\/api\/course-agent\/build\/observation/);
  assert.match(source, /\/api\/course-agent\/build\/reset/);
  assert.match(source, /event\?\.type === 'review-request'/);
  assert.match(source, /full \? \{\} : \{ checkpoint: true \}/);
  assert.match(source, /streamApi/);
  assert.match(source, /onAgentStatus/);
  assert.match(source, /kind === 'error' \? 'error' : 'working'/);
  assert.match(source, /showAuthoredCreatorCourse/);
  assert.match(source, /selectCourseContext/);
  assert.match(source, /Current view is attached automatically/);
  assert.doesNotMatch(source, /class="gb-nav/);
  assert.doesNotMatch(source, /What should we build\?/);
  assert.doesNotMatch(source, /background:\s*(?:#fff|white)/i);
});

test('creator route opens on a disposable organic green showcase instead of the practice range', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const range = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/ui/BuilderPanel.js', import.meta.url), 'utf8');
  assert.match(main, /createCreatorCanvasCourse/);
  assert.match(main, /creatorCanvasActive = isCreatorPage/);
  assert.match(main, /let creatorCanvasVariant = 0/);
  assert.match(main, /if \(reroll\) creatorCanvasVariant \+= 1/);
  assert.match(main, /creatorCanvasCameraPose/);
  assert.match(main, /showAuthoredCreatorCourse[\s\S]+builder\?\.onActiveHoleChanged\?\.\(range\.activeHole\(\)\)/);
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
  assert.match(panel, /Math\.hypot\(point\.x - green\.x, point\.z - green\.z\) \* 2/);
  assert.match(panel, /Generated green/);
  assert.doesNotMatch(panel, /blank canvas/i);
});

test('selected stable object context crosses the isolated course-agent boundary', async () => {
  const source = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  assert.match(source, /selectedContext: sanitizeSelection\(selection\)/);
  assert.match(source, /selection\.point is invalid/);
  assert.match(source, /treat that stable entity and clicked world point/);
});

test('review route plans frame a dogleg decision and follow the final approach tangent', () => {
  const green = { x: 90, z: -380 };
  const plan = deriveRouteReviewPlan([
    { x: 0, z: 0 },
    { x: 0, z: -180 },
    { x: 90, z: -220 },
    green,
  ], { par: 4 });

  assert.ok(plan);
  assert.deepEqual(plan.decision.point, { x: 0, z: -180 });
  assert.notDeepEqual(plan.teeTarget.point, green, 'the tee camera should frame the route decision, not aim blindly through the dogleg at the green');
  assert.ok(plan.teeTarget.point.x > 0 && plan.teeTarget.point.z < -180);
  assert.ok(plan.landingVantage.distance <= plan.decision.distance - 38,
    'landing review must approach the decision rather than stand on its hazards');
  assert.ok(plan.landingTarget.distance > plan.decision.distance);
  assert.ok(Math.abs(plan.approach.tangent.x) < 1e-9);
  assert.ok(plan.approach.tangent.z < -0.999);
  assert.deepEqual(plan.green.point, green);
  assert.deepEqual(plan.overview.point, { x: 45, z: -190 });
});

test('par-five review plans expose a distinct second decision before the approach', () => {
  const plan = deriveRouteReviewPlan([
    { x: 0, z: 0 }, { x: 0, z: -190 }, { x: 70, z: -300 }, { x: 95, z: -500 },
  ], { par: 5 });
  assert.ok(plan.secondDecision);
  assert.ok(plan.secondDecisionTarget);
  assert.ok(plan.secondDecision.distance > plan.decision.distance);
  assert.ok(plan.secondDecisionTarget.distance > plan.secondDecision.distance);
  assert.ok(plan.approach.distance > plan.secondDecision.distance);
});

test('multi-hole review captures select their intended live hole and restore the starting scene state', async () => {
  const holes = [
    { holeId: 'hole-1', number: 1, par: 4, tees: [{ x: 0, z: 0 }], greenStart: 0, route: { points: [{ x: 0, z: 0 }, { x: 0, z: -320 }] } },
    { holeId: 'hole-2', number: 2, par: 3, tees: [{ x: 80, z: -320 }], greenStart: 1, route: { points: [{ x: 80, z: -320 }, { x: 210, z: -350 }] } },
  ];
  const selected = [];
  const poses = [];
  const evaluator = {
    active: false,
    simulationFrozen: false,
    getState() { return { position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: 45 }; },
    enter() { this.active = true; },
    freeze() { this.simulationFrozen = true; },
    setPose(pose) { poses.push(pose); },
    settle() { return Promise.resolve(); },
    exit() { this.active = false; this.simulationFrozen = false; },
  };
  const golf = {
    creatorCanvasActive: false,
    sm: { renderer: { domElement: { toDataURL: () => 'data:image/webp;base64,review' } } },
    evaluatorCamera: evaluator,
    range: {
      routing: {},
      routingHoles: holes,
      activeHoleId: 'hole-1',
      activeHole() { return holes.find((hole) => hole.holeId === this.activeHoleId); },
      terrain: { heightAt: () => 0 },
    },
    selectHole(holeId) {
      selected.push(holeId);
      this.range.activeHoleId = holeId;
    },
  };
  const previousWindow = globalThis.window;
  globalThis.window = { golf };
  try {
    const panel = Object.create(BuilderPanel.prototype);
    panel.getCourse = () => ({
      routing: {},
      greens: [{ x: 0, z: -320 }, { x: 210, z: -350 }],
    });
    const captures = await panel._captureReviewViews();

    assert.deepEqual(captures.map(({ label, activeHoleId }) => [label, activeHoleId]), [
      ['current', 'hole-1'],
      ['hole-1-tee', 'hole-1'],
      ['hole-1-landing', 'hole-1'],
      ['hole-1-approach', 'hole-1'],
      ['hole-1-overview', 'hole-1'],
      ['hole-2-tee', 'hole-2'],
      ['hole-2-landing', 'hole-2'],
      ['hole-2-approach', 'hole-2'],
    ]);
    assert.deepEqual(selected, ['hole-1', 'hole-1', 'hole-1', 'hole-1', 'hole-2', 'hole-2', 'hole-2', 'hole-1']);
    assert.equal(golf.range.activeHoleId, 'hole-1');
    assert.equal(evaluator.active, false);
    assert.equal(evaluator.simulationFrozen, false);
    assert.equal(poses.length, 7);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('live editor publishes settled route-aware renders with the watcher revision while the build stream stays open', async () => {
  const panel = Object.create(BuilderPanel.prototype);
  Object.assign(panel, {
    busy: true,
    liveBuildId: 'course-live-browser_01',
    liveRevision: 'v4-11111111',
    liveObservationReady: true,
    liveObservationSequence: 0,
    liveRenderGeneration: 0,
    liveObservationQueue: Promise.resolve(),
    _captureReviewViews: async ({ checkpoint }) => {
      assert.equal(checkpoint, true);
      return [{
        label: 'hole-2-landing', holeId: 'hole-2', activeHoleId: 'hole-2',
        camera: { position: [4, 5, 6] }, dataUrl: 'data:image/webp;base64,YQ==',
      }];
    },
    _liveDiagnostics: () => ({ renderer: { webgpuBackend: true }, browser: { errorCount: 0 } }),
    _status: () => {},
    _liveProgress: () => {},
  });
  const requests = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { golf: { range: { activeHoleId: 'hole-1' } } };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, revision: 'v4-22222222', message: 'Published checkpoint.' }) };
  };
  try {
    const result = await panel._queueLiveObservation({
      revision: 'v4-22222222', phase: 'course-runtime', summary: 'Compiled route is live.',
    });
    assert.equal(result.revision, 'v4-22222222');
    assert.equal(requests[0].url, '/api/course-agent/build/observation');
    assert.deepEqual(requests[0].body, {
      clientBuildId: 'course-live-browser_01',
      sequence: 1,
      renderGeneration: 1,
      revision: 'v4-22222222',
      phase: 'course-runtime',
      summary: 'Compiled route is live.',
      activeHoleId: 'hole-1',
      diagnostics: { renderer: { webgpuBackend: true }, browser: { errorCount: 0 } },
      captures: [{
        label: 'hole-2-landing', holeId: 'hole-2', activeHoleId: 'hole-2',
        camera: { position: [4, 5, 6] }, dataUrl: 'data:image/webp;base64,YQ==',
      }],
    });
    assert.equal(panel.liveObservationSequence, 1);
    assert.equal(panel.liveRenderGeneration, 1);
    assert.equal(panel.liveRevision, 'v4-22222222');
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
