import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isGrassCandidateSurface, normalizeGrassWorkloadPolicy } from '../src/terrain/Grass.js';

const ROOT = new URL('../', import.meta.url);
const readGrass = () => readFile(new URL('src/terrain/Grass.js', ROOT), 'utf8');

test('rough workload policy is optional, bounded, and does not alter the fixed buffer contract', () => {
  assert.deepEqual(normalizeGrassWorkloadPolicy(), {
    densityScale: 1,
    radiusScale: 1,
    farTierScale: 1,
  });

  const input = { densityScale: 2, radiusScale: 0.1, farTierScale: -1 };
  const policy = normalizeGrassWorkloadPolicy(input);
  assert.deepEqual(policy, {
    densityScale: 1,
    radiusScale: 0.55,
    farTierScale: 0,
  });
  assert.deepEqual(input, { densityScale: 2, radiusScale: 0.1, farTierScale: -1 });
  assert.equal(Object.isFrozen(policy), true);
});

test('rough geometry is materially refined without entering maintained turf', async () => {
  const source = await readGrass();

  assert.match(source, /const BLADE_H = \{ rough: 0\.20, deepRough: 0\.32 \}/);
  assert.doesNotMatch(source, /BLADE_H\s*=\s*\{[^}]*\b(?:fairway|green|tee|fringe)\b/);
  assert.match(source, /if \( isGrassCandidateSurface\( name \) \) data\[ i \] \|= GRASS_GROWABLE_BIT/);
  assert.deepEqual(
    ['deepRough', 'rough', 'fairway', 'fringe', 'green', 'tee'].map(isGrassCandidateSurface),
    [true, true, true, true, true, true],
    'all turf classes must reach the filtered SDF so the blade boundary cannot inherit the CPU grid',
  );
  assert.deepEqual(['sand', 'water', 'unknown'].map(isGrassCandidateSurface), [false, false, false]);
  assert.match(source, /const clearForFairway = smoothstep\( -2\.0, 2\.0, edgeSD \)/,
    'blade height must use the same smooth maintained\/native shoulder as the terrain material');

  assert.match(source, /const ROOT_BURY_FRACTION = 0\.10/);
  assert.match(source, /const rootBurial = visibleHeight\.mul\( ROOT_BURY_FRACTION \)/);
  assert.match(source, /const rootedBaseY = anchor\.y\.sub\( rootBurial \)/);
  assert.match(source, /const densityBlend = smoothstep\( 0\.10, 0\.90, ecological \)/);
  assert.match(source, /const edgeCompensation = mix\( float\( 1 \), float\( EDGE_WIDTH_COMPENSATION \)/);
  assert.match(source, /const leafCoverage = float\( 1 \)\.sub\( smoothstep\( leafHalfWidth, 1\.0, bladeEdge \) \)/);
  assert.match(source, /mat\.opacityNode = farGeometry\.select\( float\( 1 \), leafCoverage \)/,
    'far real geometry must not add an interior alpha edge to its tapered silhouette');
  assert.match(source, /mat\.alphaTestNode = 0\.30/);
  assert.match(source, /biomeLand\.r\.add\( biomeLand\.g\.mul\( 0\.28 \) \)/,
    'coastal strand grass must become sparse before the dune substrate');
  assert.doesNotMatch(source, /biomeLand\.b\.mul\( 0\.55 \)/,
    'dune weight must not keep the old dense green blade carpet alive');
  assert.match(source, /const densityTarget = keepProb\.mul\( tuftDensity \)\.mul\( roughCoverage \)\s*\.mul\( vegetationWeight \)/,
    'the shared habitat weight must taper both blade height and population');

  assert.match(source, /this\.uSpecular = uniform\( 0\.06 \)/);
  assert.match(source, /mix\( 0\.68, 0\.78, bladeLift \)/);
  assert.doesNotMatch(source, /mat\.emissiveNode\s*=/);

  assert.match(source, /radius = 30, workloadPolicy = undefined/);
  assert.match(source, /this\.uPreviousRadius = uniform/);
  assert.match(source, /previousLod\.assign\( lodAt\(\s*previousCam, previousCameraForward, previousRadius/);
  assert.match(source, /radius\.notEqual\( previousRadius \)/);
  assert.match(source, /const fade = smoothstep\( hC\.sub\( DENSITY_FEATHER \), hC\.add\( DENSITY_FEATHER \), lodKeep \)/);
  assert.match(source, /farKeepUpper[\s\S]*?\.mul\( farTierScale \)\.mul\( farSamplingScale \)[\s\S]*?baseKeepUpper\.max\( farKeepUpper \)[\s\S]*?\.mul\( densityScale \)/,
    'policy density must scale the conservative tile maximum exactly once');
  assert.match(source, /tile\.mul\( uint\( CANDIDATES_PER_TILE \) \)\.add\( localCandidate \)/);
  assert.match(source, /const GRASS_TRIANGLE_BUDGET = 9_961_472/);
  assert.match(source, /const MAX_VISIBLE_BLADE_RECORDS = 1_441_792/);
  assert.match(source, /geo\.instanceCount = MAX_VISIBLE_BLADE_RECORDS/);
  assert.match(source, /geo\.setIndirect\( this\._drawArgsAttr, \[ 0, 20, 40 \] \)/,
    'one grass renderer must issue its three triangle LOD commands');
  assert.match(source, /this\.mesh\.userData\.planarReflectionDetail = 'terrain-substrate'/,
    'the source-camera indirect blade list must not be submitted to the mirrored camera');
});
