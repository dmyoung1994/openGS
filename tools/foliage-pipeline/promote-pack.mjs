import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALIAS_RE = /^(builtin|local)\.[a-z0-9]+(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(`Foliage promotion refused: ${message}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || !argv[index + 1]) fail('expected --source, --output, and --approval');
    values.set(key.slice(2), argv[index + 1]);
  }
  for (const key of ['source', 'output', 'approval']) if (!values.has(key)) fail(`--${key} is required`);
  if ([...values.keys()].some((key) => !['source', 'output', 'approval'].includes(key))) fail('unknown argument');
  return Object.fromEntries(values);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unknown field "${unknown[0]}"`);
}

function validateApproval(record, manifest, candidateManifestSha256) {
  exactKeys(record, new Set([
    'schemaVersion', 'decision', 'foliageAlias', 'candidateManifestSha256',
    'reviewer', 'reviewedAt', 'evidence',
  ]), 'approval record');
  if (record.schemaVersion !== 1 || record.decision !== 'approved') fail('approval decision is not affirmative');
  if (!ALIAS_RE.test(record.foliageAlias || '') || record.foliageAlias !== manifest.foliageAlias) {
    fail('approval alias does not match the candidate manifest');
  }
  if (!SHA256_RE.test(record.candidateManifestSha256 || '')
    || record.candidateManifestSha256 !== candidateManifestSha256) {
    fail('approval does not pin the exact candidate manifest');
  }
  if (typeof record.reviewer !== 'string' || !record.reviewer.trim()
    || typeof record.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.reviewedAt)) {
    fail('approval reviewer/reviewedAt is malformed');
  }
  if (!Array.isArray(record.evidence) || record.evidence.length < 1
    || record.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail('approval must name at least one evidence artifact');
  }
}

function validateCandidateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1
    || manifest.compatibilityVersion !== 1 || manifest.candidateOnly !== true
    || manifest.validation?.state !== 'candidate' || !ALIAS_RE.test(manifest.foliageAlias || '')) {
    fail('source manifest is not a compatible candidate pack');
  }
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.length < 3) {
    fail('source manifest has no complete requiredFiles set');
  }
  const seen = new Set();
  for (const record of manifest.requiredFiles) {
    if (!record || typeof record.file !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(record.file)
      || record.file.includes('..') || !SHA256_RE.test(record.sha256 || '')
      || !Number.isInteger(record.bytes) || record.bytes <= 0 || seen.has(record.file)) {
      fail('source manifest contains a malformed required file');
    }
    seen.add(record.file);
  }
}

async function assertMissing(path) {
  try {
    await access(path);
    fail('output already exists; promotion never overwrites an installed pack');
  } catch (error) {
    if (error?.message?.startsWith('Foliage promotion refused:')) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function promoteFoliagePack({ source, output, approval }) {
  const sourceRoot = resolve(source);
  const outputRoot = resolve(output);
  const approvalPath = resolve(approval);
  if (sourceRoot === outputRoot || outputRoot.startsWith(`${sourceRoot}/`)) {
    fail('output must be a distinct immutable pack root, not inside the candidate');
  }
  await assertMissing(outputRoot);

  const candidateManifestBytes = await readFile(resolve(sourceRoot, 'foliage-pack.json'));
  const manifest = JSON.parse(candidateManifestBytes.toString('utf8'));
  validateCandidateManifest(manifest);
  const candidateManifestSha256 = sha256(candidateManifestBytes);
  const approvalBytes = await readFile(approvalPath);
  const approvalRecord = JSON.parse(approvalBytes.toString('utf8'));
  validateApproval(approvalRecord, manifest, candidateManifestSha256);

  const verified = [];
  for (const record of manifest.requiredFiles) {
    const bytes = await readFile(resolve(sourceRoot, record.file));
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
      fail(`candidate byte/hash mismatch: ${record.file}`);
    }
    verified.push({ record, bytes });
  }

  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot, { recursive: false });
  for (const { record } of verified) {
    await copyFile(resolve(sourceRoot, record.file), resolve(outputRoot, record.file));
  }
  const approvalSha256 = sha256(approvalBytes);
  const approvedManifest = {
    ...manifest,
    candidateOnly: false,
    validation: { ...manifest.validation, state: 'approved' },
    promotion: {
      candidateManifestSha256,
      approvalSha256,
      reviewer: approvalRecord.reviewer,
      reviewedAt: approvalRecord.reviewedAt,
      evidence: [...approvalRecord.evidence],
    },
  };
  await writeFile(resolve(outputRoot, 'foliage-pack.json'), `${JSON.stringify(approvedManifest, null, 2)}\n`, { flag: 'wx' });
  return Object.freeze({
    foliageAlias: manifest.foliageAlias,
    sourceRoot,
    outputRoot,
    candidateManifestSha256,
    approvalSha256,
    copiedFiles: verified.length,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  promoteFoliagePack(parseArgs(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}
