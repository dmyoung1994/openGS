import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { SceneManager } from '../src/scene/SceneManager.js';
import TRAANode from '../src/scene/GolfTRAANode.js';

test('sun shafts remain restrained and vanish without sunlight', () => {
  const manager = Object.create(SceneManager.prototype);
  manager._sunShafts = { density: { value: 0 } };
  manager._environmentBindings = {
    sunIlluminanceScale: { value: 1 },
    sunDirection: { value: new Vector3(0, 1, 0) },
    atmosphere: { value: new Vector3(2, 0, 0) },
  };
  manager._updateSunShaftDensity();
  const noon = manager._sunShafts.density.value;
  manager._environmentBindings.sunDirection.value.y = 0.1;
  manager._updateSunShaftDensity();
  assert.ok(manager._sunShafts.density.value > noon);
  assert.ok(manager._sunShafts.density.value < 0.12);
  manager._environmentBindings.sunIlluminanceScale.value = 0;
  manager._updateSunShaftDensity();
  assert.equal(manager._sunShafts.density.value, 0);
});

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

test('post stack blooms only the final resolved scene and cloud composite', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.match(source, /const rgb = cloudTransport[\s\S]*resolvedScene\.mul\(cloudTransport\.a\)/,
    'cloud transport must resolve before bloom');
  assert.match(source, /golfBloom\(aa\.getTextureNode\(\), 0\.10, 1\.0, 0\.125\)/,
    'the existing resolved HDR texture gets one bounded eighth-resolution highlight pass');
  assert.match(source, /bloomRgb\.mul\(cloudTransport\.a\)/,
    'cloud transmittance must attenuate glare without a full-resolution composite copy');
  assert.match(source, /const displayRgb = renderOutput\([\s\S]*gradedRgb/,
    'tone mapping and spatial AA must remain downstream of linear HDR bloom');
});

test('analytic environment fill remains subordinate to the shared celestial key', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /const indirectStrength = Math\.max\(/);
  // The invariant this guards is that the sky PMREM is scaled by a FIXED unit
  // conversion, never by the celestial envelope a second time. The literal value
  // moved from 0.34 to unity once qa-sky-irradiance proved the atlas already
  // carries true scene radiance, so pin the named constant rather than a number
  // that only ever encoded the old calibration.
  assert.match(source, /scene\.environmentIntensity = SKY_IRRADIANCE_INTENSITY;/,
    'sky irradiance must come from the shared fixed constant, not an inline literal');
  assert.match(source, /const SKY_IRRADIANCE_INTENSITY = 1\.0;/,
    'the PMREM reproduces the analytic sky radiance, so its diffuse multiplier is unity');
  assert.doesNotMatch(source, /environmentIntensity\s*=[^;\n]*(sunIlluminanceScale|daylightSkyEnvelope|keyIntensity|solarStrength)/,
    'PMREM already contains the celestial envelope; scaling it by direct sunlight double-attenuates it');
  assert.match(source, /environment\.atmosphereExposure\.value \* 1\.20/,
    'Neutral calibration must retain midtone value while preserving daylight chromaticity');
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
  assert.match(source, /const thinStaticBlend = isDepthEdge\.and\( reactiveThinGeometry \)\.and\( hasValidHistory \)/,
    'invalid or untagged cloth history must never override fresh disocclusion samples');
  assert.match(source, /centerIsSky\.and\( isDepthEdge\.not\(\) \)\.or\( effectivelyStatic\.not\(\) \)/,
    'empty sky must clip stale moving-object colour even though its own velocity is zero');
  assert.match(source, /cameraJitterEnabled = true/);
  assert.match(source, /this\._historyAge\.value < _haltonOffsets\.length/,
    'a completed static sample cycle must stop shifting the distant horizon');
  assert.match(source, /if \( this\._jitterAppliedThisFrame === false \) return/);
  assert.match(source, /if \( this\._jitterAppliedThisFrame \)/);
});

test('stationary cloudy scenes retain projection jitter for hard tree silhouettes', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  assert.match(source, /aa\.cameraJitterEnabled = true/,
    'cloud transport must not disable geometry sample accumulation at setup');
  assert.match(source, /this\._traa\.cameraJitterEnabled = true/,
    'moving and stationary views both require fractional pixel coverage');
  assert.doesNotMatch(source, /cameraJitterEnabled = this\.weatherSky\?\.cloudsEnabled/,
    'cloud coverage may not force hard one-sample tree edges');
});

