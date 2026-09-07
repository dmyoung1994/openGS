import { savePlantAsset } from './lib/plant-library.mjs';
import { normalizeTreeDefinition } from '../src/trees/TreeDefinition.js';
import { Codex } from '@openai/codex-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { applyCourseMutations, compileActiveCourse, projectRevision } from '../src/course/CourseProject.js';
import { emptyState, ProposalLedger, normalizeProposal } from '../src/course/ProposalLedger.js';
import { buildAuthoringContext } from './lib/course-authoring-kernel.mjs';
import { CourseHistoryStore } from './lib/course-history-store.mjs';

const ITEM_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, title: { type: 'string' }, rationale: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } },
    mutation: {
      type: 'object', additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['create', 'replace', 'delete'] },
        entityType: { type: 'string', enum: ['project', 'site', 'atmosphere', 'surface-materials', 'hole', 'route', 'tee', 'green', 'bunker', 'pond', 'landform', 'forest-floor-area', 'environment-object', 'procedural-tree-definition', 'procedural-tree'] },
        entityId: { type: 'string' }, parentId: { type: ['string', 'null'] }, valueJson: { type: ['string', 'null'] },
      }, required: ['op', 'entityType', 'entityId', 'parentId', 'valueJson'],
    },
  }, required: ['id', 'title', 'rationale', 'dependencies', 'mutation'],
};
const PROPOSAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, summary: { type: 'string' },
    items: { type: 'array', minItems: 1, items: ITEM_SCHEMA },
  }, required: ['id', 'summary', 'items'],
};

const TREE_CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    optionId: { type: 'string' }, label: { type: 'string' },
    source: { type: 'string', enum: ['catalog', 'procedural'] },
    assetId: { type: ['string', 'null'] }, definitionUrl: { type: ['string', 'null'] },
    referenceUrl: { type: ['string', 'null'] }, scale: { type: ['number', 'null'] },
  },
  required: ['optionId', 'label', 'source', 'assetId', 'definitionUrl', 'referenceUrl', 'scale'],
};
const TREE_PRESENTATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['tree-comparison'] },
    holeId: { type: ['string', 'null'] },
    anchor: {
      type: ['object', 'null'], additionalProperties: false,
      properties: { x: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'],
    },
    candidates: { type: 'array', minItems: 1, maxItems: 3, items: TREE_CANDIDATE_SCHEMA },
  },
  required: ['kind', 'holeId', 'anchor', 'candidates'],
};
const CONTROL_ACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['select-hole', 'set-view', 'present-trees', 'clear-preview', 'observe'] },
    holeId: { type: ['string', 'null'] },
    view: { type: ['string', 'null'], enum: ['current', 'tee', 'landing', 'approach', 'overview', 'point', null] },
    point: {
      type: ['object', 'null'], additionalProperties: false,
      properties: { x: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'],
    },
    presentation: { ...TREE_PRESENTATION_SCHEMA, type: ['object', 'null'] },
    capture: { type: 'string', enum: ['none', 'current', 'review'] },
  },
  required: ['type', 'holeId', 'view', 'point', 'presentation', 'capture'],
};

// A live workspace turn always finishes with a small machine-readable envelope.
// "control" resumes automatically after the production browser returns evidence;
// "question" is terminal until the user answers it.
const LIVE_TURN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['complete', 'question', 'control'] },
    summary: { type: 'string' },
    question: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        prompt: { type: 'string' },
        recommendationOptionId: { type: 'string' },
        recommendationReason: { type: 'string' },
        options: {
          type: 'array', minItems: 2, maxItems: 3,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' },
            },
            required: ['id', 'label', 'description'],
          },
        },
        presentation: { ...TREE_PRESENTATION_SCHEMA, type: ['object', 'null'] },
      },
      required: ['prompt', 'recommendationOptionId', 'recommendationReason', 'options', 'presentation'],
    },
    control: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        id: { type: 'string' },
        actions: { type: 'array', minItems: 1, maxItems: 4, items: CONTROL_ACTION_SCHEMA },
      },
      required: ['id', 'actions'],
    },
  },
  required: ['kind', 'summary', 'question', 'control'],
};

const LIVE_BUILD_ID_RE = /^[a-z0-9][a-z0-9_-]{7,95}$/i;
const MAX_OBSERVATION_CAPTURES = 8;
const MAX_CONTROL_ROUNDS = 6;
const MAX_OBSERVATION_IMAGE_BYTES = 8 * 1024 * 1024;
function liveThreadOptions(root) {
  return {
    workingDirectory: root,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    webSearchMode: 'live',
    modelReasoningEffort: 'high',
    threadSource: 'claude-golfsim-course-builder',
  };
}

export class LiveObservationStore {
  constructor({ root, observationRoot = join(tmpdir(), 'claude-golfsim-course-observations') } = {}) {
    this.root = resolve(root);
    this.observationRoot = resolve(observationRoot);
    if (this.observationRoot === this.root || this.observationRoot.startsWith(`${this.root}${sep}`)) {
      throw new Error('live observation storage must be outside the repository');
    }
    this.sessions = new Map();
  }

  async open(clientBuildId = null) {
    const buildId = validateLiveBuildId(clientBuildId ?? `course-live-${randomUUID()}`);
    if (this.sessions.has(buildId)) throw new Error(`live build observation session "${buildId}" is already active`);
    const projectRevision = await this.currentProjectRevision();
    const renderRevision = await this.currentRenderRevision();
    await mkdir(this.observationRoot, { recursive: true });
    const directory = join(this.observationRoot, buildId);
    const session = {
      buildId,
      directory,
      latestPath: join(directory, 'latest.json'),
      lastSequence: 0,
      lastRenderGeneration: -1,
      waiters: [],
      pending: Promise.resolve(),
    };
    try {
      await mkdir(directory);
      await mkdir(join(directory, 'images'));
      await atomicWriteJson(session.latestPath, {
        version: 1,
        buildId,
        state: 'waiting-for-browser-checkpoint',
        sequence: 0,
        projectRevision,
        renderRevision,
        captureCount: 0,
        captures: [],
      });
      this.sessions.set(buildId, session);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return publicObservationSession(session, projectRevision, renderRevision);
  }

  async record(input, { beforePublish = null } = {}) {
    const buildId = validateLiveBuildId(input?.clientBuildId);
    const session = this.sessions.get(buildId);
    if (!session) throw new Error(`live build observation session "${buildId}" is not active`);
    const operation = session.pending.then(() => this._record(session, input, beforePublish));
    session.pending = operation.catch(() => {});
    return operation;
  }

  async close(clientBuildId) {
    const buildId = validateLiveBuildId(clientBuildId);
    const session = this.sessions.get(buildId);
    if (!session) return;
    this.sessions.delete(buildId);
    for (const waiter of session.waiters.splice(0)) waiter.resolve(null);
    await session.pending;
    await rm(session.directory, { recursive: true, force: true });
  }

  async waitForNext(clientBuildId, afterSequence, { timeoutMs = 8000 } = {}) {
    const buildId = validateLiveBuildId(clientBuildId);
    const session = this.sessions.get(buildId);
    if (!session) throw new Error(`live build observation session "${buildId}" is not active`);
    if (session.lastSequence > afterSequence) return JSON.parse(await readFile(session.latestPath, 'utf8'));
    return new Promise((resolveWait) => {
      const waiter = { afterSequence, resolve: resolveWait, timer: null };
      waiter.timer = setTimeout(() => {
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolveWait(null);
      }, timeoutMs);
      session.waiters.push(waiter);
    });
  }

  latestSequence(clientBuildId) {
    const buildId = validateLiveBuildId(clientBuildId);
    const session = this.sessions.get(buildId);
    if (!session) throw new Error(`live build observation session "${buildId}" is not active`);
    return session.lastSequence;
  }

  async _record(session, input, beforePublish) {
    const sequence = input?.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('observation sequence must be a positive safe integer');
    if (sequence <= session.lastSequence) throw new Error(`observation sequence must advance beyond ${session.lastSequence}`);
    const renderGeneration = input.renderGeneration ?? sequence;
    if (!Number.isSafeInteger(renderGeneration) || renderGeneration < 0) throw new Error('observation renderGeneration must be a non-negative safe integer');
    if (renderGeneration < session.lastRenderGeneration) throw new Error(`observation renderGeneration must not go backwards from ${session.lastRenderGeneration}`);

    const revision = await this.currentProjectRevision();
    if (input.revision != null && input.revision !== revision) {
      throw new Error(`stale browser observation for revision ${input.revision}; current project revision is ${revision}`);
    }
    const renderRevision = await this.currentRenderRevision();
    if (input.renderRevision != null && input.renderRevision !== renderRevision) {
      throw new Error(`stale browser render ${input.renderRevision}; current render revision is ${renderRevision}`);
    }
    if (!Array.isArray(input.captures) || input.captures.length > MAX_OBSERVATION_CAPTURES) {
      throw new Error(`observation captures must contain 0-${MAX_OBSERVATION_CAPTURES} rendered views`);
    }

    const prefix = String(sequence).padStart(6, '0');
    const captures = [];
    for (let index = 0; index < input.captures.length; index += 1) {
      const capture = input.captures[index];
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(capture?.dataUrl ?? '');
      if (!match) throw new Error(`observation capture ${index} is not a supported image data URL`);
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > MAX_OBSERVATION_IMAGE_BYTES) throw new Error(`observation capture ${index} must be 1 byte-${MAX_OBSERVATION_IMAGE_BYTES} bytes`);
      const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
      const label = boundedString(capture.label, `View ${index + 1}`, 100);
      const imagePath = join(session.directory, 'images', `${prefix}-${String(index + 1).padStart(2, '0')}-${safeName(label)}.${extension}`);
      await atomicWrite(imagePath, bytes);
      captures.push({
        label,
        path: imagePath,
        ...(capture.holeId == null ? {} : { holeId: boundedString(capture.holeId, null, 100) }),
        ...(capture.camera == null ? {} : { camera: boundedJsonObject(capture.camera, `captures[${index}].camera`) }),
      });
    }

    const observation = {
      version: 1,
      buildId: session.buildId,
      state: 'ready',
      sequence,
      renderGeneration,
      projectRevision: revision,
      renderRevision,
      capturedAt: new Date().toISOString(),
      captureCount: captures.length,
      captures,
      ...(input.phase == null ? {} : { phase: boundedString(input.phase, null, 100) }),
      ...(input.summary == null ? {} : { summary: boundedString(input.summary, null, 300) }),
      ...(input.activeHoleId == null ? {} : { activeHoleId: boundedString(input.activeHoleId, null, 100) }),
      ...(input.controlRequestId == null ? {} : { controlRequestId: normalizeControlId(input.controlRequestId) }),
      ...(input.diagnostics == null ? {} : { diagnostics: boundedJsonObject(input.diagnostics, 'diagnostics') }),
    };
    const publishRevision = await this.currentProjectRevision();
    if (publishRevision !== revision) {
      throw new Error(`project advanced from ${revision} to ${publishRevision} while the browser observation was uploading; capture the settled scene again`);
    }
    const publishRenderRevision = await this.currentRenderRevision();
    if (publishRenderRevision !== renderRevision) {
      throw new Error(`render inputs advanced from ${renderRevision} to ${publishRenderRevision} while the browser observation was uploading; capture the settled scene again`);
    }
    const publishMetadata = beforePublish ? await beforePublish(observation) : null;
    const observationPath = join(session.directory, `observation-${prefix}.json`);
    await atomicWriteJson(observationPath, observation);
    await atomicWriteJson(session.latestPath, { ...observation, observationPath });
    session.lastSequence = sequence;
    session.lastRenderGeneration = renderGeneration;
    for (const waiter of [...session.waiters]) {
      if (sequence <= waiter.afterSequence) continue;
      clearTimeout(waiter.timer);
      session.waiters.splice(session.waiters.indexOf(waiter), 1);
      waiter.resolve({ ...observation, observationPath });
    }
    return {
      buildId: session.buildId,
      sequence,
      revision,
      renderRevision,
      renderGeneration,
      captureCount: captures.length,
      observationPath,
      latestPath: session.latestPath,
      message: `Published live render checkpoint ${sequence} for ${revision} (${captures.length} ${captures.length === 1 ? 'view' : 'views'}).`,
      ...(publishMetadata && typeof publishMetadata === 'object' ? publishMetadata : {}),
    };
  }

