import { applyCourseMutations, normalizeCourseProject, projectRevision } from './CourseProject.js';

export const PROPOSAL_LEDGER_VERSION = 1;

export class ProposalLedgerError extends Error {
  constructor(message) { super(`Proposal ledger invalid: ${message}`); this.name = 'ProposalLedgerError'; }
}

export class ProposalLedger {
  constructor({ project, state } = {}) {
    this.project = normalizeCourseProject(project);
    this.state = normalizeState(state ?? emptyState());
  }

  snapshot() {
    return structuredClone({ project: this.project, state: this.state, revision: projectRevision(this.project) });
  }

  addProposal(rawProposal) {
    const proposal = normalizeProposal(rawProposal, projectRevision(this.project));
    if (this.state.proposals.some((entry) => entry.id === proposal.id)) throw new ProposalLedgerError(`proposal "${proposal.id}" already exists`);
    this.state.proposals.push(proposal);
    this.state.updatedAt = new Date().toISOString();
    return structuredClone(proposal);
  }

  replaceProposal(proposalId, rawProposal) {
    const index = this.state.proposals.findIndex((entry) => entry.id === proposalId);
    if (index < 0) throw new ProposalLedgerError(`proposal "${proposalId}" does not exist`);
    if (this.state.proposals[index].items.some((item) => item.status === 'applied')) {
      throw new ProposalLedgerError('an applied proposal cannot be replaced; branch individual items instead');
    }
    const replacement = normalizeProposal(rawProposal, projectRevision(this.project));
    replacement.id = proposalId;
    this.state.proposals[index] = replacement;
    this.state.updatedAt = new Date().toISOString();
    return structuredClone(replacement);
  }

  branchItem(proposalId, itemId, replacement) {
    const item = this._item(proposalId, itemId);
    const branch = normalizeBranch(replacement, item);
    item.branches.push(branch);
    item.activeBranchId = branch.id;
    item.status = 'proposed';
    this.state.updatedAt = new Date().toISOString();
    return structuredClone(item);
  }

  rejectItem(proposalId, itemId) {
    const item = this._item(proposalId, itemId);
    if (item.status === 'applied') throw new ProposalLedgerError('applied items must be undone, not rejected');
    item.status = 'rejected';
    this._record('reject', proposalId, itemId, this.project, this.project);
    return structuredClone(item);
  }

  applyItems(proposalId, requestedIds) {
    const proposal = this._proposal(proposalId);
    if (!Array.isArray(requestedIds) || !requestedIds.length) throw new ProposalLedgerError('itemIds must be a non-empty array');
    const ordered = dependencyOrder(proposal, requestedIds);
    const applied = [];
    for (const item of ordered) {
      if (item.status === 'applied') continue;
      if (item.status === 'rejected') throw new ProposalLedgerError(`item "${item.id}" is rejected`);
      const before = this.project;
      const mutation = activeMutation(item);
      const after = applyCourseMutations(before, [mutation]);
      this.project = after;
      item.status = 'applied';
      const event = this._record('apply', proposalId, item.id, before, after, { mutation });
      applied.push({ item: structuredClone(item), event: structuredClone(event) });
    }
    this.state.redo = [];
    return { project: this.project, revision: projectRevision(this.project), applied };
  }