test('TRAA avoids duplicate neighborhood reads for accepted static history', async () => {
  const source = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(source, /const needsVarianceClip = hasValidHistory\.and\(/);
  assert.match(source, /If\( needsVarianceClip, \(\) =>/);
  assert.match(source, /clippedHistoryColor\.assign\( varianceClipping/);
});

test('TRAA ping-pongs full-resolution history instead of copying resolve every frame', async () => {
  const source = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(source, /this\._resolveRenderTarget = new RenderTarget\( 1, 1, \{ depthBuffer: false, type: HalfFloatType \} \)/);
  assert.match(source, /const previousHistory = this\._historyRenderTarget;/);
  assert.match(source, /this\._historyRenderTarget = this\._resolveRenderTarget;/);
  assert.match(source, /this\._textureNode\.value = this\._historyRenderTarget\.texture;/);
  assert.doesNotMatch(source, /copyTextureToTexture\( this\._resolveRenderTarget\.texture, this\._historyRenderTarget\.texture \)/);
});

test('TRAA uses one standalone previous-depth surface instead of unused ping-pong depth attachments', async () => {
  const source = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(source, /this\._historyRenderTarget = new RenderTarget\( 1, 1, \{ depthBuffer: false, type: HalfFloatType \} \)/);
  assert.match(source, /this\._resolveRenderTarget = new RenderTarget\( 1, 1, \{ depthBuffer: false, type: HalfFloatType \} \)/);
  assert.match(source, /this\._previousDepthTexture = new DepthTexture\( 1, 1 \)/);
  assert.match(source, /renderer\.copyTextureToTexture\( currentDepth, this\._previousDepthTexture \)/);
  assert.match(source, /renderer\.initTexture\( this\._previousDepthTexture \)/);
  assert.doesNotMatch(source, /this\._historyRenderTarget\.depthTexture/);
  assert.doesNotMatch(source, /this\._resolveRenderTarget\.depthTexture/);
});

test('TRAA constructor keeps the two color targets depth-free and defers depth-node binding', () => {
  const traa = new TRAANode({}, {}, {}, {});
  try {
    assert.equal(traa._historyRenderTarget.depthTexture, null);
    assert.equal(traa._resolveRenderTarget.depthTexture, null);
    assert.equal(traa._previousDepthTexture.isDepthTexture, true);
    assert.equal(traa._previousDepthNode, null);
  } finally {
    traa.dispose();
  }
});

test('TRAA and bloom remain linear without a second whole-screen antialiasing blur', async () => {
  const scene = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  const traa = await readFile(new URL('../src/scene/GolfTRAANode.js', import.meta.url), 'utf8');
  assert.match(scene, /this\.postProcessing = new RenderPipeline\(this\.renderer\)/);
  assert.match(scene, /const displayRgb = renderOutput\(/);
  assert.doesNotMatch(scene, /FXAANode/);
  assert.doesNotMatch(scene, /fxaa\(displayRgb\)/);
  assert.match(scene, /this\.postProcessing\.outputColorTransform = false/);
  assert.match(scene, /this\.postProcessing\.outputNode = displayRgb/);
  assert.match(scene, /this\.postProcessing\.render\(\)/);
  assert.match(traa, /renderer\.setRenderTarget\( this\._resolveRenderTarget \)/);
  assert.match(traa, /this\._historyTextureNode\.value = this\._historyRenderTarget\.texture/);
});

test('camera motion remains observable without changing the viewport', () => {
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
  manager._fxaaPass = null;

  const diagnostics = manager.readViewportDiagnostics();
  assert.deepEqual(diagnostics.internalTargets, {
    scene: [1280, 720],
    sceneColor: [1280, 720],
    temporalHistory: [1280, 720],
    temporalResolve: [1280, 720],
    bloom: null,
    displayAntialias: null,
  });
  assert.deepEqual(diagnostics.cameraView, {
    enabled: true, fullWidth: 1280, fullHeight: 720,
    offsetX: 0.25, offsetY: -0.125, width: 1280, height: 720,
  });
});
