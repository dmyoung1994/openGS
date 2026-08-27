import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../scripts/capture-sizzle-reel.mjs', import.meta.url), 'utf8');

test('sizzle reel captures the real headful strict-WebGPU production path', () => {
  assert.match(source, /headless: false/);
  assert.match(source, /userDataDir/);
  assert.match(source, /--force-device-scale-factor=1/);
  assert.match(source, /devicePixelRatio !== 1/);
  assert.match(source, /window\.golfBootstrap\?\.ready === true/);
  assert.match(source, /webgpuRenderer/);
  assert.match(source, /webgpuBackend/);
  assert.match(source, /fallbackAdapter/);
  assert.match(source, /window\.golf\.sm\.pauseRendering\(\)/);
  assert.match(source, /window\.golf\.sm\.renderSingleFrame\(deltaSeconds\)/);
  assert.match(source, /fixedDeltaSeconds = 1 \/ fps/);
  assert.match(source, /'-f', 'image2pipe'/);
  assert.match(source, /'-i', 'pipe:0'/);
  assert.match(source, /await encoder\.writeFrame\(buffer\)/);
  assert.match(source, /No PNG sequence is\s*\n\s*\/\/ staged on disk/);
  assert.doesNotMatch(source, /frameDirectory|f%06d\.png/);
  assert.doesNotMatch(source, /Page\.startScreencast|screencastFrameAck|optical flow/i);
  assert.doesNotMatch(source, /WebGLRenderer|software rendering|mock trajectory/i);
});

test('sizzle reel uses existing camera, quality, launch-monitor, and shot-result contracts', () => {
  assert.match(source, /window\.golf\.evaluatorCamera/);
  assert.match(source, /acquirePresentationLock/);
  assert.match(source, /releasePresentationLock/);
  assert.match(source, /window\.golf\.launchMonitor\.submit/);
  assert.match(source, /window\.golf\?\.ball\?\.state === 'rest'/);
  assert.match(source, /window\.golf\?\.director\?\.phase === 'result'/);
  assert.match(source, /proof immediately after the production frame that emits rest/);
  assert.match(source, /resultVisible/);
  assert.match(source, /body\.gs-sizzle-shot \.gs-shot-ui/);
  assert.match(source, /getComputedStyle\(results\)/);
  assert.match(source, /page\.screenshot\(\{/);
  assert.match(source, /id: '05-result-hold'/);
  assert.match(source, /const onlyShot = has\('only-shot'\)/);
  assert.match(source, /carryYards/);
  assert.match(source, /totalYards/);
});

test('sizzle reel emits a shareable H.264 master and repeatable QA evidence', () => {
  assert.match(source, /'-c:v', 'libx264'/);
  assert.match(source, /'-pix_fmt', 'yuv420p'/);
  assert.match(source, /'-movflags', '\+faststart'/);
  assert.match(source, /force_original_aspect_ratio=increase/);
  assert.match(source, /crop=\$\{width\}:\$\{height\}/);
  assert.match(source, /restrained-photographic-daylight/);
  assert.match(source, /eq=contrast=0\.97/);
  assert.match(source, /colorbalance=/);
  assert.match(source, /Rangeform/);
  assert.match(source, /contactSheet/);
  assert.match(source, /consoleNetworkErrors/);
  assert.match(source, /viewportSignatures/);
  assert.match(source, /rightsSafeSilentMaster/);
});
