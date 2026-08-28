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

function channelStdDev(image, channel) {
  const mean = channelMean(image, channel);
  let sum = 0;
  for (let i = channel; i < image.pixels.length; i += image.channels) {
    const delta = image.pixels[i] / 255 - mean;
    sum += delta * delta;
  }
  return Math.sqrt(sum / (image.width * image.height));
}

test('maintained turf derivatives pin separate fairway and green Blendkit materials', async () => {
  const files = [
    ['blendkit_fairway_alb.png', 'ecfa186e0296084e044f4143465e36c6836d81c22f9475901d5c1c347f7ec4c2'],
    ['blendkit_fairway_nrh.png', '6a5a70cb1c15e2cc3477928f42897cbdcb64e7c1c1d0d2c2f152a4dd6fca4db5'],
    ['blendkit_green_alb.png', '502dcafa3446fe49774093effd914e507905dabf6ea6088ea2c71928873af73b'],
    ['blendkit_green_nrh.png', '820a6fc5c3be0a271ac95975e42f4cf079627d2aa88017192044cd485fa96668'],
  ];
  const decoded = new Map();
  for (const [name, expected] of files) {
    const bytes = await readFile(new URL(`public/assets/textures/${name}`, ROOT));
    assert.equal(sha256(bytes), expected, `${name} must remain the pinned derivative`);
    decoded.set(name, decodePNG(bytes));
  }
  for (const image of decoded.values()) {
    assert.deepEqual([image.width, image.height, image.channels], [2048, 2048, 4]);
  }
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_fairway_alb.png'), 3) - 0.909495) < 0.001,
    'fairway alpha must retain source roughness');
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_fairway_nrh.png'), 2) - 0.441241) < 0.001,
    'fairway NRH blue must retain source height');
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_green_alb.png'), 3) - 0.996078) < 0.001,
    'green alpha must retain source roughness');
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_green_nrh.png'), 2) - 0.619210) < 0.001,
    'green NRH blue must retain source height');
  assert.ok(channelStdDev(decoded.get('blendkit_green_nrh.png'), 0) > 0.08,
    'flat bentgrass normal must gain restrained light-reactive relief from source height');
});

test('terrain uses separate physical source scales without another material sample', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source,
    /set\('blendkit_fairway', 1\.8,\s*\[0\.44124056, 1\.0, 0\.90948934\], 0\.08483945, true, 2048,\s*\[0\.08400000, 0\.16600000, 0\.03400000\], 0\.75, 0\.32\)/,
    'runtime must retain the fairway physical scale, measured means, and controlled albedo response');
  assert.match(source,
    /set\('blendkit_green', 1\.5,\s*\[0\.61920959, 1\.0, 0\.99607843\], 0\.11012081, true, 2048,\s*[\s\S]*?\[0\.07500000, 0\.20000000, 0\.04500000\], 0\.30, 0\.40\)/,
    'runtime must retain the green physical scale, measured means, and readable compact albedo response');
  assert.match(source, /readTier\(maps\.green\)/, 'green must use its own normal/height tier');
  assert.match(source, /alb: 'vec4'/, 'existing albedo sample must carry packed roughness');
  assert.equal(source.match(/textureLevel\(\s*turfAlbedoArrayNode/g)?.length, 1,
    'packing roughness must not introduce a second albedo lookup');
  assert.match(source, /const scannedRoughness = tAlb\.a\.mul\(0\.30\)\.add\(0\.61\)/,
    'measured source roughness must drive a bounded matte-turf response');
  assert.match(source, /const unresolved = smoothstep\(4\.5, 7\.0, lod\)/,
    'finite source motifs must resolve by texture footprint before they repeat at range');
  assert.match(source, /textureLevel\(\s*turfAlbedoArrayNode, uvP, lod\.add\(set\.albedoLodBias\),\s*\)\.depth\(int\(set\.layer\)\)/,
    'albedo must be prefiltered independently from full-resolution normal and height detail');
  assert.match(source, /turfParallaxUV\(\s*turfNrhArrayNode, int\(set\.layer\)/,
    'parallax must use the same array layer instead of retaining hidden per-surface samplers');
  assert.match(source, /mix\(pigmentMean, normalizedAlbedo, set\.albedoContrast\)/,
    'source colour noise must remain bounded around the physical turf pigment');
});

test('Blendkit source and derivative provenance are explicit and reproducible', async () => {
  const provenance = await readFile(new URL('docs/blendkit-turf-provenance.md', ROOT), 'utf8');
  const packer = await readFile(new URL('scripts/pack_blendkit_turf.py', ROOT), 'utf8');
  assert.match(provenance, /Procedural Grass/);
  assert.match(provenance, /Golf Bentgrass/);
  assert.match(provenance, /Royalty Free/);
  assert.match(provenance, /4049fc373328129c366e1eaca82093dd7384c3d6a2030ff39f1e336c7d86f85a/);
  assert.match(provenance, /945866ca523dae46b6dfe1db9ad5611848eb55e9c0ba47f15081d4b741765edb/);
  assert.match(packer, /RGB = sRGB base color/);
  assert.match(packer, /AO channel defaults to white/);
  assert.match(packer, /normal_from_height_if_flat/);
});
