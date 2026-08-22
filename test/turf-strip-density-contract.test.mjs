import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MOW_STRIPE_PERIOD_M,
  MOW_STRIPE_PASS_WIDTH_M,
  MOW_STRIPE_CROSS_SLOPE,
  TURF_BLADE_SATURATION,
  turfBase,
  turfBladeBase,
  mowingStripCoordinate,
  mowingStripPhase,
} from '../src/terrain/turfColor.js';

const ROOT = new URL('../', import.meta.url);

test('fairway mowing passes are straight, reel-width, and fairway-only', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');

  assert.equal(MOW_STRIPE_PASS_WIDTH_M, 2.54,
    'one visual band must match a current 100-inch fairway reel pass');
  assert.equal(MOW_STRIPE_PERIOD_M, MOW_STRIPE_PASS_WIDTH_M * 2,
    'one alternating light/dark cycle must contain exactly two reel passes');
  assert.notEqual(MOW_STRIPE_CROSS_SLOPE, 0,
    'mowing coordinate must carry a stable down-range direction component');
  assert.match(source, /const stripCoordinate\s*=\s*worldXZ\.x\.add\(worldXZ\.y\.mul\(MOW_STRIPE_CROSS_SLOPE\)\);/,
    'shader stripes must be one perfectly linear world/course coordinate');
  assert.doesNotMatch(source, /mowWarp|stripCoordinate[\s\S]{0,180}macroVariation/,
    'mowing coordinate must contain no noise, warp, curvature, or phase perturbation');
  assert.match(source, /const stripPhase\s*=\s*stripCoordinate\.mul\(6\.2831853 \/ MOW_STRIPE_PERIOD_M\)/,
    'shader stripes must use a measurable physical period');
  assert.match(source, /const stripLay\s*=\s*smoothstep\(0\.40, 0\.60, stripWave\)/,
    'mowing response must resolve into equal-width passes with clean antialiased boundaries');
  assert.match(source, /const mowBand\s*=\s*stripLay\.sub\(0\.5\)\.mul\(0\.045\)/,
    'fairway albedo must remain a restrained support for physical leaf-lay contrast');
  assert.match(source, /const mowBump\s*=\s*layDirection\.mul\(stripLay\.sub\(0\.5\)\.mul\(0\.22\)\)/,
    'fairway passes must remain primarily a physical leaf-lay normal response');
  assert.match(source, /const mowResolution\s*=\s*oneMinus\(smoothstep\(0\.28, 1\.10, duvM\)\)/,
    '2.54m passes must recede by their real screen-space resolving limit');
  assert.match(source, /const mowOptical\s*=\s*stripLay\.sub\(0\.5\)[\s\S]*?const mowSpecular\s*=\s*oneMinus\(mowOptical\.mul\(0\.24\)\)/,
    'mower roughness and specular response must share one registered directional signal');
  assert.match(source, /const fairwayMowMask = m\.fairway[\s\S]*?oneMinus\(m\.fringe\)[\s\S]*?oneMinus\(m\.green\)[\s\S]*?oneMinus\(m\.tee\)[\s\S]*?oneMinus\(m\.sand\)[\s\S]*?oneMinus\(m\.waterBank\)/,
    'mowing must be owned by the authored fairway and explicitly exclude every other surface');
  assert.match(source, /const fibreBump[\s\S]*?\.mul\(fairwayMowMask\)/,
    'directional fibre normal must be fairway-only');
  assert.match(source, /const fibreRoughness[\s\S]*?\.mul\(fairwayMowMask\)/,
    'directional fibre roughness must be fairway-only');
  assert.match(source, /mowBand\.mul\(fairwayMowMask\)\.mul\(zones\.mowResolution\)/,
    'mowing bands must naturally recede by physical pixel footprint');
  assert.doesNotMatch(source, /mowCoverage|fairwayMowMask\s*=\s*m\.visualFairway/,
    'mowing response must not leak through the broad visual-maintained ecotone');
  assert.doesNotMatch(source, /wx\.mul\(0\.94\).*wz\.mul\(0\.16\)/s,
    'fairway must not reintroduce sub-metre high-frequency mower noise');
});

test('mowing strip phase is deterministic and does not follow the camera', () => {
  assert.equal(mowingStripCoordinate(12, -20), 12 - 20 * MOW_STRIPE_CROSS_SLOPE);
  assert.equal(mowingStripPhase(12, -20), mowingStripPhase(12, -20));
  assert.notEqual(mowingStripPhase(-5, -20), mowingStripPhase(1, -20),
    'distinct across-course samples should not collapse to one stripe');
  const deltaA = mowingStripCoordinate(11, -20) - mowingStripCoordinate(10, -20);
  const deltaB = mowingStripCoordinate(12, -20) - mowingStripCoordinate(11, -20);
  assert.equal(deltaA, deltaB, 'straight reel lines must have zero coordinate curvature');
});

