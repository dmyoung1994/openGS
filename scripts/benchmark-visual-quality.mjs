// Canonical visual-quality capture and GPU benchmark.
//
// This is intentionally a consumer of the production diagnostics surface. It does
// not import or patch renderer code, hide scene workloads, or substitute a viewer.
// Every image comes from the actual index route through a foreground-exempt,
// headful Chrome WebGPU session.
//
//   npm run benchmark:visual-quality -- --out /tmp/golfsim-visual-quality
//   npm run benchmark:visual-quality -- --modes quality,ultra --scenarios pond,overview
//   npm run benchmark:visual-quality -- --help
import { launch } from 'puppeteer-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicJsonCheckpoint } from './lib/atomic-json.mjs';
import { decodePNG } from './lib/png.mjs';

const MODES = Object.freeze(['auto', 'battery', 'balanced', 'quality', 'ultra']);
const SCENARIOS = Object.freeze([
  {
    id: 'address',
    description: 'Address view over the tee and down the primary fairway.',
    position: [1.6, 2.05, 6.5],
    lookAt: [0, 1.2, -28],
  },
  {
    id: 'fairway-close',
    description: 'Low golfer-height close view across maintained fairway turf.',
    position: [2.0, 1.30, -48],
    lookAt: [2.5, 0.42, -80],
  },
  {
    id: 'green',
    description: 'Approach view into the final green and its alpine backdrop.',
    position: [7, 1.75, -244],
    lookAt: [16, 0.55, -279],
  },
  {
    id: 'rough',
    description: 'Low camera at the rough/fairway edge.',
    position: [44, 1.45, -30],
    lookAt: [33, 0.45, -48],
  },
  {
    id: 'pond',
    description: 'Low oblique across pond, shoreline, terrain, and vegetation contacts.',
    position: [79, 1.40, -110],
    lookAt: [55, 0.15, -123],
  },
  {
    id: 'tree-edge',
    description: 'Golfer-height look into the authored tree edge and understory.',
    position: [-54, 1.65, -48],
    lookAt: [-74, 2.15, -70],
  },
  {
    id: 'overview',
    description: 'Elevated overview across terrain, tree line, and distant grass.',
    position: [0, 105, -110],
    lookAt: [0, 0.5, -145],
  },
]);

const USAGE = `Usage: node scripts/benchmark-visual-quality.mjs [options]

Captures the production WebGPU practice route for every requested quality mode and
camera scenario, writing PNGs plus report.json under --out.

Options:
  --url URL             Local Vite base URL (default: http://127.0.0.1:5173)
  --course ID           Course route: default or premium-range (default: default)
  --out DIR             Capture/report directory (default: benchmarks/visual-quality)
  --size WxH            CSS viewport size (default: 1280x720)
  --modes LIST          auto,battery,balanced,quality,ultra (default: all)
  --scenarios LIST      address,fairway-close,green,rough,pond,tree-edge,overview
  --settle FRAMES       Frames after each mode/camera cut (default: 45)
  --gpu-frames FRAMES   Native timestamp profile window, 1-30 (default: 12)
  --fov DEGREES         Evaluator camera field of view (default: 40)
  --timeout-ms MS       Navigation/readiness timeout (default: 90000)
  --live-adaptation     Opt-in live Auto benchmark; simulation stays frozen while
                        presentation/quality samples advance (defaults to --modes auto)
  --enforce-budget      Opt-in native budget gate for every capture, including fixed
                        modes; requires complete timestamps and both tracked GPU
                        ms/frame and completion p95 <= the selected mode target
                        (for example, Ultra uses its 16.7 ms target)
  --adapt-timeout-ms MS Maximum live Auto convergence window (default: 30000)
  --adapt-poll-frames N Frames between live adaptation samples (default: 8)
  --adapt-stable-polls N Consecutive target-ready samples required (default: 6)
  --help                Print this help without launching Chrome

The command is strict: WebGPU readiness, authored route identity, evaluator-camera
availability, non-blank output, and health diagnostics are required. Missing native
GPU timestamps are reported and fail the benchmark; images are retained when possible.
`;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const validateBooleanFlag = (name) => {
  const token = `--${name}`;
  const assignment = argv.find((value) => value.startsWith(`${token}=`));
  if (assignment) {
    throw new Error(`${token} is a flag and does not accept a value; use ${token} by itself.`);
  }
  const index = argv.indexOf(token);
  const next = index === -1 ? undefined : argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) {
    throw new Error(`${token} is a flag and does not accept a value; use ${token} by itself.`);
  }
};

const resolveBudgetGate = ({ enforceBudget = false, liveAdaptation = false } = {}) => ({
  enabled: enforceBudget === true || liveAdaptation === true,
  requestedByCli: enforceBudget === true,
  implicitForLiveAdaptation: liveAdaptation === true,
  source: liveAdaptation && enforceBudget
    ? 'live-adaptation+--enforce-budget'
    : liveAdaptation ? 'live-adaptation' : enforceBudget ? '--enforce-budget' : 'none',
  requiresCompleteNativeTimestamps: enforceBudget === true || liveAdaptation === true,
  requiresTrackedGpuMsPerFrame: enforceBudget === true || liveAdaptation === true,
  requiresCompletionP95Ms: enforceBudget === true || liveAdaptation === true,
  targetSource: 'final production quality snapshot targetMs/frameTargetMs',
});

const parsePositiveInteger = (value, name, { minimum = 1, maximum = Infinity } = {}) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
};

const parseSize = (value) => {
  const match = String(value).match(/^(\d+)x(\d+)$/i);
  if (!match) throw new Error(`--size must be WIDTHxHEIGHT; received ${String(value)}.`);
  return [parsePositiveInteger(match[1], 'size width'), parsePositiveInteger(match[2], 'size height')];
};

const parseList = (value, name, allowed) => {
  const values = [...new Set(String(value).split(',').map((entry) => entry.trim()).filter(Boolean))];
  if (!values.length) throw new Error(`--${name} must contain at least one value.`);
  const invalid = values.filter((entry) => !allowed.includes(entry));
  if (invalid.length) throw new Error(`Unknown --${name} value(s): ${invalid.join(', ')}.`);
  return values;
};

const finitePositive = (value) => Number.isFinite(value) && value > 0;
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;

