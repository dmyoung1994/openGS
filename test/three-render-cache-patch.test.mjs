import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Renderer } from 'three/webgpu';
import { BackSide, FrontSide, DoubleSide } from 'three';
import { replacements, transformRenderCache } from '../scripts/patch-three-render-cache.mjs';

test('guarded native patch is reversible, idempotent, and preserves unrelated edits', () => {
  const before = replacements.map(pair => pair[0]).join('\n') + '\n// existing user changes';
  const after = transformRenderCache(before, replacements);
  assert.equal(transformRenderCache(after, replacements), after);
  assert.equal(transformRenderCache(after, replacements, true), before);
  assert.equal(transformRenderCache(before, replacements, true), before);
  assert.throws(() => transformRenderCache('wrong package source', replacements), /context mismatch/);
});

test('queued transparent passes compile their own side and restore it on failure', async () => {
  const source = await readFile(new URL('../node_modules/three/src/renderers/common/Renderer.js', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('\t\tfor ( const item of compilationPromises ) {'),
    source.indexOf('\n\t}\n\n\t/**\n\t * Renders the scene in an async fashion.'));
  const compile = new Function('compilationPromises', 'yieldToMain', `return (async () => {${loop}})();`);
  for (const failure of [null, 'nodes', 'pipeline']) {
    const material = { side: DoubleSide }, observed = [];
    const owner = {
      _compilationPromises: [], _currentRenderContext: {},
      _objects: { get: (object, material) => ({ object, material }) },
      _nodes: {
        async getForRenderAsync(object) {
          observed.push(object.material.side);
          await Promise.resolve();
          if (failure === 'nodes') throw Error('nodes');
        },
        updateBefore() {}, updateForRender() {}, updateAfter() {},
      },
      _geometries: { updateForRender() {} }, _bindings: { updateForRender() {} },
      _pipelines: { getForRender(object, promises) {
        assert.equal(object.material.side, observed.at(-1));
        if (failure === 'pipeline') promises.push(Promise.reject(Error('pipeline')));
      } },
    };
    for (const side of [BackSide, FrontSide]) {
      material.side = side;
      Renderer.prototype._createObjectPipeline.call(owner, { geometry: {} }, material, {}, {}, {}, null, {}, side === BackSide ? 'backSide' : undefined);
    }
    material.side = DoubleSide;
    const result = compile.call(owner, owner._compilationPromises, async () => {
      assert.equal(material.side, DoubleSide);
    });
    if (failure) await assert.rejects(result, new RegExp(failure));
    else { await result; assert.deepEqual(observed, [BackSide, FrontSide]); }
    assert.equal(material.side, DoubleSide);
  }
});

test('shader compatibility excludes nesting but preserves every attachment and MRT distinction', async () => {
  const source = await readFile(new URL('../node_modules/three/src/renderers/common/RenderContexts.js', import.meta.url), 'utf8');
  const patched = transformRenderCache(source, [replacements[0], replacements[2]]);
  const body = patched.match(/get\( renderTarget = null, mrt = null, callDepth = 0 \) \{([\s\S]*?)\n\t\}\n/)[1];
  let id = 0;
  const get = new Function('RenderContext', `return function(renderTarget=null,mrt=null,callDepth=0){${body}}`)(class { constructor() { this.id = ++id; } });
  const owner = { _renderContexts: {}, renderer: { getClearDepth: () => 1, getClearStencil: () => 0 } };
  const target = { texture: { format: 1, type: 2 }, textures: [{ format: 1, type: 2, colorSpace: 'linear' }], samples: 0, depthBuffer: true, stencilBuffer: false };
  const base = get.call(owner, target, { id: 1 }, 0);
  const nested = get.call(owner, target, { id: 1 }, 2);
  assert.notEqual(base, nested); assert.notEqual(base.id, nested.id);
  assert.equal(base.shaderCacheKey, nested.shaderCacheKey);
  for (const variant of [
    { ...target, samples: 4 }, { ...target, depthBuffer: false }, { ...target, stencilBuffer: true },
    { ...target, textures: [{ format: 9, type: 2, colorSpace: 'linear' }] },
    { ...target, textures: [{ format: 1, type: 9, colorSpace: 'linear' }] },
    { ...target, textures: [{ format: 1, type: 2, colorSpace: 'srgb' }] },
    { ...target, textures: [...target.textures, { format: 9, type: 4, colorSpace: 'linear' }] },
  ]) assert.notEqual(get.call(owner, variant, { id: 1 }, 0).shaderCacheKey, base.shaderCacheKey);
  assert.notEqual(get.call(owner, target, { id: 2 }, 0).shaderCacheKey, base.shaderCacheKey);
  assert.match(replacements[1][1], /renderer\.toneMapping.*renderer\.outputColorSpace/);
});