  recordExternalProjectChange({ id, summary, title, rationale, threadId = null, project, metadata = {} }) {
    const before = this.project;
    const after = normalizeCourseProject(project);
    if (projectRevision(before) === projectRevision(after)) return null;
    const proposalId = String(id).toLowerCase().replace(/_/g, '-').slice(0, 64);
    const proposal = this.addProposal({
      id: proposalId,
      summary,
      baseRevision: projectRevision(before),
      threadId,
      items: [{
        id: `${proposalId.slice(0, 52)}-checkpoint`,
        title,
        rationale,
        dependencies: [],
        // The event stores the authoritative whole-project before/after snapshots.
        // This metadata mutation keeps the history item compatible with the typed
        // proposal UI without pretending a direct live turn was one small object edit.
        mutation: {
          op: 'replace', entityType: 'project', entityId: before.meta.id,
          value: structuredClone(after.meta),
        },
      }],
    });
    const item = this._item(proposal.id, proposal.items[0].id);
    this.project = after;
    item.status = 'applied';
    const event = this._record('apply', proposal.id, item.id, before, after, {
      externalProjectCheckpoint: true,
      ...structuredClone(metadata),
    });
    this.state.redo = [];
    return { proposal: structuredClone(this._proposal(proposal.id)), event: structuredClone(event), ...this.snapshot() };
  }

  undo(eventId = null) {
    const applied = this.state.history.filter((event) => event.kind === 'apply' && !event.undoneAt);
    const target = eventId ? applied.find((event) => event.id === eventId) : applied.at(-1);
    if (!target) throw new ProposalLedgerError('there is no applied change to undo');
    const dependents = applied.filter((event) => event.id !== target.id && event.beforeRevision === target.afterRevision);
    if (dependents.length) throw new ProposalLedgerError(`change has ${dependents.length} accepted dependent change(s); undo them first`);
    const currentRevision = projectRevision(this.project);
    if (currentRevision !== target.afterRevision) throw new ProposalLedgerError('undo target is not the current project head');
    this.project = normalizeCourseProject(target.beforeProject);
    target.undoneAt = new Date().toISOString();
    this.state.redo.push(target.id);
    const item = this._item(target.proposalId, target.itemId); item.status = 'proposed';
    this.state.updatedAt = target.undoneAt;
    return this.snapshot();
  }

  redo() {
    const eventId = this.state.redo.pop();
    if (!eventId) throw new ProposalLedgerError('there is no change to redo');
    const event = this.state.history.find((candidate) => candidate.id === eventId);
    if (!event || !event.undoneAt) throw new ProposalLedgerError('redo history is inconsistent');
    if (projectRevision(this.project) !== event.beforeRevision) throw new ProposalLedgerError('redo target is not based on the current project head');
    this.project = normalizeCourseProject(event.afterProject);
    delete event.undoneAt;
    const item = this._item(event.proposalId, event.itemId); item.status = 'applied';
    this.state.updatedAt = new Date().toISOString();
    return this.snapshot();
  }

  _record(kind, proposalId, itemId, before, after, extra = {}) {
    const now = new Date().toISOString();
    const event = {
      id: `history-${this.state.nextEventId++}`,
      kind, proposalId, itemId, createdAt: now,
      beforeRevision: projectRevision(before), afterRevision: projectRevision(after),
      beforeProject: structuredClone(before), afterProject: structuredClone(after), ...structuredClone(extra),
    };
    this.state.history.push(event); this.state.updatedAt = now; return event;
  }

  _proposal(id) {
    const proposal = this.state.proposals.find((entry) => entry.id === id);
    if (!proposal) throw new ProposalLedgerError(`proposal "${id}" does not exist`);
    return proposal;
  }

  _item(proposalId, itemId) {
    const item = this._proposal(proposalId).items.find((entry) => entry.id === itemId);
    if (!item) throw new ProposalLedgerError(`proposal item "${itemId}" does not exist`);
    return item;
  }
}

export function emptyState() {
  const now = new Date().toISOString();
  return { version: PROPOSAL_LEDGER_VERSION, proposals: [], history: [], redo: [], nextEventId: 1, createdAt: now, updatedAt: now };
}

