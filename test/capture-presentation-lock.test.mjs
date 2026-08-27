import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../scripts/shot.mjs', import.meta.url), 'utf8');

test('continuous production captures hold and restore the existing quality policy', () => {
  assert.match(source, /if \(shotTransitionSequence \|\| shotFlightSequence\) \{/);
  assert.match(source, /quality\.acquirePresentationLock\(\{ mode, renderScale \}\)/);
  assert.match(source, /quality\.releasePresentationLock\(lockId\)/);
  assert.match(source, /finally \{/,
    'presentation quality must restore even when a capture assertion fails');
  assert.match(source, /--capture-scale must be finite/);
  assert.match(source, /capture-quality', 'ultra'/,
    'canonical sequences should select the fixed full-fidelity workload');
  assert.match(source, /arg\('capture-scale', 1\)/,
    'canonical footage should render at native internal resolution');
  assert.match(source, /frame >= 4/,
    'capture must wait for the intentional quality resize before sampling signatures');
});

test('continuous captures continue to enforce a single production viewport signature', () => {
  assert.match(source, /window\.golf\.sm\.readViewportDiagnostics\(\)/);
  assert.match(source, /if \(signatures\.size !== 1\)/);
  assert.match(source, /Shot transition changed viewport\/backing-store dimensions/);
  assert.doesNotMatch(source, /WebGLRenderer|software rendering|mock viewport/i);
});
