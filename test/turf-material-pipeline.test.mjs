import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const ROOT = new URL('../', import.meta.url);
const rootPath = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

test('maintained-turf derivatives preserve the pinned Blendkit runtime contract', async () => {
  const { stdout } = await run('python3', [
    'scripts/validate_turf_pipeline.py', '--root', rootPath, '--json',
  ], { cwd: rootPath });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(Object.keys(result.maps).length, 4);
  for (const map of Object.values(result.maps)) {
    assert.deepEqual(
      [map.width, map.height, map.bitDepth, map.colorType],
      [2048, 2048, 8, 6],
    );
  }
});

test('terrain uses filtered multi-frequency detail and bounded close-up relief', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /textureOut\.generateMipmaps\s*=\s*true/,
    'the generated macro field must have a distance-filtered mip chain');
  assert.match(source, /textureOut\.mipmapsAutoUpdate\s*=\s*true/,
    'the mip chain must be refreshed after the one-time compute write');
  assert.match(source, /TURF_POM_MAX_TRAVEL_TEXELS\s*=\s*2\.5/,
    'view relief must have a declared physical texel travel cap');
  assert.match(source, /TURF_SHADOW_MAX_TRAVEL_TEXELS\s*=\s*2\.0/,
    'sun self-shadow must have a shorter declared physical travel cap');
  assert.match(source, /pomViewWeight\s*=\s*smoothstep\(TURF_POM_MIN_VIEW_UP, TURF_POM_FULL_VIEW_UP, V\.y\)/,
    'grazing POM must fall back to filtered material response');
  assert.match(source, /normalVariance\s*=\s*normalDx\.dot\(normalDx\)/,
    'normal variance must be estimated from the final lit normal');
  assert.match(source, /filteredSurfaceRoughness\s*=\s*surfaceRoughness\.add\(normalVarianceRoughness\)/,
    'normal variance must broaden matte roughness before lighting');
  assert.match(source, /const specularAA\s*=\s*oneMinus\(normalVarianceWeight\.mul\(TURF_NORMAL_VARIANCE_SPECULAR\)\)/,
    'normal variance must reduce the unresolved highlight peak');
  assert.match(source, /blendkit_fairway[\s\S]*?0\.00, 0\.78/,
    'fairway albedo must preserve the resolved Grass005 fine-blade structure without returning raw speckle');
  assert.match(source, /blendkit_green[\s\S]*?0\.15, 0\.60/,
    'green albedo must preserve its dedicated compact bentgrass source at review distance');
  assert.match(source, /const canopyHeightGradient\s*=\s*vec3\(dFdx\(tFar\.x\), 0\.0, dFdy\(tFar\.x\)\)/,
    'maintained turf must derive broad grazing relief from the authored packed height channel');
  assert.match(source, /const canopyHeightBump\s*=\s*canopyHeightGradient[\s\S]*?mul\(visualMaintained\)/,
    'height-derived relief must remain limited to maintained turf and never become geometry');
  assert.match(source, /const reliefAmplitude\s*=\s*reliefScale\.mul\(0\.94\)/,
    'authored maintained normals need a stronger but bounded grazing response');

  const start = source.indexOf('const fibreBand');
  const end = source.indexOf('const maintainedNormal', start);
  assert.ok(start >= 0 && end > start, 'filtered maintained normal section must remain explicit');
  const executable = source.slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(executable, /mx_noise_float/,
    'maintained close-up normal relief must not reintroduce full-screen fragment noise');
  assert.match(executable, /macroVariation\.(r|a|b)/,
    'the maintained normal hierarchy must use the persistent macro channels');
});

test('the offline packer keeps source-derived relief filtered and channel-registered', async () => {
  const source = await readFile(new URL('scripts/pack_blendkit_turf.py', ROOT), 'utf8');
  assert.match(source, /GaussianBlur\(radius=1\.25\)/,
    'flat source normals must derive from a deterministic prefiltered height signal');
  assert.match(source, /RGB = sRGB base color, A = linear roughness/,
    'runtime albedo/roughness channel ownership must remain explicit');
  assert.match(source, /RG = OpenGL normal XY, B = normalized height, A = canopy AO/,
    'runtime relief channel ownership must remain explicit');
  assert.match(source, /Image\.merge\("RGBA", \(\*base\.split\(\), rough\)\)/,
    'the packer must register roughness with its source albedo without changing source assets');
});
