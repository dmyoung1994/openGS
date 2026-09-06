import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('proposal review remains isolated and the live builder is an explicit workspace writer', async () => {
  const source = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  assert.match(source, /sandboxMode: 'read-only'/);
  assert.match(source, /sandboxMode: 'workspace-write'/);
  assert.match(source, /workingDirectory: workspace\.directory/);
  assert.match(source, /workingDirectory: this\.root/);
  assert.match(source, /sandboxMode: 'workspace-write',[\s\S]{0,180}networkAccessEnabled: true,[\s\S]{0,80}webSearchMode: 'live'/);
  assert.match(source, /sandboxMode: 'read-only',[\s\S]{0,180}networkAccessEnabled: false,[\s\S]{0,80}webSearchMode: 'disabled'/);
  assert.match(source, /type: 'local_image'/);
  assert.match(source, /runStreamed/);
});

test('live builder prompt governs connected routing claims and licensed asset acquisition', async () => {
  const source = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  assert.match(source, /whole-site routing plan/);
  assert.match(source, /explicit consecutive transitions/);
  assert.match(source, /renders every hole and connector together through the page-owned CreatorScene/);
  assert.match(source, /Give every hazard a stable owning-hole identity/);
  assert.match(source, /Reject decorative tee-side hazards/);
  assert.match(source, /Range, CreatorScene, and PlayScene must remain thin page-owned consumers of PlayableCourseScene/);
  assert.match(source, /Record the routing audit in project\.meta\.notes/);
  assert.match(source, /window\.golf\.selectHole\(holeId\)/);
  assert.match(source, /catalog cannot satisfy a requested visual or ecological role/);
  assert.match(source, /unknown, ambiguous, or incompatible license/);
  assert.match(source, /run the catalog and visual-asset verification/);
  assert.match(source, /item\.type === 'web_search'/);
});