  async currentProjectRevision() {
    const project = JSON.parse(await readFile(join(this.root, 'course.project.json'), 'utf8'));
    return projectRevision(project);
  }

  async currentRenderRevision() {
    const hash = createHash('sha256');
    for (const relative of [
      'course.json',
      'public/assets/environment/catalog.json',
      'public/assets/procedural-trees/catalog.json',
      'public/assets/visual-quality-manifest.json',
    ]) {
      hash.update(relative);
      try { hash.update(await readFile(join(this.root, relative))); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        hash.update('<missing>');
      }
    }
    return `render-${hash.digest('hex').slice(0, 16)}`;
  }
}

export class CourseAgentService {
  constructor({ root, onRuntimeChanged = () => {}, observationRoot } = {}) {
    this.root = resolve(root);
    this.store = new CourseHistoryStore({ root: this.root });
    this.onRuntimeChanged = onRuntimeChanged;
    this.threads = new Map();
    this.builds = new Map();
    this.liveThread = null;
    this.liveBuildRunning = false;
    this.activeLiveBuild = null;
    this.pendingLiveBuild = null;
    this.pendingLiveBuildPath = join(this.root, '.course-builder', 'pending-live-build.json');
    this.pendingLiveBuildPromise = this._loadPendingLiveBuild();
    this.observations = new LiveObservationStore({ root: this.root, observationRoot });
    this.codex = new Codex({
      config: { show_raw_agent_reasoning: false },
    });
    this.ledgerPromise = this.store.load();
  }

  async state() {
    await this.pendingLiveBuildPromise;
    return {
      ...(await this.ledgerPromise).snapshot(),
      pendingLiveBuild: this.pendingLiveBuild ? publicPendingLiveBuild(this.pendingLiveBuild) : null,
    };
  }

  async _runLiveTurn(input, { observation, onEvent, signal }) {
    let nextInput = input;
    for (let round = 0; round <= MAX_CONTROL_ROUNDS; round += 1) {
      let finalMessage = '';
      const { events } = await this.liveThread.runStreamed(nextInput, { signal, outputSchema: LIVE_TURN_SCHEMA });
      for await (const event of events) {
        const update = summarizeLiveEvent(event, this.root);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') finalMessage = event.item.text;
        if (event.type === 'turn.failed') throw new Error(event.error.message);
        if (event.type === 'error') throw new Error(event.message);
        if (update) onEvent(update);
      }
      const disposition = decodeLiveTurn(finalMessage);
      if (disposition.kind !== 'control') return { finalMessage, disposition };
      if (round === MAX_CONTROL_ROUNDS) throw new Error(`live scene control exceeded ${MAX_CONTROL_ROUNDS} rounds`);
      const afterSequence = this.observations.latestSequence(observation.buildId);
      onEvent({
        type: 'control-request',
        message: disposition.summary || 'Codex is inspecting the live course scene.',
        clientBuildId: observation.buildId,
        afterSequence,
        revision: await this.currentProjectRevision(),
        renderRevision: await this.currentRenderRevision(),
        control: disposition.control,
      });
      const result = await this._waitForControlObservation(observation.buildId, disposition.control.id, afterSequence);
      nextInput = [{ type: 'text', text: controlResultPrompt(disposition.control, result) }];
    }
    throw new Error('unreachable live scene control state');
  }

  async _waitForControlObservation(buildId, requestId, afterSequence) {
    const deadline = Date.now() + 15_000;
    let sequence = afterSequence;
    while (Date.now() < deadline) {
      const result = await this.observations.waitForNext(buildId, sequence, { timeoutMs: Math.max(1, deadline - Date.now()) });
      if (!result) break;
      sequence = result.sequence;
      if (result.controlRequestId === requestId) return result;
    }
    throw new Error(`the browser did not return scene-control evidence for "${requestId}" within 15 seconds`);
  }

