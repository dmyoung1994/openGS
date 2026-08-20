// Long-run WebGPU environment robustness gate.
//
// Default invocation is goal-eligible and intentionally expensive:
//   npm run benchmark:robustness
//
// Development wiring check (never reported as goal-eligible):
//   npm run benchmark:robustness -- --smoke
//
// The page always runs the production renderer and production rebuild hook. CLI
// options only change how long the harness observes it; they never alter renderer
// features, shaders, visibility, assets, or backend selection.
import { launch } from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const smoke = argv.includes('--smoke');
const base = String(arg('url', process.env.BENCHMARK_URL || 'http://127.0.0.1:5173'));
const outDir = resolve(String(arg('out', 'benchmarks/environment-robustness')));
const durationSeconds = Number(arg('duration-seconds', smoke ? 45 : 1800));
const minimumFrames = Number(arg('minimum-frames', smoke ? 600 : 54000));
const rebuildCount = Number(arg('rebuilds', smoke ? 3 : 20));
const gpuBudgetMs = Number(arg('gpu-p95-ms', 14));
const routeStartSeconds = Number(arg('route-start-seconds', 0));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIB = 1024 * 1024;

if (![durationSeconds, minimumFrames, rebuildCount, gpuBudgetMs, routeStartSeconds].every(Number.isFinite)
  || durationSeconds < 10 || minimumFrames < 1 || !Number.isInteger(rebuildCount)
  || rebuildCount < 2 || gpuBudgetMs <= 0 || routeStartSeconds < 0) {
  throw new Error('Invalid robustness-gate arguments.');
}

const strictContract = durationSeconds >= 1800 && minimumFrames >= 54000 && rebuildCount >= 20;
const startedAt = new Date().toISOString();
const errors = [];
const events = [];
const checkpoints = [];
const rebuilds = [];
const pushError = (message) => {
  const text = String(message);
  if (!errors.includes(text)) errors.push(text);
};

const report = {
  schemaVersion: 1,
  kind: 'environment-render-robustness',
  startedAt,
  contract: {
    backend: 'hardware WebGPU only; no fallback adapter or renderer',
    durationSeconds,
    minimumFrames,
    rebuildCount,
    gpuBudgetMs,
    routeStartSeconds,
    cameraMotion: {
      measuredRoute: 'continuous ping-pong spline; camera cuts excluded',
      segmentSeconds: 18,
      maximumDesignedLinearSpeedMps: 8.31,
      prewarmCutsIncludedInSoak: false,
    },
    strictContract,
    requiredPlatforms: ['Metal', 'D3D12 integrated GPU'],
  },
  environment: null,
  soak: { checkpoints, gpuCaptures: [] },
  rebuilds,
  unsupportedDeviceIntegration: 'Run scripts/verify-no-fallback-browser.mjs separately.',
  validation: { passed: false, goalEligible: strictContract, errors, events },
};

// A long Metal gate is invalid if macOS enters its display-idle power state: the
// GPU is down-clocked and Chrome's target is destroyed when the display sleeps.
// Own a process-scoped assertion so the test cannot silently depend on a user's
// Energy Saver settings. This changes host scheduling only; renderer workload,
// shaders, backend, tier, and acceptance budgets remain untouched.
let releasingWakeAssertion = false;
let wakeAssertion = null;
if (process.platform === 'darwin') {
  const wakeTimeoutSeconds = Math.ceil(durationSeconds + rebuildCount * 70 + 300);
  const wakeArgs = [
    '-d', '-i', '-s', '-u', '-t', String(wakeTimeoutSeconds), '-w', String(process.pid),
  ];
  wakeAssertion = spawn('/usr/bin/caffeinate', wakeArgs, {
    stdio: 'ignore',
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    wakeAssertion.once('spawn', resolveSpawn);
    wakeAssertion.once('error', rejectSpawn);
  });
  wakeAssertion.once('exit', (code, signal) => {
    if (!releasingWakeAssertion) {
      pushError(`macOS wake assertion exited early (${signal || code})`);
    }
  });
  report.contract.hostWakeAssertion = {
    provider: 'macOS caffeinate',
    pid: wakeAssertion.pid,
    binary: '/usr/bin/caffeinate',
    args: wakeArgs,
    timeoutSeconds: wakeTimeoutSeconds,
    processScoped: true,
    verifications: [],
  };
} else {
  report.contract.hostWakeAssertion = {
    provider: null,
    processScoped: false,
    note: 'Non-macOS runners must keep the foreground display session awake externally.',
  };
}

