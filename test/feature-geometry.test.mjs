import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUNKER_SAND_INSET_M, BUNKER_SAND_INSET_VARIATION_M, bunkerGradeAt,
  polygonArea, polygonSelfIntersects, roundedHazardFeature, signedDistanceToFeature,
  smoothClosedOutline,
} from '../src/course/featureGeometry.js';

test('sparse golf-feature controls normalize into a deterministic rounded outline', () => {
  const controls = [
    { x: -6, z: 0 }, { x: -3, z: -5 }, { x: 3, z: -6 },
    { x: 7, z: -1 }, { x: 4, z: 5 }, { x: -3, z: 6 },
  ];
  const first = smoothClosedOutline(controls, 3);
  const second = smoothClosedOutline(controls, 3);
  assert.deepEqual(first, second);
  assert.equal(first.length, controls.length * 3);
  assert.equal(polygonSelfIntersects(first), false);
  assert.ok(signedDistanceToFeature({ x: 0, z: 0, r: 6, shape: first }, 0, 0) > 0);
  // A midpoint-to-control-to-midpoint quadratic cannot retain the original
  // straight chord as a single long rendered/gameplay segment.
  assert.ok(first.some((point) => point.x !== controls[0].x && point.z !== controls[0].z));
});

test('one high-resolution rounded pond contour is deterministic and idempotent', () => {
  const source = {
    x: 0, z: 0, r: 12, depth: 1.6,
    shape: [
      { x: 12, z: 0 }, { x: 9, z: 8 }, { x: 1, z: 11 }, { x: -10, z: 7 },
      { x: -12, z: -2 }, { x: -7, z: -10 }, { x: 3, z: -11 }, { x: 11, z: -6 },
    ],
  };
  const pond = roundedHazardFeature(source, { kind: 'pond', index: 2 });
  assert.ok(pond.shape.length >= 96, 'overview shoreline needs sub-chord high resolution');
  assert.equal(polygonSelfIntersects(pond.shape), false);
  assert.ok(signedDistanceToFeature(pond, pond.x, pond.z) > 0);
  assert.strictEqual(roundedHazardFeature(pond, { kind: 'pond', index: 2 }), pond,
    'defensive consumers must reuse, not resmooth, the authoritative contour');
  assert.deepEqual(pond, roundedHazardFeature(source, { kind: 'pond', index: 2 }));
});

test('legacy circular bunkers become bounded asymmetric lobes with a flush monotone carve', () => {
  const source = { x: 2, z: -8, r: 5, depth: 1, pot: false };
  const bunker = roundedHazardFeature(source, { kind: 'bunker', index: 4 });
  assert.equal(bunker.shape.length, 72);
  assert.equal(polygonSelfIntersects(bunker.shape), false);
  const radii = bunker.shape.map((point) => Math.hypot(point.x - bunker.x, point.z - bunker.z));
  assert.ok(Math.min(...radii) >= bunker.r * 0.70);
  assert.ok(Math.max(...radii) <= bunker.r * 1.38);
  assert.ok(Math.max(...radii) - Math.min(...radii) > bunker.r * 0.30,
    'fallback outline must not remain a circular pill');
  const axisSpan = projectedSpan(bunker.shape, bunker, bunker._bunkerMajorAxis);
  const crossSpan = projectedSpan(bunker.shape, bunker, bunker._bunkerMajorAxis + Math.PI / 2);
  assert.ok(axisSpan / crossSpan >= 1.25 && axisSpan / crossSpan <= 1.45,
    'compiled bunker needs a legible but realistic major axis');
  assert.ok(Math.abs(Math.abs(polygonArea(bunker.shape)) - Math.PI * source.r ** 2)
    / (Math.PI * source.r ** 2) < 0.03, 'shaping must preserve authored circle area');

  assert.equal(BUNKER_SAND_INSET_M, 0.40);
  assert.equal(BUNKER_SAND_INSET_VARIATION_M, 0.10);
  const sandInsets = bunker.shape.map((point, index) => (
    Math.hypot(point.x - bunker.x, point.z - bunker.z)
      - Math.hypot(bunker._sandShape[index].x - bunker.x, bunker._sandShape[index].z - bunker.z)
  ));
  assert.ok(Math.min(...sandInsets) >= 0.30 - 1e-9);
  assert.ok(Math.max(...sandInsets) <= 0.50 + 1e-9);
  assert.ok(Math.max(...sandInsets) - Math.min(...sandInsets) > 0.15,
    'the turf face must be irregular rather than a concentric sand inset');
  assert.equal(polygonSelfIntersects(bunker._sandShape), false);

  const graded = { ...bunker, _drainageX: 0, _drainageZ: -1 };
  const base = 10;
  assert.equal(bunkerGradeAt({ bunker: graded, signedDistance: -0.01, baseHeight: base, x: 2, z: -3 }), base);
  assert.equal(bunkerGradeAt({ bunker: graded, signedDistance: 0, baseHeight: base, x: 2, z: -3 }), base,
    'rim must be exactly grade-flush');
  const depths = [0.2, 0.8, 1.8, 4].map((signedDistance) => base - bunkerGradeAt({
    bunker: graded, signedDistance, baseHeight: base, x: 2, z: -10,
  }));
  for (let i = 1; i < depths.length; i += 1) assert.ok(depths[i] >= depths[i - 1]);
  assert.ok(Math.max(...depths) <= bunker.depth + 1e-12, 'drainage floor may not exceed authored depth');
  const downDrain = base - bunkerGradeAt({
    bunker: graded, signedDistance: 3, baseHeight: base, x: 2, z: -11,
  });
  const backEdge = base - bunkerGradeAt({
    bunker: graded, signedDistance: 3, baseHeight: base, x: 2, z: -5,
  });
  assert.ok(downDrain - backEdge > bunker.depth * 0.08,
    'the floor low point must shift down the drainage axis instead of darkening the centre symmetrically');
});

function projectedSpan(points, center, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const projections = points.map((point) => (
    (point.x - center.x) * c + (point.z - center.z) * s
  ));
  return Math.max(...projections) - Math.min(...projections);
}
