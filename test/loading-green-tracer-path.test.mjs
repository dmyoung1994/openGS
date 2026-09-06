import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The module's class half pulls in GPU-only materials through Vite's Three alias.
// Load just the pure path builder that sits above it.
const source = await readFile(new URL('../src/scene/LoadingGreen.js', import.meta.url), 'utf8');
// A data: module cannot resolve bare specifiers, so pin Three to its absolute URL.
const { buildTracerPath } = await import(`data:text/javascript;base64,${Buffer.from(
  `import { Vector3 } from ${JSON.stringify(import.meta.resolve('three'))};\n`
  + source.slice(source.indexOf('const TRACER_LIFT_M'), source.indexOf('// Prewarmed real creator scene')),
).toString('base64')}`);

// A putt solved at a fixed time step bunches its samples near the cup and spreads them
// at speed, and its height comes off a bilinear collision grid. Neither should reach
// the drawn ribbon.
function solvedSamples() {
  const samples = [];
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    // Decelerating roll: sample spacing varies several-fold end to end.
    const travel = 1 - (1 - t) ** 2;
    const x = travel * 8;
    const z = Math.sin(travel * 1.4) * 1.6;
    // Grid-quantized height with a crease every 0.6 m, as bilinear sampling gives.
    const cell = Math.floor(x / 0.6);
    const frac = x / 0.6 - cell;
    const h = (a) => Math.sin(a * 0.37) * 0.35;
    samples.push({ x, y: h(cell) + (h(cell + 1) - h(cell)) * frac, z });
  }
  return samples;
}

test('the drawn stroke is evenly spaced and pinned to the real endpoints', () => {
  const samples = solvedSamples();
  const path = buildTracerPath(samples, { spacing: 0.05, passes: 2, lift: 0.12 });

  const spans = [];
  for (let i = 1; i < path.points.length; i++) spans.push(path.points[i].distanceTo(path.points[i - 1]));
  const spread = Math.max(...spans) / Math.min(...spans);
  assert.ok(spread < 1.35, `control spacing must be near-uniform, got ${spread.toFixed(2)}x`);

  // Endpoints stay put in plan, so the stroke starts at the putt and ends in the cup.
  for (const [point, sample] of [[path.points[0], samples[0]],
    [path.points[path.points.length - 1], samples[samples.length - 1]]]) {
    assert.ok(Math.hypot(point.x - sample.x, point.z - sample.z) < 1e-6);
    assert.ok(Math.abs(point.y - (sample.y + 0.12)) < 1e-6, 'every control sits one lift above grade');
  }
  assert.ok(path.total > 8 && path.total < 12);

  // The samples are ball centres, so the shipped default must not lift off them:
  // any offset reads as the trace hovering over the ball that drew it.
  const shipped = buildTracerPath(samples);
  const grounded = buildTracerPath(samples, { lift: 0 });
  assert.equal(shipped.points.length, grounded.points.length);
  for (let i = 0; i < shipped.points.length; i++) {
    assert.equal(shipped.points[i].y, grounded.points[i].y,
      'the default stroke must run through the ball centre, not above it');
  }
});

test('smoothing removes collision-grid creases without flattening the putt break', () => {
  const samples = solvedSamples();
  const bend = (points) => {
    let worst = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1];
      const u = b.clone().sub(a).normalize(), v = c.clone().sub(b).normalize();
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, u.dot(v)))));
    }
    return worst;
  };
  const raw = buildTracerPath(samples, { spacing: 0.05, passes: 0, lift: 0 });
  const smoothed = buildTracerPath(samples, { spacing: 0.05, passes: 2, lift: 0 });
  assert.ok(bend(smoothed.points) < bend(raw.points) * 0.6,
    'grid creases must be substantially reduced');

  // The break is metre-scale, so it has to survive: the smoothed curve must still
  // depart from the straight start-to-cup chord by nearly as much as the raw one.
  const sideways = (points) => {
    const first = points[0], last = points[points.length - 1];
    const axis = last.clone().sub(first).setY(0).normalize();
    let worst = 0;
    for (const point of points) {
      const d = point.clone().sub(first).setY(0);
      worst = Math.max(worst, d.clone().addScaledVector(axis, -d.dot(axis)).length());
    }
    return worst;
  };
  assert.ok(sideways(smoothed.points) > sideways(raw.points) * 0.97,
    'the authored break must not be smoothed away');
});

test('arc lookup is monotonic across the solved sample range', () => {
  const path = buildTracerPath(solvedSamples(), { spacing: 0.05, passes: 1, lift: 0 });
  let previous = -1;
  for (let index = 0; index <= 400; index += 7) {
    const arc = path.arcAtSample(index);
    assert.ok(arc >= previous, 'revealing must never walk backwards');
    previous = arc;
  }
  assert.equal(path.arcAtSample(-5), 0);
  assert.ok(Math.abs(path.arcAtSample(9999) - path.total) < 1e-9);
  assert.throws(() => buildTracerPath([{ x: 0, y: 0, z: 0 }]), /at least two/);
});
