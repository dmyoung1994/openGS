import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  cameraPoseMatches,
  createAdaptationConvergenceTracker,
  evaluateNativeGpuBudget,
  resolveBudgetGate,
} from '../scripts/benchmark-visual-quality.mjs';

const runNode = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({
    code,
    signal,
    stdout,
    stderr,
  }));
});

test('visual-quality benchmark is a strict production WebGPU capture contract', async () => {
  const [source, packageSource] = await Promise.all([
    readFile(new URL('../scripts/benchmark-visual-quality.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts['benchmark:visual-quality'], 'node scripts/benchmark-visual-quality.mjs');
  assert.match(source, /from 'puppeteer-core'/);
  assert.match(source, /headless:\s*false/);
  assert.match(source, /userDataDir/);
  assert.match(source, /mkdtemp\(join\(tmpdir\(\), 'claude-golfsim-visual-quality-'/);
  assert.match(source, /--enable-unsafe-webgpu/);
  assert.match(source, /window\.golfBootstrap\?\.ready === true/);
  assert.match(source, /window\.golf\.environmentReady/);
  assert.match(source, /evaluatorCamera\.version !== '1\.0'/);
  assert.match(source, /evaluator\.setPose/);
  assert.match(source, /evaluator\.freeze\(\)/);
  assert.match(source, /--live-adaptation/);
  assert.match(source, /--enforce-budget/);
  assert.match(source, /16\.7 ms target/);
  assert.match(source, /adaptationTimeoutMs/);
  assert.match(source, /adaptationTrace/);
  assert.match(source, /finalTargetStatus/);
  assert.match(source, /Promise\.race/);
  assert.doesNotMatch(source, /evaluator\.unfreeze\(\)/);
  assert.match(source, /defaultSimulationState: 'frozen evaluator scene/);
  assert.match(source, /cameraPoseStable/);
  assert.match(source, /simulationFrozen/);
  assert.match(source, /presentationSampling/);
  assert.match(source, /trackedGpuMsPerFrame/);
  assert.match(source, /completionP95Ms/);
  assert.match(source, /timestampRequirement/);
  assert.match(source, /requiresCompleteNativeTimestamps/);
  assert.match(source, /validation\.budgetGate/);
  assert.match(source, /selectedMode/);
  assert.match(source, /nativeGpuBudgetPassed/);
  assert.match(source, /visualAssets\.ready\(resolvedMode\)/);
  assert.match(source, /visualAssets\.diagnostics\(\)/);
  assert.match(source, /const jsonSafe = \(value\) => JSON\.parse\(JSON\.stringify\(value\)\)/);
  assert.match(source, /Visual asset profile .* did not report ready state/);
  assert.match(source, /visualAssets: modeSnapshot\.visualAssets/);
  assert.match(source, /const treeDiagnostics = await readTreeDiagnostics\(\)/);
  assert.match(source, /await treeBeauty\.readDiagnostics\(\)/);
  assert.match(source, /treeBeauty\.residencyEstimate\(window\.golf\.sm\.camera\)/);
  assert.match(source, /gpuTiming,\s*treeDiagnostics,/);
  assert.match(source, /quality\.setMode\(requestedMode, \{ persist: false, resetScale: true \}\)/);
  assert.match(source, /--course must be default or premium-range/);
  assert.match(source, /route\.searchParams\.set\('course', course\)/);
  assert.match(source, /readRenderResolutionDiagnostics/);
  assert.match(source, /readViewportDiagnostics/);
  assert.match(source, /gpuProfiler/);
  assert.match(source, /profiler\.capture\(requestedFrames\)/);
  assert.match(source, /isWebGPUBackend/);
  assert.match(source, /isWebGLBackend/);
  assert.match(source, /isFallbackAdapter/);
  assert.match(source, /canvas\.screenshot\(\)/);
  assert.match(source, /requestfailed/);
  assert.match(source, /pageerror/);
  assert.match(source, /report\.health\.badResponses/);
  for (const value of ['address', 'fairway-close', 'green', 'rough', 'pond', 'tree-edge', 'overview']) {
    assert.match(source, new RegExp(`id: '${value}'`));
  }
  for (const value of ['auto', 'battery', 'balanced', 'quality', 'ultra']) {
    assert.match(source, new RegExp(`'${value}'`));
  }
  assert.match(source, /visual-quality benchmark: FAIL/);
  assert.match(source, /process\.exitCode = 1/);
});

test('live adaptation tracker converges only with live samples and a stable target-ready state', () => {
  const camera = {
    owned: true,
    frozen: true,
    position: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    lookAt: [4, 5, 6],
    fov: 40,
    frame: 10,
  };
  const tracker = createAdaptationConvergenceTracker({
    stablePolls: 2,
    expectedCamera: camera,
    baselineAdaptationCount: 4,
  });

  for (let index = 0; index < 3; index++) {
    tracker.observe({
      atMs: index * 100,
      evaluatorCamera: { ...camera, frame: camera.frame + index },
      quality: {
        mode: 'auto',
        activeMode: 'quality',
        startingMode: 'quality',
        renderScale: 0.82,
        targetMs: 33.3,
        pressureMs: 27,
        frameMs: 27,
        sampleCount: index + 1,
        lowPressureSamples: 0,
        highPressureSamples: 0,
        adaptationCount: 4,
        atUpperRenderScaleBound: false,
        atLowerRenderScaleBound: false,
      },
    }, index * 100);
  }

  const status = tracker.finalTargetStatus({ elapsedMs: 200, framesObserved: 24 });
  assert.equal(status.status, 'converged');
  assert.equal(status.converged, true);
  assert.equal(status.withinTarget, true);
  assert.equal(status.cameraPoseStable, true);
  assert.equal(status.simulationFrozen, true);
  assert.equal(status.presentationSampling, true);
  assert.equal(tracker.trace.length, 3);
  assert.equal(tracker.adaptationEvents.length, 0);
});

test('live adaptation tracker records workload changes and refuses a pending upgrade', () => {
  const camera = {
    owned: true,
    frozen: true,
    position: [0, 1, 2],
    quaternion: [0, 0, 0, 1],
    lookAt: [3, 4, 5],
    fov: 40,
  };
  const tracker = createAdaptationConvergenceTracker({
    stablePolls: 2,
    expectedCamera: camera,
  });
  tracker.observe({
    atMs: 0,
    evaluatorCamera: camera,
    quality: {
      activeMode: 'quality',
      startingMode: 'quality',
      renderScale: 0.82,
      targetMs: 33.3,
      pressureMs: 20,
      sampleCount: 20,
      lowPressureSamples: 3,
      adaptationCount: 0,
      atUpperRenderScaleBound: false,
    },
  });
  tracker.observe({
    atMs: 100,
    evaluatorCamera: camera,
    quality: {
      activeMode: 'balanced',
      startingMode: 'quality',
      renderScale: 0.75,
      targetMs: 33.3,
      pressureMs: 32,
      sampleCount: 21,
      lowPressureSamples: 0,
      adaptationCount: 1,
      lastAdaptationAt: 100,
      lastAdaptation: {
        direction: 'down',
        kind: 'workload',
        fromMode: 'quality',
        toMode: 'balanced',
      },
      atUpperRenderScaleBound: false,
    },
  });

  const status = tracker.finalTargetStatus({ timedOut: true, elapsedMs: 300, framesObserved: 16 });
  assert.equal(status.status, 'timed-out');
  assert.equal(status.converged, false);
  assert.equal(status.pendingUpgrade, false);
  assert.equal(status.simulationFrozen, true);
  assert.equal(tracker.adaptationEvents.length, 1);
  assert.equal(tracker.adaptationEvents[0].toMode, 'balanced');
  assert.equal(tracker.trace[0].pendingUpgrade, true);
  assert.equal(tracker.trace[1].stateChanged, true);
});

test('live adaptation tracker detects camera drift and frozen samples', () => {
  const expected = {
    owned: true,
    frozen: true,
    position: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    lookAt: [4, 5, 6],
    fov: 40,
  };
  assert.equal(cameraPoseMatches({ ...expected }, expected), true);
  assert.equal(cameraPoseMatches({
    ...expected,
    owned: true,
    position: [1.1, 2, 3],
  }, expected), false);

  const tracker = createAdaptationConvergenceTracker({ stablePolls: 2, expectedCamera: expected });
  tracker.observe({
    atMs: 0,
    evaluatorCamera: expected,
    quality: {
      activeMode: 'quality',
      startingMode: 'quality',
      renderScale: 0.82,
      targetMs: 33.3,
      pressureMs: 20,
      sampleCount: 1,
      lowPressureSamples: 0,
      adaptationCount: 0,
    },
  });
  const status = tracker.finalTargetStatus({ timedOut: true, elapsedMs: 100, framesObserved: 1 });
  assert.equal(status.converged, false);
  assert.equal(status.cameraPoseStable, true);
  assert.equal(status.simulationFrozen, true);
  assert.equal(status.presentationSampling, false);
});

test('native GPU budget gate requires tracked frame time and available completion p95 to meet the final target', () => {
  const quality = { targetMs: 33.3 };
  const pass = evaluateNativeGpuBudget({
    available: true,
    complete: true,
    captureThroughput: {
      trackedGpuMsPerFrame: 30.5,
      completionDeltaP95Ms: 32.9,
    },
  }, quality);
  assert.equal(pass.passed, true);
  assert.equal(pass.trackedWithinTarget, true);
  assert.equal(pass.completionP95WithinTarget, true);

  const fail = evaluateNativeGpuBudget({
    available: true,
    complete: true,
    trackedGpuMsPerFrame: 31,
    completionP95Ms: 34,
  }, quality);
  assert.equal(fail.passed, false);
  assert.equal(fail.trackedWithinTarget, true);
  assert.equal(fail.completionP95WithinTarget, false);

  const incomplete = evaluateNativeGpuBudget({ available: true, complete: false }, quality);
  assert.equal(incomplete.passed, false);
  assert.equal(incomplete.profileComplete, false);
  assert.equal(incomplete.timestampRequirement.satisfied, false);

  const missingCompletionP95 = evaluateNativeGpuBudget({
    available: true,
    complete: true,
    framesRequested: 12,
    framesCaptured: 12,
    captureThroughput: { trackedGpuMsPerFrame: 15.8 },
  }, { mode: 'ultra', activeMode: 'ultra', targetMs: 16.7 });
  assert.equal(missingCompletionP95.passed, false);
  assert.equal(missingCompletionP95.selectedMode, 'ultra');
  assert.equal(missingCompletionP95.trackedWithinTarget, true);
  assert.equal(missingCompletionP95.completionP95WithinTarget, false);
  assert.match(missingCompletionP95.failureReasons.join(' '), /completion p95/);

  const ultraPass = evaluateNativeGpuBudget({
    available: true,
    complete: true,
    framesRequested: 12,
    framesCaptured: 12,
    captureThroughput: {
      trackedGpuMsPerFrame: 16.6,
      completionDeltaP95Ms: 16.7,
    },
  }, { mode: 'ultra', activeMode: 'ultra', targetMs: 16.7 });
  assert.equal(ultraPass.passed, true);
  assert.equal(ultraPass.targetMs, 16.7);
  assert.equal(ultraPass.timestampRequirement.satisfied, true);
});

test('budget gate is opt-in for fixed modes and remains implicit for live Auto', () => {
  const disabled = resolveBudgetGate();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.requestedByCli, false);
  assert.equal(disabled.source, 'none');

  const fixed = resolveBudgetGate({ enforceBudget: true });
  assert.equal(fixed.enabled, true);
  assert.equal(fixed.requestedByCli, true);
  assert.equal(fixed.implicitForLiveAdaptation, false);
  assert.equal(fixed.source, '--enforce-budget');
  assert.equal(fixed.requiresCompleteNativeTimestamps, true);
  assert.equal(fixed.requiresTrackedGpuMsPerFrame, true);
  assert.equal(fixed.requiresCompletionP95Ms, true);

  const live = resolveBudgetGate({ liveAdaptation: true });
  assert.equal(live.enabled, true);
  assert.equal(live.requestedByCli, false);
  assert.equal(live.implicitForLiveAdaptation, true);
  assert.equal(live.source, 'live-adaptation');
});

test('live adaptation CLI is opt-in and rejects non-Auto mode before launching Chrome', async () => {
  const help = await runNode(['scripts/benchmark-visual-quality.mjs', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--live-adaptation/);
  assert.match(help.stdout, /--enforce-budget/);
  assert.match(help.stdout, /complete timestamps/);
  assert.match(help.stdout, /16\.7 ms target/);
  assert.match(help.stdout, /--adapt-timeout-ms/);

  const invalid = await runNode([
    'scripts/benchmark-visual-quality.mjs',
    '--live-adaptation',
    '--modes',
    'quality',
  ]);
  assert.equal(invalid.code, 1);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /requires --modes auto/);

  const invalidBudgetValue = await runNode([
    'scripts/benchmark-visual-quality.mjs',
    '--enforce-budget',
    'true',
  ]);
  assert.equal(invalidBudgetValue.code, 1);
  assert.match(`${invalidBudgetValue.stdout}\n${invalidBudgetValue.stderr}`, /does not accept a value/);
});
