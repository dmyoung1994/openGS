import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAimGuidePositions } from '../src/scene/AimGuide.js';

test('world aim guide follows terrain and includes a target ring', () => {
  const positions = buildAimGuidePositions(
    { x: 0, z: 0 }, { x: 0, z: -100 },
    (x, z) => x * .1 + z * .01,
  );
  assert.ok(positions.length > 32 * 18, 'dashed line and target ring should both be present');
  for (let index = 0; index < positions.length; index += 3) {
    const [x, y, z] = positions.subarray(index, index + 3);
    assert.ok(Math.abs(y - (x * .1 + z * .01) - .045) < 1e-5, 'every vertex should stay registered to terrain');
  }
});