function verifyHostWakeAssertion(label, { recordFailure = true } = {}) {
  if (process.platform !== 'darwin') return;
  const rawAssertions = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  const powerSource = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
    .split('\n')[0]?.trim() || 'unknown';
  const owner = `pid ${wakeAssertion.pid}(caffeinate):`;
  const ownedAssertions = rawAssertions.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(owner));
  const required = [
    'UserIsActive',
    'PreventUserIdleDisplaySleep',
    'PreventUserIdleSystemSleep',
    'PreventSystemSleep',
  ];
  const missing = required.filter((name) => !ownedAssertions.some((line) => line.includes(name)));
  const verification = {
    label,
    at: new Date().toISOString(),
    powerSource,
    ownedAssertions,
    missing,
  };
  report.contract.hostWakeAssertion.verifications.push(verification);
  if (recordFailure && missing.length) pushError(`${label}: owned macOS wake assertion missing ${missing.join(', ')}`);
  if (recordFailure && strictContract && !/AC Power/i.test(powerSource)) {
    pushError(`${label}: strict Metal performance evidence requires AC power; ${powerSource}`);
  }
  return verification;
}

// `spawn` confirms process creation, but macOS may publish the new assertion records
// a few scheduler ticks later. Poll that external state for at most 500 ms so a valid
// process-scoped assertion cannot fail the renderer gate merely by winning this race.
let wakePreflight = null;
for (let attempt = 0; attempt < 10; attempt++) {
  wakePreflight = verifyHostWakeAssertion(`before Chrome launch (attempt ${attempt + 1})`, { recordFailure: false });
  if (!wakePreflight?.missing.length) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}
if (wakePreflight?.missing.length) {
  pushError(`before Chrome launch: owned macOS wake assertion missing ${wakePreflight.missing.join(', ')}`);
}
if (strictContract && wakePreflight && !/AC Power/i.test(wakePreflight.powerSource)) {
  pushError(`before Chrome launch: strict Metal performance evidence requires AC power; ${wakePreflight.powerSource}`);
}
if (errors.length) {
  releasingWakeAssertion = true;
  wakeAssertion?.kill('SIGTERM');
  throw new Error(errors.join('\n'));
}

const browser = await launch({
  executablePath: chrome,
  headless: false,
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-position=-4000,-4000',
    '--window-size=1280,810',
    '--enable-unsafe-webgpu',
    '--hide-scrollbars',
    '--mute-audio',
  ],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

page.on('console', (message) => {
  const entry = `[${message.type()}] ${message.text()}`;
  events.push(entry);
  if (['warning', 'warn', 'error'].includes(message.type())
    || /webgpu.*(validation|error)|wgsl.*error|shader.*error|device lost/i.test(entry)) pushError(entry);
});
page.on('pageerror', (error) => pushError(`[pageerror] ${error.message}`));
page.on('requestfailed', (request) => pushError(
  `[requestfailed] ${request.url()} — ${request.failure()?.errorText || 'request failed'}`,
));

const waitFrames = (count) => page.evaluate((n) => new Promise((resolveFrame) => {
  let remaining = n;
  const tick = () => (--remaining <= 0 ? resolveFrame() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), count);

async function pose(position, lookAt) {
  await page.evaluate(({ p, l }) => {
    const { sm, range, freeCam } = window.golf;
    if (!freeCam.active) freeCam.enter();
    const [px, py, pz] = p;
    const [lx, ly, lz] = l;
    const terrain = range.terrain;
    sm.camera.position.set(px, terrain.heightAt(px, pz) + py, pz);
    const targetY = terrain.heightAt(lx, lz) + ly;
    const dx = lx - sm.camera.position.x;
    const dy = targetY - sm.camera.position.y;
    const dz = lz - sm.camera.position.z;
    const length = Math.hypot(dx, dy, dz);
    freeCam.keys.clear();
    freeCam.groundClearance = 0;
    freeCam.yaw = Math.atan2(-dx, -dz);
    freeCam.pitch = Math.asin(dy / length);
    freeCam.update(0);
    sm.invalidateTemporalHistory('robustness camera cut');
  }, { p: position, l: lookAt });
}

const productionViews = [
  { position: [1.6, 2.05, 6.5], lookAt: [0, 1.2, -28] },
  { position: [44, 0.55, -30], lookAt: [33, 0.30, -48] },
  { position: [0, 105, -110], lookAt: [0, 0.5, -145] },
];

async function prewarmViews(frames = 24) {
  for (const view of productionViews) {
    await pose(view.position, view.lookAt);
    await waitFrames(frames);
  }
  await queueFence(10_000);
}

async function queueFence(timeoutMs) {
  await page.evaluate(async (timeout) => {
    const fence = window.golf.sm.renderer.backend.device.queue.onSubmittedWorkDone();
    await Promise.race([
      fence,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`WebGPU queue fence exceeded ${timeout} ms`)), timeout)),
    ]);
  }, timeoutMs);
}

