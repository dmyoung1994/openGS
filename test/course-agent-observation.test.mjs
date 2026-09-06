import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CourseAgentService, LiveObservationStore, validateLiveBuildId } from '../scripts/course-agent-service.mjs';
import { projectRevision } from '../src/course/CourseProject.js';

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X6P0WQAAAABJRU5ErkJggg==';

test('live observations publish revision-tagged image sets atomically outside the repository', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'golfsim-observation-repo-'));
  const observationRoot = await mkdtemp(join(tmpdir(), 'golfsim-observation-store-'));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(observationRoot, { recursive: true, force: true });
  });
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);
  const revision = projectRevision(project);
  const store = new LiveObservationStore({ root: repository, observationRoot });
  const session = await store.open('course-live-test_01');

  assert.equal(session.projectRevision, revision);
  assert.ok(session.directory.startsWith(observationRoot));
  assert.ok(!session.directory.startsWith(repository));
  assert.deepEqual(JSON.parse(await readFile(session.latestPath, 'utf8')), {
    version: 1,
    buildId: 'course-live-test_01',
    state: 'waiting-for-browser-checkpoint',
    sequence: 0,
    projectRevision: revision,
    renderRevision: session.renderRevision,
    captureCount: 0,
    captures: [],
  });

  const result = await store.record({
    clientBuildId: 'course-live-test_01',
    sequence: 1,
    renderGeneration: 7,
    revision,
    phase: 'Hole 2 compiled',
    activeHoleId: 'pineglass-hole-2',
    diagnostics: { webgpuReady: true, navigationEntries: 1 },
    captures: [{
      label: 'Hole 2 landing',
      holeId: 'pineglass-hole-2',
      camera: { position: [10, 18, 30], target: [0, 0, -120] },
      dataUrl: ONE_PIXEL_PNG,
    }],
  });
  const latest = JSON.parse(await readFile(session.latestPath, 'utf8'));
  assert.equal(result.sequence, 1);
  assert.equal(result.revision, revision);
  assert.equal(latest.state, 'ready');
  assert.equal(latest.sequence, 1);
  assert.equal(latest.renderGeneration, 7);
  assert.equal(latest.projectRevision, revision);
  assert.match(latest.renderRevision, /^render-[a-f0-9]{16}$/);
  assert.equal(latest.captureCount, 1);
  assert.equal(latest.captures[0].holeId, 'pineglass-hole-2');
  assert.ok(latest.captures[0].path.startsWith(session.directory));
  await access(latest.captures[0].path);
  await access(latest.observationPath);
  assert.equal((await readdir(session.directory)).some((name) => name.includes('.tmp-')), false);

  await assert.rejects(
    store.record({ clientBuildId: 'course-live-test_01', sequence: 1, captures: [{ label: 'stale', dataUrl: ONE_PIXEL_PNG }] }),
    /sequence must advance beyond 1/,
  );
  await assert.rejects(
    store.record({ clientBuildId: 'course-live-test_01', sequence: 2, renderGeneration: 8, revision: 'v4-deadbeef', captures: [{ label: 'stale', dataUrl: ONE_PIXEL_PNG }] }),
    /stale browser observation/,
  );
  await assert.rejects(
    store.record({ clientBuildId: 'course-live-test_01', sequence: 2, renderGeneration: 6, captures: [{ label: 'old render', dataUrl: ONE_PIXEL_PNG }] }),
    /renderGeneration must not go backwards/,
  );
  let revisionRead = 0;
  store.currentProjectRevision = async () => (++revisionRead === 1 ? revision : 'v4-feedbeef');
  await assert.rejects(
    store.record({ clientBuildId: 'course-live-test_01', sequence: 2, renderGeneration: 8, captures: [{ label: 'raced render', dataUrl: ONE_PIXEL_PNG }] }),
    /project advanced from .* while the browser observation was uploading/,
  );
  assert.equal(JSON.parse(await readFile(session.latestPath, 'utf8')).sequence, 1);

  await store.close('course-live-test_01');
  await assert.rejects(access(session.directory));
});

test('live observation build IDs reject traversal and repository-local storage', async () => {
  assert.throws(() => validateLiveBuildId('../../course'), /clientBuildId/);
  assert.throws(() => validateLiveBuildId('short'), /clientBuildId/);
  assert.equal(validateLiveBuildId('course-live_valid-123'), 'course-live_valid-123');
  assert.throws(
    () => new LiveObservationStore({ root: '/tmp/course-repository', observationRoot: '/tmp/course-repository/.observations' }),
    /outside the repository/,
  );
});

test('live course-agent exposes the concurrent observation endpoint and exact inbox protocol', async () => {
  const plugin = await readFile(new URL('../vite-plugin-course-agent.js', import.meta.url), 'utf8');
  const service = await readFile(new URL('../scripts/course-agent-service.mjs', import.meta.url), 'utf8');
  assert.match(plugin, /\/api\/course-agent\/build\/observation/);
  assert.match(plugin, /recordLiveObservation/);
  assert.match(plugin, /notifyStatus\(observation\.message, 'observation'\)/);
  assert.match(plugin, /event: 'course:changed', data: \{ projectRevision, renderRevision, sequence \}/);
  assert.match(service, /atomically published latest record is exactly/);
  assert.match(service, /strictly higher sequence/);
  assert.match(service, /projectRevision matches the current course\.project\.json revision/);
  assert.match(service, /Inspect the rendered images at every captures\[\]\.path/);
  assert.match(service, /at most 15 seconds total/);
});