  async liveBuild({ prompt, captures = [], selection = null, clientBuildId = null }, { onEvent = () => {}, signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    await this.pendingLiveBuildPromise;
    if (this.pendingLiveBuild) throw new Error('this course build is waiting for an answer; answer or reset it before starting another build');
    if (this.liveBuildRunning) throw new Error('another live course build is already running');
    this.liveBuildRunning = true;
    let ledger = null;
    let observation = null;
    let workspace = null;
    let finalMessage = '';
    let disposition = null;
    let state = null;
    let reconciliationAttempted = false;
    try {
      ledger = await this.ledgerPromise;
      observation = await this.observations.open(clientBuildId);
      this.activeLiveBuild = {
        buildId: observation.buildId,
        ledger,
        prompt,
        reconcileQueue: Promise.resolve(),
      };
      workspace = await this._workspace(ledger, captures, { selection });
      onEvent({
        type: 'observation',
        message: 'Live visual review inbox is ready; browser renders will be attached after each valid checkpoint.',
        clientBuildId: observation.buildId,
        observationPath: observation.latestPath,
        revision: observation.projectRevision,
        renderRevision: observation.renderRevision,
      });
      if (!this.liveThread) this.liveThread = this.codex.startThread({
        ...liveThreadOptions(this.root),
        // Keep the workspace boundary explicit at the call site as well as in the
        // shared resume options; this is the security-critical contrast to reviews.
        workingDirectory: this.root,
      });
      const context = await buildAuthoringContext(this.root, { selection: sanitizeSelection(selection), state: ledger.state });
      const input = [
        { type: 'text', text: liveBuildPrompt(prompt, context, observation) },
        ...workspace.images.map((path) => ({ type: 'local_image', path })),
      ];
      ({ finalMessage, disposition } = await this._runLiveTurn(input, { observation, onEvent, signal }));
      if (captures.length && disposition.kind === 'complete') {
        const afterSequence = this.observations.latestSequence(observation.buildId);
        onEvent({
          type: 'review-request',
          message: 'Capturing the complete final tee, decision, approach, and overview tour for Codex review.',
          clientBuildId: observation.buildId,
          afterSequence,
          revision: await this.currentProjectRevision(),
          renderRevision: await this.currentRenderRevision(),
        });
        const finalObservation = await this.observations.waitForNext(observation.buildId, afterSequence);
        if (finalObservation) {
          ({ finalMessage, disposition } = await this._runLiveTurn([{
            type: 'text',
            text: finalLiveReviewPrompt(finalObservation),
          }], { observation, onEvent, signal }));
        } else onEvent({
          type: 'warning',
          message: 'The final full-course render tour did not arrive in time; retaining the validated workspace result.',
        });
      }
      reconciliationAttempted = true;
      await this.activeLiveBuild.reconcileQueue;
      state = await this._reconcileLiveProject({
        ledger,
        beforeRevision: projectRevision(ledger.project),
        clientBuildId: observation.buildId,
        prompt,
        threadId: this.liveThread.id,
      });
      if (disposition.kind === 'question') {
        const pending = await this._persistPendingLiveBuild({
          buildId: observation.buildId,
          threadId: this.liveThread.id,
          projectRevision: await this.currentProjectRevision(),
          prompt: prompt.trim(),
          selection: sanitizeSelection(selection),
          hasCaptures: captures.length > 0,
          question: disposition.question,
        });
        const question = publicPendingLiveBuild(pending);
        onEvent({
          type: 'question',
          message: disposition.summary || question.question.prompt,
          ...question,
        });
        return {
          clientBuildId: observation.buildId,
          threadId: this.liveThread.id,
          awaitingInput: true,
          message: disposition.summary || 'Codex needs one design decision to continue.',
          question,
          state,
        };
      }
      return {
        clientBuildId: observation.buildId,
        threadId: this.liveThread.id,
        awaitingInput: false,
        message: disposition.summary || cleanStatus(finalMessage) || 'Course build finished.',
        state,
      };
    } finally {
      try {
        if (ledger && observation && !reconciliationAttempted) {
          await this.activeLiveBuild?.reconcileQueue;
          await this._reconcileLiveProject({
            ledger,
            beforeRevision: projectRevision(ledger.project),
            clientBuildId: observation.buildId,
            prompt,
            threadId: this.liveThread?.id ?? null,
          });
        }
      } finally {
        if (workspace) await rm(workspace.directory, { recursive: true, force: true });
        if (observation) await this.observations.close(observation.buildId);
        this.activeLiveBuild = null;
        this.liveBuildRunning = false;
      }
    }
  }

  async answerLiveBuild({ clientBuildId, questionId, revision, optionId, answer = null }, { onEvent = () => {}, signal } = {}) {
    await this.pendingLiveBuildPromise;
    const pending = this.pendingLiveBuild;
    if (!pending) throw new Error('there is no live course question awaiting an answer');
    validateLiveBuildId(clientBuildId);
    if (clientBuildId !== pending.buildId) throw new Error('stale live build answer: build ID does not match the pending session');
    if (questionId !== pending.question.id) throw new Error('stale live build answer: question ID does not match the pending question');
    if (revision !== pending.projectRevision) throw new Error('stale live build answer: project revision does not match the pending question');
    const currentRevision = await this.currentProjectRevision();
    if (currentRevision !== pending.projectRevision) {
      throw new Error(`stale live build answer: project advanced from ${pending.projectRevision} to ${currentRevision}`);
    }
    const selected = decodeQuestionAnswer(pending.question, optionId, answer);
    if (this.liveBuildRunning) throw new Error('another live course build is already running');

    this.liveBuildRunning = true;
    let ledger = null;
    let observation = null;
    let finalMessage = '';
    let disposition = null;
    let reconciliationAttempted = false;
    try {
      ledger = await this.ledgerPromise;
      observation = await this.observations.open(pending.buildId);
      this.activeLiveBuild = {
        buildId: pending.buildId,
        ledger,
        prompt: pending.prompt,
        reconcileQueue: Promise.resolve(),
      };
      onEvent({
        type: 'observation',
        message: 'Design answer received; live visual review is connected for the resumed build.',
        clientBuildId: observation.buildId,
        observationPath: observation.latestPath,
        revision: observation.projectRevision,
        renderRevision: observation.renderRevision,
      });
      if (!this.liveThread || this.liveThread.id !== pending.threadId) {
        this.liveThread = this.codex.resumeThread(pending.threadId, liveThreadOptions(this.root));
      }
      ({ finalMessage, disposition } = await this._runLiveTurn([{
        type: 'text',
        text: liveAnswerPrompt(pending.question, selected),
      }], { observation, onEvent, signal }));

      if (pending.hasCaptures && disposition.kind === 'complete') {
        const afterSequence = this.observations.latestSequence(observation.buildId);
        onEvent({
          type: 'review-request',
          message: 'Capturing the complete final tee, decision, approach, and overview tour for Codex review.',
          clientBuildId: observation.buildId,
          afterSequence,
          revision: await this.currentProjectRevision(),
          renderRevision: await this.currentRenderRevision(),
        });
        const finalObservation = await this.observations.waitForNext(observation.buildId, afterSequence);
        if (finalObservation) {
          ({ finalMessage, disposition } = await this._runLiveTurn([{
            type: 'text', text: finalLiveReviewPrompt(finalObservation),
          }], { observation, onEvent, signal }));
        } else onEvent({ type: 'warning', message: 'The final render tour did not arrive in time; retaining the validated workspace result.' });
      }

      reconciliationAttempted = true;
      await this.activeLiveBuild.reconcileQueue;
      const state = await this._reconcileLiveProject({
        ledger,
        beforeRevision: projectRevision(ledger.project),
        clientBuildId: liveHistoryId('answer', pending.buildId, pending.question.id),
        prompt: pending.prompt,
        threadId: pending.threadId,
        metadata: {
          questionId: pending.question.id,
          optionId: selected.optionId,
          decision: selected.answer ?? selected.label,
        },
      });
      if (disposition.kind === 'question') {
        const nextPending = await this._persistPendingLiveBuild({
          ...pending,
          projectRevision: await this.currentProjectRevision(),
          question: disposition.question,
        });
        const question = publicPendingLiveBuild(nextPending);
        onEvent({ type: 'question', message: disposition.summary || question.question.prompt, ...question });
        return {
          clientBuildId: pending.buildId, threadId: pending.threadId, awaitingInput: true,
          message: disposition.summary || 'Codex needs one more design decision to continue.', question, state,
        };
      }
      await this._clearPendingLiveBuild();
      return {
        clientBuildId: pending.buildId, threadId: pending.threadId, awaitingInput: false,
        message: disposition.summary || cleanStatus(finalMessage) || 'Course build finished.', state,
      };
    } finally {
      try {
        if (ledger && observation && !reconciliationAttempted) {
          await this.activeLiveBuild?.reconcileQueue;
          await this._reconcileLiveProject({
            ledger,
            beforeRevision: projectRevision(ledger.project),
            clientBuildId: liveHistoryId('interrupted', pending.buildId, pending.question.id),
            prompt: pending.prompt,
            threadId: pending.threadId,
          });
        }
      } finally {
        if (observation) await this.observations.close(observation.buildId);
        this.activeLiveBuild = null;
        this.liveBuildRunning = false;
      }
    }
  }

  async _loadPendingLiveBuild() {
    try {
      const value = JSON.parse(await readFile(this.pendingLiveBuildPath, 'utf8'));
      this.pendingLiveBuild = validatePendingLiveBuild(value);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`pending live course build is invalid: ${error?.message || String(error)}`);
    }
  }

  async _persistPendingLiveBuild(value) {
    const question = normalizeLiveQuestion(value.question);
    const pending = validatePendingLiveBuild({
      version: 1,
      buildId: value.buildId,
      threadId: value.threadId,
      projectRevision: value.projectRevision,
      prompt: value.prompt,
      selection: value.selection ?? null,
      hasCaptures: value.hasCaptures === true,
      question,
      updatedAt: new Date().toISOString(),
    });
    await mkdir(join(this.root, '.course-builder'), { recursive: true });
    await atomicWriteJson(this.pendingLiveBuildPath, pending);
    this.pendingLiveBuild = pending;
    return pending;
  }

  async _clearPendingLiveBuild() {
    this.pendingLiveBuild = null;
    await rm(this.pendingLiveBuildPath, { force: true });
  }

  async _reconcileLiveProject({ ledger, beforeRevision, clientBuildId, prompt, threadId, metadata = {} }) {
    if (projectRevision(ledger.project) !== beforeRevision) {
      throw new Error('course history changed while the live build was running; refusing to overwrite either project head');
    }
    const diskLedger = await this.store.load();
    const change = ledger.recordExternalProjectChange({
      id: clientBuildId,
      summary: `Live build: ${prompt.trim().slice(0, 220)}`,
      title: 'Live course build checkpoint',
      rationale: 'Groups the direct workspace turn into one reversible history boundary.',
      threadId,
      project: diskLedger.project,
      metadata: { intent: prompt.trim().slice(0, 500), ...metadata },
    });
    if (change) await this.store.saveHistory(ledger);
    this.ledgerPromise = Promise.resolve(ledger);
    return ledger.snapshot();
  }

