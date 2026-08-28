import { Codex } from '@openai/codex-sdk';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileActiveCourse, projectRevision } from '../src/course/CourseProject.js';
import { ProposalLedger, normalizeProposal } from '../src/course/ProposalLedger.js';
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
        entityType: { type: 'string', enum: ['project', 'site', 'atmosphere', 'hole', 'route', 'tee', 'green', 'bunker', 'pond', 'landform', 'environment-object', 'synthetic-tree'] },
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

export class CourseAgentService {
  constructor({ root, onRuntimeChanged = () => {} } = {}) {
    this.root = resolve(root);
    this.store = new CourseHistoryStore({ root: this.root });
    this.onRuntimeChanged = onRuntimeChanged;
    this.threads = new Map();
    this.codex = new Codex({
      config: { show_raw_agent_reasoning: false, sandbox_workspace_write: { network_access: false } },
    });
    this.ledgerPromise = this.store.load();
  }

  async state() { return (await this.ledgerPromise).snapshot(); }

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
}

function proposalPrompt(prompt, revision) {
  return `You are a golf-course design agent. Read context.json before responding. The renderer accepts only validated course data; you cannot edit the repository or apply changes. When selectedContext is present, treat that stable entity and clicked world point as the user's explicit editing context.\n\nCreate a dependency-aware proposal for revision ${revision}. Split the response into individual stable objects: one item per hole, route, tee, green, bunker, pond, landform, atmosphere preset, catalog environment object, or synthetic tree instance. Dense tree proposals may contain many items, but every tree remains separately selectable. Reuse existing IDs for replacements/deletes and create kebab-case IDs for new objects. Singleton targets are exact: project uses context.project.meta.id, site uses "site", and atmosphere uses "atmosphere". For create/replace, valueJson must be the complete JSON object for that entity. For delete it must be null. parentId is the containing hole ID for hole children, the environment collection name for catalog objects, otherwise null. Use route splines and semantic landforms; never output raw heightfields. Synthetic trees use all-procedural geometry/material parameters and must not replace or masquerade as broken catalog GLBs. Preserve playable routes, clearances, drainage, deterministic seeds, and metre scale.\n\nUser request:\n${prompt}`;
}

function reviewPrompt(proposal, revision) {
  return `Review the attached current/tee/landing/approach/overview renders for proposal ${proposal.id} against context.json. Return the complete revised proposal for base revision ${revision}. Keep strong items, repair weak composition or playability, remove redundant changes, preserve one-object-per-item granularity and valid dependencies. This is visual critique only; do not edit files.`;
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
