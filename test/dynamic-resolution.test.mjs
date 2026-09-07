import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  calculateOutputPixelRatio,
  normalizeRenderResolution,
  SceneManager,
} from '../src/scene/SceneManager.js';
import TRAANode from '../src/scene/GolfTRAANode.js';
import { ResettableTRAANode } from '../src/scene/ResettableTRAANode.js';

test('output pixel caps preserve the existing uncapped ratio and solve capped pixels', () => {
  assert.equal(calculateOutputPixelRatio({
    width: 1920, height: 1080, devicePixelRatio: 2, tierPixelRatioCap: 2,
  }), 2);
  const ratio = calculateOutputPixelRatio({
    width: 1920, height: 1080, devicePixelRatio: 2, tierPixelRatioCap: 2,
    outputPixelCap: 1920 * 1080,
  });
  assert.ok(Math.abs(ratio - 1) < 1e-12);
  assert.ok(Math.floor(1920 * ratio) * Math.floor(1080 * ratio) <= 1920 * 1080);
});

test('render resolution policy rejects unsupported super-resolution requests', () => {
  assert.deepEqual(normalizeRenderResolution({
    outputPixelCap: 2_300_000, internalRenderScale: 0.75,
  }), { outputPixelCap: 2_300_000, internalRenderScale: 0.75 });
  assert.throws(() => normalizeRenderResolution({ internalRenderScale: 1.01 }), /between/);
  assert.throws(() => normalizeRenderResolution({ internalRenderScale: 0.49 }), /between/);
  assert.throws(() => normalizeRenderResolution({ outputPixelCap: 0 }), /positive/);
});

test('runtime resolution changes resize the existing MRT source and invalidate both histories', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 1000, innerHeight: 500, devicePixelRatio: 2 };
  try {
    const manager = Object.create(SceneManager.prototype);
    manager._renderResolution = { outputPixelCap: null, internalRenderScale: 1, revision: 0 };
    manager._viewportState = { width: 1000, height: 500, pixelRatio: 2 };
    manager._viewportRevision = 1;
    manager._drawingBufferSize = null;
    manager.camera = { aspect: 2, updateProjectionMatrix() {} };
    const canvas = { width: 2000, height: 1000 };
    const renderer = {
      domElement: canvas,
      setPixelRatio(value) { this.pixelRatio = value; },
      setSize(width, height) {
        canvas.width = Math.floor(width * this.pixelRatio);
        canvas.height = Math.floor(height * this.pixelRatio);
      },
      getDrawingBufferSize(target) {
        target.set(canvas.width, canvas.height);
        return target;
      },
    };
    renderer.pixelRatio = 2;
    manager.renderer = renderer;
    manager._scenePass = {
      _resolutionScale: 1,
      renderTarget: { width: 2000, height: 1000 },
      setSize(width, height) {
        this.renderTarget.width = Math.floor(width * this._resolutionScale);
        this.renderTarget.height = Math.floor(height * this._resolutionScale);
      },
    };
    manager._traa = { readDiagnostics: () => ({ history: 'test' }) };
    const cloudScales = [];
    manager.weatherSky = { workload: { internalScale: 0.25 } };
    manager._cloudTemporal = {
      readDiagnostics: () => ({ history: 'test' }),
      setResolutionScale(value) { cloudScales.push(value); return true; },
    };
    const invalidations = [];
    manager.invalidateTemporalHistory = (reason) => invalidations.push(reason);

    const diagnostics = manager.setRenderResolution({
      outputPixelCap: 1_000_000,
      internalRenderScale: 0.75,
    });
    assert.equal(manager._scenePass._resolutionScale, 0.75);
    assert.equal(diagnostics.outputPixelCap, 1_000_000);
    assert.ok(diagnostics.output.pixels <= 1_000_000);
    assert.equal(diagnostics.internal.width, Math.floor(diagnostics.output.width * 0.75));
    assert.equal(diagnostics.internal.height, Math.floor(diagnostics.output.height * 0.75));
    assert.equal(diagnostics.temporalUpscale.enabled, false);
    assert.match(diagnostics.temporalUpscale.reason, /source-resolution/);
    assert.equal(cloudScales[0], 0.1875);
    assert.equal(invalidations.length, 1);

    manager.setRenderResolution({ outputPixelCap: null, internalRenderScale: 1 });
    assert.equal(manager._scenePass.renderTarget.width, canvas.width);
    assert.equal(manager._scenePass.renderTarget.height, canvas.height);
    assert.equal(cloudScales[1], 0.25);
    assert.equal(invalidations.length, 2);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('scaled TRAA copies source-sized depth when base TRAA skips drawing-buffer copy', () => {
  const originalUpdateBefore = TRAANode.prototype.updateBefore;
  TRAANode.prototype.updateBefore = function updateBeforeStub() { return 'base-result'; };
  try {
    const currentDepth = { name: 'current-depth' };
    const previousDepth = { name: 'previous-depth' };
    const node = Object.create(ResettableTRAANode.prototype);
    node.beautyNode = {
      isRTTNode: false,
      passNode: { renderTarget: { texture: { width: 640, height: 360 } } },
    };
    node.depthNode = { value: currentDepth };
    node._historyRenderTarget = { width: 640, height: 360 };
    node._previousDepthTexture = previousDepth;
    node._manualDepthHistoryCopies = 0;
    const copies = [];
    const renderer = {
      getDrawingBufferSize(target) {
        target.set(1280, 720);
        return target;
      },
      copyTextureToTexture(source, destination) { copies.push([source, destination]); },
    };

    assert.equal(node.updateBefore({ renderer }), 'base-result');
    assert.deepEqual(copies, [[currentDepth, previousDepth]]);
    assert.equal(node._manualDepthHistoryCopies, 1);
  } finally {
    TRAANode.prototype.updateBefore = originalUpdateBefore;
  }
});

test('dynamic-resolution interfaces and r185 source-scale hook remain explicit', async () => {
  const sceneSource = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  const traaSource = await readFile(new URL('../src/scene/ResettableTRAANode.js', import.meta.url), 'utf8');
  assert.match(sceneSource, /setRenderResolution\(options = \{\}\)/);
  assert.match(sceneSource, /setOutputPixelCap\(outputPixelCap\)/);
  assert.match(sceneSource, /setInternalRenderScale\(internalRenderScale\)/);
  assert.match(sceneSource, /get renderingPaused\(\) \{ return this\._renderingPaused; \}/,
    'presentation pacing must distinguish paused diagnostic stepping from frozen simulation');
  assert.match(sceneSource, /scenePass\._resolutionScale/);
  assert.match(sceneSource, /temporalUpscale: state\.internalRenderScale < 1 \? \{/);
  assert.match(sceneSource, /mode: 'native-resolution-temporal-resolve'/);
  assert.match(traaSource, /needsInternalDepthCopy/);
  assert.match(traaSource, /renderer\.copyTextureToTexture\(this\.depthNode\.value/);
});
