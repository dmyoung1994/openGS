import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { SceneManager } from '../src/scene/SceneManager.js';

test('delayed return after a still result orbit invalidates TRAA on its first move', () => {
  const camera = new PerspectiveCamera();
  camera.updateMatrixWorld();
  const manager = Object.create(SceneManager.prototype);
  manager.camera = camera;
  manager.motionHistory = {
    currentProjection: { value: new Matrix4() },
    currentView: { value: new Matrix4() },
    previousProjection: { value: new Matrix4() },
    previousView: { value: new Matrix4() },
    valid: false,
  };
  manager._cameraCutState = {
    position: new Vector3(), quaternion: new Quaternion(), projection: new Matrix4(), valid: false,
  };
  manager._cameraStillFrames = 0;
  const reasons = [];
  manager.invalidateTemporalHistory = (reason) => {
    reasons.push(reason);
    manager.motionHistory.valid = false;
    manager._cameraCutState.valid = false;
    manager._cameraStillFrames = 0;
  };

  // Three stationary frames establish a settled result orbit.
  manager._beginMotionFrame();
  manager._beginMotionFrame();
  manager._beginMotionFrame();
  manager._beginMotionFrame();
  assert.equal(manager._cameraStillFrames, 3);

  // The automatic return is damped and therefore below the old 8 m cut
  // threshold, but it still invalidates stale result-view history.
  camera.position.x = 2;
  manager._beginMotionFrame();
  assert.deepEqual(reasons, ['automatic camera discontinuity']);
});

test('post stack does not reintroduce a second jittered or glare copy', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /golfBloom\(/);
  assert.match(source, /const rgb = resolvedScene/);
});

test('analytic environment fill remains subordinate to the shared sun', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.match(source, /scene\.environmentIntensity = 0\.34 \* Math\.sqrt/,
    'PMREM fill must not flatten the corrected direct-daylight value structure');
  assert.match(source, /environment\.atmosphereExposure\.value \* 0\.84/,
    'ACES calibration must retain headroom for pale maintained turf');
});

test('post graph replacement disposes prior full-resolution targets and waits for weather', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.match(source, /this\._scenePass\?\.dispose\(\)/);
  assert.match(source, /this\._traa\?\.dispose\(\)/);
  assert.match(source, /this\._cloudTemporal\?\.dispose\(\)/);
  assert.doesNotMatch(source, /_skyPass|skyScene/,
    'fused cloud history must not retain the removed current-sky pass or scene');
  assert.match(source, /this\.postProcessing\?\.dispose\(\)/);
  assert.doesNotMatch(source, /this\.environmentTier = tier;[\s\S]*?this\._setupPost\(\);/);
});

test('TRAA keeps stationary sky history stable across deterministic jitter', async () => {
  const source = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(source, /const staticSkyCoverage = centerIsSky\.and\( effectivelyStatic \)/);
  assert.match(source, /isDepthEdge\.or\( staticSkyCoverage \)/);
  assert.match(source, /cameraJitterEnabled = true/);
  assert.match(source, /if \( this\.cameraJitterEnabled === false \) return/);
  assert.match(source, /if \( this\._jitterAppliedThisFrame \)/);
});

