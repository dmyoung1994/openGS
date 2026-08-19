import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeTimestampIntervals } from '../src/diagnostics/GpuPassProfiler.js';

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('GPU timestamp intervals merge overlap instead of summing pass spans', () => {
  const summary = summarizeTimestampIntervals([
    { start: 0n, end: 10_000_000n },
    { start: 2_000_000n, end: 8_000_000n },
    { start: 12_000_000n, end: 15_000_000n },
  ]);

  assert.equal(summary.unionMs, 13);
  assert.equal(summary.envelopeMs, 15);
  assert.equal(summary.nonAdditiveSumMs, 19);
  assert.equal(summary.overlapFactor, 19 / 13);
});

test('GPU timestamp interval summary handles an empty frame', () => {
  assert.deepEqual(summarizeTimestampIntervals([]), {
    unionMs: 0,
    envelopeMs: 0,
    nonAdditiveSumMs: 0,
    overlapFactor: 1,
  });
});

test('dependent environment compute stages keep individual GPU timestamp coverage', async () => {
  // Three's Renderer.compute([a, b]) emits one WebGPU compute pass and calls the
  // inspector once with the array, not once per member.  The profiler can then only
  // label it "Compute pass", losing the required reset/classify/finalize coverage.
  // Keep these submissions separate until Three exposes per-dispatch timestamp hooks
  // inside an array compute group.
  const [trees, grass] = await Promise.all([
    source('src/scene/Trees.js'),
    source('src/terrain/Grass.js'),
  ]);

  assert.doesNotMatch(trees, /renderer\.compute\s*\(\s*\[/);
  assert.doesNotMatch(grass, /renderer\.compute\s*\(\s*\[/);

  for (const node of ['_clearCompute', '_compactCompute', '_finalizeCompute']) {
    assert.match(trees, new RegExp(`renderer\\.compute\\(this\\.${node}\\)`));
  }
  for (const node of ['_clearCompute', '_tileCompute', '_tileFinalizeCompute', '_candidateCompute', '_drawFinalizeCompute']) {
    assert.match(grass, new RegExp(`renderer\\.compute\\( this\\.${node}`));
  }
});
