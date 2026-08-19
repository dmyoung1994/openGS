import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodePNG } from '../scripts/lib/png.mjs';

const ROOT = new URL('../', import.meta.url);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function channelMean(image, channel) {
  let sum = 0;
  for (let i = channel; i < image.pixels.length; i += image.channels) sum += image.pixels[i];
  return sum / (image.width * image.height * 255);
}

test('maintained turf derivative is the pinned two-sample Grass001 packing', async () => {
  const albedoBytes = await readFile(new URL('public/assets/textures/turfdetail_alb.png', ROOT));
  const nrhBytes = await readFile(new URL('public/assets/textures/turfdetail_nrh.png', ROOT));
  assert.equal(sha256(albedoBytes), 'c597fbd00dbb4e1c7476297f34607982314ab91ac48636b979efbc036ab73d3c');
  assert.equal(sha256(nrhBytes), 'a3fb4ceb7eb5063027fc22aa33ebcd621b96556b78d7729c5a2e1aace33d1539');

  const albedo = decodePNG(albedoBytes);
  const nrh = decodePNG(nrhBytes);
  assert.deepEqual([albedo.width, albedo.height, albedo.channels], [1024, 1024, 4]);
  assert.deepEqual([nrh.width, nrh.height, nrh.channels], [1024, 1024, 4]);
  assert.ok(Math.abs(channelMean(albedo, 3) - 0.54402) < 0.001,
    'albedo alpha must retain measured linear roughness');
  assert.ok(Math.abs(channelMean(nrh, 2) - 0.36329) < 0.001,
    'NRH blue must retain source displacement');
  assert.ok(Math.abs(channelMean(nrh, 3) - 0.81186) < 0.001,
    'NRH alpha must retain source ambient occlusion');
});

test('terrain uses the declared 1.4m source scale without another material sample', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source,
    /set\('turfdetail', 1\.4, \[0\.36329, 0\.81186, 0\.54402\], 0\.092492, true\)/,
    'runtime must retain official physical scale and measured far means');
  assert.match(source, /alb: 'vec4'/, 'existing albedo sample must carry packed roughness');
  assert.equal(source.match(/textureLevel\(set\.alb/g)?.length, 1,
    'packing roughness must not introduce a second albedo lookup');
  assert.match(source, /const scannedRoughness = tAlb\.a\.mul\(0\.30\)\.add\(0\.61\)/,
    'measured source roughness must drive a bounded matte-turf response');
  assert.match(source, /const unresolved = smoothstep\(4\.5, 7\.0, lod\)/,
    'finite source motifs must resolve by texture footprint before they repeat at range');
});

test('Grass001 source and derivative provenance are explicit and reproducible', async () => {
  const provenance = await readFile(new URL('docs/turf-grass001-provenance.md', ROOT), 'utf8');
  const packer = await readFile(new URL('scripts/pack_ambientcg_grass001.py', ROOT), 'utf8');
  assert.match(provenance, /Creative Commons CC0 1\.0 Universal/);
  assert.match(provenance, /Physical scan size: \*\*1\.40 m × 1\.40 m\*\*/);
  assert.match(provenance, /902f447a64171c8099589642d5bf2d1d6e52c40e94d957eb78eae722084b0cfb/);
  for (const channel of ['Color', 'NormalGL', 'Displacement', 'Roughness', 'AmbientOcclusion']) {
    assert.match(packer, new RegExp(`"${channel}"`), `${channel} source hash must be pinned`);
  }
});
