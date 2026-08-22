// Reproducible WebGPU environment-render benchmark.
//
// This deliberately shares the browser-launch contract of scripts/shot.mjs: a real,
// foreground-exempt Chrome window with WebGPU enabled. Browser headless rendering and
// throttled background tabs do not exercise this renderer reliably. gputrace.mjs stays
// the companion for Metal command-buffer inspection; this script measures presentation
// intervals and Three's renderer.info counters. When the device exposes WebGPU
// timestamp-query, it also records one bounded pass-level GPU window per scenario.
//
//   npm run benchmark:env
//   npm run benchmark:env -- --url http://127.0.0.1:5173 --frames 360 --warmup 180
//   npm run benchmark:env -- --scenario address-tee
//
// Outputs one JSON report plus a PNG for each fixed camera. It is intentionally
// WebGPU-only: a WebGL fallback, unavailable adapter, page/shader/WebGPU error, or
// incomplete environment asset set makes the command fail after writing its report.
import { launch } from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { decodePNG } from './lib/png.mjs';
import { atomicJsonCheckpoint } from './lib/atomic-json.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};

const base = String(arg('url', process.env.BENCHMARK_URL || 'http://127.0.0.1:5173'));
const outDir = resolve(String(arg('out', 'benchmarks/environment')));
const [width, height] = String(arg('size', '1280x720')).split('x').map(Number);
const warmupFrames = Number(arg('warmup', 180));
const sampleFrames = Number(arg('frames', 300));
const gpuP95BudgetMs = Number(arg('gpu-p95-ms', 33.3));
const rafP95BudgetMs = Number(arg('raf-p95-ms', 34.0));
const maxHitches = Number(arg('max-hitches', 0));
const hitchThresholdMs = 50.0;
const maxRenderPasses = Number(arg('max-render-passes', 8));
// Canonical cloudy runtime contract. These values describe the shipped GPU
// resource and the single low-resolution sky integration plus its ping-pong resolve.
const cloudVolumeDimensions = '96x96x96';
const cloudLightTransportMode = 'paired-sun-offset-volume-probe';
// Sub-byte average error and two-tenths of one percent high-delta coverage remain
// well below visible motion, while accommodating the fixed-resolution volumetric
// cloud resolve at extreme sky-heavy camera pitches. Earlier broken resize/LOD
// cases measured 0.57 MAE / 1.27% and still fail these calibrated gates decisively.
const temporalMaeBudget = Number(arg('temporal-mae', 0.15));
const temporalChangedPixelBudgetPct = Number(arg('temporal-changed-pct', 0.2));
const performanceTier = String(arg('performance-tier', 'high-desktop-webgpu'));
const expectedDeviceTier = String(arg('expected-device-tier', 'high'));
const allowPerformanceMiss = argv.includes('--allow-performance-miss');
const requestedScenario = arg('scenario', null);
const saveTemporalCaptures = argv.includes('--save-temporal-captures');
const foliageCandidate = arg('foliage-candidate', null);
const forbiddenDiagnosticFlags = argv.filter((value) => value.startsWith('--diagnose-'));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (forbiddenDiagnosticFlags.length) {
  throw new Error(`The strict environment benchmark does not permit renderer-altering diagnostic flags: ${forbiddenDiagnosticFlags.join(', ')}`);
}

if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
  throw new Error(`Invalid --size ${arg('size', '')}; expected WIDTHxHEIGHT`);
}
if (!Number.isInteger(warmupFrames) || warmupFrames < 1 || !Number.isInteger(sampleFrames) || sampleFrames < 30) {
  throw new Error('--warmup must be >= 1 and --frames must be >= 30');
}
if (!performanceTier.trim()) throw new Error('--performance-tier must be a non-empty name');
if (!['high', 'balanced', 'conservative'].includes(expectedDeviceTier)) {
  throw new Error('--expected-device-tier must be high, balanced, or conservative');
}
if (![gpuP95BudgetMs, rafP95BudgetMs].every((value) => Number.isFinite(value) && value > 0)
  || !Number.isInteger(maxHitches) || maxHitches < 0
  || !Number.isInteger(maxRenderPasses) || maxRenderPasses < 1
  || ![temporalMaeBudget, temporalChangedPixelBudgetPct]
    .every((value) => Number.isFinite(value) && value >= 0)) {
  throw new Error('Benchmark budgets are invalid; timing values must be positive and counts/non-temporal thresholds non-negative');
}

// Positions and looks are world X/Z plus metres above the locally sampled terrain.
// These are fixed stress views, not director shots: comparisons remain valid while
// cinematic camera behavior evolves.
const scenarios = [
  {
    id: 'address-tee',
    description: 'Address view over the tee and down the primary fairway.',
    position: [1.6, 2.05, 6.5],
    lookAt: [0, 1.2, -28],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 50,
      maxMeanLuma: 160,
      maxNearBlackPct: 20,
      maxNearWhitePct: 10,
    },
  },
  {
    id: 'low-rough',
    description: 'Low camera at the rough/fairway edge; stresses cutout vegetation and AA.',
    // Golfer-eye low oblique, not a camera buried inside the 0.5–0.9 m rough
    // canopy. The former 0.55 m pose mostly photographed blade interiors and could
    // pass its luminance gate without showing any terrain/object contact at all.
    position: [44, 1.45, -30],
    lookAt: [33, 0.45, -48],
    // Excludes the launch monitor and sky, then checks the near rough itself. The
    // displaced-height-as-blade-coordinate bug drove this crop to 15 mean sRGB luma
    // with 81% near-black pixels; correctly lit open-sky rough is ~101 / 0% here.
    visualGate: {
      region: [0.25, 0.45, 1.0, 1.0],
      minMeanLuma: 45,
      maxMeanLuma: 180,
      maxNearBlackPct: 20,
      maxNearWhitePct: 5,
    },
  },
  {
    id: 'tree-edge-close',
    description: 'Golfer-height look into the lower forest edge; proves trunks, bases, and understory survive near LODs.',
    // Deliberately stands inside the dense rough volume while filling the frame
    // with the forest. Keep it as an explicit visual/temporal stress probe rather
    // than making this off-route inspection pose part of the production-view suite.
    stressOnly: true,
    position: [-54, 1.65, -48],
    lookAt: [-74, 2.15, -70],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 35,
      maxMeanLuma: 175,
      maxNearBlackPct: 20,
      maxNearWhitePct: 8,
    },
  },
  {
    id: 'landing-crosscourse',
    description: 'Golfer-height landing-area view across the route toward the next target.',
    position: [-34, 1.70, -145],
    lookAt: [18, 0.65, -190],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 40,
      maxMeanLuma: 175,
      maxNearBlackPct: 15,
      maxNearWhitePct: 8,
    },
  },
  {
    id: 'landing-return',
    description: 'Reverse strategic landing-area view back across maintained ground and its dressed edge.',
    position: [38, 1.70, -185],
    lookAt: [-20, 0.65, -135],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 40,
      maxMeanLuma: 175,
      maxNearBlackPct: 15,
      maxNearWhitePct: 8,
    },
  },
  {
    id: 'approach-green',
    description: 'Golfer-height approach view into the final green and its alpine backdrop.',
    position: [7, 1.75, -244],
    lookAt: [16, 0.55, -279],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 40,
      maxMeanLuma: 175,
      maxNearBlackPct: 15,
      maxNearWhitePct: 8,
    },
  },
  {
    id: 'pond-contact',
    description: 'Low oblique across shoreline, water, terrain, rocks, and vegetation contacts.',
    position: [79, 1.40, -110],
    lookAt: [55, 0.15, -123],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 35,
      maxMeanLuma: 175,
      maxNearBlackPct: 15,
      maxNearWhitePct: 8,
    },
  },
  {
    id: 'overview',
    description: 'Elevated overview across terrain chunks, tree line, and distant grass.',
    position: [0, 105, -110],
    lookAt: [0, 0.5, -145],
    visualGate: {
      region: [0, 0, 1, 1],
      minMeanLuma: 35,
      maxMeanLuma: 150,
      maxNearBlackPct: 20,
      maxNearWhitePct: 10,
    },
  },
];
const selectedScenarios = requestedScenario
  ? scenarios.filter((scenario) => scenario.id === requestedScenario)
  : scenarios.filter((scenario) => !scenario.stressOnly);