test('rough retains thick blade ribbons while increasing close-field coverage', async () => {
  const source = await readFile(new URL('src/terrain/Grass.js', ROOT), 'utf8');
  assert.match(source, /ROUGH_BLADE_WIDTH_MIN_M\s*=\s*0\.0075/,
    'rough blade thickness must not regress to wire-like slivers');
  assert.match(source, /ROUGH_BLADE_WIDTH_MAX_M\s*=\s*0\.018/,
    'rough blades need physically varied broad widths');
  assert.match(source, /const ecologicalWidth = mix\( hE, tuft, 0\.30 \)[\s\S]*?\.clamp\( 0\.0, 1\.0 \)/,
    'ecological variation must remain a bounded interpolation inside the authored width range');
  assert.match(source, /widthBase\.assign\( mix\( ROUGH_BLADE_WIDTH_MIN_M, ROUGH_BLADE_WIDTH_MAX_M, ecologicalWidth \) \)/,
    'effective rooted blade width must stay literally within 7.5–18 mm');
  assert.doesNotMatch(source, /widthBase[^;]*\.mul\( mix\( 0\.92, 1\.12, ecological \) \)/,
    'effective rooted width must not multiply below or above the declared invariant');
  assert.match(source, /ROUGH_COVERAGE_MIN\s*=\s*0\.64/,
    'rough needs a solid oblique-view coverage floor');
  assert.match(source, /ROUGH_COVERAGE_MAX\s*=\s*0\.88/,
    'rough needs dense high-colony occupancy without widening blades');
  assert.match(source, /ROUGH_COLONY_FLOOR\s*=\s*0\.88/,
    'rough colony mass must remain present between individual blades');
  assert.equal(TURF_BLADE_SATURATION, 1.28,
    'rough pigment needs natural species/age colour variation without neon saturation');
  assert.match(source, /BLADE_COLOR\[ name \] = turfBladeBase\( name, new Color\(\) \)/,
    'geometric blades must consume the shared rough pigment transform');
  assert.match(source, /const age = mix\( hD, ecological, 0\.45 \)/,
    'rough pigment must carry stable age variation');
  assert.match(source, /const BLADE_INDEX_COUNT = BLADE_SEGMENTS \* 12/,
    'rough blade should use crossed ribbons in the same indirect draw');
  assert.match(source, /t\.lessThan\( 0\.5 \)\.select\( float\( 1\.0 \)/,
    'rough blade must retain its broad lower body and use the fixed-row upper-third profile');
  assert.match(source, /float\( 0\.9616200671 \).*float\( 0\.06 \)/s,
    'rough blade silhouette must retain the authored mid-row and tip widths');
  assert.match(source, /transformNormalToView\( vec3\([\s\S]*?\.toVarying\( 'vGrassViewNormal' \)/,
    'dense rough must hoist ribbon-basis and linear view-transform arithmetic out of overdrawn fragments');
  assert.match(source, /mat\.normalNode = bladeNormalView\.normalize\(\)/,
    'the view-space normal still needs its exact post-interpolation normalization');
  assert.match(source, /\.toVarying\( 'vGrassBladeColor' \)/,
    'dense rough must shade the fixed blade rows before fragment interpolation');
  assert.match(source, /mix\( ROUGH_COLONY_FLOOR, 1\.0, colony \)/,
    'colony floor must be applied to the stable world-space acceptance field');
  assert.doesNotMatch(source, /widthBase\s*=\s*mix\( 0\.0042, 0\.011/, 
    'rough pass must not silently thin blades to meet a density budget');
});

test('rough substrate and geometric blades share one canonical pigment', async () => {
  const terrain = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  const blade = turfBladeBase('rough');
  const base = turfBase('rough');
  assert.notDeepEqual(blade.toArray(), base.toArray(),
    'the shared blade tint must retain its intentional chlorophyll saturation');
  assert.match(terrain, /rough: roughUndercoat\('rough'\), deepRough: roughUndercoat\('deepRough'\)/,
    'both long-grass terrain classes must use the exact geometric-blade undercoat');
  assert.match(terrain, /let zoneGrade = float\(0\.90\);[\s\S]*?float\(0\.90\), m\.rough/,
    'rough undercoat value must match the mean stable blade pigment instead of reopening dark gaps');
});
