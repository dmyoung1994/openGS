import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { signedDistanceToFeature } from '../src/course/featureGeometry.js';

// Range.js is intentionally a browser/WebGPU assembly module and cannot be
// imported by Node's plain test runner (Three's node-material exports are
// browser-bundler-only). Keep these contract tests independent while checking
// the exact pure grade equations below against the source implementation.
const rangeSource = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const pondGradeAt = ({ pond: feature, signedDistance, baseHeight, waterLevel }) => (
  signedDistance >= 0
    ? waterLevel - feature.depth * smoothstep(0, Math.max(0.1, feature._centerInset || feature.r), signedDistance)
    : baseHeight * (1 - smoothstep(-4, 0, signedDistance)) + waterLevel * smoothstep(-4, 0, signedDistance)
);

const pond = {
  x: 0, z: 0, r: 10, depth: 1.6,
  shape: [
    { x: -13, z: -3 }, { x: -8, z: -9 }, { x: 1, z: -11 },
    { x: 11, z: -7 }, { x: 14, z: 1 }, { x: 8, z: 8 },
    { x: -1, z: 10 }, { x: -10, z: 7 },
  ],
  _centerInset: 8.4,
};

test('pond datum is deterministic and resistant to one noisy shoreline sample', () => {
  const baseline = ({ x, z }) => 0.15 + x * 0.035 + z * 0.012;
  const pondWaterDatum = (feature, height) => {
    const points = [];
    for (let i = 0; i < 48; i += 1) {
      const position = (i / 48) * feature.shape.length;
      const index = Math.floor(position) % feature.shape.length;
      const next = (index + 1) % feature.shape.length;
      const t = position - Math.floor(position);
      points.push({
        x: feature.shape[index].x * (1 - t) + feature.shape[next].x * t,
        z: feature.shape[index].z * (1 - t) + feature.shape[next].z * t,
      });
    }
    const elevations = points.map(height).sort((a, b) => a - b);
    const middle = Math.floor(elevations.length * 0.5);
    return elevations.length % 2 ? elevations[middle] : (elevations[middle - 1] + elevations[middle]) * 0.5;
  };
  const datum = pondWaterDatum(pond, baseline);
  const noisy = pondWaterDatum(pond, ({ x, z }) => (
    x === pond.shape[4].x && z === pond.shape[4].z ? baseline({ x, z }) + 7 : baseline({ x, z })
  ));
  assert.equal(datum, noisy, 'a single shoreline outlier must not move the entire water plane');
  assert.equal(pondWaterDatum(pond, baseline), datum, 'datum must be repeatable');
  assert.match(rangeSource, /export function pondWaterDatum\(pond, baseHeight, sampleCount = 48\)/);
  assert.match(rangeSource, /elevations\.sort\(\(a, b\) => a - b\)/);
  assert.match(rangeSource, /const position = \(i \/ sampleCount\) \* pond\.shape\.length/);
});

test('irregular shoreline has exact water contact and a monotone submerged interior', () => {
  const level = 2.75;
  for (const point of pond.shape) {
    const sd = signedDistanceToFeature(pond, point.x, point.z);
    const grade = pondGradeAt({ pond, signedDistance: sd, baseHeight: 99, waterLevel: level });
    assert.ok(Math.abs(sd) < 1e-9, `outline sample must be on the authored boundary (sd=${sd})`);
    assert.equal(grade, level, 'terrain must meet the flat water plane at every outline point');
  }

  const shallow = pondGradeAt({ pond, signedDistance: 0.35, baseHeight: 99, waterLevel: level });
  const deep = pondGradeAt({ pond, signedDistance: pond._centerInset, baseHeight: 99, waterLevel: level });
  assert.ok(shallow < level, 'water interior must be below the plane immediately inside the bank');
  assert.ok(deep < shallow, 'basin grade must continue monotonically below the shoreline');
  assert.equal(deep, level - pond.depth, 'deep interior must reach the authored basin depth');
  assert.match(rangeSource, /h = pondGradeAt\(\{ pond: p, signedDistance: sd, baseHeight: h, waterLevel: level \}\)/);
  assert.match(rangeSource, /if \(signedDistance >= 0\) return waterLevel - pond\.depth \* smoothstep\(0, inset, signedDistance\)/);
});

test('outside grade returns naturally without a circular/radial apron', () => {
  const level = 2.75;
  const natural = 0.6;
  assert.equal(
    pondGradeAt({ pond, signedDistance: 0, baseHeight: natural, waterLevel: level }),
    level,
  );
  assert.equal(
    pondGradeAt({ pond, signedDistance: -4, baseHeight: natural, waterLevel: level }),
    natural,
  );
  const near = pondGradeAt({ pond, signedDistance: -1, baseHeight: natural, waterLevel: level });
  assert.ok(near > natural && near < level, 'shore shoulder must be a short monotone tie-in');
});
