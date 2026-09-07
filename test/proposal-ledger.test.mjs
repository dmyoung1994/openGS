import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCourseProject, projectRevision } from '../src/course/CourseProject.js';
import { emptyState, ProposalLedger } from '../src/course/ProposalLedger.js';

const project = normalizeCourseProject(JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8')));

function proposal() {
  const hole = project.holes[0];
  const green = structuredClone(hole.greens[0]); green.r += 0.4;
  const bunker = structuredClone(hole.bunkers[0]); bunker.depth += 0.1;
  return {
    id: 'agent-proposal-1', baseRevision: projectRevision(project), summary: 'Refine two independent objects',
    items: [
      { id: 'move-green', title: 'Refine green', rationale: 'More usable target.', dependencies: [], mutation: { op: 'replace', entityType: 'green', entityId: green.id, parentId: hole.id, value: green } },
      { id: 'deepen-bunker', title: 'Deepen bunker', rationale: 'Supports the green change.', dependencies: ['move-green'], mutation: { op: 'replace', entityType: 'bunker', entityId: bunker.id, parentId: hole.id, value: bunker } },
    ],
  };
}

test('dependency selection applies prerequisites as separate history events', () => {
  const ledger = new ProposalLedger({ project }); ledger.addProposal(proposal());
  const result = ledger.applyItems('agent-proposal-1', ['deepen-bunker']);
  assert.deepEqual(result.applied.map(({ item }) => item.id), ['move-green', 'deepen-bunker']);
  assert.equal(ledger.state.history.filter(({ kind }) => kind === 'apply').length, 2);
});

test('undo and redo operate on one semantic object change', () => {
  const ledger = new ProposalLedger({ project }); ledger.addProposal(proposal()); ledger.applyItems('agent-proposal-1', ['move-green']);
  const changed = projectRevision(ledger.project); ledger.undo(); assert.equal(projectRevision(ledger.project), projectRevision(project));
  ledger.redo(); assert.equal(projectRevision(ledger.project), changed);
});

test('card revisions branch without changing sibling cards', () => {
  const ledger = new ProposalLedger({ project }); ledger.addProposal(proposal());
  const item = ledger.state.proposals[0].items[0]; const replacement = structuredClone(item.mutation.value); replacement.r += 0.2;
  ledger.branchItem('agent-proposal-1', 'move-green', { id: 'move-green-natural', rationale: 'Quieter contour edge.', mutation: { ...item.mutation, value: replacement } });
  assert.equal(ledger.state.proposals[0].items[0].branches.length, 1);
  assert.equal(ledger.state.proposals[0].items[1].branches.length, 0);
});

test('a direct live project turn becomes one reversible checkpoint instead of desynchronizing history', () => {
  const ledger = new ProposalLedger({ project, state: emptyState() });
  const beforeRevision = projectRevision(ledger.project);
  const liveProject = structuredClone(project);
  liveProject.meta.name = 'Live-built three-hole course';
  liveProject.meta.notes = 'Authored through the persistent WebGPU editor.';

  const recorded = ledger.recordExternalProjectChange({
    id: 'course-live-history-test',
    summary: 'Live build: create the routed course',
    title: 'Live course build checkpoint',
    rationale: 'One reversible direct workspace turn.',
    threadId: 'thread-live-history-test',
    project: liveProject,
  });

  assert.ok(recorded);
  assert.notEqual(projectRevision(ledger.project), beforeRevision);
  assert.equal(ledger.state.proposals.at(-1).items[0].status, 'applied');
  assert.equal(ledger.state.history.at(-1).externalProjectCheckpoint, true);
  ledger.undo();
  assert.equal(projectRevision(ledger.project), beforeRevision);
  ledger.redo();
  assert.equal(ledger.project.meta.name, 'Live-built three-hole course');
});