async function resourceSnapshot() {
  return page.evaluate(() => {
    const { renderer } = window.golf.sm;
    const grouped = new Map();
    for (const [resource, value] of renderer.info.memoryMap.entries()) {
      const type = typeof value === 'object' ? value.type : (resource?.isTexture ? 'textures' : 'programs');
      const size = typeof value === 'object' ? value.size : value;
      const name = resource?.name || resource?.label || resource?.constructor?.name || 'unnamed';
      const key = `${type}\u0000${name}\u0000${size}`;
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }
    const multiset = [...grouped.entries()].map(([key, count]) => {
      const [type, name, size] = key.split('\u0000');
      return { type, name, size: Number(size), count };
    }).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
      || a.size - b.size || a.count - b.count);
    const memory = Object.fromEntries(Object.entries(renderer.info.memory)
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
    return { frame: renderer.info.frame, memory, multiset };
  });
}

async function diagnostics() {
  // The tree line is mixed-species: one classifier and one shadow proxy per
  // catalog prototype. Every batch is read, not just the first.
  return page.evaluate(async () => {
    const { range } = window.golf;
    return {
      grass: await range.grass.readDiagnostics(),
      treeBeauty: await Promise.all(range.treeBeauties.map((beauty) => beauty.readDiagnostics())),
      treeShadow: await Promise.all(range.treeShadows.map((shadow) => shadow.readDiagnostics())),
    };
  });
}

function validateDiagnostics(label, value) {
  if (value.grass.overflow !== 0 || value.grass.visibleCount > value.grass.capacity) {
    pushError(`${label}: invalid grass classifier ${JSON.stringify(value.grass)}`);
  }
  if (!value.treeBeauty.length) pushError(`${label}: no tree beauty classifiers reported`);
  for (const beauty of value.treeBeauty) {
    if (!beauty.classificationComplete || beauty.overflow !== 0 || !beauty.siblingCountsEqual) {
      pushError(`${label}: invalid tree beauty classifier ${JSON.stringify(beauty)}`);
    }
  }
  for (const shadow of value.treeShadow) {
    if (shadow.visibleCount > shadow.sourceCount) {
      pushError(`${label}: invalid tree shadow classifier ${JSON.stringify(shadow)}`);
    }
  }
}

const steadyRequiredPasses = [
  'Scene MRT', 'Weather clouds [ fused raymarch + temporal resolve ]', 'TRAA',
  'Final output pass',
  'Grass GPU reset', 'Grass tile classify', 'Grass tile dispatch finalize',
  'Grass blade compact', 'Grass indirect draw finalize',
  'Tree beauty GPU reset', 'Tree beauty camera-relative LOD compact',
  'Tree beauty indirect finalize',
];
const shadowRefreshPasses = ['Tree shadow GPU reset', 'Tree shadow light-frustum compact'];