  async recordLiveObservation(input) {
    const active = this.activeLiveBuild;
    return this.observations.record(input, { beforePublish: !active || active.buildId !== input?.clientBuildId || input.phase === 'render-failed'
      ? null
      : async (observation) => {
      const state = await this._reconcileLiveProject({
        ledger: active.ledger,
        beforeRevision: projectRevision(active.ledger.project),
        clientBuildId: `${active.buildId}-checkpoint-${observation.sequence}`,
        prompt: `${active.prompt} (render checkpoint ${observation.sequence})`,
        threadId: this.liveThread?.id ?? null,
      });
      return { historyRevision: state.revision };
    } });
  }

  async currentProjectRevision() {
    return this.observations.currentProjectRevision();
  }

  async currentRenderRevision() {
    return this.observations.currentRenderRevision();
  }

  async resetLiveThread() {
    if (this.liveBuildRunning) throw new Error('cannot start a new conversation while a live build is running');
    await this.pendingLiveBuildPromise;
    await this._clearPendingLiveBuild();
    this.liveThread = null;
    return { reset: true };
  }

  async startBuild({ prompt, captures = [], selection = null }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    const ledger = await this.ledgerPromise;
    const workspace = await this._workspace(ledger, captures, { selection });
    const id = `course-build-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    const stages = createIterativeBuildStages(prompt, ledger.project);
    this.builds.set(id, {
      id, prompt: prompt.trim(), selection: sanitizeSelection(selection), stages, index: 0,
      directory: workspace.directory, images: workspace.images, thread: null,
      baseProject: ledger.project, baseRevision: projectRevision(ledger.project),
      workingProject: ledger.project, items: [], priorStageItemIds: [], running: false,
    });
    return { build: { id, stages: stages.map(({ id: stageId, label }) => ({ id: stageId, label })), index: 0 } };
  }

  async nextBuild({ buildId, captures = [], selection = null }) {
    const build = this.builds.get(buildId);
    if (!build) throw new Error('iterative build session does not exist');
    if (build.running) throw new Error('iterative build stage is already running');
    const ledger = await this.ledgerPromise;
    if (projectRevision(ledger.project) !== build.baseRevision) {
      await this._disposeBuild(buildId);
      throw new Error('the course changed while the iterative build was running; start again from the current course');
    }
    const stage = build.stages[build.index];
    if (!stage) throw new Error('iterative build has no remaining stage');
    build.running = true;
    try {
      const workspace = await this._refreshBuildWorkspace(build, captures, selection, stage);
      if (!build.thread) build.thread = this.codex.startThread({
        workingDirectory: build.directory,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        modelReasoningEffort: 'high',
        threadSource: 'claude-golfsim-course-builder',
      });
      const turn = await build.thread.run([
        { type: 'text', text: iterativeStagePrompt(build, stage) },
        ...workspace.images.map((path) => ({ type: 'local_image', path })),
      ], { outputSchema: PROPOSAL_SCHEMA });
      let stageProposal = decodeProposal(turn.finalResponse, projectRevision(build.workingProject), build.thread.id);
      stageProposal = namespaceStageProposal(stageProposal, stage, build.items);
      const isolated = new ProposalLedger({ project: build.workingProject, state: emptyState() });
      isolated.addProposal(stageProposal);
      const applied = isolated.applyItems(stageProposal.id, stageProposal.items.map((item) => item.id));
      build.workingProject = applied.project;
      const linkedItems = linkStageItems(stageProposal.items, build.priorStageItemIds);
      build.items.push(...linkedItems);
      build.priorStageItemIds = linkedItems.map((item) => item.id);
      build.index += 1;

      const done = build.index === build.stages.length;
      const combined = combinedBuildProposal(build, done);
      const runtime = compileStageRuntime(build.workingProject, stage).runtime;
      if (!done) return {
        done: false, stage: { ...stage, index: build.index, total: build.stages.length },
        proposal: combined, runtime,
      };

      validateProposalApplication(ledger, combined);
      const proposal = ledger.addProposal(combined);
      this.threads.set(proposal.id, build.thread);
      await this.store.save(ledger, { compileRuntime: false });
      const state = ledger.snapshot();
      await this._disposeBuild(buildId, { retainThread: true });
      return {
        done: true, stage: { ...stage, index: build.index, total: build.stages.length },
        proposal, runtime, state,
      };
    } catch (error) {
      await this._disposeBuild(buildId);
      throw error;
    } finally {
      build.running = false;
    }
  }

  async abortBuild({ buildId }) {
    if (typeof buildId !== 'string' || !buildId) throw new Error('buildId is required');
    const existed = this.builds.has(buildId);
    await this._disposeBuild(buildId);
    return { aborted: existed };
  }

  async propose({ prompt, captures = [], selection = null }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    const ledger = await this.ledgerPromise;
    const workspace = await this._workspace(ledger, captures, { selection });
    try {
      const thread = this.codex.startThread({
        workingDirectory: workspace.directory,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        modelReasoningEffort: 'high',
        threadSource: 'claude-golfsim-course-builder',
      });
      const turn = await thread.run([
        { type: 'text', text: proposalPrompt(prompt, projectRevision(ledger.project)) },
        ...workspace.images.map((path) => ({ type: 'local_image', path })),
      ], { outputSchema: PROPOSAL_SCHEMA });
      const proposal = decodeProposal(turn.finalResponse, projectRevision(ledger.project), thread.id);
      validateProposalApplication(ledger, proposal);
      ledger.addProposal(proposal);
      this.threads.set(proposal.id, thread);
      await this.store.save(ledger, { compileRuntime: false });
      return { proposal, state: ledger.snapshot(), reviewRequested: true };
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }

  async review({ proposalId, captures = [], selection = null }) {
    const ledger = await this.ledgerPromise;
    const original = ledger.state.proposals.find((entry) => entry.id === proposalId);
    if (!original) throw new Error(`proposal "${proposalId}" does not exist`);
    if ((original.review?.passes ?? 0) >= 2) throw new Error('proposal has reached the two-pass review limit');
    const workspace = await this._workspace(ledger, captures, { proposal: original, selection });
    try {
      const thread = this.threads.get(proposalId)
        ?? (original.threadId ? this.codex.resumeThread(original.threadId) : null);
      if (!thread) throw new Error('proposal thread is unavailable; create a new proposal after restart');
      const turn = await thread.run([
        { type: 'text', text: reviewPrompt(original, projectRevision(ledger.project)) },
        ...workspace.images.map((path) => ({ type: 'local_image', path })),
      ], { outputSchema: PROPOSAL_SCHEMA });
      const replacement = decodeProposal(turn.finalResponse, projectRevision(ledger.project), thread.id);
      replacement.id = original.id;
      replacement.review = {
        stage: 'reviewed', passes: (original.review?.passes ?? 0) + 1,
        captures: captures.map(({ label, camera }) => ({ label, camera })), diagnostics: [],
      };
      validateProposalApplication(ledger, replacement);
      ledger.replaceProposal(proposalId, replacement);
      await this.store.save(ledger, { compileRuntime: false });
      return { proposal: replacement, state: ledger.snapshot() };
    } finally { await rm(workspace.directory, { recursive: true, force: true }); }
  }

  async preview({ proposalId, itemIds }) {
    const ledger = await this.ledgerPromise;
    const isolated = new ProposalLedger({ project: ledger.project, state: ledger.state });
    const result = isolated.applyItems(proposalId, itemIds);
    return { project: result.project, runtime: compileActiveCourse(result.project).runtime, revision: result.revision };
  }

  async revise({ proposalId, itemId, prompt, captures = [], selection = null }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('revision prompt is required');
    const ledger = await this.ledgerPromise;
    const proposal = ledger.state.proposals.find((entry) => entry.id === proposalId);
    const item = proposal?.items.find((entry) => entry.id === itemId);
    if (!proposal || !item) throw new Error('proposal item does not exist');
    const workspace = await this._workspace(ledger, captures, { proposal: { ...proposal, items: [item] }, selection });
    try {
      const thread = this.threads.get(proposalId) ?? (proposal.threadId ? this.codex.resumeThread(proposal.threadId) : null);
      if (!thread) throw new Error('proposal thread is unavailable; create a new proposal after restart');
      const turn = await thread.run([
        { type: 'text', text: `Revise only proposal item ${itemId}. Preserve its entity target and dependencies unless the request makes that impossible. Return one complete item with a new kebab-case branch ID. User refinement: ${prompt}` },
        ...workspace.images.map((path) => ({ type: 'local_image', path })),
      ], { outputSchema: ITEM_SCHEMA });
      const decoded = decodeItem(JSON.parse(turn.finalResponse));
      const branch = ledger.branchItem(proposalId, itemId, {
        id: decoded.id, rationale: decoded.rationale, mutation: decoded.mutation,
      });
      await this.store.save(ledger, { compileRuntime: false });
      return { item: branch, state: ledger.snapshot() };
    } finally { await rm(workspace.directory, { recursive: true, force: true }); }
  }

  async plantAction(action, body) {
    const run = async () => {
      if (this.liveBuildRunning) throw new Error('Wait for the current course build before saving or placing a plant');
      if (action === 'save') return { asset: await savePlantAsset(this.root, body) };
      if (action !== 'place') throw new Error('Unknown plant action');
      const definition = normalizeTreeDefinition(body.definition);
      const ledger = await this.ledgerPromise;
      if (body.baseRevision !== projectRevision(ledger.project)) throw new Error('Course changed; refresh before placing the plant');
      const exists = ledger.project.site.environment.proceduralTreeDefinitions.some(d => d.id === definition.id);
      const existing = ledger.project.site.environment.proceduralTreeDefinitions.find(d => d.id === definition.id);
      if (existing && JSON.stringify(normalizeTreeDefinition(existing)) !== JSON.stringify(definition)) throw new Error('This definition ID is already used in the course; choose a new ID to place a different plant');
      const id = `plant-${randomUUID()}`;
      const placement = { id, definitionId: definition.id, x: body.x, z: body.z, rotationY: 0, scale: 1, seed: definition.seed, age: 1, health: 1, windExposure: 0.5 };
      const project = applyCourseMutations(ledger.project, [
        { op: exists ? 'replace' : 'create', entityType: 'procedural-tree-definition', entityId: definition.id, value: definition },
        { op: 'create', entityType: 'procedural-tree', entityId: id, value: placement },
      ]);
      compileActiveCourse(project);
      ledger.recordExternalProjectChange({ id, summary: `Place ${definition.id}`, title: 'Procedural plant', rationale: 'Placed from Plant Studio', project });
      const snapshot = await this.store.save(ledger); this.onRuntimeChanged(); return snapshot;
    };
    const pending = (this.plantQueue ?? Promise.resolve()).then(run);
    this.plantQueue = pending.catch(() => {}); return pending;
  }

  async apply({ proposalId, itemIds }) {
    const ledger = await this.ledgerPromise;
    const result = ledger.applyItems(proposalId, itemIds);
    const snapshot = await this.store.save(ledger);
    this.onRuntimeChanged();
    return { ...result, state: snapshot.state };
  }

  async reject({ proposalId, itemId }) {
    const ledger = await this.ledgerPromise; const item = ledger.rejectItem(proposalId, itemId);
    await this.store.save(ledger, { compileRuntime: false }); return { item, state: ledger.snapshot() };
  }

  async undo({ eventId = null } = {}) {
    const ledger = await this.ledgerPromise; const snapshot = ledger.undo(eventId);
    await this.store.save(ledger); this.onRuntimeChanged(); return snapshot;
  }

  async redo() {
    const ledger = await this.ledgerPromise; const snapshot = ledger.redo();
    await this.store.save(ledger); this.onRuntimeChanged(); return snapshot;
  }

  async _workspace(ledger, captures, { proposal = null, selection = null } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'golfsim-course-agent-'));
    await writeFile(join(directory, 'context.json'), `${JSON.stringify({
      revision: projectRevision(ledger.project), project: ledger.project, proposal,
      selectedContext: sanitizeSelection(selection),
      contract: 'Return proposal JSON only. Never edit files. Every item changes exactly one stable entity.',
    }, null, 2)}\n`);
    const images = [];
    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(capture.dataUrl ?? '');
      if (!match) throw new Error(`capture ${index} is not a supported image data URL`);
      const path = join(directory, `review-${index}-${safeName(capture.label ?? 'view')}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
      await writeFile(path, Buffer.from(match[2], 'base64')); images.push(path);
    }
    return { directory, images };
  }

  async _refreshBuildWorkspace(build, captures, selection, stage) {
    const selectedContext = sanitizeSelection(selection ?? build.selection);
    await writeFile(join(build.directory, 'context.json'), `${JSON.stringify({
      revision: projectRevision(build.workingProject), project: build.workingProject,
      proposal: combinedBuildProposal(build, false), selectedContext,
      iterativeStage: stage,
      contract: 'Return proposal JSON only. Never edit files. Every item changes exactly one stable entity.',
    }, null, 2)}\n`);
    const images = [];
    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(capture.dataUrl ?? '');
      if (!match) throw new Error(`capture ${index} is not a supported image data URL`);
      const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
      const path = join(build.directory, `${stage.id}-${index}-${safeName(capture.label ?? 'view')}.${extension}`);
      await writeFile(path, Buffer.from(match[2], 'base64'));
      images.push(path);
    }
    build.images = images.length ? images : build.images;
    return { directory: build.directory, images: build.images };
  }

  async _disposeBuild(buildId, { retainThread = false } = {}) {
    const build = this.builds.get(buildId);
    if (!build) return;
    this.builds.delete(buildId);
    await rm(build.directory, { recursive: true, force: true });
    if (!retainThread && build.thread?.id) this.threads.delete(build.thread.id);
  }
}

