import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('address resets preserve the evaluator camera while still placing the ball', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const address = source.match(/function toAddress\([\s\S]*?\n\}/)?.[0];
  assert.match(address, /ball\.placeAt\(tee\.x, tee\.z\)/);
  assert.match(address, /if \(!evaluatorCamera\?\.active\) \{\s*if \(smooth\) director\.returnToAddress[\s\S]*?else director\.setAddress[\s\S]*?\n  \}/);
});

test('public course changes use the watcher queue, which preserves ordering after failures', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const api = source.slice(source.indexOf('window.golf = {'));
  for (const method of ['rebuild', 'previewCourse', 'clearCoursePreview', 'showAuthoredCreatorCourse', 'showCreatorCanvas']) {
    assert.match(api, new RegExp(`${method}: \\([^)]*\\) => queueLiveSceneMutation\\(`));
  }
  const definition = source.match(/function queueLiveSceneMutation\(task\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(definition);
  const enqueue = new Function(`let liveSceneMutationQueue = Promise.resolve(); ${definition}; return queueLiveSceneMutation;`)();
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = enqueue(async () => { events.push('first'); await gate; throw new Error('failed build'); });
  const rejected = assert.rejects(first, /failed build/);
  const second = enqueue(() => { events.push('second'); return 42; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  release();
  await rejected;
  assert.equal(await second, 42);
  assert.deepEqual(events, ['first', 'second']);
});