async function proveStaticShadowCache() {
  const proof = await page.evaluate(async () => {
    const { sm, lighting } = window.golf;
    const captureOne = async () => {
      const promise = sm.gpuProfiler.capture(1);
      sm.renderSingleFrame();
      const capture = await promise;
      // GpuPassProfiler clears its resolving sentinel in a promise-finally after
      // resolving the public result. Yield one task before opening the next window.
      await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      return capture;
    };
    sm.pauseRendering();
    try {
      lighting.invalidateShadow();
      const dirty = await captureOne();
      const clean = await captureOne();
      return { dirty, clean };
    } finally {
      sm.resumeRendering();
    }
  });
  const labels = (capture) => capture.passes?.map((entry) => entry.label) || [];
  const dirtyLabels = labels(proof.dirty);
  const cleanLabels = labels(proof.clean);
  const dirtyMissing = shadowRefreshPasses.filter((name) => !dirtyLabels.includes(name));
  if (!dirtyLabels.some((name) => name.startsWith('Shadow Map'))) dirtyMissing.push('Shadow Map*');
  const cleanUnexpected = cleanLabels.filter((name) =>
    shadowRefreshPasses.includes(name) || name.startsWith('Shadow Map'));
  if (!proof.dirty.complete || dirtyMissing.length) {
    pushError(`dirty shadow proof failed; missing ${dirtyMissing.join(', ') || 'complete capture'}`);
  }
  if (!proof.clean.complete || cleanUnexpected.length) {
    pushError(`clean shadow proof repeated cached work: ${cleanUnexpected.join(', ') || 'incomplete capture'}`);
  }
  report.shadowCache = {
    dirty: { complete: proof.dirty.complete, labels: dirtyLabels },
    clean: { complete: proof.clean.complete, labels: cleanLabels },
    dirtyMissing,
    cleanUnexpected,
  };
}

async function captureGpu(label) {
  const { capture, camera } = await page.evaluate(async () => {
    const { sm } = window.golf;
    sm.pauseRendering();
    try {
      // Snapshot the measured pose before yielding to timestamp resolution. The
      // independent route rAF can advance while `await promise` is pending even
      // though scene rendering is paused, so reading it afterward misreports the
      // actual camera—especially when a resolve itself is slow.
      const camera = {
        position: sm.camera.position.toArray(),
        quaternion: sm.camera.quaternion.toArray(),
      };
      // Checkpoint diagnostics perform bounded GPU readbacks after a queue fence.
      // That deliberately idle interval can leave the first adjacent submission in
      // a transient device power state. Condition with the exact production frame
      // path before enabling timestamps, then record the first and only measured
      // window. There is no fence, await, retry, camera change, simulation freeze,
      // or workload mutation between these fixed windows.
      for (let index = 0; index < 30; index++) sm.renderSingleFrame();
      const promise = sm.gpuProfiler.capture(30);
      for (let index = 0; index < 30; index++) sm.renderSingleFrame();
      const capture = await promise;
      return { capture, camera };
    } finally {
      sm.resumeRendering();
    }
  });
  const labels = new Set(capture.passes?.map((entry) => entry.label) || []);
  const missing = steadyRequiredPasses.filter((required) => !labels.has(required));
  const unexpectedShadow = [...labels].filter((entry) =>
    shadowRefreshPasses.includes(entry) || entry.startsWith('Shadow Map'));
  const p95 = capture.captureThroughput?.completionDeltaP95Ms;
  if (!capture.available || !capture.complete || capture.unavailablePassCount !== 0) {
    pushError(`${label}: incomplete GPU capture`);
  }
  if (missing.length) pushError(`${label}: missing GPU passes: ${missing.join(', ')}`);
  if (unexpectedShadow.length) {
    pushError(`${label}: unchanged static shadow cache unexpectedly reran: ${unexpectedShadow.join(', ')}`);
  }
  if (!Number.isFinite(p95) || p95 > gpuBudgetMs) {
    pushError(`${label}: GPU completion p95 ${p95 ?? 'unavailable'} ms exceeds ${gpuBudgetMs} ms`);
  }
  const summary = {
    label,
    p95,
    complete: capture.complete,
    missing,
    unexpectedShadow,
    frames: capture.framesCaptured,
    camera,
    captureThroughput: capture.captureThroughput,
    lastFrameGpuMs: capture.lastFrameGpuMs,
    passes: capture.passes,
    frameDetails: capture.frames,
  };
  report.soak.gpuCaptures.push(summary);
  return summary;
}