export function createIterativeBuildStages(prompt, project) {
  const requested = requestedHoleCount(prompt);
  if (!requested) return [{ id: 'design', label: 'Course design', kind: 'design' }];
  const active = project.holes.find((hole) => hole.id === project.activeHoleId) ?? project.holes[0];
  const stages = [{ id: 'hole-1', label: 'Course foundation + Hole 1', kind: 'foundation', holeNumber: 1, activeHoleId: active.id }];
  for (let number = 2; number <= requested; number += 1) {
    stages.push({ id: `hole-${number}`, label: `Hole ${number}`, kind: 'hole', holeNumber: number });
  }
  if (/forest|tree|pine|woodland|vegetation|foliage|understor|landscap|environment|rock|fern|grass/i.test(prompt)) {
    stages.push({ id: 'environment', label: 'Forest and understory', kind: 'environment' });
  }
  return stages;
}

function requestedHoleCount(prompt) {
  const words = new Map([['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18]]);
  const match = String(prompt).toLowerCase().match(/\b(1[0-8]|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)[ -]ho(?:le|ld)s?\b/);
  if (!match) return null;
  return Number(match[1]) || words.get(match[1]) || null;
}

function iterativeStagePrompt(build, stage) {
  const shared = `You are building a golf course progressively inside its live Course Creator. Read context.json before responding. This is stage ${build.index + 1} of ${build.stages.length}: ${stage.label}. Return only the objects needed for THIS stage as one valid proposal. Every mutation must leave the project valid when applied individually in dependency order. Preserve all completed work in context.json and do not repeat or replace it unless this stage explicitly requires that. ${CREATIVE_INTENT} The original user request is:\n${build.prompt}`;
  if (stage.kind === 'foundation') return `${shared}\n\nEstablish the course identity, sufficiently large site bounds, atmosphere, and Hole 1 only. Reuse and replace the existing active hole entity ID "${stage.activeHoleId}" so activeHoleId remains valid; do not delete it. A hole replacement must be a complete valid hole object including its route, at least one tee, at least one green, hazards, landforms, and runtime corridor. You may replace project metadata, site, atmosphere, and that active hole. Reset obsolete site environment collections to clean valid arrays but do not add detailed environment objects yet. Do not create Hole 2 or later holes.`;
  if (stage.kind === 'hole') return `${shared}\n\nCreate exactly Hole ${stage.holeNumber} as one complete hole mutation. Its value must include the complete valid nested route, tees, green, hazards, landforms, and runtime corridor because a newly created hole must validate as a standalone object. Do not modify the site, completed holes, atmosphere, or environment in this stage.`;
  if (stage.kind === 'environment') return `${shared}\n\nDress the completed course environment now. Create site-level forest-floor-area mutations for maintained pine-straw beds; each value is {id,shape:[{x,z},...]} with 4..32 sparse, non-self-intersecting world-space control points. Shape broad woodland beds from route strategy and forest composition, never by tracing individual tree crowns or assembly rectangles. Create catalog environment-object mutations and, when the user asks for original trees, reusable procedural-tree-definition records followed by procedural-tree placements. Use the built-in ImageGen skill for front/right/top transparent references, then run npm run tree:build to fit and validate the definition before placing it. Generated pixels may texture explicit leaf meshes only; never create a whole-tree billboard or use generated content as a catalog fallback. Prefer deterministic asymmetric groups outside protected play and preserve clear tees, landings, approaches, recoveries, hazard edges, and pin backdrops.`;
  return `${shared}\n\nMake the smallest coherent set of course-object mutations that produces a useful live preview. Keep gameplay and environment objects separate and preserve the existing active hole ID.`;
}

function namespaceStageProposal(proposal, stage, existingItems) {
  const existing = new Set(existingItems.map((item) => item.id));
  const idMap = new Map();
  for (let index = 0; index < proposal.items.length; index += 1) {
    const original = proposal.items[index].id;
    const base = `${stage.id}-${original}`.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 58).replace(/-$/, '') || `${stage.id}-item`;
    let id = base, suffix = 2;
    while (existing.has(id) || [...idMap.values()].includes(id)) id = `${base.slice(0, 58 - String(suffix).length)}-${suffix++}`;
    idMap.set(original, id);
  }
  proposal.id = `${stage.id}-proposal`;
  proposal.items = proposal.items.map((item) => ({
    ...item,
    id: idMap.get(item.id),
    dependencies: [...new Set(item.dependencies.map((dependency) => idMap.get(dependency) ?? dependency))],
  }));
  return proposal;
}

function linkStageItems(items, priorStageItemIds) {
  if (!priorStageItemIds.length) return structuredClone(items);
  return items.map((item) => ({
    ...structuredClone(item),
    dependencies: [...new Set([...priorStageItemIds, ...item.dependencies])],
  }));
}

function combinedBuildProposal(build, reviewed) {
  return {
    id: `${build.id}-proposal`.slice(0, 63),
    summary: `Progressive build: ${build.prompt.slice(0, 220)}`,
    baseRevision: build.baseRevision,
    threadId: build.thread?.id ?? null,
    items: structuredClone(build.items),
    review: {
      stage: reviewed ? 'reviewed' : 'building', passes: 0,
      captures: [], diagnostics: build.stages.slice(0, build.index).map((stage) => `${stage.label} previewed live`),
    },
  };
}

function compileStageRuntime(project, stage) {
  if (!stage.holeNumber) return compileActiveCourse(project);
  const hole = project.holes.find((candidate) => candidate.number === stage.holeNumber);
  if (!hole) return compileActiveCourse(project);
  return compileActiveCourse({ ...structuredClone(project), activeHoleId: hole.id });
}

const CREATIVE_INTENT = `Preserve the user's defining experience through every checkpoint. For greens, author strategic asymmetric spline shapes and explicit green.contours semantic landforms as documented in the golf-course-authoring engine reference. Choose a distinct primary green defense from contour, approach angle, depth control, recoverable ground slopes or an explicitly supported carry hazard. Preserve a genuine bailout and vary miss/recovery outcomes; do not default to circles with symmetrical flanking bunkers. A legacy contour label creates no physical relief; never substitute an oval and a label for requested shelves, ridges, bays or alternate pin regions. Before changing geometry, identify the design mode (realistic, spectacle, or hybrid), signature shots, spatial topology, and miss/recovery rules. Record a concise creative brief in project.meta.notes so later revisions retain it. An explicit fantasy or TGL-style request authorizes spectacle architecture with authentic ball physics; do not flatten it into a conventional parkland hole. For detached playing islands, preserve separate tee, landing, and green platforms, their heights and carry gaps, and specify what happens when a ball misses an island. Visually hiding terrain is not detached geometry: rendered boundaries and collision occupancy must agree, including a low-speed ball rolling off an edge. The current schema has no authored detached-platform/void contract; the disposable creator opening green is a presentation cutout, not that capability. Identify such missing engine support before authoring dependent geometry, explain it plainly, and retain the original concept. Do not invent schema fields, claim unsupported features are built, or substitute continuous land or water without the user's choice. Complete supported parts only when they remain useful independently. At final review, compare every signature requirement with the actual production scene and explicitly report anything still missing.`;

function liveBuildPrompt(prompt, context, observation) {
  return `You are the live Course Creator workspace agent for this repository. Work directly in the current repository and follow AGENTS.md plus the golf-course-authoring and golf-environment-vibe skills. You are authorized to create and edit the course project, compiled runtime, supporting geometry data, catalog metadata, and necessary licensed assets inside the repository. Do not return proposal JSON and do not wait until the end to make one large change.

This live build has a revision-tagged browser observation inbox. Its build ID is ${observation.buildId} and its atomically published latest record is exactly:
${observation.latestPath}
The record begins at sequence 0 with state "waiting-for-browser-checkpoint". Keep track of the highest ready sequence you have reviewed. After each valid compile checkpoint, briefly poll that exact file for a strictly higher sequence (at most 15 seconds total; do not block the build indefinitely). Only trust a record with state "ready" whose projectRevision matches the current course.project.json revision. Inspect the rendered images at every captures[].path, use the diagnostics and activeHoleId to confirm the intended live state, then make the next small correction in the same running turn. The browser publishes complete image sets before atomically advancing latest.json, so never inspect similarly named temporary files. If no newer observation arrives, report the missing live feedback and continue with compiler/tests rather than reloading the app or starting a second server. Before finishing, review the newest available checkpoint after the final compile. Do not edit, move, or delete anything in the observation inbox.

Build in small visible checkpoints. For a multi-hole request: (1) make a whole-site routing plan before detailing Hole 1; author distinct local hole centerlines plus project.site.routing placements, clubhouse, and explicit consecutive transitions; check transformed rough envelopes rather than centerlines alone for crossing play, unsafe shot-cone conflicts, backtracking, and the start/finish relationship; (2) author the first valid routed-site checkpoint, write course.project.json, and run npm run compile:course so course.json schema v4 renders every hole and connector together through the page-owned CreatorScene; (3) add or refine each later hole one at a time and compile after every valid change so the shared WebGPU terrain updates while you work; (4) dress the shared site in bounded catalog-backed groups or validated procedural tree definitions only after the routing passes, and compile another valid checkpoint; (5) restore Hole 1 as active, run the compiler and tests, then review whole-site plus tee/landing/approach views for all holes. Record the routing audit in project.meta.notes. Give every hazard a stable owning-hole identity plus a declared shot context, route-progress band, lateral offset, carry-to-front/clear, bailout, and earned benefit; reject decorative tee-side hazards, and place decision cameras before rather than inside the interaction band. A routed site must pass the compiler's transformed bounds, route crossing, adjacent green-to-next-tee miss-cone safety, non-adjacent rough-envelope separation, connector, environment-clearance, and schema checks. Range, CreatorScene, and PlayScene must remain thin page-owned consumers of PlayableCourseScene's shared terrain, hazard, water, vegetation, and presentation primitives; never move shared primitives into a page scene or select a scene merely from course shape. Use window.golf.selectHole(holeId) for no-rebuild active-hole review; do not move holes by duplicating world geometry or flatten a routed site back into Range. Never serialize compileActiveCourse(...).normalized as course.json; it contains derived fields that authored runtime JSON rejects. The browser watches project, runtime, model, texture, and catalog files and rebuilds the production WebGPU scene after every valid checkpoint, so make the first playable checkpoint quickly and refine afterward. Keep course.project.json schema v5 as the editable source of truth; compile a routed project to course.json schema v4 and an unrouted legacy/practice project to schema v3. Use existing repository scripts and schema code rather than inventing formats.

Inspect the existing catalog before searching. Use live web search or network downloads only when the catalog cannot satisfy a requested visual or ecological role. Before downloading, stream a short status explaining what is missing and what licensed source you are checking. Prefer official Poly Haven asset pages and APIs and their CC0 originals. Do not download an asset with an unknown, ambiguous, or incompatible license; do not scrape search-result thumbnails or arbitrary mirrors. Record the canonical source URL, author, license, source hash, derivative lineage, pipeline version, dimensions, bounds, spacing, clearances, and biome use. Preserve authored geometry, normals, UVs, vertex colours, alpha, and PBR maps, and build runtime derivatives with the repository's existing asset pipeline. An acquisition checkpoint is incomplete unless a checked-in command or script can reproduce the catalog filename from the recorded official source and pinned tool version; use scripts/fetch_polyhaven_pine_tree_01.mjs plus scripts/process_pine_tree.py as the Pine Tree 01 example. Update provenance documentation plus catalog hashes/metadata in the same checkpoint, then run the catalog and visual-asset verification. Catalog-backed Poly Haven GLBs are the source of truth for authored trees. Never create a procedural, billboard, atlas, placeholder, or generic-prop fallback for a failed authored tree asset; fail closed and explain the blocker instead. Do not use network access for unrelated work. Do not modify application source code unless the user explicitly asked to change the builder itself. Keep unrelated user work untouched.

The compact AuthoringContext below is the authoritative situation report for this turn. Prefer it over rediscovering facts. When uncertainty is visual, return kind "control" with 1-4 bounded actions from capabilities.controls; the browser will execute them in the production scene and resume this thread with revision-tagged evidence. Use diagnostics before screenshots, request no more evidence than needed, and never attempt arbitrary browser JavaScript. A control turn has question null. Use kind "complete" with question and control null when finished.

Use kind "question" only when one user choice materially changes the design and guessing would be costly. A question must offer 2 or 3 concise mutually exclusive options, identify one recommendation, and leave Other to the browser. If trees are material and the existing-vs-custom source cannot be inferred, ask explicitly. A visual tree question should attach a tree-comparison presentation whose candidate optionIds exactly match offered choices; use real catalog asset IDs or registered same-origin procedural definition URLs. Prefer two relevant existing assets plus a custom-tree option when appropriate. A question has control null and ends the turn cleanly.

${CREATIVE_INTENT}

AuthoringContext: ${JSON.stringify(context)}

User request:
${prompt}`;
}

function finalLiveReviewPrompt(observation) {
  return `Perform the final adversarial visual review for the live course build. ${CREATIVE_INTENT} The browser has published a complete production-WebGPU tour at:
${observation.observationPath}
It is sequence ${observation.sequence}, project revision ${observation.projectRevision}, and contains ${observation.captureCount} views. Read that manifest and inspect every captures[].path. Confirm tee, decision/landing, approach, overview, active-hole furniture, routing flow, landing width, intentional blind-shot cues, environment maturity, authored-tree silhouette/PBR crispness, grounding, and maintained-play clearances. Audit every bunker/hazard by stable ID: owning hole, shot context, route-progress band, carry-to-front/clear, lateral offset, bailout, and earned benefit. Reject decorative tee-side hazards and reject a decision view whose camera stands on a hazard shoulder or inside the interaction band; verify page-scene ownership, active hole, and transforms before moving otherwise sound geometry. If a material visual or playability defect remains, make the smallest coherent correction, compile it, and inspect the next revision-tagged observation through the existing inbox protocol. Otherwise do not churn files; report that the final tour is accepted. Never replace a failed authored asset with a fallback. Finish with the required structured live-turn envelope: complete, question, or a bounded control request when one more targeted production-scene observation is necessary.`;
}

function liveAnswerPrompt(question, selected) {
  return `Resume the same live Course Creator build from the exact question you asked. The user selected ${JSON.stringify(selected.label)} (${JSON.stringify(selected.optionId)})${selected.answer ? ` and added: ${JSON.stringify(selected.answer)}` : ''}. Apply that decision directly, continue the small compile/render checkpoints and visual review protocol from the prior turn, and preserve unrelated work. Do not re-ask the answered question. Finish with the required structured live-turn envelope: complete, question, or a bounded control request for necessary scene evidence.\n\nAnswered question:\n${question.prompt}`;
}

function controlResultPrompt(control, observation) {
  return `The production browser completed scene-control request ${control.id}. Its immutable result is ${observation.observationPath}, sequence ${observation.sequence}, project revision ${observation.projectRevision}, render revision ${observation.renderRevision}, with ${observation.captureCount} capture(s). Read the manifest and any captures[].path, then continue the same task. Treat the result as evidence only; it did not authorize a project mutation. Finish with complete, question, or another bounded control request within the remaining budget.`;
}

export function summarizeLiveEvent(event, root = '') {
  if (event?.type === 'thread.started') return { type: 'status', message: 'Codex workspace session started.' };
  if (event?.type === 'turn.started') return { type: 'status', message: 'Codex is reading the course and planning the first live checkpoint.' };
  if (!event?.item) {
    if (event?.type === 'turn.completed') return { type: 'status', message: 'Codex finished the live build pass.' };
    return null;
  }
  const item = event.item;
  if (item.type === 'reasoning' && item.text) return { type: 'status', message: cleanStatus(item.text) };
  if (item.type === 'agent_message' && item.text) {
    try {
      const envelope = JSON.parse(item.text);
      if (['complete', 'question', 'control'].includes(envelope?.kind) && typeof envelope.summary === 'string') {
        return { type: 'message', message: cleanStatus(envelope.summary) };
      }
    } catch { /* Ordinary agent prose remains a valid backwards-compatible completion. */ }
    return { type: 'message', message: cleanStatus(item.text) };
  }
  if (item.type === 'file_change' && item.changes?.length) {
    const files = item.changes.map(({ path }) => relativeDisplayPath(path, root));
    return { type: 'file', message: `${item.status === 'failed' ? 'Could not update' : 'Updated'} ${joinNatural(files)}.`, files };
  }
  if (item.type === 'command_execution') {
    if (item.status === 'failed') return { type: 'warning', message: 'A course build command failed; Codex is inspecting the result.' };
    if (item.status === 'completed') return { type: 'status', message: 'Validated the latest workspace checkpoint.' };
    return { type: 'status', message: 'Running a course build or validation command.' };
  }
  if (item.type === 'todo_list') {
    const active = item.items?.find(({ completed }) => !completed)?.text;
    if (active) return { type: 'status', message: cleanStatus(active) };
  }
  if (item.type === 'web_search') return { type: 'status', message: `Searching licensed asset sources for “${cleanStatus(item.query, 110)}”.` };
  if (item.type === 'mcp_tool_call') return { type: item.status === 'failed' ? 'warning' : 'status', message: `${item.status === 'failed' ? 'Could not complete' : 'Using'} ${item.tool} for the live course.` };
  if (item.type === 'error') return { type: 'warning', message: cleanStatus(item.message) };
  return null;
}

function cleanStatus(value, max = 180) {
  const text = String(value ?? '').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentence = text.match(/^.{1,220}?[.!?](?:\s|$)/)?.[0]?.trim() ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function relativeDisplayPath(value, root) {
  const path = String(value ?? '').replaceAll('\\', '/');
  const normalizedRoot = String(root ?? '').replaceAll('\\', '/').replace(/\/$/, '');
  return normalizedRoot && path.startsWith(`${normalizedRoot}/`) ? path.slice(normalizedRoot.length + 1) : path;
}

function joinNatural(values) {
  const unique = [...new Set(values)].slice(0, 4);
  if (values.length > unique.length) unique.push(`${values.length - unique.length} more files`);
  if (unique.length < 2) return unique[0] ?? 'workspace files';
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}

function proposalPrompt(prompt, revision) {
  return `You are a golf-course design agent. Read context.json before responding. The renderer accepts only validated course data; you cannot edit the repository or apply changes. When selectedContext is present, treat that stable entity and clicked world point as the user's explicit editing context.\n\nCreate a dependency-aware proposal for revision ${revision}. Split the response into individual stable objects: one item per hole, route, tee, green, bunker, pond, landform, site-level forest-floor-area, surface-materials preset, atmosphere preset, catalog environment object, reusable procedural tree definition, or procedural tree placement. A forest-floor-area value is {id,shape:[{x,z},...]} with 4..32 sparse world-space controls; use it for smooth maintained pine-straw beds and never infer its silhouette from tree crowns. Reuse existing IDs for replacements/deletes and create kebab-case IDs for new objects. Singleton targets are exact: project uses context.project.meta.id, site uses "site", atmosphere uses "atmosphere", and surface-materials uses "surface-materials". For create/replace, valueJson must be the complete JSON object for that entity. For delete it must be null. parentId is the containing hole ID for hole children, "forestFloorAreas" for pine-straw beds, the environment collection name for environment objects and trees, otherwise null. Use route splines and semantic landforms; never output raw heightfields. Procedural tree placements reference validated definitions and neither source may replace or masquerade as a broken catalog GLB. Preserve playable routes, clearances, drainage, deterministic seeds, and metre scale.\n\n${CREATIVE_INTENT}\n\nUser request:\n${prompt}`;
}

function reviewPrompt(proposal, revision) {
  return `Review the attached current/tee/landing/approach/overview renders for proposal ${proposal.id} against context.json. Return the complete revised proposal for base revision ${revision}. Keep strong items, repair weak composition or playability, remove redundant changes, preserve one-object-per-item granularity and valid dependencies. ${CREATIVE_INTENT} This is visual critique only; do not edit files.`;
}

function decodeProposal(text, baseRevision, threadId) {
  const raw = JSON.parse(text);
  const proposal = {
    ...raw, baseRevision, threadId: threadId ?? null,
    items: raw.items.map(decodeItem),
    review: { stage: 'proposal', captures: [], diagnostics: [], passes: 0 },
  };
  return normalizeProposal(proposal, baseRevision);
}

function decodeItem(item) {
  return {
    ...item,
    mutation: {
      op: item.mutation.op, entityType: item.mutation.entityType, entityId: item.mutation.entityId,
      ...(item.mutation.parentId ? { parentId: item.mutation.parentId } : {}),
      ...(item.mutation.valueJson ? { value: JSON.parse(item.mutation.valueJson) } : {}),
    },
  };
}

function validateProposalApplication(ledger, proposal) {
  const isolated = new ProposalLedger({ project: ledger.project, state: ledger.state });
  let validationId = 'validation-proposal';
  let suffix = 1;
  while (isolated.state.proposals.some((entry) => entry.id === validationId)) validationId = `validation-proposal-${suffix++}`;
  isolated.addProposal({ ...structuredClone(proposal), id: validationId });
  const validating = isolated.state.proposals.at(-1);
  for (const item of validating.items) item.dependencies = item.dependencies.map((id) => `${id}`);
  isolated.applyItems(validating.id, validating.items.map((item) => item.id));
}

export function validateLiveBuildId(value) {
  if (typeof value !== 'string' || !LIVE_BUILD_ID_RE.test(value)) {
    throw new Error('clientBuildId must be 8-96 letters, numbers, underscores, or hyphens and start with a letter or number');
  }
  return value;
}

function decodeLiveTurn(text) {
  let value;
  try { value = JSON.parse(String(text ?? '')); }
  catch { return { kind: 'complete', summary: cleanStatus(text) || 'Course build finished.', question: null }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex live turn returned an invalid structured envelope');
  const summary = boundedString(value.summary, 'Course build finished.', 300);
  if (value.kind === 'complete') {
    if (value.question != null) throw new Error('completed Codex live turn must not contain a question');
    if (value.control != null) throw new Error('completed Codex live turn must not contain a control request');
    return { kind: 'complete', summary, question: null, control: null };
  }
  if (value.kind === 'question') {
    if (value.control != null) throw new Error('Codex live question must not contain a control request');
    return { kind: 'question', summary, question: normalizeLiveQuestion(value.question), control: null };
  }
  if (value.kind === 'control') {
    if (value.question != null) throw new Error('Codex live control turn must not contain a question');
    return { kind: 'control', summary, question: null, control: normalizeLiveControl(value.control) };
  }
  throw new Error('Codex live turn kind must be complete, question, or control');
}

function normalizeLiveQuestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex live question must be an object');
  const options = Array.isArray(value.options) ? value.options.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('Codex live question options must be objects');
    const id = boundedString(option.id, null, 48);
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(id) || id.toLowerCase() === 'other') throw new Error(`invalid live question option ID "${id}"`);
    return {
      id,
      label: boundedString(option.label, null, 80),
      description: boundedString(option.description, null, 240),
    };
  }) : [];
  if (options.length < 2 || options.length > 3) throw new Error('Codex live question must contain 2 or 3 options');
  if (new Set(options.map(({ id }) => id)).size !== options.length) throw new Error('Codex live question option IDs must be unique');
  const recommendationOptionId = boundedString(
    value.recommendationOptionId ?? value.recommendation?.optionId, null, 48,
  );
  if (!options.some(({ id }) => id === recommendationOptionId)) throw new Error('Codex live question recommendation must reference one offered option');
  const suppliedId = value.id == null ? `question-${randomUUID()}` : boundedString(value.id, null, 64);
  if (!/^question-[a-z0-9][a-z0-9-]{5,54}$/i.test(suppliedId)) throw new Error('invalid live question ID');
  return {
    id: suppliedId,
    prompt: boundedString(value.prompt, null, 300),
    recommendationOptionId,
    recommendationReason: boundedString(value.recommendationReason ?? value.recommendation?.reason, null, 300),
    options,
    presentation: value.presentation == null ? null : normalizeTreePresentation(value.presentation, new Set(options.map(({ id }) => id))),
  };
}

function normalizeLiveControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex live control must be an object');
  const id = normalizeControlId(value.id);
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 4) throw new Error('Codex live control must contain 1-4 actions');
  let requestedCaptures = 0;
  const actions = value.actions.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`live control action ${index} must be an object`);
    const type = boundedString(raw.type, null, 40);
    if (!['select-hole', 'set-view', 'present-trees', 'clear-preview', 'observe'].includes(type)) throw new Error(`unsupported live control action "${type}"`);
    const capture = raw.capture == null ? 'none' : boundedString(raw.capture, null, 20);
    if (!['none', 'current', 'review'].includes(capture)) throw new Error(`invalid live control capture mode "${capture}"`);
    requestedCaptures += capture === 'review' ? 4 : capture === 'current' ? 1 : 0;
    const point = raw.point == null ? null : normalizePoint(raw.point, `control.actions[${index}].point`);
    const action = {
      type,
      holeId: raw.holeId == null ? null : boundedString(raw.holeId, null, 100),
      view: raw.view == null ? null : boundedString(raw.view, null, 24),
      point,
      presentation: raw.presentation == null ? null : normalizeTreePresentation(raw.presentation),
      capture,
    };
    if (type === 'select-hole' && !action.holeId) throw new Error('select-hole requires holeId');
    if (type === 'set-view' && !['current', 'tee', 'landing', 'approach', 'overview', 'point'].includes(action.view)) throw new Error('set-view requires a supported semantic view');
    if (type === 'set-view' && action.view === 'point' && !point) throw new Error('point view requires point');
    if (type === 'present-trees' && !action.presentation) throw new Error('present-trees requires a presentation');
    return action;
  });
  if (requestedCaptures > MAX_OBSERVATION_CAPTURES) throw new Error(`live control requests ${requestedCaptures} captures; maximum is ${MAX_OBSERVATION_CAPTURES}`);
  return { id, actions };
}

