import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rangeSource = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');

test('greens inherit continuous landform and never add a radial height patch', () => {
  const start = rangeSource.indexOf('// Greens inherit the continuous course landform');
  const end = rangeSource.indexOf('// Carve each bunker', start);
  assert.ok(start >= 0 && end > start, 'green height section must remain explicit');
  const greenHeight = rangeSource.slice(start, end);

  assert.doesNotMatch(greenHeight, /smoothstep|signedDistanceToFeature|greenContour|t\.r|Math\.hypot/,
    'green height section must not add any independent pad, rim, or contour');
  assert.doesNotMatch(rangeSource, /function greenContour|_targetContourData/,
    'legacy per-green relief machinery must not return');
});