function memoryCapForTier(tierId) {
  if (tierId === 'high') return 384 * MIB;
  if (tierId === 'balanced') return 256 * MIB;
  if (tierId === 'conservative') return 192 * MIB;
  throw new Error(`Unknown environment tier: ${tierId}`);
}

function sameMultiset(a, b, includedTypes = null) {
  const select = (entries) => includedTypes
    ? entries.filter((entry) => includedTypes.includes(entry.type))
    : entries;
  return JSON.stringify(select(a)) === JSON.stringify(select(b));
}

function validateStableMemory(label, baseline, current, {
  exact = true, exactTypes = null, slopeBytes = 0,
} = {}) {
  const growth = current.memory.total - baseline.memory.total;
  if (growth > MIB) pushError(`${label}: renderer memory grew ${growth} bytes (> 1 MiB)`);
  if (slopeBytes > 64 * 1024) pushError(`${label}: memory growth slope ${slopeBytes} bytes/unit (> 64 KiB)`);
  if (exact && !sameMultiset(baseline.multiset, current.multiset, exactTypes)) {
    pushError(`${label}: normalized active GPU resource multiset changed`);
  }
}

function validateSceneTopology(label, topology) {
  // A mixed tree line draws one beauty group and one shadow proxy PER SPECIES.
  // The invariant is that ratio, not a fixed count, so adding a species to the
  // course cannot silently add a second classifier for an existing one.
  const expected = {
    terrainClipmaps: 1,
    grassDraws: 1,
    treeBeautyGroups: topology.treeSpecies,
    treeShadowDraws: topology.treeSpecies,
  };
  if (!(topology.treeSpecies >= 1)) pushError(`${label}: treeSpecies=${topology.treeSpecies}, expected at least 1`);
  for (const [key, count] of Object.entries(expected)) {
    if (topology[key] !== count) pushError(`${label}: ${key}=${topology[key]}, expected ${count}`);
  }
}

async function sceneTopology() {
  return page.evaluate(() => {
    const countName = (name) => {
      let count = 0;
      window.golf.sm.scene.traverse((object) => { if (object.name === name) count++; });
      return count;
    };
    return {
      terrainClipmaps: countName('terrain-gpu-clipmap'),
      grassDraws: countName('grass-gpu-indirect'),
      treeBeautyGroups: countName('trees-gpu-camera-relative'),
      treeShadowDraws: countName('tree-shadow-gpu-indirect'),
      treeSpecies: window.golf.range.treeBeauties?.length ?? 0,
    };
  });
}

