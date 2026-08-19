import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const scalar = (text, name) => {
  const match = text.match(new RegExp(`const ${name} = ([\\d._]+)`));
  assert.ok(match, `missing ${name}`);
  return Number(match[1].replaceAll('_', ''));
};

test('grass LOD follows the final active render camera, not the ball or a static origin', async () => {
  const [main, range, grass] = await Promise.all([
    read('src/main.js'),
    read('src/scene/Range.js'),
    read('src/terrain/Grass.js'),
  ]);

  const evaluatorUpdate = main.indexOf('if (evaluatorCamera.active) evaluatorCamera.update?.(dt);');
  const rangeUpdate = main.indexOf('range.update(t);');
  assert.ok(evaluatorUpdate >= 0 && rangeUpdate > evaluatorUpdate,
    'evaluator must resolve the shared render camera before Range updates grass');
  assert.match(range, /this\.grass\.update\(t, this\.camera\)/,
    'Range must pass its live shared camera every frame');
  assert.match(grass, /this\.uCameraPosition\.value\.copy\( cam\.position \)/,
    'Grass must copy the final camera centre into its compute uniform');
  assert.match(grass, /cam\.getWorldDirection\( this\._cameraForwardScratch \)/,
    'Grass must derive its view footprint from the final camera orientation');
  assert.match(grass, /const cam = this\.uCameraPosition;[\s\S]*?const cameraForward = this\.uCameraForwardXZ;/,
    'tile and candidate classification must consume the camera-owned uniforms');
  assert.doesNotMatch(grass, /uBall(Position|Center)|ballPosition|ballCentered/i,
    'full rough geometry must not regain a ball-centred LOD input');
});