export function normalizeProposal(raw, expectedRevision) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProposalLedgerError('proposal must be an object');
  const proposal = structuredClone(raw);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(proposal.id)) throw new ProposalLedgerError('proposal.id must be a stable kebab-case identifier');
  if (proposal.baseRevision !== expectedRevision) throw new ProposalLedgerError(`proposal is stale: expected ${expectedRevision}, received ${proposal.baseRevision}`);
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim()) throw new ProposalLedgerError('proposal.summary is required');
  if (!Array.isArray(proposal.items) || !proposal.items.length) throw new ProposalLedgerError('proposal.items must be non-empty');
  const ids = new Set();
  proposal.items = proposal.items.map((rawItem) => {
    const item = structuredClone(rawItem);
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(item.id) || ids.has(item.id)) throw new ProposalLedgerError(`invalid or duplicate proposal item id "${item.id}"`);
    ids.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim()) throw new ProposalLedgerError(`item "${item.id}" requires title`);
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) throw new ProposalLedgerError(`item "${item.id}" requires rationale`);
    if (!Array.isArray(item.dependencies)) throw new ProposalLedgerError(`item "${item.id}" dependencies must be an array`);
    item.status = 'proposed'; item.branches = []; item.activeBranchId = null;
    activeMutation(item);
    return item;
  });
  for (const item of proposal.items) for (const dependency of item.dependencies) if (!ids.has(dependency) || dependency === item.id) throw new ProposalLedgerError(`item "${item.id}" has invalid dependency "${dependency}"`);
  dependencyOrder(proposal, proposal.items.map((item) => item.id));
  proposal.createdAt = proposal.createdAt ?? new Date().toISOString();
  proposal.review = proposal.review ?? { stage: 'proposal', captures: [], diagnostics: [], passes: 0 };
  proposal.threadId = proposal.threadId ?? null;
  return proposal;
}

function normalizeBranch(raw, item) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProposalLedgerError('branch must be an object');
  const branch = structuredClone(raw);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(branch.id)) throw new ProposalLedgerError('branch.id must be a stable kebab-case identifier');
  if (item.branches.some((entry) => entry.id === branch.id)) throw new ProposalLedgerError(`branch "${branch.id}" already exists`);
  if (typeof branch.rationale !== 'string' || !branch.rationale.trim()) throw new ProposalLedgerError('branch.rationale is required');
  if (!branch.mutation) throw new ProposalLedgerError('branch.mutation is required');
  activeMutation({ ...item, branches: [branch], activeBranchId: branch.id });
  branch.createdAt = branch.createdAt ?? new Date().toISOString();
  return branch;
}

function activeMutation(item) {
  const mutation = item.activeBranchId
    ? item.branches.find((branch) => branch.id === item.activeBranchId)?.mutation
    : item.mutation;
  if (!mutation || typeof mutation !== 'object' || !['create', 'replace', 'delete'].includes(mutation.op)) throw new ProposalLedgerError(`item "${item.id}" has an invalid mutation`);
  return mutation;
}

function dependencyOrder(proposal, requestedIds) {
  const byId = new Map(proposal.items.map((item) => [item.id, item]));
  const result = [], permanent = new Set(), temporary = new Set();
  const visit = (id) => {
    const item = byId.get(id); if (!item) throw new ProposalLedgerError(`item "${id}" does not exist`);
    if (permanent.has(id)) return; if (temporary.has(id)) throw new ProposalLedgerError(`proposal dependencies contain a cycle at "${id}"`);
    temporary.add(id); for (const dependency of item.dependencies) visit(dependency); temporary.delete(id); permanent.add(id); result.push(item);
  };
  for (const id of requestedIds) visit(id);
  return result;
}

function normalizeState(raw) {
  const state = structuredClone(raw);
  if (state.version !== PROPOSAL_LEDGER_VERSION) throw new ProposalLedgerError(`state.version must be ${PROPOSAL_LEDGER_VERSION}`);
  if (!Array.isArray(state.proposals) || !Array.isArray(state.history) || !Array.isArray(state.redo)) throw new ProposalLedgerError('state collections are invalid');
  if (!Number.isInteger(state.nextEventId) || state.nextEventId < 1) throw new ProposalLedgerError('state.nextEventId is invalid');
  return state;
}