async function installCameraRoute(phaseSeconds = 0) {
  await page.evaluate((initialPhaseSeconds) => {
    // Return over the same waypoints instead of flying 321 metres from the back of
    // the range to the tee in 18 seconds. Smoothstep makes velocity zero at every
    // waypoint, and the longest leg now tops out at 8.31 m/s. This models a normal
    // cinematic/dolly camera; instant cuts are tested separately and never enter
    // sustained throughput evidence.
    const points = [
      [0, 2.0, 6], [36, 1.0, -38], [-45, 2.2, -88], [25, 4.0, -155],
      [-22, 12, -225], [0, 48, -315], [-22, 12, -225], [25, 4.0, -155],
      [-45, 2.2, -88], [36, 1.0, -38], [0, 2.0, 6],
    ];
    const started = performance.now() - initialPhaseSeconds * 1000;
    const { sm, range, freeCam } = window.golf;
    if (!freeCam.active) freeCam.enter();
    freeCam.keys.clear();
    let previousAt = null;
    let previousPosition = null;
    let previousQuaternion = null;
    window.__environmentSoakRouteMotion = {
      maxLinearSpeedMps: 0,
      maxAngularSpeedRadPerSecond: 0,
    };
    const tick = (now) => {
      if (!window.__environmentSoakRouteActive) return;
      const segmentSeconds = 18;
      const elapsed = (now - started) / 1000;
      const progress = elapsed / segmentSeconds;
      const index = Math.floor(progress) % (points.length - 1);
      const local = progress - Math.floor(progress);
      const smooth = local * local * (3 - 2 * local);
      const a = points[index], b = points[index + 1];
      const x = a[0] + (b[0] - a[0]) * smooth;
      const z = a[2] + (b[2] - a[2]) * smooth;
      const relativeY = a[1] + (b[1] - a[1]) * smooth;
      sm.camera.position.set(x, range.terrain.heightAt(x, z) + relativeY, z);
      const targetZ = z - 35;
      const targetY = range.terrain.heightAt(x, targetZ) + 1.2;
      const dy = targetY - sm.camera.position.y;
      const dz = targetZ - z;
      freeCam.yaw = 0;
      freeCam.pitch = Math.atan2(dy, Math.abs(dz));
      freeCam.update(0);
      if (previousAt !== null && now > previousAt) {
        const dt = (now - previousAt) / 1000;
        const linear = Math.hypot(
          sm.camera.position.x - previousPosition[0],
          sm.camera.position.y - previousPosition[1],
          sm.camera.position.z - previousPosition[2],
        ) / dt;
        const q = sm.camera.quaternion;
        const dot = Math.min(1, Math.abs(
          q.x * previousQuaternion[0] + q.y * previousQuaternion[1]
          + q.z * previousQuaternion[2] + q.w * previousQuaternion[3]
        ));
        const angular = 2 * Math.acos(dot) / dt;
        const motion = window.__environmentSoakRouteMotion;
        motion.maxLinearSpeedMps = Math.max(motion.maxLinearSpeedMps, linear);
        motion.maxAngularSpeedRadPerSecond = Math.max(motion.maxAngularSpeedRadPerSecond, angular);
      }
      previousAt = now;
      previousPosition = sm.camera.position.toArray();
      previousQuaternion = sm.camera.quaternion.toArray();
      requestAnimationFrame(tick);
    };
    window.__environmentSoakRouteActive = true;
    requestAnimationFrame(tick);
  }, phaseSeconds);
}

async function stopCameraRoute() {
  return page.evaluate(() => {
    window.__environmentSoakRouteActive = false;
    return window.__environmentSoakRouteMotion;
  });
}

function checkpointSchedule(seconds) {
  if (seconds >= 1800) return [300, 600, 900, 1200, 1500, 1740, 1800];
  return [seconds * 0.25, seconds * 0.55, seconds * 0.9, seconds];
}

