import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const EXPECTED_SHA256 = 'f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170';

test('NASA LRO lunar albedo is pinned with runtime and provenance contracts', async () => {
  const [asset, source, provenance] = await Promise.all([
    readFile(new URL('public/assets/textures/moon_lroc_color_2k.jpg', ROOT)),
    readFile(new URL('src/environment/EnvironmentGpuBindings.js', ROOT), 'utf8'),
    readFile(new URL('docs/nasa-moon-texture-provenance.md', ROOT), 'utf8'),
  ]);
  assert.equal(createHash('sha256').update(asset).digest('hex'), EXPECTED_SHA256);
  assert.match(source, /moon_lroc_color_2k\.jpg/);
  assert.match(source, /const lunarAlbedo = texture\(this\.moonAlbedoMap, moonUv\)\.rgb/);
  assert.match(source, /moonSurfaceNormal\.dot\(this\.sunDirection\.normalize\(\)\)/,
    'lunar phase must come from real spherical solar incidence');
  assert.match(provenance, /NASA Scientific Visualization Studio/);
  assert.match(provenance, /Lunar Reconnaissance Orbiter Camera/);
  assert.match(provenance, new RegExp(EXPECTED_SHA256));
});
