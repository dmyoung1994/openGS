import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NoToneMapping, ColorManagement } from 'three';

test('actual MRT preparation restores native context and deferred viewport after rejection', async () => {
  const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');
  const body = source.match(/async prepareScenePass\(\) \{([\s\S]*?)\n  \}\n\n  _applyViewport/)[1];
  const prepare = new Function('NoToneMapping', 'ColorManagement', `return async function(){${body}}`)(NoToneMapping, ColorManagement);
  for (const reject of [false, true]) {
    const renderer = { target: 'old', mrt: 'old-mrt', toneMapping: 3, outputColorSpace: 'srgb',
      getRenderTarget() { return this.target; }, setRenderTarget(v) { this.target = v; },
      getMRT() { return this.mrt; }, setMRT(v) { this.mrt = v; } };
    const owner = { renderer, scene: {}, camera: {},
      _scenePass: { renderTarget: {}, getMRT: () => 'actual-mrt' },
      _syncScenePassResolution() {}, _readViewport: () => 'latest',
      _applyViewport(v) { assert.equal(this._preparingScenePass, false); assert.equal(v, 'latest'); } };
    renderer.compileAsync = async (scene, camera) => {
      assert.equal(scene, owner.scene); assert.equal(camera, owner.camera);
      assert.equal(renderer.target, owner._scenePass.renderTarget);
      assert.equal(renderer.mrt, 'actual-mrt'); assert.equal(renderer.toneMapping, NoToneMapping);
      assert.equal(renderer.outputColorSpace, ColorManagement.workingColorSpace);
      await Promise.resolve(); if (reject) throw new Error('native compilation failed');
    };
    if (reject) await assert.rejects(prepare.call(owner), /native compilation failed/);
    else await prepare.call(owner);
    assert.equal(renderer.target, 'old'); assert.equal(renderer.mrt, 'old-mrt');
    assert.equal(renderer.toneMapping, 3); assert.equal(renderer.outputColorSpace, 'srgb');
  }
});