try {
  await mkdir(outDir, { recursive: true });
  const url = new URL('/index.html', base);
  url.searchParams.set('view', 'practice');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.golf?.sm?._ready && window.golf.range && window.golf.freeCam, {
    timeout: 90_000,
    polling: 100,
  });
  await page.evaluate(() => window.golf.environmentReady);
  report.environment = await page.evaluate(() => {
    const { sm } = window.golf;
    const backend = sm.renderer.backend;
    return {
      browser: navigator.userAgent,
      backend: {
        webgpu: backend?.isWebGPUBackend === true,
        webgl: backend?.isWebGLBackend === true,
        fallback: backend?.isFallbackAdapter ?? null,
        adapterInfo: backend?.adapterInfo || null,
      },
      tier: backend?.environmentTierSnapshot || null,
    };
  });
  if (!report.environment.backend.webgpu || report.environment.backend.webgl
    || report.environment.backend.fallback === true) {
    throw new Error('Robustness gate did not acquire strict hardware WebGPU.');
  }

  await prewarmViews();
  await proveStaticShadowCache();
  // Prewarm intentionally exercises fixed camera cuts for residency and temporal
  // correctness. Return to the continuous route's first pose and fully settle it
  // before establishing the measured baseline, so no teleport or lazy compilation
  // can enter sustained FPS/GPU evidence.
  await pose([0, 2.0, 6], [0, 1.2, -29]);
  await waitFrames(60);
  await queueFence(10_000);
  const soakBaseline = await resourceSnapshot();
  const cap = memoryCapForTier(report.environment.tier?.id);
  if (soakBaseline.memory.total > cap) {
    pushError(`post-prewarm memory ${soakBaseline.memory.total} bytes exceeds ${cap} byte ${report.environment.tier.id} cap`);
  }
  const soakStartFrame = soakBaseline.frame;
  const soakStart = Date.now();
  let priorFrame = soakStartFrame;
  let priorCheckpointAt = soakStart;
  let minuteFiveCapture = null;
  await installCameraRoute(routeStartSeconds);

  for (const targetSeconds of checkpointSchedule(durationSeconds)) {
    const targetAt = soakStart + targetSeconds * 1000;
    while (Date.now() < targetAt) {
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(2000, targetAt - Date.now())));
      const frame = await page.evaluate(() => window.golf.sm.renderer.info.frame);
      if (frame <= priorFrame && Date.now() - priorCheckpointAt >= 2000) {
        pushError(`renderer frame counter stalled at ${frame}`);
      }
      priorFrame = frame;
      priorCheckpointAt = Date.now();
    }
    verifyHostWakeAssertion(`soak checkpoint ${targetSeconds}s`);
    await queueFence(10_000);
    const elapsedSeconds = (Date.now() - soakStart) / 1000;
    const snapshot = await resourceSnapshot();
    const diagnostic = await diagnostics();
    validateDiagnostics(`soak ${elapsedSeconds.toFixed(0)}s`, diagnostic);
    const checkpoint = { elapsedSeconds, snapshot, diagnostic };
    checkpoints.push(checkpoint);

    const isCapture = strictContract
      ? [300, 900, 1740].some((time) => Math.abs(targetSeconds - time) < 1)
      : targetSeconds < durationSeconds;
    if (isCapture) {
      const capture = await captureGpu(`soak ${elapsedSeconds.toFixed(0)}s`);
      if (!minuteFiveCapture) minuteFiveCapture = capture;
    }
  }
  report.soak.cameraMotion = await stopCameraRoute();
  const soakFinal = await resourceSnapshot();
  const soakMinutes = Math.max(durationSeconds / 60, 1 / 60);
  validateStableMemory('soak final', soakBaseline, soakFinal, {
    slopeBytes: Math.max(0, soakFinal.memory.total - soakBaseline.memory.total) / soakMinutes,
  });
  const renderedFrames = soakFinal.frame - soakStartFrame;
  report.soak.renderedFrames = renderedFrames;
  report.soak.baseline = soakBaseline;
  report.soak.final = soakFinal;
  if (renderedFrames < minimumFrames) pushError(`soak rendered ${renderedFrames} frames; requires ${minimumFrames}`);
  const lastCapture = report.soak.gpuCaptures.at(-1);
  if (minuteFiveCapture && lastCapture?.p95 > minuteFiveCapture.p95 * 1.2) {
    pushError(`thermal GPU p95 regressed more than 20%: ${minuteFiveCapture.p95} -> ${lastCapture.p95} ms`);
  }

  let rebuildBaseline = null;
  const rebuildTotals = [];
  for (let index = 1; index <= rebuildCount; index++) {
    const rebuildStarted = Date.now();
    await page.evaluate(async () => {
      await window.golf.rebuild();
      await window.golf.environmentReady;
    });
    await prewarmViews();
    const snapshot = await resourceSnapshot();
    const diagnostic = await diagnostics();
    const topology = await sceneTopology();
    const elapsedMs = Date.now() - rebuildStarted;
    validateDiagnostics(`rebuild ${index}`, diagnostic);
    validateSceneTopology(`rebuild ${index}`, topology);
    if (elapsedMs > 30_000) pushError(`rebuild ${index} took ${elapsedMs} ms (> 30000)`);
    rebuilds.push({ index, elapsedMs, snapshot, diagnostic, topology });
    rebuildTotals.push(snapshot.memory.total);
    if (index === 2) rebuildBaseline = snapshot;
    if (index >= 3) {
      const slope = Math.max(0, snapshot.memory.total - rebuildBaseline.memory.total) / (index - 2);
      validateStableMemory(`rebuild ${index}`, rebuildBaseline, snapshot, {
        slopeBytes: slope,
        // Three may rebuild tiny object/render uniform groups and program source IDs.
        // The hard rebuild contract is exact for owned scene resources; total bytes
        // and slope separately catch any unbounded renderer-cache growth.
        exactTypes: [
          'textures', 'attributes', 'indexAttributes',
          'storageAttributes', 'indirectStorageAttributes',
        ],
      });
    }
  }
  // DevTools retains objects touched by Runtime.evaluate in its console object group.
  // This main page intentionally evaluates Range diagnostics, so a WeakRef test here
  // would measure the harness. Run the retention proof in a fresh production page:
  // one fire-and-forget evaluation starts every real rebuild, then all work and Range
  // tracking happen inside the app without DevTools touching a Range object.
  await page.close();
  const retentionPage = await browser.newPage();
  retentionPage.on('console', (message) => {
    const entry = `[retention ${message.type()}] ${message.text()}`;
    events.push(entry);
    if (['warning', 'warn', 'error'].includes(message.type())) pushError(entry);
  });
  retentionPage.on('pageerror', (error) => pushError(`[retention pageerror] ${error.message}`));
  retentionPage.on('requestfailed', (request) => pushError(
    `[retention requestfailed] ${request.url()} — ${request.failure()?.errorText || 'request failed'}`,
  ));
  await retentionPage.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await retentionPage.waitForSelector('#loading.hidden', { timeout: 90_000 });
  await retentionPage.evaluate((count) => {
    document.body.dataset.rangeProbeDone = 'false';
    setTimeout(async () => {
      try {
        window.golf.beginRangeRetentionProbe();
        for (let index = 0; index < count; index++) await window.golf.rebuild();
        document.body.dataset.rangeProbeDone = 'true';
      } catch (error) {
        document.body.dataset.rangeProbeError = error?.stack || error?.message || String(error);
      }
    }, 0);
    return null;
  }, rebuildCount);
  await retentionPage.waitForSelector('body[data-range-probe-done="true"]', {
    timeout: rebuildCount * 30_000 + 90_000,
  });
  const retentionCdp = await retentionPage.createCDPSession();
  for (let gc = 0; gc < 3; gc++) {
    await retentionCdp.send('HeapProfiler.collectGarbage');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  report.rebuildWeakRefs = await retentionPage.evaluate(() => window.golf.sampleRangeRetentionProbe());
  await retentionPage.evaluate(() => window.golf.endRangeRetentionProbe());
  await retentionPage.close();
  // The most recent superseded Range can remain observable until the async function's
  // activation is collected; every earlier Range must be unreachable after forced GC.
  if (report.rebuildWeakRefs.alive > 1) {
    pushError(`${report.rebuildWeakRefs.alive}/${report.rebuildWeakRefs.total} superseded Range objects survived forced GC`);
  }

  report.validation.passed = errors.length === 0;
  if (!report.validation.passed) process.exitCode = 1;
} catch (error) {
  pushError(error.stack || error.message || String(error));
  process.exitCode = 1;
} finally {
  try {
    verifyHostWakeAssertion('before cleanup');
  } catch (error) {
    pushError(`before cleanup: unable to verify host wake assertion: ${error.message || error}`);
  }
  report.finishedAt = new Date().toISOString();
  report.validation.passed = errors.length === 0;
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`environment robustness report: ${join(outDir, 'report.json')}`);
  console.log(report.validation.passed
    ? `environment robustness: PASS${strictContract ? '' : ' (development smoke; not goal-eligible)'}`
    : 'environment robustness: FAIL');
  await browser.close();
  releasingWakeAssertion = true;
  wakeAssertion?.kill('SIGTERM');
}