const summarizeQualitySnapshot = (quality) => {
  const targetMs = finitePositive(quality?.targetMs)
    ? quality.targetMs
    : finitePositive(quality?.frameTargetMs) ? quality.frameTargetMs : null;
  const pressureMs = finitePositive(quality?.pressureMs)
    ? quality.pressureMs
    : finitePositive(quality?.ewma?.pressureMs) ? quality.ewma.pressureMs : null;
  const renderScale = Number.isFinite(quality?.renderScale) ? quality.renderScale : null;
  const adaptationCount = Number.isInteger(quality?.adaptationCount)
    ? quality.adaptationCount
    : null;
  return {
    mode: quality?.mode ?? null,
    activeMode: quality?.activeMode ?? null,
    startingMode: quality?.startingMode ?? null,
    renderScale,
    targetMs,
    frameMs: finitePositive(quality?.frameMs) ? quality.frameMs : null,
    gpuMs: finitePositive(quality?.gpuMs) ? quality.gpuMs : null,
    pressureMs,
    sampleCount: Number.isInteger(quality?.sampleCount) ? quality.sampleCount : null,
    highPressureSamples: Number.isInteger(quality?.highPressureSamples)
      ? quality.highPressureSamples : null,
    lowPressureSamples: Number.isInteger(quality?.lowPressureSamples)
      ? quality.lowPressureSamples : null,
    adaptationCount,
    lastAdaptationAt: Number.isFinite(quality?.lastAdaptationAt)
      ? quality.lastAdaptationAt : null,
    lastAdaptation: quality?.lastAdaptation ? { ...quality.lastAdaptation } : null,
    atLowerRenderScaleBound: quality?.atLowerRenderScaleBound === true,
    atUpperRenderScaleBound: quality?.atUpperRenderScaleBound === true,
  };
};

const vectorsMatch = (left, right, epsilon = 1e-5) => Array.isArray(left)
  && Array.isArray(right)
  && left.length === right.length
  && left.every((value, index) => Number.isFinite(value)
    && Number.isFinite(right[index])
    && Math.abs(value - right[index]) <= epsilon);

const cameraPoseMatches = (actual, expected, epsilon = 1e-5) => Boolean(
  actual?.owned === true
  && expected?.owned === true
  && vectorsMatch(actual.position, expected.position, epsilon)
  && vectorsMatch(actual.quaternion, expected.quaternion, epsilon)
  && vectorsMatch(actual.lookAt, expected.lookAt, epsilon)
  && Number.isFinite(actual.fov)
  && Number.isFinite(expected.fov)
  && Math.abs(actual.fov - expected.fov) <= epsilon,
);

const qualityStateKey = (quality) => (
  quality.activeMode === null || quality.renderScale === null
    ? null
    : `${quality.activeMode}:${quality.renderScale.toFixed(6)}`
);

/**
 * Track only the production quality snapshot values needed to prove live Auto
 * convergence. This is deliberately renderer-agnostic so the benchmark can
 * test the adaptation contract without replacing or mocking the scene.
 */
const createAdaptationConvergenceTracker = ({
  stablePolls = 6,
  expectedCamera = null,
  baselineAdaptationCount = 0,
} = {}) => {
  if (!Number.isInteger(stablePolls) || stablePolls < 1) {
    throw new RangeError('stablePolls must be a positive integer.');
  }

  const trace = [];
  const adaptationEvents = [];
  let previousStateKey = null;
  let stablePollCount = 0;
  let lastAdaptationCount = Number.isInteger(baselineAdaptationCount)
    ? baselineAdaptationCount : 0;
  let previousEvaluatorFrame = null;
  let previousSampleCount = null;
  let presentationFramesObserved = 0;
  let qualitySamplesObserved = 0;
  let latest = null;

  const observe = (sample, elapsedMs = 0) => {
    const quality = summarizeQualitySnapshot(sample?.quality);
    const camera = sample?.evaluatorCamera ?? null;
    const stateKey = qualityStateKey(quality);
    const stateChanged = previousStateKey !== null && stateKey !== previousStateKey;
    const withinTarget = finitePositive(quality.pressureMs)
      && finitePositive(quality.targetMs)
      && quality.pressureMs <= quality.targetMs;
    const cameraPoseStable = cameraPoseMatches(camera, expectedCamera);
    const cameraOwned = camera?.owned === true;
    const simulationFrozen = camera?.frozen === true;
    const evaluatorFrame = Number.isFinite(camera?.frame) ? camera.frame : null;
    const frameAdvancing = previousEvaluatorFrame !== null
      && evaluatorFrame !== null
      && evaluatorFrame > previousEvaluatorFrame;
    const sampleCountAdvancing = previousSampleCount !== null
      && quality.sampleCount !== null
      && quality.sampleCount > previousSampleCount;
    if (frameAdvancing) presentationFramesObserved += 1;
    if (sampleCountAdvancing) qualitySamplesObserved += 1;
    const presentationSampling = presentationFramesObserved > 0 && qualitySamplesObserved > 0;
    const lowPressure = (quality.lowPressureSamples ?? 0) > 0;
    const pendingUpgrade = withinTarget && lowPressure && (
      !quality.atUpperRenderScaleBound
      || quality.activeMode !== quality.startingMode
    );
    const targetReady = withinTarget
      && cameraOwned
      && cameraPoseStable
      && simulationFrozen
      && presentationSampling
      && !pendingUpgrade;

    if (targetReady && !stateChanged) stablePollCount += 1;
    else stablePollCount = 0;

    if (quality.adaptationCount !== null && quality.adaptationCount > lastAdaptationCount) {
      adaptationEvents.push({
        sequence: quality.adaptationCount,
        atMs: quality.lastAdaptationAt,
        ...quality.lastAdaptation,
      });
      lastAdaptationCount = quality.adaptationCount;
    } else if (quality.adaptationCount !== null) {
      lastAdaptationCount = Math.max(lastAdaptationCount, quality.adaptationCount);
    }

    const traceEntry = {
      sequence: trace.length + 1,
      atMs: Number.isFinite(sample?.atMs) ? sample.atMs : null,
      elapsedMs: Math.max(0, Math.round(Number.isFinite(elapsedMs) ? elapsedMs : 0)),
      frame: Number.isFinite(sample?.evaluatorCamera?.frame)
        ? sample.evaluatorCamera.frame : null,
      quality,
      evaluatorCamera: camera ? {
        owned: camera.owned === true,
        frozen: camera.frozen === true,
        position: Array.isArray(camera.position) ? [...camera.position] : null,
        quaternion: Array.isArray(camera.quaternion) ? [...camera.quaternion] : null,
        lookAt: Array.isArray(camera.lookAt) ? [...camera.lookAt] : null,
        fov: Number.isFinite(camera.fov) ? camera.fov : null,
      } : null,
      stateChanged,
      withinTarget,
      pendingUpgrade,
      targetReady,
      cameraOwned,
      cameraPoseStable,
      simulationFrozen,
      frameAdvancing,
      sampleCountAdvancing,
      presentationSampling,
      presentationFramesObserved,
      qualitySamplesObserved,
      stablePolls: stablePollCount,
    };
    trace.push(traceEntry);
    previousStateKey = stateKey;
    previousEvaluatorFrame = evaluatorFrame;
    previousSampleCount = quality.sampleCount;
    latest = traceEntry;
    return traceEntry;
  };

  const finalTargetStatus = ({
    timedOut = false,
    elapsedMs = 0,
    framesObserved = 0,
    reason = null,
  } = {}) => {
    const quality = latest?.quality ?? summarizeQualitySnapshot(null);
    const converged = stablePollCount >= stablePolls && latest?.targetReady === true;
    return {
      status: converged ? 'converged' : timedOut ? 'timed-out' : 'not-converged',
      converged,
      timedOut,
      reason: reason || (converged ? 'target-ready-state-stable' : 'awaiting-target-ready-state'),
      elapsedMs: Math.max(0, Math.round(Number.isFinite(elapsedMs) ? elapsedMs : 0)),
      framesObserved,
      stablePolls: stablePollCount,
      stablePollsRequired: stablePolls,
      withinTarget: latest?.withinTarget === true,
      targetReady: latest?.targetReady === true,
      pendingUpgrade: latest?.pendingUpgrade === true,
      targetMs: quality.targetMs,
      pressureMs: quality.pressureMs,
      frameMs: quality.frameMs,
      gpuMs: quality.gpuMs,
      activeMode: quality.activeMode,
      startingMode: quality.startingMode,
      renderScale: quality.renderScale,
      sampleCount: quality.sampleCount,
      adaptationCount: quality.adaptationCount,
      adaptationsObserved: adaptationEvents.length,
      presentationFramesObserved,
      qualitySamplesObserved,
      presentationSampling: latest?.presentationSampling === true,
      atLowerRenderScaleBound: quality.atLowerRenderScaleBound,
      atUpperRenderScaleBound: quality.atUpperRenderScaleBound,
      cameraOwned: latest?.cameraOwned === true,
      cameraPoseStable: latest?.cameraPoseStable === true,
      simulationFrozen: latest?.simulationFrozen === true,
    };
  };

  return {
    observe,
    trace,
    adaptationEvents,
    finalTargetStatus,
  };
};

