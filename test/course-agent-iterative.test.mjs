import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createIterativeBuildStages, summarizeLiveEvent } from '../scripts/course-agent-service.mjs';

const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));

test('multi-hole forest prompts become visible hole-by-hole build stages', () => {
  const stages = createIterativeBuildStages(
    'Design a three-hole forest course with a par 4, par 3, then par 5 and thick trees with fern understory.',
    project,
  );
  assert.deepEqual(stages.map(({ id }) => id), ['hole-1', 'hole-2', 'hole-3', 'environment']);
  assert.equal(stages[0].activeHoleId, project.activeHoleId);
  assert.deepEqual(stages.slice(0, 3).map(({ holeNumber }) => holeNumber), [1, 2, 3]);
});

test('course builder recognizes the common three-hold typo without losing progressive staging', () => {
  const stages = createIterativeBuildStages('Build a 3 hold golf course in the pine forest', project);
  assert.deepEqual(stages.map(({ id }) => id), ['hole-1', 'hole-2', 'hole-3', 'environment']);
});

test('live course-agent streams workspace edits and watched asset changes', async () => {
  const plugin = await readFile(new URL('../vite-plugin-course-agent.js', import.meta.url), 'utf8');
  const service = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const playableScene = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');
  assert.match(plugin, /build\/live/);
  assert.match(plugin, /application\/x-ndjson/);
  assert.match(plugin, /course:agent-status/);
  assert.match(plugin, /course:assets-changed/);
  assert.match(plugin, /Asset changed:[\s\S]+course:assets-changed/);
  assert.match(main, /range\.reloadTreeAssets\(nextCatalog/);
  assert.match(main, /atomic live tree asset swap/);
  assert.match(main, /builder\.onSceneCheckpoint/);
  assert.match(main, /builder\.onCourseReloaded\(range\.course, event\)/);
  assert.match(main, /queueLiveSceneMutation/);
  assert.match(main, /serial !== liveAssetReloadSerial/);
  assert.match(main, /serial !== liveCourseReloadSerial/);
  assert.match(playableScene, /Decode the replacement species batches off-scene/);
  assert.match(service, /sandboxMode: 'workspace-write'/);
  assert.match(service, /networkAccessEnabled: true/);
  assert.match(service, /webSearchMode: 'live'/);
  assert.match(service, /runStreamed/);
  assert.match(service, /Range, CreatorScene, and PlayScene must remain thin page-owned consumers of PlayableCourseScene/);
  assert.match(service, /adjacent green-to-next-tee miss-cone safety/);
  assert.match(service, /checked-in command or script can reproduce the catalog filename/);
});

test('live event summaries report reasoning and file changes without raw command output', () => {
  assert.deepEqual(summarizeLiveEvent({ type: 'item.updated', item: { type: 'reasoning', text: 'Shaping the par-four landing area before compiling.' } }), {
    type: 'status', message: 'Shaping the par-four landing area before compiling.',
  });
  assert.deepEqual(summarizeLiveEvent({ type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [
    { path: '/workspace/course.project.json', kind: 'update' },
    { path: '/workspace/course.json', kind: 'update' },
  ] } }, '/workspace'), {
    type: 'file', message: 'Updated course.project.json and course.json.', files: ['course.project.json', 'course.json'],
  });
  assert.deepEqual(summarizeLiveEvent({ type: 'item.started', item: { type: 'web_search', query: 'Poly Haven pine tree CC0 GLB' } }), {
    type: 'status', message: 'Searching licensed asset sources for “Poly Haven pine tree CC0 GLB”.',
  });
  assert.equal(summarizeLiveEvent({ type: 'item.started', item: { type: 'command_execution', status: 'in_progress', command: 'secret command', aggregated_output: '' } }).message, 'Running a course build or validation command.');
  assert.deepEqual(summarizeLiveEvent({ type: 'item.completed', item: { type: 'command_execution', status: 'failed', command: 'secret command', aggregated_output: 'secret output' } }), {
    type: 'warning', message: 'A course build command failed; Codex is inspecting the result.',
  });
});
