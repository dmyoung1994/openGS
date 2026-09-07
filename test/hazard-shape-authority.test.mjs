import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  roundedHazardFeature, signedDistanceToFeature,
} from '../src/course/featureGeometry.js';

const [rangeSource, waterSource, terrainSource] = await Promise.all([
  readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/scene/WaterSurface.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/terrain/Terrain.js', import.meta.url), 'utf8'),
]);

test('Range compiles one rounded hazard authority before every terrain consumer', () => {
  assert.match(rangeSource, /this\.bunkers = course\.bunkers\.map[\s\S]*?roundedHazardFeature\(feature, \{ kind: 'bunker', index \}\)/);
  assert.match(rangeSource, /this\.ponds = course\.ponds\.map[\s\S]*?roundedHazardFeature\(feature, \{ kind: 'pond', index \}\)/);
  assert.match(rangeSource, /sands: this\.bunkers\.map[\s\S]*?shape: b\.shape/,
    'terrain render mask/minimap must receive the compiled bunker outline');
  assert.match(rangeSource, /b\.pot \? \{ shape: b\.shape, inset: b\.r \* 0\.28, pot: true \} : \{ shape: b\._sandShape \}/,
    'regular render sand must use the compiled irregular inner contour');
  assert.match(rangeSource, /waters: this\.ponds\.map[\s\S]*?shape: p\.shape/,
    'terrain render mask/minimap must receive the compiled pond outline');
  assert.match(rangeSource, /h = bunkerGradeAt\(\{[\s\S]*?bunker: b, signedDistance: sd, baseHeight: h, x, z/,
    'collision terrain must carve from that bunker SDF');
  assert.match(rangeSource, /for \(const p of this\.ponds\)[\s\S]*?inFeatureBounds\(p\._bounds, x, z\)[\s\S]*?signedDistanceToFeature\(p, x, z\) > 0/,
    'high-resolution pond classification must retain an exact conservative broad phase');
  assert.match(rangeSource, /inFeatureBounds\(this\._bunkerBounds\[bunkerIndex\], x, z\)[\s\S]*?signedDistanceToFeature\(b, x, z\)/,
    'high-resolution bunker classification must retain an exact conservative broad phase');
  assert.match(rangeSource, /signedDistanceToFeature\(b\._sandFeature, x, z\) > 0/,
    'ball lie/surface ownership must use the same irregular inner contour as rendering');
  assert.match(waterSource, /pond = roundedHazardFeature\(pond, \{ kind: 'pond' \}\)/);
  assert.match(waterSource, /contains\(x, z\) \{ return signedDistanceToFeature\(this\.pond, x, z\) >= 0; \}/,
    'water impact/physics contains must use the same compiled pond');
  assert.match(terrainSource, /buildZoneMap\(zones, bounds\)/,
    'terrain/minimap material zones must remain the shared baked authority');
});

test('regular bunker keeps one authoritative irregular turf-face and directional floor', () => {
  const bunker = roundedHazardFeature({ x: 2, z: -10, r: 5, depth: 1, pot: false }, {
    kind: 'bunker', index: 3,
  });
  assert.ok(bunker._sandShape?.length === bunker.shape.length);
  assert.equal(signedDistanceToFeature({ ...bunker, shape: bunker._sandShape }, bunker.x, bunker.z) > 0, true);
  assert.match(rangeSource, /_sandFeature: sandFeature/,
    'Range must cache the inner authority instead of allocating it per surface sample');
  assert.match(terrainSource, /sandFaceDistance: sd\.b/,
    'the shader must retain signed face position from the shared zone SDF');
  assert.match(terrainSource, /sandFacePosition = m\.sandFaceDistance[\s\S]*?zones\.sandSignal\.mul\(0\.08\)/,
    'sand face value must be aggregate-broken rather than a constant radial halo');
  assert.match(terrainSource, /sandFaceBlend = smoothstep\(0\.06, 0\.62, sandFacePosition\)/);
});

test('rounded pond boundary is continuous and preserves exact inside/outside ownership', () => {
  const pond = roundedHazardFeature({
    x: 4, z: -20, r: 9, depth: 1.4,
    shape: [
      { x: 13, z: -20 }, { x: 11, z: -14 }, { x: 4, z: -11 }, { x: -4, z: -15 },
      { x: -5, z: -22 }, { x: 0, z: -28 }, { x: 8, z: -28 }, { x: 13, z: -24 },
    ],
  }, { kind: 'pond', index: 0 });
  assert.ok(pond.shape.length >= 96);
  for (const point of pond.shape) {
    assert.ok(Math.abs(signedDistanceToFeature(pond, point.x, point.z)) < 1e-9,
      'every high-resolution mesh vertex must lie on the collision/render SDF boundary');
  }
  assert.ok(signedDistanceToFeature(pond, pond.x, pond.z) > 0);
  assert.ok(signedDistanceToFeature(pond, pond.x + pond.r * 1.6, pond.z) < 0);
});