const evaluateNativeGpuBudget = (gpuTiming, quality) => {
  const targetMs = finitePositive(quality?.targetMs)
    ? quality.targetMs
    : finitePositive(quality?.frameTargetMs) ? quality.frameTargetMs : null;
  const trackedGpuMsPerFrame = finiteNonNegative(gpuTiming?.trackedGpuMsPerFrame)
    ? gpuTiming.trackedGpuMsPerFrame
    : finiteNonNegative(gpuTiming?.captureThroughput?.trackedGpuMsPerFrame)
      ? gpuTiming.captureThroughput.trackedGpuMsPerFrame : null;
  const completionP95Ms = finiteNonNegative(gpuTiming?.completionP95Ms)
    ? gpuTiming.completionP95Ms
    : finiteNonNegative(gpuTiming?.captureThroughput?.completionDeltaP95Ms)
      ? gpuTiming.captureThroughput.completionDeltaP95Ms : null;
  const profileComplete = gpuTiming?.available === true && gpuTiming?.complete === true;
  const trackedWithinTarget = profileComplete
    && finitePositive(targetMs)
    && finiteNonNegative(trackedGpuMsPerFrame)
    && trackedGpuMsPerFrame <= targetMs;
  const completionP95WithinTarget = profileComplete
    && finitePositive(targetMs)
    && finiteNonNegative(completionP95Ms)
    && completionP95Ms <= targetMs;
  const failureReasons = [];
  if (!profileComplete) failureReasons.push('complete native WebGPU timestamps are required');
  if (!finitePositive(targetMs)) failureReasons.push('selected quality mode has no positive targetMs');
  if (profileComplete && !trackedWithinTarget) {
    failureReasons.push('tracked native GPU ms/frame exceeds the selected target or is unavailable');
  }
  if (profileComplete && !completionP95WithinTarget) {
    failureReasons.push('native completion p95 exceeds the selected target or is unavailable');
  }
  const passed = profileComplete && trackedWithinTarget && completionP95WithinTarget;
  return {
    status: passed ? 'pass' : 'fail',
    passed,
    profileComplete,
    selectedMode: quality?.activeMode ?? quality?.mode ?? null,
    targetMs,
    trackedGpuMsPerFrame,
    trackedWithinTarget,
    completionP95Ms,
    completionP95WithinTarget,
    timestampRequirement: {
      required: true,
      available: gpuTiming?.available === true,
      complete: gpuTiming?.complete === true,
      satisfied: profileComplete,
      framesRequested: gpuTiming?.framesRequested ?? null,
      framesCaptured: gpuTiming?.framesCaptured ?? null,
      unavailablePassCount: gpuTiming?.unavailablePassCount ?? null,
    },
    failureReasons,
    requirement: 'complete native WebGPU timestamps; tracked native GPU ms/frame and completion p95 must both be <= final quality targetMs',
  };
};

export {
  cameraPoseMatches,
  createAdaptationConvergenceTracker,
  evaluateNativeGpuBudget,
  resolveBudgetGate,
  summarizeQualitySnapshot,
};

const analyzePNG = (bytes) => {
  const { width, height, channels, pixels } = decodePNG(bytes);
  let lumaSum = 0;
  let lumaSquaredSum = 0;
  let nonBlack = 0;
  let nearBlack = 0;
  let nearWhite = 0;
  const pixelCount = width * height;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * channels;
    const luma = 0.2126 * pixels[offset]
      + 0.7152 * pixels[offset + 1]
      + 0.0722 * pixels[offset + 2];
    lumaSum += luma;
    lumaSquaredSum += luma * luma;
    if (luma > 3) nonBlack++;
    if (luma < 8) nearBlack++;
    if (luma > 247) nearWhite++;
  }
  const meanLuma = lumaSum / pixelCount;
  return {
    width,
    height,
    pixelCount,
    meanSrgbLuma: +meanLuma.toFixed(3),
    standardDeviation: +Math.sqrt(Math.max(0, lumaSquaredSum / pixelCount - meanLuma ** 2)).toFixed(3),
    nonBlackPct: +(100 * nonBlack / pixelCount).toFixed(3),
    nearBlackPct: +(100 * nearBlack / pixelCount).toFixed(3),
    nearWhitePct: +(100 * nearWhite / pixelCount).toFixed(3),
    nonBlank: meanLuma > 3 && nonBlack / pixelCount > 0.01,
  };
};