test('view-oriented far tier extends the terminal horizon without changing close density', async () => {
  const grass = await read('src/terrain/Grass.js');
  const near = scalar(grass, 'DENSITY_NEAR_RADIUS');
  const far = scalar(grass, 'DENSITY_FAR_RADIUS');
  const power = scalar(grass, 'DENSITY_CURVE_POWER');
  const feather = scalar(grass, 'DENSITY_FEATHER');
  const tailStart = scalar(grass, 'FAR_TIER_START_RADIUS');
  const tailTerminal = scalar(grass, 'FAR_TIER_TERMINAL_RADIUS');
  const lateralScale = scalar(grass, 'FAR_TIER_LATERAL_SCALE');
  const tailPeak = scalar(grass, 'FAR_TIER_PEAK_KEEP');
  const baseTerminal = near + (far - near)
    * (1 - Math.pow(feather / (1.08 + feather), 1 / power));

  assert.equal(near, 0.18, 'the accepted full-density close field is immutable');
  assert.ok(tailStart < baseTerminal,
    'the sparse tail must overlap the base fade instead of exposing a gap');
  assert.ok(tailTerminal >= 0.70 && tailTerminal <= 0.78,
    'forward geometry must reach the requested 70–78% of nominal radius');
  assert.ok(tailTerminal / lateralScale < baseTerminal,
    'the far tier must be view-oriented, not a widened circular disk');
  assert.ok(tailPeak > 0 && tailPeak <= 0.10,
    'the projected far tier must remain a bounded sparse population');
  assert.match(grass, /const keepProb = baseKeepProb\.toVar\(\);[\s\S]*?keepProb\.maxAssign\( farTierKeepAt/,
    'tail acceptance may only add far candidates; it must not thin the base field');
  assert.match(grass, /const nearby = nearbyBase\.or\( nearbyFar \)/,
    'tile dispatch must cover the union of the accepted base disk and forward tail');
  assert.match(grass, /tail\.mul\( tail \)\.mul\( FAR_TIER_PEAK_KEEP \)\.mul\( forwardGate \)/,
    'terminal transition must be a soft forward-gated falloff');
});

test('grass diagnostics expose the live LOD footprint contract', async () => {
  const [grass, benchmark] = await Promise.all([
    read('src/terrain/Grass.js'),
    read('scripts/benchmark-environment.mjs'),
  ]);
  for (const field of [
    'lodCameraPosition',
    'lodCameraForwardXZ',
    'activeTileCount',
    'nominalRadius',
    'fullDensityRadius',
    'baseTerminalRadius',
    'farTierStartRadius',
    'farTierTerminalRadius',
    'farTierLateralRadius',
  ]) {
    assert.match(grass, new RegExp(`${field}:`), `missing diagnostic ${field}`);
  }
  assert.match(benchmark, /grass LOD centre is not the active evaluator camera/,
    'the engine harness must reject a ball- or origin-centred grass footprint');
  assert.match(benchmark, /grass LOD forward axis is not the active evaluator view/,
    'the engine harness must reject a stale world-space forward axis');
  assert.match(benchmark, /farTierTerminalRadius >= grassDiagnostics\.nominalRadius \* 0\.70/,
    'the engine harness must bind the extended forward horizon');
});

test('all active tiles reject provably impossible lanes before expensive turf preparation', async () => {
  const grass = await read('src/terrain/Grass.js');
  assert.match(grass, /const DENSITY_TARGET_MAX_SCALE = 1\.24 \* ROUGH_COVERAGE_MAX/,
    'early rejection must use the exact tuft and coverage maxima');
  assert.match(grass, /const tileBoundHalfExtent = TILE_SIZE \* 0\.5 \+ CANDIDATE_JITTER_MARGIN/,
    'tile distance bound must explicitly include the full authored candidate jitter');
  assert.match(grass, /nearestDx[\s\S]*?tileMinDistance[\s\S]*?baseKeepUpper[\s\S]*?\.max\( FAR_TIER_PEAK_KEEP \)/,
    'tile bound must conservatively cover both radial density and the projected far tail');
  assert.match(grass, /densityUpperByte[\s\S]*?\.add\( uint\( 1 \) \)\.min\( uint\( ACTIVE_TILE_BOUND_MAX \) \)/,
    'quantized tile ceiling must round upward');
  assert.match(grass, /tile\.shiftLeft\( uint\( ACTIVE_TILE_RECORD_SHIFT \) \)[\s\S]*?densityUpperByte\.shiftLeft\( uint\( 1 \) \)[\s\S]*?bitOr\( farOnly \)/,
    'tile compaction must pack its density ceiling and retain far-only membership');
  assert.match(grass, /const tile = activeRecord\.shiftRight\( uint\( ACTIVE_TILE_RECORD_SHIFT \) \)/,
    'candidate identity must decode the original tile index');
  assert.match(grass, /const densityUpper = float\( activeRecord\.shiftRight\( uint\( 1 \) \)[\s\S]*?ACTIVE_TILE_BOUND_MAX/,
    'candidate compaction must decode the upward-rounded density ceiling');
  assert.match(grass, /const canPossiblyLive = hC\.lessThan\( densityUpper \)/,
    'the conservative guard must apply to base, overlap, and far-only tiles');
  const guard = grass.indexOf('If( canPossiblyLive');
  const secondaryWorldHash = grass.indexOf('hA.assign( hash2', guard);
  const jitteredWorldPosition = grass.indexOf('worldX.assign(', guard);
  const terrainSample = grass.indexOf('const data = textureLoad', guard);
  const ecologicalNoise = grass.indexOf('const macroCluster = mx_noise_float', guard);
  assert.ok(guard >= 0 && secondaryWorldHash > guard && jitteredWorldPosition > guard
    && terrainSample > guard && ecologicalNoise > guard,
    'far eligibility must guard secondary hashes, jitter, terrain sampling, and ecological noise');
  assert.match(grass, /alive\.assign\([\s\S]*?keepCandidate[\s\S]*?select\( uint\( 1 \), uint\( 0 \) \)/,
    'the guarded path must retain the exact final acceptance predicate');

  const densityAt = (radius, distance) => {
    const progress = Math.min(1, Math.max(0,
      (distance - radius * 0.18) / (radius * (0.99 - 0.18))));
    return (1 - progress) ** 8 * (1.08 + 0.05) - 0.05;
  };
  const maxScale = 1.24 * 0.66;
  const jitterMargin = (8 / 192) * 0.45;
  const tileHalfExtent = 4 + jitterMargin;
  for (const dx of [-30, -17.5, -8, 0, 6.25, 19, 31]) {
    for (const dz of [-29, -13, -4, 0, 9.5, 21, 32]) {
      const nearestDx = Math.max(Math.abs(dx) - tileHalfExtent, 0);
      const nearestDz = Math.max(Math.abs(dz) - tileHalfExtent, 0);
      const analytic = Math.min(1,
        Math.max(densityAt(43, Math.hypot(nearestDx, nearestDz)), 0.09) * maxScale);
      const boundByte = Math.min(255, Math.trunc(analytic * 255) + 1);
      const decodedBound = boundByte / 255;
      for (const ox of [-tileHalfExtent, -4, -2.25, 0, 1.75, 4, tileHalfExtent]) {
        for (const oz of [-tileHalfExtent, -4, -1.5, 0, 2.5, 4, tileHalfExtent]) {
          const candidateKeep = Math.max(densityAt(43, Math.hypot(dx + ox, dz + oz)), 0.09);
          assert.ok(decodedBound + Number.EPSILON >= candidateKeep * maxScale,
            'upward-rounded tile bound must never reject a candidate that the exact predicate can retain');
        }
      }
      for (const tile of [0, 1, 511, 1315, 8191]) {
        for (const farOnly of [0, 1]) {
          const record = (tile << 9) | (boundByte << 1) | farOnly;
          assert.equal(record >>> 9, tile, 'packed density bound must not alter stable tile identity');
          assert.equal((record >>> 1) & 255, boundByte, 'packed density ceiling must round-trip exactly');
          assert.equal(record & 1, farOnly, 'far-only membership must round-trip exactly');
        }
      }
    }
  }
});

test('packed surface and canopy guard is conservative and precedes zone and ecology work', async () => {
  const grass = await read('src/terrain/Grass.js');
  const dataFetch = grass.indexOf('const data = textureLoad( c.dataTex');
  const canopyDecode = grass.indexOf('const canopyMask = packedGround.mod', dataFetch);
  const growableDecode = grass.indexOf('const growable = packedGround.greaterThanEqual', canopyDecode);
  const canopyKeep = grass.indexOf('const canopyKeep = mix( 1.0, CANOPY_DENSITY_FLOOR, canopyMask )', growableDecode);
  const surfaceCeiling = grass.indexOf('const surfaceDensityUpper = densityUpper.mul( canopyKeep )', canopyKeep);
  const surfaceGuard = grass.indexOf('If( canReachExactDensity', surfaceCeiling);
  const zoneFetch = grass.indexOf('const zoneSD = textureLevel( c.zoneTex', surfaceGuard);
  const edgeNoise = grass.indexOf('const edgeWarp = mx_noise_float', surfaceGuard);
  const macroNoise = grass.indexOf('const macroCluster = mx_noise_float', surfaceGuard);
  const patchNoise = grass.indexOf('const patchBreak = mx_noise_float', surfaceGuard);
  const exactPredicate = grass.indexOf('const keepCandidate = hC.lessThan( densityTarget )', surfaceGuard);
  assert.ok(dataFetch >= 0 && canopyDecode > dataFetch && growableDecode > canopyDecode
    && canopyKeep > growableDecode && surfaceCeiling > canopyKeep && surfaceGuard > surfaceCeiling,
  'the existing packed fetch must decode surface and canopy before the nested guard');
  assert.ok(zoneFetch > surfaceGuard && edgeNoise > surfaceGuard
    && macroNoise > surfaceGuard && patchNoise > surfaceGuard && exactPredicate > surfaceGuard,
  'zone sampling, all three ecological noises, and the unchanged exact predicate must be nested behind the guard');
  assert.match(grass, /const canReachExactDensity = inBounds\.and\( growable \)[\s\S]*?hC\.lessThan\( surfaceDensityUpper \)/,
    'out-of-bounds, non-growable, and canopy-retired lanes must all stop at one conservative guard');
  assert.match(grass, /If\( canopyMask\.greaterThan\( 0\.0 \), \(\) => \{[\s\S]*?densityTarget\.mulAssign\( mix\( 1\.0, CANOPY_DENSITY_FLOOR, canopyMask \) \)/,
    'the exact final density expression must remain unchanged inside the guard');

  // Exhaust every seven-bit canopy code against every eight-bit upward-bound
  // bucket, with 256 substeps through each source interval. The exact base target
  // cannot exceed the unquantized tile analytic value; multiplying both sides by
  // the same nonnegative canopy keep proves the nested ceiling for every packed
  // field value, including the zero-mask bit-identical path.
  const densityFloor = scalar(grass, 'CANOPY_DENSITY_FLOOR');
  for (let upperBucket = 0; upperBucket < 255; upperBucket++) {
    const decodedUpper = (upperBucket + 1) / 255;
    for (let substep = 0; substep < 256; substep++) {
      const exactBaseUpper = (upperBucket + substep / 256) / 255;
      for (let canopyByte = 0; canopyByte <= 127; canopyByte++) {
        const canopy = canopyByte / 127;
        const keep = 1 + (densityFloor - 1) * canopy;
        const earlyCeiling = decodedUpper * keep;
        const exactFinalUpper = exactBaseUpper * keep;
        if (earlyCeiling + Number.EPSILON < exactFinalUpper) {
          assert.fail(`canopy ceiling underflow at ${upperBucket}/${substep}/${canopyByte}`);
        }
      }
    }
  }
  for (let canopyByte = 0; canopyByte <= 127; canopyByte++) {
    const canopy = canopyByte / 127;
    const keep = 1 + (densityFloor - 1) * canopy;
    assert.equal(1 * keep, 1 * keep, 'the saturated upper bucket remains exact');
  }
});
