// Capture an investor-facing reel from the production simulator.
//
// This script deliberately uses the same strict path as scripts/shot.mjs:
// headful Chrome, a fresh profile, the real WebGPU renderer, window.golf's
// evaluator camera, and the provider-neutral launch-monitor boundary. It records
// separate editorial beats so the reel can be recut without re-recording a shot.
//
//   npm run capture:sizzle -- --url http://127.0.0.1:5173
//   npm run capture:sizzle -- --out shots/investor-reel.mp4 --music /path/to/licensed-track.wav

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launch } from 'puppeteer-core';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const has = (name) => argv.includes(`--${name}`);

function finiteNumber(name, value, { minimum = -Infinity, maximum = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RangeError(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function parseSize(value) {
  const match = /^(\d+)x(\d+)$/.exec(String(value));
  if (!match) throw new TypeError('--size must be WIDTHxHEIGHT');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1280 || height < 720) throw new RangeError('--size must be at least 1280x720');
  return { width, height };
}

function run(command, args, { cwd = process.cwd(), capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

async function durationOf(ffprobe, file) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { capture: true });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read duration for ${file}`);
  return duration;
}

function openFrameEncoder(ffmpeg, { path, fps, quality }) {
  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'png', '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg frame encoder exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
  return {
    async writeFrame(buffer) {
      if (!child.stdin.write(buffer)) await once(child.stdin, 'drain');
    },
    async finish() {
      child.stdin.end();
      await completion;
    },
    async abort() {
      child.stdin.destroy();
      child.kill('SIGTERM');
      await completion.catch(() => {});
    },
  };
}

const root = resolve(new URL('..', import.meta.url).pathname);
const baseUrl = String(arg('url', process.env.GOLF_URL || 'http://127.0.0.1:5173'));
const output = resolve(String(arg('out', 'shots/rangeform-sizzle-v2.mp4')));
const workDirectory = resolve(String(arg('work-dir', join(dirname(output), 'sizzle-reel-clips'))));
const { width, height } = parseSize(arg('size', '1920x1080'));
const fps = finiteNumber('fps', arg('fps', 30), { minimum: 24, maximum: 60 });
const quality = finiteNumber('quality', arg('quality', 16), { minimum: 0, maximum: 51 });
const transitionSeconds = finiteNumber('transition', arg('transition', 0.35), { minimum: 0, maximum: 1.5 });
const chrome = String(arg('chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
const ffmpeg = String(arg('ffmpeg', process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg'));
const ffprobe = String(arg('ffprobe', process.env.FFPROBE || '/opt/homebrew/bin/ffprobe'));
const music = arg('music', null);
const onlyShot = has('only-shot');
const photographicGrade = [
  'eq=contrast=0.97:brightness=0.003:saturation=0.82:gamma=1.015',
  'colorbalance=rs=-0.010:gs=0.004:bs=0.012:rm=0.006:gm=-0.012:bm=-0.004:rh=0.012:gh=0.004:bh=-0.010:pl=1',
].join(',');

await Promise.all([access(chrome), access(ffmpeg), access(ffprobe)]);
if (music) await access(resolve(String(music)));
await mkdir(workDirectory, { recursive: true });
await mkdir(dirname(output), { recursive: true });

const userDataDir = await mkdtemp(join(tmpdir(), 'golfsim-sizzle-chrome-'));
const logs = [];
const capture = {
  kind: 'production-sizzle-reel',
  brand: 'Rangeform',
  generatedAt: new Date().toISOString(),
  url: null,
  viewport: { width, height },
  fps,
  quality,
  timebase: {
    mode: 'deterministic-production-frame-step-direct-encode',
    deltaSeconds: 1 / fps,
  },
  captureTransport: 'lossless-png-image2pipe-to-ffmpeg',
  colorGrade: {
    intent: 'restrained-photographic-daylight',
    ffmpeg: photographicGrade,
  },
  clips: [],
  preflight: null,
  health: null,
  output,
};

let browser;
let presentationLockId = null;
try {
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
      '--force-device-scale-factor=1',
      '--high-dpi-support=1',
      '--enable-unsafe-webgpu',
      '--hide-scrollbars',
      '--mute-audio',
    ],
    defaultViewport: { width, height, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
  page.on('requestfailed', (request) => logs.push(
    `[requestfailed] ${request.url()} — ${request.failure()?.errorText || 'request failed'}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400) logs.push(`[http] ${response.status()} ${response.url()}`);
  });

  const url = new URL('/index.html', baseUrl);
  url.searchParams.set('view', 'practice');
  capture.url = url.href;
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(() => window.golfBootstrap?.ready === true, {
      polling: 100,
      timeout: 120_000,
    });
    await page.evaluate(() => window.golf.environmentReady);
  } catch (error) {
    const state = await page.evaluate(() => ({
      stage: window.golfBootstrap?.stage ?? null,
      error: window.golfBootstrap?.diagnostics?.error ?? null,
      stages: Array.from(window.golfBootstrap?.diagnostics?.stages ?? [], (entry) => ({ ...entry })),
    })).catch(() => null);
    throw new Error(`Sizzle-reel readiness failed: ${JSON.stringify(state)}; ${error.message}`);
  }

  capture.preflight = await page.evaluate(() => {
    const { sm, evaluatorCamera, launchMonitor } = window.golf;
    const backend = sm?.renderer?.backend;
    return {
      pageIdentity: {
        href: location.href,
        pathname: location.pathname,
        title: document.title,
        canvas: Boolean(document.querySelector('canvas')),
        devicePixelRatio,
      },
      bootstrap: {
        ready: window.golfBootstrap?.ready === true,
        stage: window.golfBootstrap?.stage ?? null,
        error: window.golfBootstrap?.diagnostics?.error ?? null,
      },
      renderer: {
        webgpuRenderer: sm?.renderer?.isWebGPURenderer === true,
        webgpuBackend: backend?.isWebGPUBackend === true,
        webglBackend: backend?.isWebGLBackend === true,
        fallbackAdapter: backend?.isFallbackAdapter === true,
      },
      evaluatorCamera: evaluatorCamera?.version ?? null,
      launchMonitor: launchMonitor?.snapshot?.() ?? null,
      viewport: sm?.readViewportDiagnostics?.() ?? null,
    };
  });
  const preflight = capture.preflight;
  if (!preflight.pageIdentity.canvas
      || preflight.pageIdentity.pathname !== '/index.html'
      || preflight.pageIdentity.devicePixelRatio !== 1
      || !preflight.bootstrap.ready
      || preflight.bootstrap.error
      || !preflight.renderer.webgpuRenderer
      || !preflight.renderer.webgpuBackend
      || preflight.renderer.webglBackend
      || preflight.renderer.fallbackAdapter
      || preflight.evaluatorCamera !== '1.0'
      || preflight.launchMonitor?.state !== 'ready') {
    throw new Error(`Strict production preflight failed: ${JSON.stringify(preflight)}`);
  }

  const lock = await page.evaluate(() => window.golf.quality.acquirePresentationLock({
    mode: 'ultra',
    renderScale: 1,
  }));
  presentationLockId = lock.presentationLock.id;
  await page.evaluate(() => new Promise((resolvePromise) => {
    let frame = 0;
    const tick = () => (++frame >= 8 ? resolvePromise() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));

  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'gs-sizzle-style';
    style.textContent = `
      body.gs-sizzle-clean #gs-lab-toggle,
      body.gs-sizzle-clean #gs-topright,
      body.gs-sizzle-clean .gs-shot-ui { opacity: 0 !important; pointer-events: none !important; }
      body.gs-sizzle-shot #gs-lab-toggle,
      body.gs-sizzle-shot #gs-topright { opacity: 0 !important; pointer-events: none !important; }
      body.gs-sizzle-shot .gs-shot-ui { display: block !important; opacity: 1 !important;
        visibility: visible !important; z-index: 1001 !important; }
      #gs-sizzle-copy { position: fixed; inset: 0; z-index: 1000; pointer-events: none;
        display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start;
        padding: clamp(42px, 5vw, 92px); color: #fff; font-family: ui-sans-serif, -apple-system,
        BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; text-shadow: 0 2px 24px rgba(0,0,0,.44); }
      #gs-sizzle-copy.center { justify-content: center; align-items: center; text-align: center; }
      #gs-sizzle-copy::before { content: ''; position: absolute; inset: 0;
        background: linear-gradient(0deg, rgba(4,11,8,.36), transparent 48%); z-index: -1; }
      #gs-sizzle-copy.center::before { background: radial-gradient(circle at center,
        rgba(3,10,7,.24), transparent 62%); }
      #gs-sizzle-copy .kicker { font-size: clamp(11px, 1vw, 15px); font-weight: 650;
        letter-spacing: .26em; text-transform: uppercase; opacity: .78; }
      #gs-sizzle-copy .title { margin-top: 13px; max-width: 950px; font-size: clamp(34px, 4.5vw, 78px);
        line-height: .98; font-weight: 560; letter-spacing: -.045em; }
      #gs-sizzle-copy .detail { margin-top: 17px; max-width: 640px; font-size: clamp(15px, 1.35vw, 22px);
        line-height: 1.35; font-weight: 430; letter-spacing: -.01em; opacity: .82; }
      #gs-sizzle-copy { opacity: 0; transform: translateY(14px); }
    `;
    document.head.appendChild(style);
  });

  const setEditorialState = async ({ clean, shot, copy = null }) => page.evaluate((state) => {
    document.body.classList.toggle('gs-sizzle-clean', state.clean);
    document.body.classList.toggle('gs-sizzle-shot', state.shot);
    document.getElementById('gs-sizzle-copy')?.remove();
    if (!state.copy) return;
    const overlay = document.createElement('div');
    overlay.id = 'gs-sizzle-copy';
    overlay.className = state.copy.align === 'center' ? 'center' : '';
    const kicker = document.createElement('div');
    kicker.className = 'kicker';
    kicker.textContent = state.copy.kicker;
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = state.copy.title;
    overlay.append(kicker, title);
    if (state.copy.detail) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = state.copy.detail;
      overlay.append(detail);
    }
    document.body.appendChild(overlay);
  }, { clean, shot, copy });

  const fixedDeltaSeconds = 1 / fps;

  const setEditorialProgress = async (progress) => page.evaluate((value) => {
    const overlay = document.getElementById('gs-sizzle-copy');
    if (!overlay) return;
    const smoothstep = (from, to, input) => {
      const x = Math.max(0, Math.min(1, (input - from) / (to - from)));
      return x * x * (3 - 2 * x);
    };
    const fadeIn = smoothstep(0, 0.13, value);
    const fadeOut = 1 - smoothstep(0.78, 1, value);
    const opacity = Math.min(fadeIn, fadeOut);
    overlay.style.opacity = String(opacity);
    overlay.style.transform = `translateY(${14 * (1 - fadeIn) - 5 * (1 - fadeOut)}px)`;
  }, progress);

  const setCameraProgress = async (move, progress) => page.evaluate(({ cameraMove, value }) => {
    const evaluator = window.golf.evaluatorCamera;
    if (!evaluator.active) evaluator.enter();
    evaluator.unfreeze();
    const eased = value * value * (3 - 2 * value);
    const lerp = (a, b) => a.map((number, index) => number + (b[index] - number) * eased);
    evaluator.setPose({
      position: lerp(cameraMove.from, cameraMove.to),
      lookAt: lerp(cameraMove.lookFrom, cameraMove.lookTo),
      fov: cameraMove.fovFrom + (cameraMove.fovTo - cameraMove.fovFrom) * eased,
    });
  }, { cameraMove: move, value: progress });

  const renderFixedFrame = async () => page.evaluate(
    (deltaSeconds) => window.golf.sm.renderSingleFrame(deltaSeconds),
    fixedDeltaSeconds,
  );

  const warmCamera = async (move, frames = 8) => {
    await setCameraProgress(move, 0);
    await setEditorialProgress(0);
    for (let frame = 0; frame < frames; frame++) await renderFixedFrame();
  };

  // The live animation loop is intentionally stopped for capture. Each lossless
  // in-memory frame is preceded by one exact production update + WebGPU render at
  // the output timebase, then streamed directly into FFmpeg. No PNG sequence is
  // staged on disk, and slow readback cannot cause duplicate or skipped motion.
  await page.evaluate(() => window.golf.sm.pauseRendering());

  const recordClip = async (id, {
    duration: requestedDuration,
    beforeFrame = null,
    afterFrame = null,
  }) => {
    const path = join(workDirectory, `${id}.mp4`);
    const encoder = openFrameEncoder(ffmpeg, { path, fps, quality });
    let frameCount = 0;
    const startedAt = Date.now();
    const maximumFrames = Math.max(2, Math.round(requestedDuration * fps));
    try {
      for (let frame = 0; frame < maximumFrames; frame++) {
        const progress = maximumFrames === 1 ? 1 : frame / (maximumFrames - 1);
        if (beforeFrame) await beforeFrame({ frame, progress, elapsed: frame * fixedDeltaSeconds });
        await renderFixedFrame();
        const buffer = await page.screenshot({ type: 'png', captureBeyondViewport: false });
        await encoder.writeFrame(buffer);
        frameCount++;
        if (afterFrame && await afterFrame({ frame, progress, elapsed: frameCount * fixedDeltaSeconds })) break;
        if (frameCount % fps === 0) console.log(`capture ${id} ${(frameCount / fps).toFixed(0)}s`);
      }
      if (frameCount < 2) throw new Error(`${id}: captured only ${frameCount} deterministic frames`);
      await encoder.finish();
    } catch (error) {
      await encoder.abort();
      throw error;
    }
    const duration = await durationOf(ffprobe, path);
    const state = await page.evaluate(() => ({
      directorPhase: window.golf.director.phase,
      ballState: window.golf.ball.state,
      camera: window.golf.sm.camera.position.toArray(),
      viewport: window.golf.sm.readViewportDiagnostics(),
    }));
    const record = {
      id,
      path,
      duration,
      frameCount,
      simulatedSeconds: frameCount / fps,
      wallSeconds: (Date.now() - startedAt) / 1000,
      state,
    };
    capture.clips.push(record);
    console.log(`clip ${id} ${duration.toFixed(2)}s ${path}`);
    return record;
  };

  if (!onlyShot) await setEditorialState({
    clean: true,
    shot: false,
    copy: {
      kicker: 'Rangeform',
      title: 'Golf, rendered true.',
      detail: 'A physics-first simulation platform built for any launch monitor.',
      align: 'center',
      duration: 4.8,
    },
  });
  const establishingMove = {
    from: [72, 30, 18],
    to: [48, 18, -34],
    lookFrom: [0, 1, -155],
    lookTo: [0, 1, -170],
    fovFrom: 46,
    fovTo: 42,
    duration: 4.8,
  };
  if (!onlyShot) {
    await warmCamera(establishingMove);
    await recordClip('01-establishing', {
      duration: establishingMove.duration,
      beforeFrame: async ({ progress }) => {
        await setCameraProgress(establishingMove, progress);
        await setEditorialProgress(progress);
      },
    });
  }

  if (!onlyShot) await setEditorialState({
    clean: true,
    shot: false,
    copy: {
      kicker: 'Native WebGPU',
      title: 'Detail that holds up in motion.',
      detail: 'Dense turf, authored vegetation, terrain, wind, light, and atmosphere render as one system.',
      duration: 4.0,
    },
  });
  const turfMove = {
    from: [38, 1.62, -10],
    to: [30, 1.48, -42],
    lookFrom: [3, 0.3, -70],
    lookTo: [-4, 0.4, -94],
    fovFrom: 40,
    fovTo: 38,
    duration: 4.0,
  };
  if (!onlyShot) {
    await warmCamera(turfMove);
    await recordClip('02-turf', {
      duration: turfMove.duration,
      beforeFrame: async ({ progress }) => {
        await setCameraProgress(turfMove, progress);
        await setEditorialProgress(progress);
      },
    });
  }

  if (!onlyShot) await setEditorialState({
    clean: true,
    shot: false,
    copy: {
      kicker: 'Course-scale environments',
      title: 'From maintained turf to the ocean edge.',
      detail: 'Playable surfaces stay authoritative while visual and ecological transitions shape the world around them.',
      duration: 4.0,
    },
  });
  const coastMove = {
    from: [128, 5.3, -164],
    to: [121, 3.8, -218],
    lookFrom: [84, 0.6, -178],
    lookTo: [78, 0.4, -224],
    fovFrom: 44,
    fovTo: 40,
    duration: 4.0,
  };
  if (!onlyShot) {
    await warmCamera(coastMove);
    await recordClip('03-coast', {
      duration: coastMove.duration,
      beforeFrame: async ({ progress }) => {
        await setCameraProgress(coastMove, progress);
        await setEditorialProgress(progress);
      },
    });
  }

  await setEditorialState({ clean: false, shot: true });
  await page.evaluate(() => window.golf.evaluatorCamera.exit());
  for (let frame = 0; frame < 16; frame++) await renderFixedFrame();

  let shotResult = null;
  let shotSubmitted = false;
  const addressFrames = Math.round(0.65 * fps);
  await recordClip('04-flight-and-results', {
    duration: 30,
    beforeFrame: async ({ frame }) => {
      if (frame !== addressFrames || shotSubmitted) return;
      const accepted = await page.evaluate(() => window.golf.launchMonitor.submit({
        ballSpeed: 160,
        launchAngle: 12,
        launchDirection: 2,
        spinRate: 2900,
        spinAxis: -9,
        timestamp: Date.now(),
        optional: { deviceShotId: 'rangeform-sizzle-driver' },
      }));
      if (!accepted?.accepted) throw new Error(`Launch-monitor shot was rejected: ${JSON.stringify(accepted)}`);
      shotSubmitted = true;
    },
    afterFrame: async () => {
      if (!shotSubmitted) return false;
      const terminal = await page.evaluate(() => (
        window.golf?.ball?.state === 'rest' && window.golf?.director?.phase === 'result'
      ));
      if (!terminal) return false;
      // Capture proof immediately after the production frame that emits rest.
      // The real ten-second UI timer is wall-clock based and the offline encode
      // can take longer, so the edit holds this genuine completed frame.
      shotResult = await page.evaluate(() => ({
      state: window.golf.ball.state,
      phase: window.golf.director.phase,
      carryYards: window.golf.ball.carryYards,
      totalYards: window.golf.ball.totalYards,
      resultVisible: window.golf.panel.state === 'results',
      resultText: document.querySelector('.gs-results')?.innerText ?? '',
      presentation: (() => {
        const root = document.querySelector('.gs-shot-ui');
        const results = document.querySelector('.gs-results');
        const rootStyle = root ? getComputedStyle(root) : null;
        const resultStyle = results ? getComputedStyle(results) : null;
        return {
          bodyView: document.body.dataset.view ?? null,
          bodyClasses: document.body.className,
          root: rootStyle ? {
            display: rootStyle.display,
            opacity: rootStyle.opacity,
            visibility: rootStyle.visibility,
            zIndex: rootStyle.zIndex,
          } : null,
          results: resultStyle ? {
            display: resultStyle.display,
            opacity: resultStyle.opacity,
            visibility: resultStyle.visibility,
            rect: results.getBoundingClientRect().toJSON(),
          } : null,
        };
      })(),
      }));
      return true;
    },
  });

  capture.shot = shotResult;
  if (!shotResult || shotResult.state !== 'rest' || shotResult.phase !== 'result' || !shotResult.resultVisible
      || !(shotResult.carryYards > 0) || !(shotResult.totalYards >= shotResult.carryYards)) {
    throw new Error(`Shot/result proof failed: ${JSON.stringify(shotResult)}`);
  }

  const resultClipPath = join(workDirectory, '05-result-hold.mp4');
  const resultEncoder = openFrameEncoder(ffmpeg, { path: resultClipPath, fps, quality });
  const resultFrame = await page.screenshot({ type: 'png', captureBeyondViewport: false });
  const resultFrameCount = 5 * fps;
  try {
    for (let frame = 0; frame < resultFrameCount; frame++) await resultEncoder.writeFrame(resultFrame);
    await resultEncoder.finish();
  } catch (error) {
    await resultEncoder.abort();
    throw error;
  }
  const resultDuration = await durationOf(ffprobe, resultClipPath);
  capture.clips.push({
    id: '05-result-hold',
    path: resultClipPath,
    duration: resultDuration,
    frameCount: resultFrameCount,
    wallSeconds: 0,
    state: capture.clips.at(-1).state,
  });
  console.log(`clip 05-result-hold ${resultDuration.toFixed(2)}s ${resultClipPath}`);

  const viewportSignatures = new Set(capture.clips.map((clip) => JSON.stringify({
    authoritative: clip.state.viewport.authoritative,
    canvasClientPx: clip.state.viewport.canvasClientPx,
    canvasBackingPx: clip.state.viewport.canvasBackingPx,
    internalTargets: clip.state.viewport.internalTargets,
  })));
  if (viewportSignatures.size !== 1) throw new Error('Sizzle capture changed viewport/backing-store dimensions between clips.');

  const healthErrors = logs.filter((entry) => /^\[(pageerror|requestfailed|http|error)\]/.test(entry));
  capture.health = { consoleNetworkErrors: healthErrors };
  if (healthErrors.length) throw new Error(`Console/network health failed: ${healthErrors.join('; ')}`);
} finally {
  if (browser) {
    if (presentationLockId !== null) {
      await browser.pages().then(async ([page]) => {
        await page?.evaluate((id) => window.golf?.quality?.releasePresentationLock?.(id), presentationLockId)
          .catch(() => {});
      }).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  await rm(userDataDir, { recursive: true, force: true });
}

const durations = await Promise.all(capture.clips.map((clip) => durationOf(ffprobe, clip.path)));
const inputs = capture.clips.flatMap((clip) => ['-i', clip.path]);
if (music) inputs.push('-stream_loop', '-1', '-i', resolve(String(music)));

const filters = capture.clips.map((_, index) => (
  `[${index}:v]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,`
  + `crop=${width}:${height},setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`
));
let current = 'v0';
let currentDuration = durations[0];
for (let index = 1; index < capture.clips.length; index++) {
  const next = `x${index}`;
  const offset = Math.max(0, currentDuration - transitionSeconds);
  filters.push(`[${current}][v${index}]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset.toFixed(3)}[${next}]`);
  current = next;
  currentDuration += durations[index] - transitionSeconds;
}
const fadeOutStart = Math.max(0, currentDuration - 0.8);
filters.push(
  `[${current}]${photographicGrade},fade=t=in:st=0:d=0.35,`
  + `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.8[vout]`,
);

const encodeArgs = [
  '-hide_banner', '-loglevel', 'warning', '-y', ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[vout]',
];
if (music) {
  const musicIndex = capture.clips.length;
  encodeArgs.push(
    '-map', `${musicIndex}:a:0`, '-filter:a', `afade=t=in:st=0:d=1.4,afade=t=out:st=${Math.max(0, currentDuration - 1.8).toFixed(3)}:d=1.8,volume=.72`,
    '-shortest', '-c:a', 'aac', '-b:a', '192k',
  );
} else encodeArgs.push('-an');
encodeArgs.push(
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high',
  '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709',
  '-color_trc', 'bt709', '-movflags', '+faststart', '-r', String(fps), output,
);
await run(ffmpeg, encodeArgs, { cwd: root });

const poster = output.replace(/\.mp4$/i, '-poster.jpg');
const contactSheet = output.replace(/\.mp4$/i, '-contact-sheet.jpg');
await run(ffmpeg, [
  '-hide_banner', '-loglevel', 'warning', '-y', '-ss', '2.4', '-i', output,
  '-frames:v', '1', '-update', '1', '-vf', 'scale=1280:-2', '-q:v', '2', poster,
]);
await run(ffmpeg, [
  '-hide_banner', '-loglevel', 'warning', '-y', '-i', output,
  '-vf', 'fps=1/6,scale=600:-2,tile=3x2:padding=8:margin=8:color=#101713',
  '-frames:v', '1', '-update', '1', '-q:v', '2', contactSheet,
]);

capture.duration = await durationOf(ffprobe, output);
capture.poster = poster;
capture.contactSheet = contactSheet;
capture.music = music ? resolve(String(music)) : null;
capture.rightsSafeSilentMaster = !music;
capture.completedAt = new Date().toISOString();
const report = output.replace(/\.mp4$/i, '-report.json');
await writeFile(report, `${JSON.stringify(capture, null, 2)}\n`);
console.log(`sizzle ${JSON.stringify({
  output,
  duration: capture.duration,
  poster,
  contactSheet,
  report,
  shot: capture.shot,
  health: capture.health,
})}`);

if (!has('keep-clips')) await rm(workDirectory, { recursive: true, force: true });
