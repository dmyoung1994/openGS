import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = () => readFile(new URL('../src/terrain/Grass.js', import.meta.url), 'utf8');
const scalar = (text, name) => {
  const match = text.match(new RegExp(`const ${name} = ([\\d._]+)`));
  assert.ok(match, `missing ${name}`);
  return Number(match[1].replaceAll('_', ''));
};

test('grass tile horizon rejects only candidates that cannot survive compaction', async () => {
  const grass = await source();
  const near = scalar(grass, 'DENSITY_NEAR_RADIUS');
  const far = scalar(grass, 'DENSITY_FAR_RADIUS');
  const power = scalar(grass, 'DENSITY_CURVE_POWER');
  const feather = scalar(grass, 'DENSITY_FEATHER');
  const active = scalar(grass, 'DENSITY_ACTIVE_RADIUS');
  const positiveProgress = 1 - Math.pow(feather / (1.08 + feather), 1 / power);
  const positiveRadius = near + (far - near) * positiveProgress;

  assert.ok(active > positiveRadius, 'tile horizon must include the full positive keep curve');
  assert.match(grass, /radius\.mul\( DENSITY_ACTIVE_RADIUS \)\.add\( TILE_CIRCUMRADIUS \)/);
  assert.doesNotMatch(grass, /radius\.add\( TILE_SIZE \* 1\.55 \)/);
});

test('grass tile horizon removes at least 20 percent of the old high-tier candidate ring', async () => {
  const grass = await source();
  const active = scalar(grass, 'DENSITY_ACTIVE_RADIUS');
  const tileSize = scalar(grass, 'TILE_SIZE');
  const grid = scalar(grass, 'GRID');
  const radius = 46;
  const oldHorizon = radius + tileSize * 1.55;
  const tileCircumradius = Math.SQRT2 * tileSize * 0.5 + tileSize / grid;
  const newHorizon = radius * active + tileCircumradius;
  const reduction = 1 - (newHorizon / oldHorizon) ** 2;

  assert.ok(reduction >= 0.20, `candidate area reduction was ${(reduction * 100).toFixed(1)}%`);
});

test('grass ribbon view transform is vertex-hoisted without changing fragment normals', async () => {
  const grass = await source();
  assert.match(grass,
    /const bladeNormalView = transformNormalToView\( vec3\([\s\S]*?\) \)\.toVarying\( 'vGrassViewNormal' \)/,
    'the linear normal-matrix multiply must run before the varying');
  assert.match(grass, /mat\.normalNode = bladeNormalView\.normalize\(\)/,
    'interpolated view normals still require one fragment normalization');
  assert.doesNotMatch(grass, /transformNormalToView\( bladeNormalView/,
    'the dense fragment path must not re-run the view transform');
});

test('grass Phong path retains shared daylight and canonical crossed-ribbon UVs', async () => {
  const grass = await source();
  assert.match(grass, /class SharedEnvironmentGrassPhongMaterial extends MeshPhongNodeMaterial/);
  assert.match(grass, /builder\.environmentNode \? new BasicEnvironmentNode\( builder\.environmentNode \) : null/,
    'Phong fallback must consume the renderer shared environment');
  assert.match(grass, /shininess: 4\.0/);
  assert.match(grass, /mat\.specularNode = vec3\( this\.uSpecular\.mul\( 0\.04 \) \)/);
  assert.match(grass, /mat\.mrtNode = mrt\( \{ velocity: vec3\( velocityNode, 1\.0 \) \} \)/);

  assert.match(grass, /const uv = \[\]/);
  assert.match(grass, /uv\.push\( 0, y, 1, y, 0, y, 1, y \)/,
    'u must derive from ribbon side and v from the existing authored row on both planes');
  assert.match(grass,
    /geo\.setAttribute\( 'uv', new BufferAttribute\( new Float32Array\( uv \), 2 \) \)/);
  assert.match(grass, /const BLADE_SEGMENTS = 3/,
    'the UV addition must not change the accepted longitudinal geometry');
  assert.match(grass, /pos\.push\( -0\.5, y, 0, 0\.5, y, 0, -0\.5, y, 1, 0\.5, y, 1 \)/,
    'the accepted crossed-ribbon positions must remain exact');
});