if (requestedScenario && selectedScenarios.length === 0) {
  throw new Error(`Unknown --scenario ${requestedScenario}; expected one of ${scenarios.map((scenario) => scenario.id).join(', ')}`);
}

const canonicalTimingContract = !allowPerformanceMiss
  && warmupFrames >= 180 && sampleFrames >= 300
  && rafP95BudgetMs === 34.0 && maxHitches === 0 && maxRenderPasses === 8
  && temporalMaeBudget === 0.15 && temporalChangedPixelBudgetPct === 0.2
  && performanceTier === 'high-desktop-webgpu' && expectedDeviceTier === 'high'
  && (
    (!requestedScenario && width === 1280 && height === 720 && gpuP95BudgetMs === 33.3)
    || (requestedScenario === 'tree-edge-close' && width === 1280 && height === 720 && gpuP95BudgetMs === 33.3)
    || (['address-tee', 'low-rough', 'pond-contact', 'tree-edge-close'].includes(requestedScenario)
      && width === 2408 && height === 1506 && gpuP95BudgetMs === 33.3)
  );
const readHostState = (args) => {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('/usr/bin/pmset', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
};
const hostPowerSource = readHostState(['-g', 'batt']);
const hostThermalState = readHostState(['-g', 'therm']);
const acPowerEligible = process.platform === 'darwin' && /AC Power/i.test(hostPowerSource || '');

const report = {
  schemaVersion: 1,
  kind: 'environment-render-benchmark',
  startedAt: new Date().toISOString(),
  contract: {
    backend: 'WebGPU only (WebGL fallback is a failure)',
    viewportCssPx: [width, height],
    deviceScaleFactor: 1,
    performanceTier,
    expectedDeviceTier,
    warmupFrames,
    sampleFrames,
    hitchThresholdMs,
    performanceBudgets: {
      gpuCompletionP95Ms: gpuP95BudgetMs,
      maxRenderPasses,
      enforced: !allowPerformanceMiss,
    },
    presentationTelemetry: {
      rafIntervalP95Ms: rafP95BudgetMs,
      maxHitches,
      enforced: false,
      reason: 'Offscreen Chrome rAF cadence is display scheduling telemetry, not renderer throughput.',
    },
    temporalStability: {
      // One complete 32-phase Halton cycle plus two queue/scheduler guard frames.
      frozenSimulationSettleFrames: 34,
      // One complete 31-phase Halton cycle plus the starting phase. Every adjacent
      // transition must pass; sampling only two lucky phases can hide shimmer.
      captures: 32,
      maxMeanAbsoluteRgbError: temporalMaeBudget,
      maxPixelsOver8Pct: temporalChangedPixelBudgetPct,
    },
    frameMetric: 'requestAnimationFrame interval; reports presentation/CPU frame pacing, not GPU timestamp timing',
    gpuTiming: 'bounded native WebGPU timestamp intervals; performance uses frame-completion cadence because pass spans overlap and are not additive',
    goalEligibility: {
      canonicalTimingContract,
      acPowerRequired: true,
      acPowerEligible,
      eligible: canonicalTimingContract && acPowerEligible,
    },
  },
  scenarios: [],
  validation: { passed: false, errors: [], console: [], requests: [] },
};
if (canonicalTimingContract && !acPowerEligible) {
  report.validation.errors.push(`Strict Metal performance evidence requires AC power; ${hostPowerSource || process.platform}`);
}
const reportPath = join(outDir, 'report.json');
report.progress = {
  state: 'initializing',
  selectedScenarioIds: selectedScenarios.map((scenario) => scenario.id),
  completedScenarioIds: [],
};
// Serialize checkpoints so a browser-disconnect callback cannot race the normal
// per-scenario write and publish a stale snapshot over a newer one.
let checkpointQueue = Promise.resolve();
const checkpointReport = () => {
  checkpointQueue = checkpointQueue.then(() => atomicJsonCheckpoint(reportPath, report));
  return checkpointQueue;
};

// Establish an observable report before Chrome/WebGPU startup. This is also the
// durable baseline when the process is externally interrupted during launch.
await checkpointReport();

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

function analyzeScreenshot(bytes, region = [0, 0, 1, 1]) {
  const { width: w, height: h, channels: ch, pixels } = decodePNG(bytes);
  const [x0, y0, x1, y1] = region;
  const minX = Math.floor(w * x0), maxX = Math.ceil(w * x1);
  const minY = Math.floor(h * y0), maxY = Math.ceil(h * y1);
  let count = 0, lumaSum = 0, nearBlack = 0, nearWhite = 0;
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const i = (y * w + x) * ch;
      const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      lumaSum += luma;
      if (luma < 8) nearBlack++;
      if (luma > 247) nearWhite++;
      count++;
    }
  }
  return {
    region,
    pixelCount: count,
    meanSrgbLuma: lumaSum / count,
    nearBlackPct: 100 * nearBlack / count,
    nearWhitePct: 100 * nearWhite / count,
  };
}

