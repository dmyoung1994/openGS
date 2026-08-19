import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJsonCheckpoint } from '../scripts/lib/atomic-json.mjs';

test('benchmark JSON checkpoints replace reports atomically and leave no temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'golfsim-benchmark-checkpoint-'));
  const report = join(directory, 'report.json');
  try {
    await atomicJsonCheckpoint(report, { completed: ['address-tee'] });
    assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), { completed: ['address-tee'] });
    await atomicJsonCheckpoint(report, { completed: ['address-tee', 'low-rough'] });
    assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {
      completed: ['address-tee', 'low-rough'],
    });
    assert.deepEqual(await readdir(directory), ['report.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