function normalizeTreePresentation(value, optionIds = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'tree-comparison') throw new Error('tree presentation kind must be tree-comparison');
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 3) throw new Error('tree presentation must contain 1-3 candidates');
  const seen = new Set();
  const candidates = value.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`tree presentation candidate ${index} must be an object`);
    const optionId = boundedString(candidate.optionId, null, 48);
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(optionId) || seen.has(optionId)) throw new Error(`invalid or duplicate tree presentation optionId "${optionId}"`);
    if (optionIds && !optionIds.has(optionId)) throw new Error(`tree presentation optionId "${optionId}" is not offered by the question`);
    seen.add(optionId);
    const source = boundedString(candidate.source, null, 20);
    if (!['catalog', 'procedural'].includes(source)) throw new Error(`invalid tree presentation source "${source}"`);
    const assetId = candidate.assetId == null ? null : boundedString(candidate.assetId, null, 64);
    const definitionUrl = candidate.definitionUrl == null ? null : boundedString(candidate.definitionUrl, null, 200);
    const referenceUrl = candidate.referenceUrl == null ? null : boundedString(candidate.referenceUrl, null, 200);
    if (source === 'catalog' && (!assetId || definitionUrl)) throw new Error('catalog tree candidates require assetId only');
    if (source === 'procedural' && (!/^\/assets\/procedural-trees\/[a-z0-9_./-]+\/definition\.json$/i.test(definitionUrl ?? '') || assetId)) throw new Error('procedural tree candidates require a same-origin definitionUrl only');
    if (referenceUrl != null && !/^\/assets\/procedural-trees\/[a-z0-9_./-]+\/reference\.png$/i.test(referenceUrl)) throw new Error('tree candidate referenceUrl is invalid');
    const scale = candidate.scale == null ? 1 : candidate.scale;
    if (!Number.isFinite(scale) || scale < 0.36 || scale > 2.5) throw new Error('tree candidate scale must be 0.36-2.5');
    return { optionId, label: boundedString(candidate.label, null, 80), source, assetId, definitionUrl, referenceUrl, scale };
  });
  return {
    kind: 'tree-comparison',
    holeId: value.holeId == null ? null : boundedString(value.holeId, null, 100),
    anchor: value.anchor == null ? null : normalizePoint(value.anchor, 'presentation.anchor'),
    candidates,
  };
}