function compareScreenshots(referenceBytes, candidateBytes) {
  const reference = decodePNG(referenceBytes);
  const candidate = decodePNG(candidateBytes);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error('Temporal capture dimensions changed within one scenario');
  }
  let absSum = 0;
  let pixelsOver8 = 0;
  const pixelCount = reference.width * reference.height;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const referenceOffset = pixelIndex * reference.channels;
    const candidateOffset = pixelIndex * candidate.channels;
    let maxDelta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(reference.pixels[referenceOffset + channel]
        - candidate.pixels[candidateOffset + channel]);
      absSum += delta;
      maxDelta = Math.max(maxDelta, delta);
    }
    if (maxDelta > 8) pixelsOver8++;
  }
  return {
    meanAbsoluteRgbError: absSum / (pixelCount * 3),
    pixelsOver8Pct: 100 * pixelsOver8 / pixelCount,
  };
}

const browser = await launch({
  executablePath: chrome,
  headless: false,
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
let closingBrowser = false;
browser.on('disconnected', () => {
  if (closingBrowser) return;
  const message = 'Browser disconnected before benchmark completion';
  if (!report.validation.errors.includes(message)) report.validation.errors.push(message);
  report.progress.state = 'browser-disconnected';
  void checkpointReport().catch((error) => console.error(`benchmark checkpoint failed: ${error.message}`));
});

const page = await browser.newPage();
const pushError = (message) => {
  if (!report.validation.errors.includes(message)) report.validation.errors.push(message);
};
page.on('console', (message) => {
  const entry = `[${message.type()}] ${message.text()}`;
  report.validation.console.push(entry);
  // A benchmark must describe the intended scene, not a degraded-but-renderable one.
  // Missing course/assets and renderer validation commonly surface as warnings, so a
  // warning is a failed baseline rather than something the harness silently records.
  if (message.type() === 'warning' || message.type() === 'warn' || message.type() === 'error'
    || /webgpu.*(validation|error)|wgsl.*error|shader.*error/i.test(entry)) pushError(entry);
});
page.on('pageerror', (error) => pushError(`[pageerror] ${error.message}`));
page.on('requestfailed', (request) => {
  const entry = `${request.url()} — ${request.failure()?.errorText || 'request failed'}`;
  report.validation.requests.push(entry);
  pushError(`[requestfailed] ${entry}`);
});

async function waitFrames(count) {
  await page.evaluate((n) => new Promise((resolve) => {
    let remaining = n;
    const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), count);
}

async function poseScenario(scenario) {
  return page.evaluate((s) => {
    const golf = window.golf;
    const { range, evaluatorCamera } = golf;
    if (!range || !evaluatorCamera) throw new Error('Practice range/evaluator camera API is not ready');
    if (evaluatorCamera.version !== '1.0') throw new Error(`Unsupported evaluator camera API ${evaluatorCamera.version}`);
    if (!evaluatorCamera.owned) evaluatorCamera.enter();
    const terrain = range.terrain;
    const [px, py, pz] = s.position;
    const [lx, ly, lz] = s.lookAt;
    const position = [px, terrain.heightAt(px, pz) + py, pz];
    const targetY = terrain.heightAt(lx, lz) + ly;
    evaluatorCamera.setPose({ position, lookAt: [lx, targetY, lz], fov: s.fov ?? 40 });
    return evaluatorCamera.getState();
  }, scenario);
}

// WebGPUInfo records a texture's byte estimate at its first GPU allocation.  Rendering
// only the requested view before taking a memory snapshot leaves assets used by other
// production camera angles lazily unallocated, which makes one-scenario reports look
// artificially smaller.  Compile/render every shipped benchmark view first, drain the
// queue, then start the actual selected scenario measurements from a fresh camera cut.
async function prewarmProductionViews() {
  for (const scenario of scenarios) {
    await poseScenario(scenario);
    await waitFrames(24);
  }
  await page.evaluate(() => window.golf.sm.renderer.backend.device.queue.onSubmittedWorkDone());
}

async function proveStaticShadowCache() {
  const proof = await page.evaluate(async () => {
    const { sm, lighting } = window.golf;
    const captureOne = async () => {
      const promise = sm.gpuProfiler.capture(1);
      sm.renderSingleFrame();
      const capture = await promise;
      await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      return capture;
    };
    sm.pauseRendering();
    try {
      lighting.invalidateShadow();
      return { dirty: await captureOne(), clean: await captureOne() };
    } finally {
      sm.resumeRendering();
    }
  });
  const passLabels = (capture) => capture.passes?.map((entry) => entry.label) || [];
  const dirtyLabels = passLabels(proof.dirty);
  const cleanLabels = passLabels(proof.clean);
  const shadowCompute = foliageCandidate
    ? [] : ['Tree shadow GPU reset', 'Tree shadow light-frustum compact'];
  const dirtyMissing = shadowCompute.filter((label) => !dirtyLabels.includes(label));
  if (!dirtyLabels.some((label) => label.startsWith('Shadow Map'))) dirtyMissing.push('Shadow Map*');
  const cleanUnexpected = cleanLabels.filter((label) =>
    shadowCompute.includes(label) || label.startsWith('Shadow Map'));
  if (!proof.dirty.complete || dirtyMissing.length) {
    pushError(`dirty shadow proof failed; missing ${dirtyMissing.join(', ') || 'complete capture'}`);
  }
  if (!proof.clean.complete || cleanUnexpected.length) {
    pushError(`clean shadow proof repeated cached work: ${cleanUnexpected.join(', ') || 'incomplete capture'}`);
  }
  return {
    dirty: { complete: proof.dirty.complete, labels: dirtyLabels },
    clean: { complete: proof.clean.complete, labels: cleanLabels },
    dirtyMissing,
    cleanUnexpected,
  };
}

function textureMemorySnapshot() {
  return page.evaluate(() => {
    const { renderer } = window.golf.sm;
    const entries = [...renderer.info.memoryMap.entries()]
      .filter(([resource]) => resource?.isTexture)
      .map(([resource, byteSize]) => ({
        name: resource.name || 'unnamed',
        byteSize,
        width: resource.image?.width ?? resource.width ?? null,
        height: resource.image?.height ?? resource.height ?? null,
        format: resource.format,
        type: resource.type,
      }))
      .sort((a, b) => b.byteSize - a.byteSize || a.name.localeCompare(b.name));
    return {
      totalBytes: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
      entries,
    };
  });
}

async function collectScenario(scenario) {
  const camera = await poseScenario(scenario);
  // Explicit zero-warmup frame: it exercises the production onUpdate ordering
  // (tree clear → compact → finalize before camera render) at a fresh camera cut.
  // Keeping this capture makes a frame-one tree pop a reproducible artifact rather
  // than something hidden by the convergence warm-up below.
  const startupScreenshot = join(outDir, `${scenario.id}-startup.png`);
  await page.evaluate(() => {
    const { sm } = window.golf;
    sm.pauseRendering();
    try { sm.renderSingleFrame(); } finally { sm.resumeRendering(); }
  });
  const startupCanvas = await page.$('canvas');
  if (!startupCanvas) throw new Error('No renderer canvas found for zero-warmup capture');
  // Capture the fixed benchmark viewport rather than asking Puppeteer to isolate
  // the canvas element. Element screenshots may scroll/resize the layout while
  // resolving an element clip, which invalidates the renderer's temporal history
  // and turns the stability probe into a browser-capture test.
  await writeFile(startupScreenshot, await page.screenshot({ captureBeyondViewport: false }));
  // Asset readiness happens once per run; this per-scenario warm-up lets the selected
  // camera compile its material variants and converge GTAO/TRAA history before timing.
  await waitFrames(warmupFrames);
  // Keep timestamp instrumentation bounded: Three allocates its own per-pass query
  // pools, resolves each type once after this window, and immediately disables it.
  // Let a few normal frames follow before rAF pacing samples so readback is not mixed
  // into the existing presentation/CPU metric.
  const gpuTiming = await page.evaluate(async () => {
    const { sm } = window.golf;
    sm.freezeSimulation = true;
    sm.pauseRendering();
    try {
      const resultPromise = sm.gpuProfiler.capture(30);
      // Submit the exact production update/compute/post stack without a 60 Hz rAF
      // gap between frames. Native completion timestamps now measure GPU throughput
      // instead of the display scheduler's cadence.
      for (let frame = 0; frame < 30; frame++) sm.renderSingleFrame();
      return await resultPromise;
    } finally {
      sm.freezeSimulation = false;
      sm.resumeRendering();
    }
  });
  const requiredGpuPasses = [
    'Scene MRT', 'TRAA',
    'Final output pass',
  ];
  const requiredGrassComputePasses = [
    'Grass GPU reset',
    'Grass tile classify',
    'Grass tile dispatch finalize',
    'Grass blade compact',
    'Grass indirect draw finalize',
  ];
  const requiredTreeBeautyComputePasses = foliageCandidate ? [] : [
    'Tree beauty GPU reset',
    'Tree beauty camera-relative LOD compact',
    'Tree beauty indirect finalize',
  ];
  if (!gpuTiming.available) {
    pushError(`${scenario.id} GPU timing unavailable: ${gpuTiming.reason || 'unknown reason'}`);
  } else {
    if (!gpuTiming.complete || gpuTiming.framesCaptured !== gpuTiming.framesPlanned
      || gpuTiming.unavailablePassCount !== 0) {
      pushError(`${scenario.id} GPU timing capture incomplete: ${gpuTiming.framesCaptured}/${gpuTiming.framesPlanned} frames, ${gpuTiming.unavailablePassCount} unavailable passes`);
    }
    const lastCapturedFrame = gpuTiming.frames.at(-1);
    const threeNonAdditiveMs = gpuTiming.threeResolvedNonAdditiveLastFrameMs?.total;
    if (!lastCapturedFrame || !Number.isFinite(threeNonAdditiveMs)
      || Math.abs(lastCapturedFrame.nonAdditivePassSumMs - threeNonAdditiveMs) > 0.02) {
      pushError(`${scenario.id} raw GPU intervals do not match Three's diagnostic non-additive sum`);
    }
    for (const frame of gpuTiming.frames) {
      if (!Number.isFinite(frame.gpuUnionMs) || !Number.isFinite(frame.gpuEnvelopeMs)
        || frame.gpuUnionMs < 0 || frame.gpuUnionMs > frame.gpuEnvelopeMs + 0.001
        || frame.nonAdditivePassSumMs + 0.001 < frame.gpuUnionMs) {
        pushError(`${scenario.id} GPU interval union invariants failed in capture frame ${frame.index}`);
        break;
      }
    }
    const labels = new Set(gpuTiming.passes.map((entry) => entry.label));
    for (const label of requiredGpuPasses) {
      if (!labels.has(label)) pushError(`${scenario.id} GPU timing missing required pass: ${label}`);
    }
    if (labels.has('Golf Bloom [ Fused 2D ]')) {
      pushError(`${scenario.id} production stack unexpectedly restored the removed duplicate glare pass`);
    }
    for (const label of requiredGrassComputePasses) {
      if (!labels.has(label)) pushError(`${scenario.id} GPU timing missing required grass compute pass: ${label}`);
    }
    for (const label of requiredTreeBeautyComputePasses) {
      if (!labels.has(label)) pushError(`${scenario.id} GPU timing missing required tree-beauty compute pass: ${label}`);
    }
    if (foliageCandidate) {
      const generatedReset = [...labels].some((label) => /^Generated foliage identity \d+ reset$/.test(label));
      const generatedCompact = [...labels].some((label) => /^Tree beauty generated foliage identity \d+ compact$/.test(label));
      if (!generatedReset || !generatedCompact) {
        pushError(`${scenario.id} GPU timing missing generated foliage reset/compact work`);
      }
    }
    const unexpectedShadow = [...labels].filter((label) =>
      label === 'Tree shadow GPU reset'
      || label === 'Tree shadow light-frustum compact'
      || label.startsWith('Shadow Map'));
    if (unexpectedShadow.length) {
      pushError(`${scenario.id} unchanged static shadow cache unexpectedly reran: ${unexpectedShadow.join(', ')}`);
    }
    const renderPassCount = Math.max(...gpuTiming.frames.map((frame) => frame.renderPassCount));
    if (renderPassCount > maxRenderPasses) {
      pushError(`${scenario.id} render-pass budget exceeded: ${renderPassCount} > ${maxRenderPasses}`);
    }
  }
  await waitFrames(10);
  const sampled = await page.evaluate((n) => new Promise((resolve) => {
    const intervals = [];
    requestAnimationFrame((first) => {
      let previous = first;
      const tick = (now) => {
        intervals.push(now - previous);
        previous = now;
        if (intervals.length === n) resolve(intervals);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }), sampleFrames);
  const stats = await page.evaluate(() => {
    const { renderer, _bloomPass: bloomPass } = window.golf.sm;
    const numericCopy = (value) => Object.fromEntries(Object.entries(value)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
    const canvas = renderer.domElement;
    return {
      backend: {
        isWebGPUBackend: renderer.backend?.isWebGPUBackend === true,
        isWebGLBackend: renderer.backend?.isWebGLBackend === true,
      },
      canvas: {
        cssPx: [canvas.clientWidth, canvas.clientHeight],
        drawingBufferPx: [canvas.width, canvas.height],
        devicePixelRatio: window.devicePixelRatio,
      },
      rendererInfo: {
        render: numericCopy(renderer.info.render),
        compute: numericCopy(renderer.info.compute),
        memory: numericCopy(renderer.info.memory),
      },
      postProcessing: {
        bloom: bloomPass ? {
          nodeType: bloomPass.constructor?.name || null,
          resolutionScale: bloomPass.resolutionScale ?? null,
          horizontalTargetPx: bloomPass._horizontalTarget
            ? [bloomPass._horizontalTarget.width, bloomPass._horizontalTarget.height]
            : null,
          verticalTargetPx: bloomPass._verticalTarget
            ? [bloomPass._verticalTarget.width, bloomPass._verticalTarget.height]
            : null,
        } : null,
      },
    };
  });
  stats.textureMemory = await textureMemorySnapshot();
  if (!stats.backend.isWebGPUBackend || stats.backend.isWebGLBackend) {
    throw new Error(`Scenario ${scenario.id} did not run on a WebGPU backend`);
  }
  const screenshot = join(outDir, `${scenario.id}.png`);
  const canvas = await page.$('canvas');
  if (!canvas) throw new Error('No renderer canvas found');
  const screenshotBytes = await page.screenshot({ captureBeyondViewport: false });
  await writeFile(screenshot, screenshotBytes);
  const visual = analyzeScreenshot(screenshotBytes, scenario.visualGate?.region);
  if (scenario.visualGate) {
    const { minMeanLuma, maxMeanLuma, maxNearBlackPct, maxNearWhitePct } = scenario.visualGate;
    if (visual.meanSrgbLuma < minMeanLuma) {
      pushError(`${scenario.id} visual gate: mean sRGB luma ${visual.meanSrgbLuma.toFixed(2)} < ${minMeanLuma}`);
    }
    if (visual.nearBlackPct > maxNearBlackPct) {
      pushError(`${scenario.id} visual gate: near-black ${visual.nearBlackPct.toFixed(2)}% > ${maxNearBlackPct}%`);
    }
    if (visual.meanSrgbLuma > maxMeanLuma) {
      pushError(`${scenario.id} visual gate: mean sRGB luma ${visual.meanSrgbLuma.toFixed(2)} > ${maxMeanLuma}`);
    }
    if (visual.nearWhitePct > maxNearWhitePct) {
      pushError(`${scenario.id} visual gate: near-white ${visual.nearWhitePct.toFixed(2)}% > ${maxNearWhitePct}%`);
    }
  }
  const cpuP95 = quantile(sampled, 0.95);
  const hitchCount = sampled.filter((ms) => ms > hitchThresholdMs).length;
  const gpuP95 = gpuTiming.available && gpuTiming.complete
    ? gpuTiming.captureThroughput?.completionDeltaP95Ms ?? null
    : null;
  const performance = {
    passed: gpuP95 !== null && gpuP95 <= gpuP95BudgetMs,
    gpuCompletionP95Ms: gpuP95,
    rafIntervalP95Ms: cpuP95,
    hitchCount,
    budgets: report.contract.performanceBudgets,
    presentationTelemetry: {
      passed: cpuP95 <= rafP95BudgetMs && hitchCount <= maxHitches,
      budgets: report.contract.presentationTelemetry,
    },
  };
  if (!performance.passed && !allowPerformanceMiss) {
    pushError(`${scenario.id} performance target missed: GPU completion-cadence p95 ${gpuP95?.toFixed(2) ?? 'unavailable'} ms (budget ${gpuP95BudgetMs})`);
  }

  // Freeze authored animation while the renderer and TRAA continue advancing. After
  // history settles, any remaining delta is reconstruction shimmer/instability rather
  // than wind. Captures stay in memory; the report stores only calibrated metrics.
  await page.evaluate(() => {
    const { sm, evaluatorCamera } = window.golf;
    if (!evaluatorCamera.owned) evaluatorCamera.enter();
    evaluatorCamera.freeze();
    sm.invalidateTemporalHistory('benchmark frozen-time temporal stability');
  });
  await waitFrames(report.contract.temporalStability.frozenSimulationSettleFrames);
  // Stop rAF submission before waiting on the queue. Otherwise new animation frames
  // keep entering behind the fence and screenshots that claim to be adjacent can be
  // separated by a dozen Halton phases. Manual frames below execute the identical
  // WebGPU update/compute/post path, one completed submission at a time.
  await page.evaluate(() => window.golf.sm.pauseRendering());
  const temporalCaptures = [];
  const temporalFrameStates = [];
  // The offscreen benchmark can submit rAF work faster than the GPU presents it.
  // Drain the queue at each sample boundary so PNG comparisons represent adjacent
  // completed frames, not arbitrary points in a backlog of correctly rendered work.
  const waitForGpu = () => page.evaluate(() =>
    window.golf.sm.renderer.backend.device.queue.onSubmittedWorkDone());
  await waitForGpu();
  for (let captureIndex = 0; captureIndex < report.contract.temporalStability.captures; captureIndex++) {
    if (captureIndex > 0) {
      // Three advances NodeFrame from its own rAF scheduler. Invoke the manual render
      // on a fresh scheduler tick so FRAME-scoped nodes (TRAA/GTAO/compute) update
      // exactly once; screenshots may take many wall-clock rAFs but submit no frames.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
        window.golf.sm.renderSingleFrame();
        resolve();
      })));
      await waitForGpu();
    }
    temporalCaptures.push(await page.screenshot({ captureBeyondViewport: false }));
    temporalFrameStates.push(await page.evaluate(() => ({
      rendererFrame: window.golf.sm.renderer.info.frame,
      jitterIndex: window.golf.sm._traa._jitterIndex,
      temporalInvalidation: window.golf.sm._lastTemporalInvalidation || null,
      viewport: window.golf.sm.readViewportDiagnostics(),
    })));
  }
  await page.evaluate(() => {
    const { sm, evaluatorCamera } = window.golf;
    evaluatorCamera.unfreeze();
    sm.resumeRendering();
  });
  const temporalComparisons = temporalCaptures.slice(1)
    .map((candidate, index) => compareScreenshots(temporalCaptures[index], candidate));
  if (saveTemporalCaptures) {
    await Promise.all(temporalCaptures.map((capture, captureIndex) =>
      writeFile(join(outDir, `${scenario.id}-temporal-${captureIndex}.png`), capture)));
  }
  const temporalStability = {
    comparisons: temporalComparisons,
    frameStates: temporalFrameStates,
    maxMeanAbsoluteRgbError: Math.max(...temporalComparisons.map((entry) => entry.meanAbsoluteRgbError)),
    maxPixelsOver8Pct: Math.max(...temporalComparisons.map((entry) => entry.pixelsOver8Pct)),
    budgets: report.contract.temporalStability,
  };
  const viewportSignatures = temporalFrameStates.map(({ viewport }) => JSON.stringify(viewport));
  temporalStability.viewportStable = new Set(viewportSignatures).size === 1;
  temporalStability.passed = temporalStability.maxMeanAbsoluteRgbError <= temporalMaeBudget
    && temporalStability.maxPixelsOver8Pct <= temporalChangedPixelBudgetPct
    && temporalStability.viewportStable;
  if (!temporalStability.passed) {
    pushError(`${scenario.id} frozen-time temporal stability failed: RGB MAE ${temporalStability.maxMeanAbsoluteRgbError.toFixed(3)} (budget ${temporalMaeBudget}), changed pixels ${temporalStability.maxPixelsOver8Pct.toFixed(3)}% (budget ${temporalChangedPixelBudgetPct}%)`);
  }
  if (!temporalStability.viewportStable) {
    pushError(`${scenario.id} viewport/backing-store changed during the frozen temporal cycle`);
  }
  const grassDiagnostics = await page.evaluate(() => window.golf.range.grass.readDiagnostics());
  // A mixed tree line owns one shadow proxy and one beauty classifier per species.
  // Every batch is measured; the per-species contracts below must hold for all of
  // them, so a second species cannot smuggle in a beauty caster or a fourth draw.
  const treeShadowDiagnostics = await page.evaluate(async () => {
    const { range, lighting } = window.golf;
    const generated = range.treeBeauties?.some((beauty) => beauty.residencyEstimate?.().generatedSource === true);
    if (!range.treeShadows?.length && !generated) throw new Error('GPU tree shadow proxy is missing.');
    const proxyMeshes = new Set(range.treeShadows.map((shadow) => shadow.mesh));
    let beautyCasters = 0;
    range.trees.traverse((object) => {
      if (!proxyMeshes.has(object) && object.castShadow === true) beautyCasters++;
    });
    return {
      species: await Promise.all(range.treeShadows.map(async (shadow) => ({
        ...(await shadow.readDiagnostics()),
        proxyLayer: shadow.mesh.layers.mask,
      }))),
      beautyCasters,
      generated,
      shadowCameraLayers: lighting.sun.shadow.camera.layers.mask,
    };
  });
  const treeBeautyDiagnostics = await page.evaluate(async () => {
    const { range } = window.golf;
    if (!range.treeBeauties?.length) throw new Error('GPU tree beauty LOD path is missing.');
    return Promise.all(range.treeBeauties.map((beauty) => beauty.readDiagnostics()));
  });
  const weatherDiagnostics = await page.evaluate(async () => {
    const { sm } = window.golf;
    return {
      ...(await sm.weatherSky.readDiagnostics()),
      usesVolumetricClouds: sm.weatherSky.usesVolumetricClouds === true,
      hasCloudTemporalPass: sm._cloudTemporal !== null,
    };
  });
  const waterReflectionDiagnostics = await page.evaluate(() => window.golf.range.waterReflectionDiagnostics());
  const targetPropDiagnostics = await page.evaluate(() => window.golf.range.targetPropDiagnostics());
  if (grassDiagnostics.overflow !== 0) {
    pushError(`${scenario.id} GPU grass compact buffer overflowed; indirect draw was suppressed`);
  }
  if (grassDiagnostics.visibleCount > grassDiagnostics.capacity) {
    pushError(`${scenario.id} GPU grass visible count is invalid: ${grassDiagnostics.visibleCount}/${grassDiagnostics.capacity}`);
  }
  // Address and overview cameras can legitimately contain no blade surfaces inside
  // the close-range rough volume. The low-rough shot is the coverage assertion: it
  // must exercise a non-empty indirect draw or the visual/temporal grass gates would
  // be capable of passing while testing only terrain.
  if (scenario.id === 'low-rough' && grassDiagnostics.visibleCount < 1) {
    pushError(`${scenario.id} GPU grass coverage is empty: ${grassDiagnostics.visibleCount}/${grassDiagnostics.capacity}`);
  }
  if (scenario.id === 'low-rough') {
    const [cx, , cz] = camera.position;
    const [gx, , gz] = grassDiagnostics.lodCameraPosition || [];
    const cameraDelta = Math.hypot((gx ?? Infinity) - cx, (gz ?? Infinity) - cz);
    if (!Number.isFinite(cameraDelta) || cameraDelta > 0.001) {
      pushError(`${scenario.id} grass LOD centre is not the active evaluator camera: delta ${cameraDelta}`);
    }
    const [fx, fz] = grassDiagnostics.lodCameraForwardXZ || [];
    const forwardLength = Math.hypot(fx ?? 0, fz ?? 0);
    const expectedX = camera.lookAt[0] - camera.position[0];
    const expectedZ = camera.lookAt[2] - camera.position[2];
    const expectedLength = Math.hypot(expectedX, expectedZ);
    const forwardAlignment = expectedLength > 0 && forwardLength > 0
      ? (fx * expectedX + fz * expectedZ) / (forwardLength * expectedLength)
      : -1;
    if (Math.abs(forwardLength - 1) > 0.001 || forwardAlignment < 0.999) {
      pushError(`${scenario.id} grass LOD forward axis is not the active evaluator view: length ${forwardLength}, alignment ${forwardAlignment}`);
    }
    if (!(grassDiagnostics.activeTileCount > 0)
      || !(grassDiagnostics.farTierTerminalRadius >= grassDiagnostics.nominalRadius * 2.20)
      || !(grassDiagnostics.farTierTerminalRadius > grassDiagnostics.baseTerminalRadius)) {
      pushError(`${scenario.id} grass forward footprint is incomplete: ${JSON.stringify(grassDiagnostics)}`);
    }
  }
  for (const shadow of treeShadowDiagnostics.species) {
    if (shadow.shadowDraws !== 1 || shadow.trianglesPerTree !== 2) {
      pushError(`${scenario.id} tree shadow path is not one two-triangle indirect proxy draw per species`);
    }
    if (shadow.visibleCount > shadow.sourceCount) {
      pushError(`${scenario.id} tree shadow visible caster count exceeds immutable primary source count`);
    }
    if (shadow.proxyLayer !== 2) {
      pushError(`${scenario.id} tree shadow proxy is not isolated to the directional shadow layer`);
    }
  }
  if ((treeShadowDiagnostics.shadowCameraLayers & 2) === 0) {
    pushError(`${scenario.id} directional shadow camera does not include the tree proxy layer`);
  }
  if (!treeShadowDiagnostics.generated && treeShadowDiagnostics.beautyCasters !== 0) {
    pushError(`${scenario.id} beauty tree caster fallback detected: ${treeShadowDiagnostics.beautyCasters}`);
  }
  for (const beauty of treeBeautyDiagnostics) {
    if (beauty.generatedSource) {
      if (!beauty.classificationComplete || beauty.counts.visible !== beauty.counts.near + beauty.counts.far) {
        pushError(`${scenario.id} generated foliage GPU classification is incomplete`);
      }
      continue;
    }
    // One indirect command per LOD0 role primitive, the same set again for LOD1,
    // and exactly one runtime-lit impostor card. A combined one-part prototype is
    // the partCount === 1 case of that same contract.
    if (beauty.impostorDraws !== 1 || beauty.lod0Draws !== beauty.partCount
      || beauty.lod1Draws !== beauty.partCount
      || beauty.beautyDraws !== beauty.lod0Draws + beauty.lod1Draws + 1) {
      pushError(`${scenario.id} tree beauty path is not matched LOD0/LOD1 role draws plus one runtime-lit impostor indirect draw per species`);
    }
    if (!beauty.classificationComplete || beauty.overflow !== 0 || !beauty.siblingCountsEqual) {
      pushError(`${scenario.id} tree beauty GPU classification/indirect sibling counts are incomplete`);
    }
  }
  if (scenario.id === 'address-tee'
    && treeBeautyDiagnostics.reduce((sum, beauty) => sum + beauty.behindRejected + beauty.frustumRejected, 0) < 1) {
    pushError(`${scenario.id} tree beauty classifier submitted every source; offscreen/behind rejection was not exercised`);
  }
  // Clear weather deliberately has no volumetric pass or storage texture: WeatherSky
  // binds its analytic background directly to the main scene. Cloudy weather is
  // validated by the live mode/workload contract, the truthful GPU volume resource,
  // one bounded fused raymarch/history pass, and one same-resolution ping-pong resolve. It is not
  // validated through a CPU-side noise field or invented density statistics.
  const cloudPasses = (gpuTiming.passes || []).filter(({ label }) =>
    /fused raymarch \+ temporal resolve|WeatherCloud|weather cloud/i.test(label));
  const cloudsEnabled = weatherDiagnostics.usesVolumetricClouds === true;
  if (!cloudsEnabled) {
    const unexpectedCloudWork = weatherDiagnostics.mode !== 'clear-sky'
      || weatherDiagnostics.proceduralNoise !== false
      || weatherDiagnostics.gpuOnly !== true
      || weatherDiagnostics.raySteps !== 0
      || weatherDiagnostics.lightTransportSamples !== 0
      || weatherDiagnostics.lightProbeSteps !== 0
      || weatherDiagnostics.lightTransportMode !== 'none'
      || weatherDiagnostics.noiseOctaves !== 0
      || weatherDiagnostics.usesVolumetricClouds
      || weatherDiagnostics.hasCloudTemporalPass
      || weatherDiagnostics.renderTopology !== 'analytic-background'
      || weatherDiagnostics.cloudHistory?.pingPong
      || weatherDiagnostics.cloudHistory?.previousFrameSampling
      || weatherDiagnostics.cloudVolume?.gpuResident
      || weatherDiagnostics.cloudVolume?.initStatus !== 'none'
      || weatherDiagnostics.cloudVolume?.sampledInRaymarch;
    if (unexpectedCloudWork || cloudPasses.length) {
      pushError(`${scenario.id} clear weather unexpectedly allocated volumetric cloud work: diagnostics=${JSON.stringify(weatherDiagnostics)}, passes=${JSON.stringify(cloudPasses.map(({ label }) => label))}`);
    }
  } else {
    const volume = weatherDiagnostics.cloudVolume;
    const validCloudRuntime = weatherDiagnostics.mode === 'gpu-volume-raymarch'
      && weatherDiagnostics.proceduralNoise === true
      && weatherDiagnostics.gpuOnly === true
      && weatherDiagnostics.hasCloudTemporalPass === true
      && weatherDiagnostics.renderTopology === 'fused-temporal-volume'
      && weatherDiagnostics.cloudHistory?.pingPong === true
      && weatherDiagnostics.cloudHistory?.previousFrameSampling === true
      && weatherDiagnostics.cloudHistory?.cameraReprojection === true
      && weatherDiagnostics.cloudHistory?.disocclusionRejection === true
      && weatherDiagnostics.cloudHistory?.transmittanceAware === true
      && weatherDiagnostics.raySteps > 0
      && weatherDiagnostics.lightTransportSamples > 0
      && weatherDiagnostics.lightProbeSteps === weatherDiagnostics.raySteps / 2
      && weatherDiagnostics.lightTransportMode === cloudLightTransportMode
      && weatherDiagnostics.noiseOctaves >= 2
      && volume?.dimensions?.join('x') === cloudVolumeDimensions
      && volume.channels === 4
      && volume.format === 'rgba8unorm'
      && volume.gpuResident === true
      && volume.initStatus === 'submitted'
      && volume.sampledInRaymarch === true
      && cloudPasses.some(({ label }) => /fused raymarch \+ temporal resolve/i.test(label));
    if (!validCloudRuntime) {
      pushError(`${scenario.id} cloud runtime contract failed: diagnostics=${JSON.stringify(weatherDiagnostics)}, passes=${JSON.stringify(cloudPasses.map(({ label }) => label))}`);
    }
  }
  if (scenario.id === 'pond-contact') {
    if (!waterReflectionDiagnostics.length
      || waterReflectionDiagnostics.some((entry) => !entry.ready || entry.mode !== 'analytic'
        || entry.revision !== 0 || entry.size !== 0 || entry.proxyMeshes !== 0
        || entry.fixedCanvas !== true || entry.renderTargetChurn !== false)) {
      pushError(`${scenario.id} analytic zero-target water contract is incomplete: ${JSON.stringify(waterReflectionDiagnostics)}`);
    }
  }
  if (targetPropDiagnostics.targetDraws !== 11 || targetPropDiagnostics.signDraws !== 6
    || targetPropDiagnostics.instances?.flagPoles !== 6
    || targetPropDiagnostics.instances?.flagCloth !== 6
    || targetPropDiagnostics.instances?.flagBases !== 6
    || targetPropDiagnostics.instances?.signPosts !== 12
    || targetPropDiagnostics.instances?.teeMarkers !== 2) {
    pushError(`${scenario.id} target prop draw/instance contract failed: ${JSON.stringify(targetPropDiagnostics)}`);
  }

  return {
    id: scenario.id,
    description: scenario.description,
    camera,
    startupScreenshot,
    warmupFrames,
    screenshot,
    visual: {
      ...visual,
      gate: scenario.visualGate || null,
    },
    cpuFrameIntervalMs: {
      samples: sampled,
      min: Math.min(...sampled),
      mean: sampled.reduce((sum, ms) => sum + ms, 0) / sampled.length,
      p50: quantile(sampled, 0.50),
      p95: cpuP95,
      p99: quantile(sampled, 0.99),
      max: Math.max(...sampled),
      hitchCount,
    },
    performance,
    temporalStability,
    grassDiagnostics,
    treeShadowDiagnostics,
    treeBeautyDiagnostics,
    weatherDiagnostics,
    waterReflectionDiagnostics,
    targetPropDiagnostics,
    ...stats,
    gpuTiming,
  };
}

try {
  await mkdir(outDir, { recursive: true });
  const url = new URL('/index.html', base);
  url.searchParams.set('view', 'practice');
  if (foliageCandidate) url.searchParams.set('foliageCandidate', String(foliageCandidate));
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.golf?.sm?._ready && window.golf.range && window.golf.freeCam, {
    timeout: 90000, polling: 100,
  });
  const ready = await page.evaluate(async () => {
    await window.golf.environmentReady;
    const { sm, range, environmentLoadError } = window.golf;
    const bootstrap = window.golfBootstrap;
    const bunkerGroup = range.group.children.find((child) => child.name === 'bunkers');
    const bunkerCentersAreTerrainSand = range.bunkers.every((bunker) =>
      range.terrain?.renderedZoneAt?.(bunker.x, bunker.z) === 'sand');
    return {
      webgpu: sm.renderer.backend?.isWebGPUBackend === true,
      webgl: sm.renderer.backend?.isWebGLBackend === true,
      // Clear weather binds the shared verified sky directly to the main scene.
      // Cloudy weather renders one fused quarter-resolution raymarch/history pass
      // before full-resolution scene TRAA. Both paths share a valid PMREM and fail closed.
      atmosphere: !!sm.weatherSky
        && (sm.weatherSky.usesVolumetricClouds
          ? sm.scene.backgroundNode === sm.weatherSky.clearBackgroundNode
            && sm._cloudTemporal !== null
          : sm.scene.backgroundNode === sm.weatherSky.backgroundNode
            && sm._cloudTemporal === null)
        && !!sm.scene.environment?.isTexture && !environmentLoadError,
      turf: !!range.terrain?.assetsReady,
      trees: !!range.trees,
      // Sand must be authored by Terrain's zone/material pipeline. A separate
      // bunker group is precisely the overlay geometry this gate now rejects.
      bunkers: !bunkerGroup && bunkerCentersAreTerrainSand,
      environmentSeed: range.environmentSeed,
      environmentTier: sm.environmentTier || null,
      bootstrap: {
        stage: bootstrap?.stage ?? null,
        elapsedMs: bootstrap?.elapsedMs ?? null,
        error: bootstrap?.diagnostics?.error ?? null,
        stages: Array.from(bootstrap?.diagnostics?.stages ?? [], (entry) => ({ ...entry })),
      },
    };
  });
  report.ready = ready;
  report.progress.state = 'prewarming';
  await checkpointReport();
  report.environment = {
    browserVersion: await browser.version(),
    deviceTier: ready.environmentTier,
    benchmarkHost: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      powerSource: hostPowerSource,
      thermalState: hostThermalState,
    },
    ...await page.evaluate(() => {
      const { renderer } = window.golf.sm;
      const device = renderer.backend?.device;
      const info = renderer.backend?.adapterInfo || device?.adapterInfo;
      const limits = device?.limits;
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
      return {
        navigator: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          deviceMemoryGiB: navigator.deviceMemory ?? null,
        },
        gpu: {
          isFallbackAdapter: renderer.backend?.isFallbackAdapter ?? null,
          adapterInfo: info ? {
            vendor: info.vendor || null,
            architecture: info.architecture || null,
            device: info.device || null,
            description: info.description || null,
          } : null,
          features: device ? [...device.features].sort() : [],
          limits: limits ? Object.fromEntries(keyLimitNames.map((name) => [name, limits[name] ?? null])) : null,
        },
      };
    }),
  };
  report.contract.environmentSeed = ready.environmentSeed;
  report.contract.actualDeviceTier = ready.environmentTier?.id ?? null;
  if (!ready.environmentTier?.id) {
    pushError('Environment device tier was not resolved from the active WebGPU device.');
  } else if (ready.environmentTier.id !== expectedDeviceTier) {
    pushError(`Environment device tier mismatch: expected ${expectedDeviceTier}, got ${ready.environmentTier.id}.`);
  }
  const adapterText = Object.values(report.environment.gpu.adapterInfo || {}).join(' ');
  if (report.environment.gpu.isFallbackAdapter === true
    || /swiftshader|software|llvmpipe|lavapipe/i.test(adapterText)) {
    pushError(`Software WebGPU adapter is forbidden by the no-fallback renderer contract: ${adapterText}`);
  }

  // Puppeteer's element screenshot is clipped to the canvas bounds, but Chrome still
  // composites sibling DOM layers inside that rectangle. The launch panel and FPS text
  // therefore contaminated renderer screenshots and made the frozen-scene stability
  // gate measure a changing DOM counter. Hide only sibling chrome; the WebGPU canvas,
  // renderer workload, resolution, and frame path remain untouched.
  await page.evaluate(() => {
    const app = document.getElementById('app');
    for (const child of document.body.children) {
      if (child !== app) child.style.setProperty('visibility', 'hidden', 'important');
    }
  });
  for (const name of ['webgpu', 'atmosphere', 'turf', 'trees', 'bunkers']) {
    if (!ready[name]) pushError(`Asset/backend readiness failed: ${name}`);
  }
  if (ready.webgl) pushError('Asset/backend readiness failed: WebGL backend is active');
  if (report.validation.errors.length) throw new Error('Environment did not reach a valid WebGPU asset-ready state');

  await prewarmProductionViews();
  report.shadowCache = await proveStaticShadowCache();
  report.prewarm = {
    views: scenarios.map((scenario) => scenario.id),
    textureMemory: await textureMemorySnapshot(),
  };

  report.progress.state = 'collecting';
  for (const scenario of selectedScenarios) {
    report.progress.activeScenarioId = scenario.id;
    await checkpointReport();
    report.scenarios.push(await collectScenario(scenario));
    report.progress.completedScenarioIds.push(scenario.id);
    delete report.progress.activeScenarioId;
    await checkpointReport();
  }
  report.validation.passed = report.validation.errors.length === 0;
  report.progress.state = 'complete';
  if (!report.validation.passed) process.exitCode = 1;
} catch (error) {
  pushError(error.stack || error.message || String(error));
  report.progress.state = report.progress.state === 'browser-disconnected'
    ? 'browser-disconnected'
    : 'failed';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await checkpointReport();
  console.log(`environment benchmark report: ${reportPath}`);
  console.log(report.validation.passed ? 'environment benchmark: PASS' : 'environment benchmark: FAIL');
  try {
    await page.evaluate(() => window.golf?.evaluatorCamera?.exit());
  } catch { /* page may already be gone after a fatal navigation/device error */ }
  closingBrowser = true;
  await browser.close();
}
