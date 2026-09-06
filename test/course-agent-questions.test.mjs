import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CourseAgentService } from '../scripts/course-agent-service.mjs';

function questionEnvelope() {
  return JSON.stringify({
    kind: 'question',
    summary: 'Choose the forest-floor character before I place the understory.',
    question: {
      prompt: 'How wild should the pine floor feel around the playable corridor?',
      recommendationOptionId: 'natural',
      recommendationReason: 'It keeps the forest immersive without hiding recovery lines.',
      options: [
        { id: 'natural', label: 'Natural', description: 'Pine straw, ferns, and controlled gaps.' },
        { id: 'manicured', label: 'Manicured', description: 'Cleaner floor and broader recovery visibility.' },
        { id: 'wild', label: 'Wild', description: 'Dense understory with narrow recovery windows.' },
      ],
    },
  });
}

function eventStream(message) {
  return (async function* events() {
    yield { type: 'item.completed', item: { type: 'agent_message', text: message } };
    yield { type: 'turn.completed', usage: null };
  }());
}

test('structured live question persists, survives restart, rejects stale answers, and resumes the same SDK thread', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'golfsim-question-repo-'));
  const observationRoot = await mkdtemp(join(tmpdir(), 'golfsim-question-observations-'));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(observationRoot, { recursive: true, force: true });
  });
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);

  const service = new CourseAgentService({ root: repository, observationRoot });
  service.codex = {
    startThread() {
      return {
        id: 'thread-live-question-test',
        async runStreamed(_input, options) {
          assert.ok(options.outputSchema, 'live turns must require a structured result envelope');
          return { events: eventStream(questionEnvelope()) };
        },
      };
    },
  };
  const streamed = [];
  const paused = await service.liveBuild({
    clientBuildId: 'course-live-question_01',
    prompt: 'Build a forest course and ask only if a meaningful design choice blocks you.',
  }, { onEvent: (event) => streamed.push(event) });

  assert.equal(paused.awaitingInput, true);
  assert.equal(paused.question.clientBuildId, 'course-live-question_01');
  assert.equal(paused.question.question.options.length, 3);
  assert.equal(paused.question.question.recommendation.optionId, 'natural');
  assert.equal(streamed.at(-1).type, 'question');
  const pendingPath = join(repository, '.course-builder', 'pending-live-build.json');
  const persisted = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert.equal(persisted.threadId, 'thread-live-question-test');
  assert.equal(persisted.question.id, paused.question.questionId);

  const restarted = new CourseAgentService({ root: repository, observationRoot });
  let resumedThreadId = null;
  let resumedPrompt = '';
  restarted.codex = {
    resumeThread(threadId, options) {
      resumedThreadId = threadId;
      assert.equal(options.workingDirectory, repository);
      assert.equal(options.sandboxMode, 'workspace-write');
      return {
        id: threadId,
        async runStreamed(input, turnOptions) {
          resumedPrompt = input[0].text;
          assert.ok(turnOptions.outputSchema);
          return { events: eventStream(JSON.stringify({ kind: 'complete', summary: 'Forest floor applied.', question: null })) };
        },
      };
    },
  };
  const restoredState = await restarted.state();
  const pending = restoredState.pendingLiveBuild;
  assert.equal(pending.questionId, paused.question.questionId);

  await assert.rejects(restarted.answerLiveBuild({
    clientBuildId: 'course-live-wrong_01', questionId: pending.questionId,
    revision: pending.revision, optionId: 'natural',
  }), /stale live build answer: build ID/);
  await assert.rejects(restarted.answerLiveBuild({
    clientBuildId: pending.clientBuildId, questionId: 'question-wrong-answer-id',
    revision: pending.revision, optionId: 'natural',
  }), /stale live build answer: question ID/);
  await assert.rejects(restarted.answerLiveBuild({
    clientBuildId: pending.clientBuildId, questionId: pending.questionId,
    revision: 'v4-stale000', optionId: 'natural',
  }), /stale live build answer: project revision/);

  const advanced = structuredClone(project);
  advanced.meta.name = `${advanced.meta.name} advanced`;
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(advanced)}\n`);
  await assert.rejects(restarted.answerLiveBuild({
    clientBuildId: pending.clientBuildId, questionId: pending.questionId,
    revision: pending.revision, optionId: 'natural',
  }), /project advanced/);
  await writeFile(join(repository, 'course.project.json'), `${JSON.stringify(project)}\n`);

  const completed = await restarted.answerLiveBuild({
    clientBuildId: pending.clientBuildId,
    questionId: pending.questionId,
    revision: pending.revision,
    optionId: 'other',
    answer: 'Keep the pine straw natural but make recovery windows obvious.',
  });
  assert.equal(completed.awaitingInput, false);
  assert.equal(resumedThreadId, 'thread-live-question-test');
  assert.match(resumedPrompt, /same live Course Creator build/);
  assert.match(resumedPrompt, /recovery windows obvious/);
  await assert.rejects(access(pendingPath));
  assert.equal((await restarted.state()).pendingLiveBuild, null);
});

test('question contract expands the existing bottom status and prompt component upward', async () => {
  const panel = await readFile(new URL('../src/ui/BuilderPanel.js', import.meta.url), 'utf8');
  const plugin = await readFile(new URL('../vite-plugin-course-agent.js', import.meta.url), 'utf8');
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /id="gb-updates"|>Updates</);
  assert.match(panel, /class="gb-status-panel glass" id="gb-status-panel"/);
  assert.match(panel, /id="gb-status"[^>]*aria-controls="gb-status-details"/);
  assert.match(panel, /id="gb-update-timeline"/);
  assert.match(panel, /id="gb-status-details" aria-hidden="true"/);
  assert.match(panel, /id="gb-status-details"[\s\S]*id="gb-question"[\s\S]*id="gb-prompt"/);
  assert.match(panel, /\.gb-thread\{position:absolute[\s\S]*bottom:151px/);
  assert.match(panel, /\.gb-status-panel\{pointer-events:auto[\s\S]*max-height:calc\(100vh - 112px\)/);
  assert.match(panel, /\.gb-status-details\{display:none;max-height:min\(58vh,430px\)/);
  assert.match(panel, /\.gb-status-panel\.open \.gb-status-details\{display:block\}/);
  assert.match(panel, /this\.statusCopyEl\.textContent = copy;[\s\S]*this\._appendUpdate\(copy, kind\)/);
  assert.match(panel, /this\._setStatusOpen\(true\)/);
  assert.match(panel, /this\._setStatusOpen\(false\)/);
  assert.match(panel, /question\.options/);
  assert.match(panel, /question\.recommendation\.optionId/);
  assert.match(panel, />Other</);
  assert.match(panel, /\/api\/course-agent\/build\/answer/);
  assert.match(plugin, /url\.endsWith\('\/answer'\)/);
  assert.match(ignore, /^\.course-builder\/$/m);
});
