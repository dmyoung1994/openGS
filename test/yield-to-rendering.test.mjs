import test from 'node:test';
import assert from 'node:assert/strict';
import { yieldToRendering } from '../src/util/yieldToRendering.js';

test('browser preparation checkpoint crosses an animation frame and its paint task', async () => {
  const oldRAF = globalThis.requestAnimationFrame;
  let frame;
  globalThis.requestAnimationFrame = callback => { frame = callback; };
  try {
    let resumed = false;
    const checkpoint = yieldToRendering().then(() => { resumed = true; });
    await Promise.resolve();
    assert.equal(resumed, false);
    assert.equal(typeof frame, 'function');
    frame(16.7);
    await Promise.resolve();
    assert.equal(resumed, false, 'work must not resume inside the pre-paint RAF microtask');
    await checkpoint;
    assert.equal(resumed, true);
  } finally {
    if (oldRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = oldRAF;
  }
});