function normalizePoint(value, label) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.x) || !Number.isFinite(value.z)) throw new Error(`${label} must contain finite x and z`);
  return { x: value.x, z: value.z };
}

function normalizeControlId(value) {
  const id = boundedString(value, null, 64);
  if (!/^control-[a-z0-9][a-z0-9-]{5,54}$/i.test(id)) throw new Error('invalid live control ID');
  return id;
}

function validatePendingLiveBuild(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('pending live build must use version 1');
  const buildId = validateLiveBuildId(value.buildId);
  const threadId = boundedString(value.threadId, null, 200);
  const projectRevision = boundedString(value.projectRevision, null, 100);
  const prompt = boundedString(value.prompt, null, 8_000);
  return {
    version: 1,
    buildId,
    threadId,
    projectRevision,
    prompt,
    selection: value.selection == null ? null : sanitizeSelection(value.selection),
    hasCaptures: value.hasCaptures === true,
    question: normalizeLiveQuestion(value.question),
    updatedAt: boundedString(value.updatedAt, null, 100),
  };
}

function publicPendingLiveBuild(pending) {
  return {
    clientBuildId: pending.buildId,
    questionId: pending.question.id,
    revision: pending.projectRevision,
    awaitingInput: true,
    question: {
      id: pending.question.id,
      prompt: pending.question.prompt,
      options: structuredClone(pending.question.options),
      recommendation: {
        optionId: pending.question.recommendationOptionId,
        reason: pending.question.recommendationReason,
      },
      presentation: pending.question.presentation == null ? null : structuredClone(pending.question.presentation),
    },
  };
}

function decodeQuestionAnswer(question, optionId, answer) {
  const id = boundedString(optionId, null, 48);
  if (id === 'other') {
    return { optionId: id, label: 'Other', answer: boundedString(answer, null, 2_000) };
  }
  const option = question.options.find((entry) => entry.id === id);
  if (!option) throw new Error('answer option is not part of the pending question');
  if (answer != null && (typeof answer !== 'string' || answer.trim())) throw new Error('custom answer text is allowed only with Other');
  return { optionId: option.id, label: option.label, answer: null };
}

function liveHistoryId(kind, buildId, questionId) {
  const digest = createHash('sha256').update(`${buildId}\0${questionId}`).digest('hex').slice(0, 16);
  return `live-${kind}-${digest}`;
}

function publicObservationSession(session, revision, renderRevision) {
  return {
    buildId: session.buildId,
    directory: session.directory,
    latestPath: session.latestPath,
    projectRevision: revision,
    renderRevision,
  };
}

function boundedString(value, fallback, max) {
  if (value == null && fallback != null) return fallback;
  if (typeof value !== 'string') throw new Error('observation text fields must be strings');
  const result = value.replace(/\s+/g, ' ').trim();
  if (!result) {
    if (fallback != null) return fallback;
    throw new Error('observation text fields must not be empty');
  }
  if (result.length > max) throw new Error(`observation text fields must not exceed ${max} characters`);
  return result;
}

function boundedJsonObject(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`observation ${label} must be an object or array`);
  let json;
  try { json = JSON.stringify(value); } catch { throw new Error(`observation ${label} must be JSON serializable`); }
  if (!json || json.length > 32 * 1024) throw new Error(`observation ${label} must not exceed 32 KiB`);
  return JSON.parse(json);
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeName(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'view'; }

function sanitizeSelection(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('selection must be an object');
  const result = {};
  for (const key of ['entityType', 'entityId', 'parentId', 'label', 'surface', 'biome', 'holeId']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'string' || value[key].length > 160) throw new Error(`selection.${key} is invalid`);
    result[key] = value[key];
  }
  if (value.point != null) {
    if (!value.point || typeof value.point !== 'object' || !Number.isFinite(value.point.x) || !Number.isFinite(value.point.z)) throw new Error('selection.point is invalid');
    result.point = { x: value.point.x, z: value.point.z };
  }
  return result;
}
