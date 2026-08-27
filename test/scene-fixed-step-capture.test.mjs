import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8');

test('paused production rendering accepts a bounded explicit capture timestep', () => {
  assert.match(source, /renderSingleFrame\(deltaSeconds = null\)/);
  assert.match(source, /fixedDelta < 0 \|\| fixedDelta > 0\.1/);
  assert.match(source, /this\._lastFrameTime = now - fixedDelta \* 1000/);
  assert.match(source, /this\._renderFrame\(now\)/);
  assert.doesNotMatch(source, /renderCaptureFrame|captureRenderer|mockRenderer/);
});