const uniquePush = (array, value) => {
  if (!array.includes(value)) array.push(value);
};

const keyLimitNames = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension',
  'maxStorageBuffersPerShaderStage',
  'maxBindGroups',
  'maxTextureDimension2D',
];

const main = async () => {
  if (has('help')) {
    console.log(USAGE);
    return;
  }

  const [width, height] = parseSize(arg('size', '1280x720'));
  validateBooleanFlag('enforce-budget');
  const liveAdaptation = has('live-adaptation');
  const enforceBudget = has('enforce-budget');
  const budgetGateConfig = resolveBudgetGate({ enforceBudget, liveAdaptation });
  const modes = parseList(arg('modes', liveAdaptation ? 'auto' : MODES.join(',')), 'modes', MODES);
  if (liveAdaptation && (modes.length !== 1 || modes[0] !== 'auto')) {
    throw new Error('--live-adaptation requires --modes auto (or no --modes option).');
  }
  const scenarioIds = parseList(arg('scenarios', SCENARIOS.map(({ id }) => id).join(',')),
    'scenarios', SCENARIOS.map(({ id }) => id));
  const scenarios = scenarioIds.map((id) => SCENARIOS.find((scenario) => scenario.id === id));
  const settleFrames = parsePositiveInteger(arg('settle', 45), 'settle', { minimum: 2, maximum: 600 });
  const gpuFrames = parsePositiveInteger(arg('gpu-frames', 12), 'gpu-frames', { maximum: 30 });
  const adaptationTimeoutMs = parsePositiveInteger(
    arg('adapt-timeout-ms', 30_000),
    'adapt-timeout-ms',
    { minimum: 1_000, maximum: 120_000 },
  );
  const adaptationPollFrames = parsePositiveInteger(
    arg('adapt-poll-frames', 8),
    'adapt-poll-frames',
    { maximum: 120 },
  );
  const adaptationStablePolls = parsePositiveInteger(
    arg('adapt-stable-polls', 6),
    'adapt-stable-polls',
    { minimum: 2, maximum: 60 },
  );
  const fov = Number(arg('fov', 40));
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new Error('--fov must be between 0 and 180 degrees.');
  const timeoutMs = parsePositiveInteger(arg('timeout-ms', 90_000), 'timeout-ms', { minimum: 1_000 });
  const base = String(arg('url', process.env.BENCHMARK_URL || 'http://127.0.0.1:5173'));
  const course = String(arg('course', 'default')).trim();
  if (!['default', 'premium-range'].includes(course)) {
    throw new Error(`--course must be default or premium-range; received ${course}.`);
  }
  const route = new URL('/index.html', base);
  if (!['http:', 'https:'].includes(route.protocol)) {
    throw new Error(`--url must be an HTTP(S) local route; received ${route.protocol}`);
  }
  route.searchParams.set('view', 'practice');
  if (course === 'premium-range') route.searchParams.set('course', course);
  const outDir = resolve(String(arg('out', 'benchmarks/visual-quality')));
  const reportPath = join(outDir, 'report.json');
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const report = {
    schemaVersion: 1,
    kind: 'visual-quality-benchmark',
    startedAt: new Date().toISOString(),
    outputDirectory: outDir,
    route: { requested: route.href, actual: null, status: null },
    contract: {
      backend: 'strict hardware WebGPU only; WebGL and software/fallback adapters fail',
      headfulChrome: true,
      freshUserDataDir: true,
      viewportCssPx: [width, height],
      deviceScaleFactor: 1,
      modes,
      course,
      scenarios: scenarioIds,
      settleFrames,
      gpuFrames,
      evaluatorCameraApi: '1.0',
      imageSource: 'canvas screenshot from the production index.html route',
      liveAdaptation: {
        enabled: liveAdaptation,
        mode: liveAdaptation ? 'auto' : null,
        timeoutMs: liveAdaptation ? adaptationTimeoutMs : null,
        pollFrames: liveAdaptation ? adaptationPollFrames : null,
        stablePolls: liveAdaptation ? adaptationStablePolls : null,
        defaultSimulationState: 'frozen evaluator scene; production quality sampling remains uncontrolled',
        liveSimulationState: liveAdaptation
          ? 'frozen evaluator scene; live presentation and quality sampling advance'
          : null,
        cameraInvariant: 'evaluator-owned exact pose throughout live sampling',
        nativeGpuBudgetGate: liveAdaptation
          ? 'trackedGpuMsPerFrame and available completion p95 <= final quality targetMs'
          : 'not required for non-adaptive captures',
        visualAssetResidencyBarrier: 'await golf.visualAssets.ready(resolved active mode) before settle/timing; record JSON-safe diagnostics',
      },
      budgetGate: {
        ...budgetGateConfig,
        scope: 'every requested mode/scenario capture',
        requirement: 'complete native WebGPU timestamps; tracked GPU ms/frame and completion p95 must both be <= the final selected mode target',
      },
    },
    browser: null,
    pageIdentity: null,
    gpuProfile: null,
    captures: [],
    health: {
      console: [],
      pageErrors: [],
      requestFailures: [],
      badResponses: [],
    },
    validation: {
      passed: false,
      errors: [],
      warnings: [],
      health: null,
      budgetGate: {
        ...budgetGateConfig,
        passed: null,
        captures: [],
      },
    },
    progress: {
      state: 'initializing',
      completed: [],
      requested: modes.flatMap((mode) => scenarioIds.map((scenario) => `${mode}/${scenario}`)),
    },
  };

  const checkpoint = () => atomicJsonCheckpoint(reportPath, report);
  const addError = (message) => uniquePush(report.validation.errors, String(message));
  const addWarning = (message) => uniquePush(report.validation.warnings, String(message));
  await checkpoint();

  let browser = null;
  let page = null;
  let userDataDir = null;
  let closingBrowser = false;

  try {
    userDataDir = await mkdtemp(join(tmpdir(), 'claude-golfsim-visual-quality-'));
    browser = await launch({
      executablePath: chrome,
      headless: false,
      userDataDir,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-position=-4000,-4000',
        `--window-size=${width},${height + 90}`,
        '--enable-unsafe-webgpu',
        '--hide-scrollbars',
        '--mute-audio',
      ],
      defaultViewport: { width, height, deviceScaleFactor: 1 },
    });
    report.browser = { version: await browser.version(), executablePath: chrome };
    browser.on('disconnected', () => {
      if (!closingBrowser) addError('Chrome disconnected before benchmark completion.');
    });

    page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.on('console', (message) => {
      const entry = `[${message.type()}] ${message.text()}`;
      report.health.console.push(entry);
      if (['warning', 'warn', 'error'].includes(message.type())
        || /webgpu.*(validation|error)|wgsl.*error|shader.*error/i.test(entry)) {
        addError(`Console health: ${entry}`);
      }
    });
    page.on('pageerror', (error) => {
      const entry = `[pageerror] ${error.message}`;
      report.health.pageErrors.push(entry);
      addError(entry);
    });
    page.on('requestfailed', (request) => {
      const entry = `${request.url()} — ${request.failure()?.errorText || 'request failed'}`;
      report.health.requestFailures.push(entry);
      addError(`[requestfailed] ${entry}`);
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const entry = `${response.status()} ${response.url()}`;
      report.health.badResponses.push(entry);
      addError(`[http] ${entry}`);
    });

    const navigation = await page.goto(route.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    report.route.actual = page.url();
    report.route.status = navigation?.status() ?? null;
    if (navigation && navigation.status() >= 400) throw new Error(`Production route returned HTTP ${navigation.status()}.`);

    try {
      await page.waitForFunction(
        () => window.golfBootstrap?.ready === true,
        { polling: 100, timeout: timeoutMs },
      );
    } catch (error) {
      const state = await page.evaluate(() => ({
        stage: window.golfBootstrap?.stage ?? null,
        error: window.golfBootstrap?.diagnostics?.error ?? null,
        stages: Array.from(window.golfBootstrap?.diagnostics?.stages ?? [], (entry) => ({ ...entry })),
      })).catch(() => null);
      throw new Error(`window.golfBootstrap.ready did not become true: ${JSON.stringify(state)}; ${error.message}`);
    }

    const preflight = await page.evaluate(async (limitsToRead) => {
      if (!window.golf?.environmentReady) throw new Error('window.golf.environmentReady is unavailable.');
      await window.golf.environmentReady;
      const golf = window.golf;
      const sm = golf.sm;
      const backend = sm?.renderer?.backend;
      const device = backend?.device;
      const info = backend?.adapterInfo || device?.adapterInfo || null;
      const adapterInfo = info ? {
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        device: info.device || null,
        description: info.description || null,
      } : null;
      const limits = device?.limits
        ? Object.fromEntries(limitsToRead.map((name) => [name, device.limits[name] ?? null]))
        : null;
      const gpuTimingAvailability = sm?.gpuProfiler?.availability?.() ?? {
        available: false,
        reason: 'Native GPU profiler is not exposed by the production SceneManager.',
      };
      return {
        pageIdentity: {
          href: location.href,
          pathname: location.pathname,
          title: document.title,
          view: document.body?.dataset?.view ?? null,
          canvas: Boolean(document.querySelector('canvas')),
        },
        bootstrap: {
          ready: window.golfBootstrap?.ready === true,
          stage: window.golfBootstrap?.stage ?? null,
          elapsedMs: window.golfBootstrap?.elapsedMs ?? null,
          error: window.golfBootstrap?.diagnostics?.error ?? null,
        },
        evaluatorCamera: {
          available: Boolean(golf.evaluatorCamera),
          version: golf.evaluatorCamera?.version ?? null,
          namespace: golf.evaluatorCamera?.namespace ?? null,
        },
        quality: {
          available: typeof golf.quality?.setMode === 'function'
            && typeof golf.quality?.snapshot === 'function',
          snapshot: golf.quality?.snapshot?.() ?? null,
        },
        webgpu: {
          navigatorGpu: Boolean(navigator.gpu),
          isWebGPUBackend: backend?.isWebGPUBackend === true,
          isWebGLBackend: backend?.isWebGLBackend === true,
          isFallbackAdapter: backend?.isFallbackAdapter ?? null,
          adapterInfo,
          features: device ? [...device.features].sort() : [],
          limits,
          environmentTier: sm?.environmentTier ?? null,
        },
        gpuTimingAvailability,
      };
    }, keyLimitNames);
    report.pageIdentity = preflight.pageIdentity;
    report.gpuProfile = {
      ...preflight.webgpu,
      timestampQuery: preflight.gpuTimingAvailability,
    };

    if (preflight.pageIdentity.pathname !== '/index.html') {
      addError(`Page identity mismatch: expected /index.html, got ${preflight.pageIdentity.pathname}.`);
    }
    if (preflight.pageIdentity.view !== 'practice') {
      addError(`Page identity mismatch: expected practice view, got ${preflight.pageIdentity.view}.`);
    }
    if (!preflight.pageIdentity.canvas) addError('Production page has no renderer canvas.');
    if (!preflight.bootstrap.ready) addError('Bootstrap diagnostics did not confirm ready state.');
    if (!preflight.evaluatorCamera.available || preflight.evaluatorCamera.version !== '1.0') {
      addError(`Evaluator camera API v1.0 is unavailable: ${JSON.stringify(preflight.evaluatorCamera)}.`);
    }
    if (!preflight.quality.available) addError('Visual quality API is unavailable.');
    const adapterText = Object.values(preflight.webgpu.adapterInfo || {}).join(' ');
    if (!preflight.webgpu.navigatorGpu || !preflight.webgpu.isWebGPUBackend || preflight.webgpu.isWebGLBackend) {
      addError(`Strict WebGPU backend contract failed: ${JSON.stringify(preflight.webgpu)}.`);
    }
    if (preflight.webgpu.isFallbackAdapter === true
      || /swiftshader|software|llvmpipe|lavapipe/i.test(adapterText)) {
      addError(`Software/fallback WebGPU adapter is forbidden: ${adapterText || 'adapter identity unavailable'}.`);
    }
    if (!preflight.gpuTimingAvailability.available) {
      addError(`Native GPU timestamp profile unavailable: ${preflight.gpuTimingAvailability.reason || 'unknown reason'}.`);
    }

    report.progress.state = 'capturing';
    await checkpoint();
    if (report.validation.errors.length) {
      throw new Error('Production preflight failed; no visual-quality benchmark is valid.');
    }

    const canvas = await page.$('canvas');
    if (!canvas) throw new Error('No renderer canvas found after ready state.');

    const waitForFrames = async (count, waitTimeoutMs = timeoutMs) => {
      const framePromise = page.evaluate(async (frameCount) => {
        const evaluator = window.golf?.evaluatorCamera;
        if (!evaluator?.waitForFrames) throw new Error('Evaluator camera frame wait hook is unavailable.');
        await evaluator.waitForFrames(frameCount);
        return evaluator.getState();
      }, count);
      const boundedMs = Math.max(1, Math.floor(Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : timeoutMs));
      let timer = null;
      const timeoutPromise = new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), boundedMs);
      });
      try {
        return await Promise.race([framePromise, timeoutPromise]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    };

    const setMode = async (mode) => page.evaluate(async (requestedMode) => {
      const quality = window.golf?.quality;
      if (!quality || typeof quality.setMode !== 'function') throw new Error('Visual quality setMode API is unavailable.');
      const snapshot = quality.setMode(requestedMode, { persist: false, resetScale: true });
      if (!snapshot || snapshot.activeMode === undefined) throw new Error(`Quality mode ${requestedMode} returned no snapshot.`);
      const visualAssets = window.golf?.visualAssets;
      if (!visualAssets || typeof visualAssets.ready !== 'function') {
        throw new Error('Visual asset residency API golf.visualAssets.ready is unavailable.');
      }
      // Auto resolves to the capability-selected active mode. Explicit modes use
      // their requested profile. In both cases this barrier completes before any
      // settle frame, screenshot, presentation trace, or GPU timing begins.
      const resolvedMode = requestedMode === 'auto' ? snapshot.activeMode : requestedMode;
      const readiness = await visualAssets.ready(resolvedMode);
      if (readiness?.ready !== true) {
        throw new Error(`Visual asset profile ${resolvedMode} did not report ready state.`);
      }
      const jsonSafe = (value) => JSON.parse(JSON.stringify(value));
      const diagnostics = typeof visualAssets.diagnostics === 'function'
        ? visualAssets.diagnostics()
        : typeof visualAssets.snapshot === 'function' ? visualAssets.snapshot() : null;
      return {
        ...snapshot,
        visualAssets: {
          requestedMode,
          resolvedMode,
          readyAtMs: performance.now(),
          readiness: jsonSafe(readiness),
          diagnostics: jsonSafe(diagnostics),
        },
      };
    }, mode);

    const pose = async (scenario) => page.evaluate(({ camera, cameraFov }) => {
      const golf = window.golf;
      const evaluator = golf?.evaluatorCamera;
      const terrain = golf?.range?.terrain;
      if (!evaluator || evaluator.version !== '1.0') throw new Error('Evaluator camera API v1.0 is unavailable.');
      if (!terrain || typeof terrain.heightAt !== 'function') throw new Error('Authoritative terrain heightAt API is unavailable.');
      if (!evaluator.owned) evaluator.enter();
      const [px, py, pz] = camera.position;
      const [lx, ly, lz] = camera.lookAt;
      const position = [px, terrain.heightAt(px, pz) + py, pz];
      const lookAt = [lx, terrain.heightAt(lx, lz) + ly, lz];
      evaluator.setPose({ position, lookAt, fov: cameraFov });
      evaluator.freeze();
      return { camera: evaluator.getState(), terrainHeights: { position: position[1], lookAt: lookAt[1] } };
    }, { camera: scenario, cameraFov: fov });

    const readState = () => page.evaluate(() => {
      const golf = window.golf;
      const sm = golf?.sm;
      const renderer = sm?.renderer;
      const quality = golf?.quality?.snapshot?.() ?? null;
      return {
        quality,
        renderResolution: sm?.readRenderResolutionDiagnostics?.() ?? null,
        viewport: sm?.readViewportDiagnostics?.() ?? null,
        evaluatorCamera: golf?.evaluatorCamera?.getState?.() ?? null,
        rendererInfo: renderer?.info ? {
          frame: renderer.info.frame ?? null,
          renderCalls: renderer.info.render?.calls ?? null,
          renderTriangles: renderer.info.render?.triangles ?? null,
          computeCalls: renderer.info.compute?.calls ?? null,
        } : null,
      };
    });

    // Read this only after native timestamp capture. GPU buffer readback is an
    // intentional synchronization point and must never contaminate the timed
    // frames. Recording the resolved authored LOD memberships makes a tree-heavy
    // result explainable: policy snapshots alone cannot prove which geometry the
    // indirect draw actually submitted for the evaluator camera.
    const readTreeDiagnostics = () => page.evaluate(async () => {
      const treeBeauty = window.golf?.range?.treeBeauty;
      if (!treeBeauty) return null;
      if (typeof treeBeauty.readDiagnostics !== 'function'
        || typeof treeBeauty.residencyEstimate !== 'function') {
        throw new Error('Tree beauty diagnostics are unavailable.');
      }
      const jsonSafe = (value) => JSON.parse(JSON.stringify(value));
      const gpu = await treeBeauty.readDiagnostics();
      const estimate = treeBeauty.residencyEstimate(window.golf.sm.camera);
      return { gpu: jsonSafe(gpu), estimate: jsonSafe(estimate) };
    });

    const readLiveState = () => page.evaluate(() => ({
      atMs: performance.now(),
      quality: window.golf?.quality?.snapshot?.() ?? null,
      evaluatorCamera: window.golf?.evaluatorCamera?.getState?.() ?? null,
    }));

    const waitForLiveAdaptation = async ({ expectedCamera, baselineAdaptationCount }) => {
      const startedAt = Date.now();
      const deadline = startedAt + adaptationTimeoutMs;
      const tracker = createAdaptationConvergenceTracker({
        stablePolls: adaptationStablePolls,
        expectedCamera,
        baselineAdaptationCount,
      });
      let framesObserved = 0;
      let timedOut = false;
      let timeoutReason = null;
      let latestSample = await readLiveState();
      tracker.observe(latestSample, 0);

      const observeAfterFrames = async (frameCount) => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          timeoutReason = 'live adaptation deadline expired while waiting for frames';
          return;
        }
        const frameState = await waitForFrames(frameCount, remainingMs);
        if (frameState === null) {
          timedOut = true;
          timeoutReason = `live adaptation frame wait exceeded ${adaptationTimeoutMs} ms`;
          return;
        }
        framesObserved += frameCount;
        latestSample = await readLiveState();
        tracker.observe(latestSample, Date.now() - startedAt);
      };

      // The requested settle window remains simulation-frozen in this mode. It
      // gives the real presentation loop enough samples to seed Auto's EWMA.
      if (tracker.finalTargetStatus().converged === false) {
        await observeAfterFrames(settleFrames);
      }
      while (!timedOut && tracker.finalTargetStatus().converged === false) {
        await observeAfterFrames(adaptationPollFrames);
      }

      const elapsedMs = Math.min(adaptationTimeoutMs, Math.max(0, Date.now() - startedAt));
      const finalTargetStatus = tracker.finalTargetStatus({
        timedOut,
        elapsedMs,
        framesObserved,
        reason: timeoutReason,
      });
      return {
        enabled: true,
        mode: 'auto',
        samplingControlled: true,
        samplingMode: 'frozen simulation with live presentation cadence',
        timeoutMs: adaptationTimeoutMs,
        warmupFrames: settleFrames,
        pollFrames: adaptationPollFrames,
        stablePollsRequired: adaptationStablePolls,
        adaptationTrace: [...tracker.trace],
        adaptationEvents: [...tracker.adaptationEvents],
        finalTargetStatus,
        finalSample: latestSample,
      };
    };

    const profileGpu = async () => page.evaluate(async (requestedFrames) => {
      const sm = window.golf?.sm;
      const profiler = sm?.gpuProfiler;
      const unavailable = profiler?.availability?.() ?? {
        available: false,
        reason: 'Native GPU profiler is unavailable.',
      };
      if (!unavailable.available) return unavailable;
      const wasFrozen = Boolean(sm.freezeSimulation);
      sm.freezeSimulation = true;
      sm.pauseRendering();
      try {
        const resultPromise = profiler.capture(requestedFrames);
        for (let frame = 0; frame < requestedFrames; frame++) sm.renderSingleFrame();
        const result = await resultPromise;
        return {
          available: result.available,
          complete: result.complete,
          reason: result.reason || null,
          framesRequested: result.framesRequested ?? requestedFrames,
          framesCaptured: result.framesCaptured ?? null,
          unavailablePassCount: result.unavailablePassCount ?? null,
          lastFrameGpuMs: result.lastFrameGpuMs ?? null,
          trackedGpuMsPerFrame: result.captureThroughput?.trackedGpuMsPerFrame ?? null,
          completionP95Ms: result.captureThroughput?.completionDeltaP95Ms ?? null,
          captureThroughput: result.captureThroughput ?? null,
          passCoverage: result.passCoverage ?? null,
          passes: result.passes?.map(({ label, type, samples, mean, p50, p95, max }) => ({
            label, type, samples, mean, p50, p95, max,
          })) ?? [],
        };
      } finally {
        sm.freezeSimulation = wasFrozen;
        sm.resumeRendering();
      }
    }, gpuFrames);

    for (const mode of modes) {
      for (const scenario of scenarios) {
        const captureId = `${mode}/${scenario.id}`;
        report.progress.active = captureId;
        await checkpoint();

        const healthStart = {
          console: report.health.console.length,
          pageErrors: report.health.pageErrors.length,
          requestFailures: report.health.requestFailures.length,
          badResponses: report.health.badResponses.length,
        };
        const modeSnapshot = await setMode(mode);
        const cameraState = await pose(scenario);
        let liveAdaptationReport = {
          enabled: false,
          mode: null,
          samplingControlled: false,
          timeoutMs: null,
          warmupFrames: null,
          pollFrames: null,
          stablePollsRequired: null,
          adaptationTrace: [],
          adaptationEvents: [],
          finalTargetStatus: {
            status: 'not-requested',
            converged: null,
            timedOut: false,
            reason: 'live convergence was not requested; frozen-scene capture does not disable production quality sampling',
          },
          nativeGpuBudget: {
            status: 'not-requested',
            passed: null,
            certificationRequired: false,
          },
        };
        if (liveAdaptation) {
          // Keep deterministic wind/daylight/scene state frozen. The production
          // loop still advances evaluator frames and presentation-cadence samples.
          liveAdaptationReport = await waitForLiveAdaptation({
            expectedCamera: cameraState.camera,
            baselineAdaptationCount: modeSnapshot.adaptationCount,
          });
          if (!liveAdaptationReport.finalTargetStatus.converged) {
            addError(`${captureId} live Auto adaptation did not converge: ${JSON.stringify(
              liveAdaptationReport.finalTargetStatus,
            )}`);
          }
          if (!liveAdaptationReport.finalTargetStatus.cameraPoseStable) {
            addError(`${captureId} evaluator camera pose changed during live adaptation.`);
          }
          if (!liveAdaptationReport.finalTargetStatus.simulationFrozen) {
            addError(`${captureId} live adaptation did not preserve the frozen simulation invariant.`);
          }
        } else {
          // Existing deterministic captures retain their original frozen behavior.
          await waitForFrames(settleFrames);
        }
        const state = await readState();
        const image = await canvas.screenshot();
        const imageStats = analyzePNG(image);
        const file = join(outDir, mode, `${scenario.id}.png`);
        await mkdir(join(outDir, mode), { recursive: true });
        await writeFile(file, image);
        if (!imageStats.nonBlank) addError(`${captureId} produced a blank or near-blank canvas.`);

        const gpuTiming = await profileGpu();
        if (!gpuTiming.available) {
          addError(`${captureId} GPU profile unavailable: ${gpuTiming.reason || 'unknown reason'}.`);
        } else if (!gpuTiming.complete) {
          addError(`${captureId} GPU profile incomplete: ${gpuTiming.reason || 'unavailable pass timestamps'}.`);
        }
        const treeDiagnostics = await readTreeDiagnostics();
        const finalQuality = state.quality || modeSnapshot;
        const measuredNativeGpuBudget = evaluateNativeGpuBudget(gpuTiming, finalQuality);
        const nativeGpuBudget = budgetGateConfig.enabled
          ? {
            ...measuredNativeGpuBudget,
            certificationRequired: true,
            gateSource: budgetGateConfig.source,
          }
          : {
            ...measuredNativeGpuBudget,
            status: 'not-requested',
            passed: null,
            certificationRequired: false,
            note: 'native budget measured but not used as a certification gate; pass --enforce-budget to enforce fixed-mode targets',
          };
        const captureBudgetGate = {
          ...nativeGpuBudget,
          enabled: budgetGateConfig.enabled,
          requestedByCli: enforceBudget,
          implicitForLiveAdaptation: liveAdaptation,
          requestedMode: mode,
          selectedMode: measuredNativeGpuBudget.selectedMode || modeSnapshot.activeMode || mode,
        };
        if (liveAdaptation) {
          liveAdaptationReport = {
            ...liveAdaptationReport,
            nativeGpuBudget: captureBudgetGate,
            finalTargetStatus: {
              ...liveAdaptationReport.finalTargetStatus,
              status: liveAdaptationReport.finalTargetStatus.converged && !captureBudgetGate.passed
                ? 'gpu-budget-failed' : liveAdaptationReport.finalTargetStatus.status,
              converged: liveAdaptationReport.finalTargetStatus.converged === true
                && captureBudgetGate.passed === true,
              nativeGpuBudgetPassed: captureBudgetGate.passed,
              trackedGpuMsPerFrame: captureBudgetGate.trackedGpuMsPerFrame,
              completionP95Ms: captureBudgetGate.completionP95Ms,
            },
          };
          if (!captureBudgetGate.passed) {
            addError(`${captureId} native GPU budget gate failed: ${JSON.stringify(captureBudgetGate)}.`);
          }
        } else {
          liveAdaptationReport.nativeGpuBudget = captureBudgetGate;
          if (enforceBudget && !captureBudgetGate.passed) {
            addError(`${captureId} native GPU budget gate failed: ${JSON.stringify(captureBudgetGate)}.`);
          }
        }

        const health = {
          consoleMessages: report.health.console.length - healthStart.console,
          consoleIssues: report.health.console.slice(healthStart.console)
            .filter((entry) => /^\[(warning|warn|error)\]/.test(entry)).length,
          pageErrors: report.health.pageErrors.length - healthStart.pageErrors,
          requestFailures: report.health.requestFailures.length - healthStart.requestFailures,
          badResponses: report.health.badResponses.length - healthStart.badResponses,
        };
        report.captures.push({
          id: captureId,
          mode,
          scenario: {
            id: scenario.id,
            description: scenario.description,
            position: scenario.position,
            lookAt: scenario.lookAt,
            fov,
          },
          file,
          camera: cameraState.camera,
          quality: state.quality || modeSnapshot,
          visualAssets: modeSnapshot.visualAssets,
          renderResolution: state.renderResolution,
          viewport: state.viewport,
          rendererInfo: state.rendererInfo,
          image: imageStats,
          gpuTiming,
          treeDiagnostics,
          budgetGate: captureBudgetGate,
          health,
          liveAdaptation: liveAdaptationReport,
        });
        report.progress.completed.push(captureId);
        delete report.progress.active;
        await checkpoint();
      }
    }

    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    report.validation.health = {
      consoleMessages: report.health.console.length,
      consoleIssues: report.health.console.filter((entry) => /^\[(warning|warn|error)\]/.test(entry)).length,
      pageErrors: report.health.pageErrors.length,
      requestFailures: report.health.requestFailures.length,
      badResponses: report.health.badResponses.length,
      healthy: report.health.console.every((entry) => !/^\[(warning|warn|error)\]/.test(entry))
        && report.health.pageErrors.length === 0
        && report.health.requestFailures.length === 0
        && report.health.badResponses.length === 0,
    };
    if (!report.validation.health.healthy) addError('Console/network health is not clean.');
    report.validation.liveAdaptation = {
      enabled: liveAdaptation,
      passed: !liveAdaptation || report.captures.every((capture) => (
        capture.liveAdaptation?.finalTargetStatus?.converged === true
        && capture.liveAdaptation?.finalTargetStatus?.cameraPoseStable === true
        && capture.liveAdaptation?.finalTargetStatus?.simulationFrozen === true
        && capture.liveAdaptation?.finalTargetStatus?.presentationSampling === true
        && capture.liveAdaptation?.finalTargetStatus?.nativeGpuBudgetPassed === true
      )),
      captures: report.captures.filter((capture) => capture.liveAdaptation?.enabled === true).map((capture) => ({
        id: capture.id,
        finalTargetStatus: capture.liveAdaptation.finalTargetStatus,
      })),
    };
    if (liveAdaptation && !report.validation.liveAdaptation.passed) {
      addError('One or more live Auto captures failed the adaptation/camera invariants.');
    }
    report.validation.budgetGate = {
      ...budgetGateConfig,
      passed: !budgetGateConfig.enabled || (
        report.captures.length === modes.length * scenarios.length
        && report.captures.every((capture) => capture.budgetGate?.passed === true)
      ),
      captures: report.captures.map((capture) => ({
        id: capture.id,
        enabled: capture.budgetGate?.enabled === true,
        requestedMode: capture.budgetGate?.requestedMode ?? null,
        selectedMode: capture.budgetGate?.selectedMode ?? null,
        targetMs: capture.budgetGate?.targetMs ?? null,
        profileComplete: capture.budgetGate?.profileComplete === true,
        trackedGpuMsPerFrame: capture.budgetGate?.trackedGpuMsPerFrame ?? null,
        completionP95Ms: capture.budgetGate?.completionP95Ms ?? null,
        passed: capture.budgetGate?.passed ?? null,
        failureReasons: capture.budgetGate?.failureReasons ?? [],
      })),
    };
    if (budgetGateConfig.enabled && !report.validation.budgetGate.passed) {
      addError('One or more captures failed the requested native GPU budget gate.');
    }
    report.validation.passed = report.validation.errors.length === 0
      && report.captures.length === modes.length * scenarios.length;
    report.progress.state = report.validation.passed ? 'complete' : 'failed';
    if (!report.validation.passed) process.exitCode = 1;
  } catch (error) {
    addError(error?.stack || error?.message || String(error));
    report.progress.state = 'failed';
    process.exitCode = 1;
  } finally {
    report.validation.health ??= {
      consoleMessages: report.health.console.length,
      consoleIssues: report.health.console.filter((entry) => /^\[(warning|warn|error)\]/.test(entry)).length,
      pageErrors: report.health.pageErrors.length,
      requestFailures: report.health.requestFailures.length,
      badResponses: report.health.badResponses.length,
      healthy: false,
    };
    report.finishedAt = new Date().toISOString();
    await checkpoint();
    try {
      await page?.evaluate(() => window.golf?.evaluatorCamera?.exit());
    } catch { /* the page may be gone after a strict bootstrap failure */ }
    closingBrowser = true;
    try { await browser?.close(); } catch { /* preserve the benchmark failure */ }
    if (userDataDir) {
      try { await rm(userDataDir, { recursive: true, force: true }); } catch (error) {
        addWarning(`Could not remove temporary Chrome profile: ${error.message}`);
        await checkpoint();
      }
    }
    console.log(`visual-quality benchmark report: ${reportPath}`);
    console.log(report.validation.passed ? 'visual-quality benchmark: PASS' : 'visual-quality benchmark: FAIL');
  }
};

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