test('TRAA avoids duplicate neighborhood reads for accepted static history', async () => {
  const source = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(source, /const needsVarianceClip = hasValidHistory\.and\(/);
  assert.match(source, /If\( needsVarianceClip, \(\) =>/);
  assert.match(source, /clippedHistoryColor\.assign\( varianceClipping/);
});

test('TRAA ping-pongs full-resolution history instead of copying resolve every frame', async () => {
  const source = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(source, /this\._resolveRenderTarget = new RenderTarget\( 1, 1, \{ depthBuffer: false, type: HalfFloatType, depthTexture: new DepthTexture\(\) \} \)/);
  assert.match(source, /const previousHistory = this\._historyRenderTarget;/);
  assert.match(source, /this\._historyRenderTarget = this\._resolveRenderTarget;/);
  assert.match(source, /this\._textureNode\.value = this\._historyRenderTarget\.texture;/);
  assert.doesNotMatch(source, /copyTextureToTexture\( this\._resolveRenderTarget\.texture, this\._historyRenderTarget\.texture \)/);
});

test('camera motion disables projection jitter without changing the viewport', () => {
  const camera = new PerspectiveCamera();
  camera.updateMatrixWorld();
  const manager = Object.create(SceneManager.prototype);
  manager.camera = camera;
  manager.motionHistory = {
    currentProjection: { value: new Matrix4() },
    currentView: { value: new Matrix4() },
    previousProjection: { value: new Matrix4() },
    previousView: { value: new Matrix4() },
    valid: false,
  };
  manager._cameraCutState = {
    position: new Vector3(), quaternion: new Quaternion(), projection: new Matrix4(), valid: false,
  };
  manager._cameraStillFrames = 0;
  manager.invalidateTemporalHistory = () => {};

  manager._beginMotionFrame();
  assert.equal(manager._cameraMoving, false);
  camera.position.x = 0.001;
  manager._beginMotionFrame();
  assert.equal(manager._cameraMoving, true);
  manager._beginMotionFrame();
  assert.equal(manager._cameraMoving, false);
});

test('viewport application is idempotent and does not let canvas CSS feedback retrigger resize', () => {
  const manager = Object.create(SceneManager.prototype);
  manager._viewportState = { width: 1280, height: 720, pixelRatio: 2 };
  manager._viewportRevision = 4;
  manager.camera = { aspect: 1280 / 720, updateProjectionMatrix() {} };
  const calls = [];
  manager.renderer = {
    setPixelRatio(value) { calls.push(['dpr', value]); },
    setSize(width, height, updateStyle) { calls.push(['size', width, height, updateStyle]); },
  };
  let invalidations = 0;
  manager.invalidateTemporalHistory = () => { invalidations++; };

  assert.equal(manager._applyViewport({ width: 1280, height: 720, pixelRatio: 2 }), false);
  assert.equal(manager._applyViewport({ width: 1280, height: 720, pixelRatio: 2 }), false);
  assert.equal(calls.length, 0);
  assert.equal(manager._applyViewport({ width: 1279, height: 720, pixelRatio: 2 }), true);
  assert.deepEqual(calls, [['dpr', 2], ['size', 1279, 720, false]]);
  assert.equal(invalidations, 1);
  // A canvas.clientWidth mismatch is intentionally irrelevant: only the cached
  // browser viewport tuple controls whether a resize is applied.
  assert.equal(manager._viewportState.width, 1279);
  assert.equal(manager._viewportRevision, 5);
});

test('viewport diagnostics expose every full-screen render surface and camera view rectangle', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 1280, innerHeight: 720 };
  test.after(() => { globalThis.window = previousWindow; });
  const manager = Object.create(SceneManager.prototype);
  manager._viewportState = { width: 1280, height: 720, pixelRatio: 1 };
  manager._viewportRevision = 2;
  manager.renderer = {
    domElement: {
      clientWidth: 1280, clientHeight: 720, width: 1280, height: 720,
      style: { width: '', height: '' },
    },
  };
  manager.camera = {
    view: {
      enabled: true, fullWidth: 1280, fullHeight: 720,
      offsetX: 0.25, offsetY: -0.125, width: 1280, height: 720,
    },
  };
  manager._scenePass = { renderTarget: { width: 1280, height: 720, texture: { width: 1280, height: 720 } } };
  manager._traa = {
    _historyRenderTarget: { width: 1280, height: 720 },
    _resolveRenderTarget: { width: 1280, height: 720 },
  };
  manager._bloomPass = null;

  const diagnostics = manager.readViewportDiagnostics();
  assert.deepEqual(diagnostics.internalTargets, {
    scene: [1280, 720],
    sceneColor: [1280, 720],
    temporalHistory: [1280, 720],
    temporalResolve: [1280, 720],
    bloom: null,
  });
  assert.deepEqual(diagnostics.cameraView, {
    enabled: true, fullWidth: 1280, fullHeight: 720,
    offsetX: 0.25, offsetY: -0.125, width: 1280, height: 720,
  });
});
