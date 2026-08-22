import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promoteFoliagePack } from '../tools/foliage-pipeline/promote-pack.mjs';

const sourceRoot = new URL('../public/assets/trees_candidates/generated_monterey_cypress/processed/v1/', import.meta.url);
const manifestBytes = await readFile(new URL('foliage-pack.json', sourceRoot));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');

async function fixture(decision = 'approved') {
  const root = await mkdtemp(join(tmpdir(), 'foliage-promotion-'));
  const approval = join(root, 'approval.json');
  await writeFile(approval, JSON.stringify({
    schemaVersion: 1,
    decision,
    foliageAlias: manifest.foliageAlias,
    candidateManifestSha256: manifestSha256,
    reviewer: 'automated promotion contract test',
    reviewedAt: '2026-08-21T12:00:00Z',
    evidence: ['test fixture: reviewed matrix'],
  }));
  return { root, approval, output: join(root, 'approved-pack') };
}

test('reviewed foliage promotion preserves every required byte and approves only the manifest', async () => {
  const paths = await fixture();
  try {
    const report = await promoteFoliagePack({ source: sourceRoot.pathname, output: paths.output, approval: paths.approval });
    assert.equal(report.foliageAlias, manifest.foliageAlias);
    assert.equal(report.copiedFiles, manifest.requiredFiles.length);
    const approved = JSON.parse(await readFile(join(paths.output, 'foliage-pack.json'), 'utf8'));
    assert.equal(approved.candidateOnly, false);
    assert.equal(approved.validation.state, 'approved');
    assert.equal(approved.promotion.candidateManifestSha256, manifestSha256);
    for (const record of manifest.requiredFiles) {
      assert.deepEqual(await readFile(join(paths.output, record.file)), await readFile(new URL(record.file, sourceRoot)));
    }
    await assert.rejects(() => promoteFoliagePack({
      source: sourceRoot.pathname, output: paths.output, approval: paths.approval,
    }), /never overwrites/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('foliage promotion rejects absent affirmative review and an unpinned candidate', async () => {
  const rejected = await fixture('rejected');
  try {
    await assert.rejects(() => promoteFoliagePack({
      source: sourceRoot.pathname, output: rejected.output, approval: rejected.approval,
    }), /not affirmative/);
    const record = JSON.parse(await readFile(rejected.approval, 'utf8'));
    record.decision = 'approved';
    record.candidateManifestSha256 = '0'.repeat(64);
    await writeFile(rejected.approval, JSON.stringify(record));
    await assert.rejects(() => promoteFoliagePack({
      source: sourceRoot.pathname, output: rejected.output, approval: rejected.approval,
    }), /does not pin/);
  } finally {
    await rm(rejected.root, { recursive: true, force: true });
  }
});
