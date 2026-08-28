import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { atomicJsonCheckpoint } from './atomic-json.mjs';
import { compileActiveCourse, migrateCourseV3, normalizeCourseProject } from '../../src/course/CourseProject.js';
import { emptyState, ProposalLedger } from '../../src/course/ProposalLedger.js';

export class CourseHistoryStore {
  constructor({ root, projectFile = 'course.project.json', runtimeFile = 'course.json', historyFile = '.course-builder/history.json' }) {
    this.root = root;
    this.projectPath = resolve(root, projectFile);
    this.runtimePath = resolve(root, runtimeFile);
    this.historyPath = resolve(root, historyFile);
    this.historyDirectory = dirname(this.historyPath);
  }

  async load() {
    let project;
    try { project = normalizeCourseProject(JSON.parse(await readFile(this.projectPath, 'utf8'))); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      project = migrateCourseV3(JSON.parse(await readFile(this.runtimePath, 'utf8')));
      await atomicJsonCheckpoint(this.projectPath, project);
    }
    let state;
    try { state = JSON.parse(await readFile(this.historyPath, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; state = emptyState(); }
    return new ProposalLedger({ project, state });
  }

  async save(ledger, { compileRuntime = true } = {}) {
    const snapshot = ledger.snapshot();
    await atomicJsonCheckpoint(this.projectPath, snapshot.project);
    await atomicJsonCheckpoint(this.historyPath, snapshot.state);
    if (compileRuntime) {
      const { runtime } = compileActiveCourse(snapshot.project);
      await atomicJsonCheckpoint(this.runtimePath, runtime);
    }
    return snapshot;
  }
}
