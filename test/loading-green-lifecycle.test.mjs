import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The constructor imports GPU-only materials through Vite's Three alias. Exercise
// its real lifecycle method without constructing that browser-only scene in Node.
const source = await readFile(new URL('../src/scene/LoadingGreen.js', import.meta.url), 'utf8');
const { LoadingGreen } = await import(`data:text/javascript;base64,${Buffer.from(
  source.slice(source.indexOf('export class LoadingGreen')),
).toString('base64')}`);

test('canceled worker errors are ignored but current and initialization failures surface', () => {
  const body = source.match(/this\.puttWorker\.onmessage = \(\{ data \}\) => \{([\s\S]*?)\n    \};/)[1];
  const receive = new Function('data', body);
  const failures = [];
  const loading = { _puttRequestId: 2, _puttsWanted: true, _prefetchAttempts: 4,
    _puttFailed: error => failures.push(error.message) };
  receive.call(loading, { requestId: 1, error: 'stale' });
  receive.call(loading, { requestId: 2, error: 'current' });
  loading._puttsWanted = false;
  receive.call(loading, { requestId: 2, error: 'stopped' });
  receive.call(loading, { error: 'initialization' });
  assert.deepEqual(failures, ['current', 'initialization']);
});

// The solver runs from the constructor, well before the scene is presented, so a
// trajectory can arrive with no frame loop to clock it.
test('solved trajectories are queued for the frame loop rather than started on arrival', () => {
  const body = source.match(/this\.puttWorker\.onmessage = \(\{ data \}\) => \{([\s\S]*?)\n    \};/)[1];
  const receive = new Function('data', body);
  const loading = { _puttRequestId: 7, _puttsWanted: true, _prefetchAttempts: 4, _puttPending: true, diagnostics: {}, _solverStartedAtMs: 0,
    _startPutt() { throw new Error('playback must not begin inside the worker callback'); },
    _nextPutt() { this.requested = (this.requested ?? 0) + 1; },
    _puttFailed: error => { throw error; } };
  receive.call(loading, { requestId: 7, putt: { samples: [] } });
  assert.deepEqual(loading._queuedPutt, { samples: [] });
  assert.equal(loading._puttPending, false);
  assert.equal(loading.requested, undefined);

  // An unsolvable start must reach for another one, bounded, instead of idling.
  const retrying = { _puttRequestId: 1, _puttsWanted: true, _prefetchAttempts: 2, requested: 0, diagnostics: {},
    _nextPutt() { this.requested++; }, _puttFailed: error => { throw error; } };
  for (let reply = 0; reply < 5; reply++) receive.call(retrying, { requestId: 1, putt: null });
  assert.equal(retrying.requested, 2, 'the retry budget must bound worker round trips');
});

test('retained loading scene tolerates an older RAF timestamp and advances stopped renderer passes', () => {
  const oldWindow = globalThis.window, oldRaf = globalThis.requestAnimationFrame;
  globalThis.window = { innerWidth: 1280, innerHeight: 720 };
  globalThis.requestAnimationFrame = () => 1;
  try {
    const events = [];
    const loading = Object.assign(Object.create(LoadingGreen.prototype), {
      diagnostics: { active: true, disposed: false, frames: 0 },
      lastFrameAt: 1010, reducedMotion: true, _flareStartedAt: null,
      environmentState: { advanceFixedTicks: ticks => {
        assert.ok(Number.isInteger(ticks) && ticks >= 0); events.push('ticks');
      } },
      // The viewport fit is solved once per aspect change, so a steady window must
      // not re-enter it every frame.
      _fitAspect: 1280 / 720,
      _applyViewportFit(aspect) {
        assert.equal(aspect, this._fitAspect, 'an unchanged aspect must not reframe');
        events.push('fit');
      },
      environment: { update() {} }, camera: { updateProjectionMatrix() {} },
      course: { update() {} }, lighting: { sun: { shadow: {} } },
      renderer: { target: 'pending-reflection', getRenderTarget() { return this.target; },
        setRenderTarget(target) { this.target = target; },
        getMRT() { return this.mrt; }, setMRT(mrt) { this.mrt = mrt; },
        info: {}, _nodes: { nodeFrame: { frameId: 1, update: () => events.push('frame') } },
        _inspector: { begin() {}, finish() {} } },
      pipeline: { render: () => { assert.equal(loading.renderer.target, null); events.push('render'); } },
      onError: error => { throw error; }, stop() {},
    });
    loading._frame(1000);
    assert.equal(loading.renderer.target, 'pending-reflection');
    assert.deepEqual(events, ['ticks', 'fit', 'frame', 'render']);
    assert.equal(loading.diagnostics.frames, 1);
    assert.equal(loading.diagnostics.active, true);
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = oldRaf;
  }
});
