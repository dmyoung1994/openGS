import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CourseAgentService } from '../scripts/course-agent-service.mjs';
import { buildAuthoringContext, queryTreeAssets } from '../scripts/lib/course-authoring-kernel.mjs';

function stream(message) {
  return (async function* events() {
    yield { type: 'item.completed', item: { type: 'agent_message', text: message } };
    yield { type: 'turn.completed' };
  }());
}

test('a bounded scene-control turn returns revision-tagged evidence to the same Codex thread', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'golfsim-control-repo-'));
  const observationRoot = await mkdtemp(join(tmpdir(), 'golfsim-control-observations-'));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(observationRoot, { recursive: true, force: true });
  });
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);
  const prompts = [];
  const service = new CourseAgentService({ root: repository, observationRoot });
  service.codex = {
    startThread() {
      return {
        id: 'thread-control-test',
        async runStreamed(input, options) {
          prompts.push(input[0].text);
          assert.ok(options.outputSchema.properties.control);
          const message = prompts.length === 1 ? JSON.stringify({
            kind: 'control', summary: 'Inspect the landing view.', question: null,
            control: {
              id: 'control-landing-01',
              actions: [{ type: 'set-view', holeId: null, view: 'landing', point: null, presentation: null, capture: 'current' }],
            },
          }) : JSON.stringify({ kind: 'complete', summary: 'Landing view accepted.', question: null, control: null });
          return { events: stream(message) };
        },
      };
    },
  };
  let evidence;
  const result = await service.liveBuild({ clientBuildId: 'course-live-control-01', prompt: 'Inspect the landing.' }, {
    onEvent(event) {
      if (event.type !== 'control-request') return;
      assert.equal(event.control.id, 'control-landing-01');
      evidence = service.recordLiveObservation({
        clientBuildId: event.clientBuildId,
        controlRequestId: event.control.id,
        sequence: event.afterSequence + 1,
        renderGeneration: 1,
        revision: event.revision,
        renderRevision: event.renderRevision,
        phase: 'agent-control',
        diagnostics: { renderer: { webgpuRenderer: true } },
        captures: [],
      });
    },
  });
  await evidence;
  assert.equal(result.awaitingInput, false);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /control-landing-01/);
  assert.match(prompts[1], /0 capture\(s\)/);
});

test('authoring context is compact, revision-tagged, and merges both tree catalogs', async () => {
  const context = await buildAuthoringContext(new URL('..', import.meta.url).pathname);
  const assets = await queryTreeAssets(new URL('..', import.meta.url).pathname);
  assert.equal(context.version, 1);
  assert.match(context.revision, /^v5-/);
  assert.equal(context.capabilities.source, 'course.project.json@v5');
  assert.ok(context.capabilities.controls.includes('present-trees'));
  assert.ok(assets.some(({ source }) => source === 'catalog'));
  assert.ok(assets.some(({ source, id }) => source === 'procedural' && id === 'imagegen-live-oak'));
  assert.equal('holes' in context.project.activeHole, false);
});

test('tree questions use select-then-confirm and disposable production-scene previews', async () => {
  const panel = await readFile(new URL('../src/ui/BuilderPanel.js', import.meta.url), 'utf8');
  const scene = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');
  assert.match(panel, /gb-question-confirm/);
  assert.match(panel, /_selectQuestionOption/);
  assert.match(panel, /_stageQuestionPresentation/);
  assert.match(panel, /controlRequestId: event\.control\.id/);
  assert.match(scene, /presentTreeCandidates/);
  assert.match(scene, /clearTreeCandidates/);
  assert.match(scene, /No safe rough-area lineup/);
  assert.match(scene, /treePresentationAnchors/);
  assert.match(scene, /rotY: 0, targetHeight/,
    'catalog previews must use the production tree placement contract');
  assert.match(scene, /this\._treePresentation\?\.line\.treeBeauties/,
    'temporary catalog candidates must run the same GPU-indirect update as course trees');
  assert.match(panel, /_showTreePresentationLabels/);
  assert.match(panel, /button\.style\.left = `\$\{Math\.round/,
    'comparison labels remain crisp DOM controls instead of filtered scene textures');
  assert.match(scene, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(scene, /onSubmittedWorkDone/);
});
