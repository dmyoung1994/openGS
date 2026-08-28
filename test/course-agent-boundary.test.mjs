import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Codex course agent is isolated, read-only, image-aware, and proposal-only', async () => {
  const source = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  assert.match(source, /sandboxMode: 'read-only'/);
  assert.match(source, /workingDirectory: workspace\.directory/);
  assert.match(source, /networkAccessEnabled: false/);
  assert.match(source, /webSearchMode: 'disabled'/);
  assert.match(source, /type: 'local_image'/);
  assert.doesNotMatch(source, /writeFile\([^)]*course\.json/);
});