test('a browser can publish an observation while the live Codex stream remains open', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'golfsim-live-service-repo-'));
  const observationRoot = await mkdtemp(join(tmpdir(), 'golfsim-live-service-store-'));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(observationRoot, { recursive: true, force: true });
  });
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);

  const service = new CourseAgentService({ root: repository, observationRoot });
  let agentPrompt = '';
  let observationPromise = null;
  let latestPath = '';
  service.codex = {
    startThread() {
      return {
        id: 'thread-live-observation-test',
        async runStreamed(input) {
          agentPrompt = input[0].text;
          return {
            events: (async function* events() {
              await observationPromise;
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed the live render.' } };
              yield { type: 'turn.completed' };
            }()),
          };
        },
      };
    },
  };

  const result = await service.liveBuild({
    clientBuildId: 'course-live-stream_01',
    prompt: 'Widen the first fairway and inspect it live.',
  }, {
    onEvent(event) {
      if (event.type !== 'observation') return;
      latestPath = event.observationPath;
      observationPromise = service.recordLiveObservation({
        clientBuildId: event.clientBuildId,
        sequence: 1,
        renderGeneration: 1,
        phase: 'Initial live render',
        captures: [{ label: 'Hole 1 tee', dataUrl: ONE_PIXEL_PNG }],
      });
    },
  });
  const observation = await observationPromise;
  assert.equal(result.clientBuildId, 'course-live-stream_01');
  assert.equal(observation.sequence, 1);
  assert.match(agentPrompt, new RegExp(latestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(agentPrompt, /highest ready sequence you have reviewed/);
  await assert.rejects(access(latestPath));
});

test('a direct live build rebases the ledger and remains undoable without overwriting the new project', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'golfsim-live-history-repo-'));
  const observationRoot = await mkdtemp(join(tmpdir(), 'golfsim-live-history-store-'));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(observationRoot, { recursive: true, force: true });
  });
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));
  const liveProject = structuredClone(project);
  liveProject.meta.name = 'Rebased live course';
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);

  const service = new CourseAgentService({ root: repository, observationRoot });
  service.codex = {
    startThread() {
      return {
        id: 'thread-live-history-test',
        async runStreamed() {
          await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(liveProject)}\n`);
          return { events: (async function* events() {
            yield { type: 'item.completed', item: { type: 'agent_message', text: 'Live edit complete.' } };
            yield { type: 'turn.completed' };
          }()) };
        },
      };
    },
  };

  const result = await service.liveBuild({
    clientBuildId: 'course-live-history_01', prompt: 'Rename and revise the course.',
  });
  assert.equal(result.state.project.meta.name, 'Rebased live course');
  assert.equal(result.state.state.history.length, 1);
  assert.equal(result.state.state.history[0].externalProjectCheckpoint, true);
  assert.equal(JSON.parse(await readFile(join(repository, 'course.project.json'), 'utf8')).meta.name, 'Rebased live course');

  await service.undo();
  assert.equal(JSON.parse(await readFile(join(repository, 'course.project.json'), 'utf8')).meta.name, project.meta.name);
  await service.redo();
  assert.equal(JSON.parse(await readFile(join(repository, 'course.project.json'), 'utf8')).meta.name, 'Rebased live course');
});

test('the browser supplies a full final tour and Codex receives a second adversarial review turn', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'golfsim-final-tour-repo-'));
  const observationRoot = await mkdtemp(join(tmpdir(), 'golfsim-final-tour-store-'));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(observationRoot, { recursive: true, force: true });
  });
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);
  const service = new CourseAgentService({ root: repository, observationRoot });
  const prompts = [];
  service.codex = {
    startThread() {
      return {
        id: 'thread-final-tour-test',
        async runStreamed(input) {
          prompts.push(input[0].text);
          return { events: (async function* events() {
            yield { type: 'item.completed', item: { type: 'agent_message', text: prompts.length === 1 ? 'Initial pass.' : 'Final tour accepted.' } };
            yield { type: 'turn.completed' };
          }()) };
        },
      };
    },
  };

  let finalObservation;
  const result = await service.liveBuild({
    clientBuildId: 'course-live-final-tour',
    prompt: 'Review the complete routed forest course.',
    captures: [{ label: 'initial', dataUrl: ONE_PIXEL_PNG }],
  }, {
    onEvent(event) {
      if (event.type !== 'review-request') return;
      finalObservation = service.recordLiveObservation({
        clientBuildId: event.clientBuildId,
        sequence: event.afterSequence + 1,
        renderGeneration: 9,
        revision: event.revision,
        renderRevision: event.renderRevision,
        phase: 'final-review',
        captures: [{ label: 'Complete route overview', dataUrl: ONE_PIXEL_PNG }],
      });
    },
  });
  await finalObservation;
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /final adversarial visual review/);
  assert.match(prompts[1], /Complete production-WebGPU tour/i);
  assert.equal(result.message, 'Final tour accepted.');
});
