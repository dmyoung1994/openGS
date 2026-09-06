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

test('maintained turf derivatives pin separate Grass005 fairway and Blendkit green materials', async () => {
  const files = [
    ['blendkit_fairway_alb.png', '129d315bbc22e6ff05a6fb5a3c54474ec9845b86afbdf615a4e8a21f996cdc76'],
    ['blendkit_fairway_nrh.png', '300200a8f864dd383ba05dc8688e97196081419d06005362dd45b7a334932970'],
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
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_fairway_alb.png'), 3) - 0.701571) < 0.001,
    'fairway alpha must retain Grass005 source roughness');
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_fairway_nrh.png'), 2) - 0.258480) < 0.001,
    'fairway NRH blue must retain Grass005 source displacement');
  assert.ok(Math.abs(channelMean(decoded.get('blendkit_fairway_nrh.png'), 3) - 0.609951) < 0.001,
    'fairway NRH alpha must retain Grass005 source AO');
  assert.ok(channelStdDev(decoded.get('blendkit_fairway_nrh.png'), 0) > 0.08,
    'fairway normal must retain authored blade-scale directional relief');
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
    /set\('blendkit_fairway', 1\.2,\s*\[0\.25848001, 0\.60995079, 0\.70157140\], 0\.20198728, true, 2048,\s*[\s\S]*?\[0\.08400000, 0\.16600000, 0\.03400000\], 0\.00, 0\.78\)/,
    'runtime must retain the calibrated fairway scale, measured means, and crisp filtered albedo response');
  assert.match(source,
    /set\('blendkit_green', 1\.5,\s*\[0\.61920959, 1\.0, 0\.99607843\], 0\.11012081, true, 2048,\s*[\s\S]*?\[0\.07500000, 0\.20000000, 0\.04500000\], 0\.15, 0\.60\)/,
    'runtime must retain the green physical scale, measured means, and readable compact albedo response');
  assert.match(source, /readTier\(maps\.green\)/, 'green must use its own normal/height tier');
  assert.match(source, /alb: 'vec4'/, 'existing albedo sample must carry packed roughness');
  assert.equal(source.match(/texture\(turfAlbedoArrayNode, uvP\)/g)?.length, 1,
    'packing roughness must not introduce a second albedo lookup');
  assert.match(source, /const scannedRoughness = tAlb\.a\.mul\(0\.30\)\.add\(0\.61\)/,
    'measured source roughness must drive a bounded matte-turf response');
  assert.match(source, /const unresolved = smoothstep\(5\.5, 8\.0, filteredLod\)/,
    'finite source motifs must resolve by the anisotropically filtered footprint before they repeat');
  assert.match(source, /texture\(turfAlbedoArrayNode, uvP\)\.depth\(int\(set\.layer\)\)\s*\.grad\(uvDx\.mul\(albedoGradientScale\), uvDy\.mul\(albedoGradientScale\)\)/,
    'albedo must preserve anisotropic screen gradients and its independent mip bias');
  assert.match(source, /turfParallaxUV\(\s*turfNrhArrayNode, int\(set\.layer\)/,
    'parallax must use the same array layer instead of retaining hidden per-surface samplers');
  assert.match(source, /mix\(pigmentMean, normalizedAlbedo, set\.albedoContrast\)/,
    'source colour noise must remain bounded around the physical turf pigment');
});

test('Grass005 fairway and Blendkit green provenance are explicit and reproducible', async () => {
  const provenance = await readFile(new URL('docs/blendkit-turf-provenance.md', ROOT), 'utf8');
  const fairwayProvenance = await readFile(
    new URL('docs/ambientcg-grass005-fairway-provenance.md', ROOT), 'utf8',
  );
  const packer = await readFile(new URL('scripts/pack_blendkit_turf.py', ROOT), 'utf8');
  const fairwayPacker = await readFile(
    new URL('scripts/pack_ambientcg_grass005.py', ROOT), 'utf8',
  );
  assert.match(provenance, /Procedural Grass/);
  assert.match(provenance, /Golf Bentgrass/);
  assert.match(provenance, /Royalty Free/);
  assert.match(provenance, /4049fc373328129c366e1eaca82093dd7384c3d6a2030ff39f1e336c7d86f85a/);
  assert.match(provenance, /945866ca523dae46b6dfe1db9ad5611848eb55e9c0ba47f15081d4b741765edb/);
  assert.match(fairwayProvenance, /Grass 005/);
  assert.match(fairwayProvenance, /Creative Commons CC0 1\.0 Universal/);
  assert.match(fairwayProvenance, /1\.20 m × 1\.20 m/);
  assert.match(fairwayProvenance, /22ebad413aad388fd09e109cd2ecb4f8193b2af12908b8c3ba90f87438ec83e4/);
  assert.match(fairwayPacker, /EXPECTED_SHA256/);
  assert.match(fairwayPacker, /source OpenGL normal XY/);
  assert.match(packer, /RGB = sRGB base color/);
  assert.match(packer, /AO channel defaults to white/);
  assert.match(packer, /normal_from_height_if_flat/);
});
