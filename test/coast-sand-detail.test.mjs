import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  acquireCoastSandTextures, COAST_SAND_URLS, releaseCoastSandTextures,
} from '../src/scene/CoastSandDetail.js';

test('terrain and backdrop share one reference-counted coastal texture set', async () => {
  const first = acquireCoastSandTextures();
  const second = acquireCoastSandTextures();
  assert.strictEqual(first.textures, second.textures);
  assert.strictEqual(first.ready, second.ready);
  await first.ready;

  let albedoDisposed = 0;
  let normalDisposed = 0;
  first.textures.albedoRoughness.addEventListener('dispose', () => { albedoDisposed += 1; });
  first.textures.normal.addEventListener('dispose', () => { normalDisposed += 1; });
  assert.equal(releaseCoastSandTextures(first.textures), true);
  assert.equal(albedoDisposed, 0, 'the first owner may not dispose shared textures');
  assert.equal(releaseCoastSandTextures(second.textures), true);
  assert.equal(albedoDisposed, 1);
  assert.equal(normalDisposed, 1);

  const replacement = acquireCoastSandTextures();
  assert.notStrictEqual(replacement.textures, first.textures,
    'a fully released asset must not return disposed texture objects');
  releaseCoastSandTextures(replacement.textures);
});

test('coastal sand packs roughness in albedo alpha and retains one authored normal map', async () => {
  assert.equal(COAST_SAND_URLS.albedoRoughness,
    '/assets/materials/aerial_beach_01/aerial_beach_01_diff_rough_2k.png');
  assert.equal(COAST_SAND_URLS.normal,
    '/assets/materials/aerial_beach_01/aerial_beach_01_nor_gl_2k.jpg');
  const source = await readFile(new URL('../src/scene/CoastSandDetail.js', import.meta.url), 'utf8');
  assert.match(source, /const roughnessScan = scanA\.a\.mul\(0\.72\)\.add\(scanB\.a\.mul\(0\.28\)\)/,
    'packed alpha must be the only roughness source');
  assert.doesNotMatch(source, /roughnessTexture|sandRoughness/,
    'the shared coast path must not reintroduce a third sampler');
  assert.match(source, /wetSand\.add\(shallowShelf\)/,
    'wet mineral substrate must continue beneath the shelf until water owns coverage');
});
