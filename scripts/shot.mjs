// Render the asset viewer to a PNG from the command line.
//
// WHY THIS EXISTS
// This is a WebGPU app, so "does it look right" can only be answered by a real GPU
// drawing a real frame — there is no headless software path that exercises the same
// shaders. Driving a browser interactively is not a substitute: a tab that isn't in the
// foreground gets its rAF throttled and its WebGPU device init and buffer readbacks
// stalled outright, so you get a black canvas and no way to tell a throttled tab from a
// black shader. That failure mode cost a whole debugging session.
//
// So: launch our own Chrome with backgrounding disabled, wait for frames the app has
// ACTUALLY drawn (viewer.frames), and screenshot the canvas. The window is parked
// off-screen rather than headless because headless Chrome's WebGPU support is the thing
// most likely to differ from what ships.
//
//   node scripts/shot.mjs --asset "turf: rough" --out shots/rough.png
//   node scripts/shot.mjs --asset "turf: fairway" --cam 1.5,12,26 --look 0,0,0
//
// In viewer mode, --cam/--look are metres relative to the asset focus point (see
// setCamera in src/viewer/main.js). In --game mode they are exact world-space metres
// and drive window.golf.evaluatorCamera rather than simulating user input. --probe
// prints the mean sRGB of a few regions, which is how you answer "is the ground
// actually black" with a number instead of an opinion.
import { launch } from 'puppeteer-core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { decodePNG } from './lib/png.mjs';

// Minimal RGB PNG writer, for the flicker heatmap.
function encodePNG(W, H, rgb) {
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const has = (name) => argv.includes(`--${name}`);

const asset = arg('asset', 'turf: fairway');
const out = resolve(arg('out', `shots/${asset.replace(/\W+/g, '-')}.png`));
const base = arg('url', process.env.VIEWER_URL || 'http://localhost:5173');
const [w, h] = String(arg('size', '1280x720')).split('x').map(Number);
const frames = Number(arg('frames', 90));           // TRAA needs a few frames to settle
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// `--game` shoots index.html instead of the viewer. Worth having: the viewer's turf patch
// is a finite 44 m island with SKY behind its far edge, and a blade silhouetted against
// sky aliases in a way one silhouetted against more ground does not. So an artifact seen
// at the patch edge has to be re-checked on the real course before it is believed.
const game = has('game');
const waitRest = game && has('wait-rest');
const shotTransitionSequence = game && has('shot-transition-seq');
const shotFlightSequence = game && has('shot-flight-seq');
const parseTriple = (value, name) => {
  if (value === undefined) return null;
  const parsed = String(value).split(',').map(Number);
  if (parsed.length !== 3 || parsed.some((component) => !Number.isFinite(component))) {
    throw new Error(`--${name} must be a finite x,y,z triple`);
  }
  return parsed;
};
const cameraPose = parseTriple(arg('cam'), 'cam');
const cameraLook = parseTriple(arg('look'), 'look');
const cameraSweepPose = parseTriple(arg('cam-to'), 'cam-to');
const cameraSweepLook = parseTriple(arg('look-to'), 'look-to');
if ((cameraSweepPose || cameraSweepLook) && (!cameraPose || !cameraLook || !cameraSweepPose || !cameraSweepLook)) {
  throw new Error('A camera sweep requires --cam, --look, --cam-to, and --look-to together.');
}
const url = new URL(game ? '/index.html' : '/viewer.html', base);
if (game) {
  url.searchParams.set('view', arg('view', 'practice'));   // skip the landing menu
}
else url.searchParams.set('asset', asset);
if (!game && cameraPose) url.searchParams.set('cam', cameraPose.join(','));
if (!game && cameraLook) url.searchParams.set('look', cameraLook.join(','));

const userDataDir = await mkdtemp(join(tmpdir(), 'golfsim-shot-chrome-'));
let browser;
try {
  browser = await launch({
    executablePath: chrome,
    headless: false,
    userDataDir,
    args: [
      // The whole point: a window Chrome will not throttle even though nobody is looking.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=-4000,-4000',
      `--window-size=${w},${h + 90}`,
      '--enable-unsafe-webgpu',
      '--hide-scrollbars',
      '--mute-audio',
    ],
    defaultViewport: { width: w, height: h },
  });
} catch (error) {
  await rm(userDataDir, { recursive: true, force: true });
  throw error;
}

const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} — ${r.failure()?.errorText || 'request failed'}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http] ${r.status()} ${r.url()}`); });

try {
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the scene, then let --eval run against it before we start counting frames,
  // so an isolating tweak ("hide the blades and show me just the ground") is one flag
  // rather than a temporary source edit.
  try {
    await page.waitForFunction(
      (g) => (g ? window.golfBootstrap?.ready === true : window.viewer?.current?.terrain),
      { timeout: 90000, polling: 100 }, game,
    );
  } catch (error) {
    const state = await page.evaluate((g) => g ? ({
      stage: window.golfBootstrap?.stage ?? null,
      error: window.golfBootstrap?.diagnostics?.error ?? null,
      stages: Array.from(window.golfBootstrap?.diagnostics?.stages ?? [], (entry) => ({ ...entry })),
    }) : ({ viewerReady: Boolean(window.viewer?.current?.terrain) }), game).catch(() => null);
    throw new Error(`Render readiness failed: ${JSON.stringify(state)}; ${error.message}`);
  }
  const qaPreflight = await page.evaluate((gameView) => {
    const owner = gameView ? window.golf : window.viewer;
    const sm = owner?.sm;
    const backend = sm?.renderer?.backend;
    return {
      pageIdentity: { href: location.href, pathname: location.pathname, title: document.title, canvas: Boolean(document.querySelector('canvas')) },
      bootstrap: gameView ? {
        ready: window.golfBootstrap?.ready === true,
        stage: window.golfBootstrap?.stage ?? null,
        error: window.golfBootstrap?.diagnostics?.error ?? null,
      } : null,
      renderer: {
        webgpuRenderer: sm?.renderer?.isWebGPURenderer === true,
        webgpuBackend: backend?.isWebGPUBackend === true,
        webglBackend: backend?.isWebGLBackend === true,
        fallbackAdapter: backend?.isFallbackAdapter === true,
      },
      evaluatorCamera: gameView ? window.golf?.evaluatorCamera?.version ?? null : null,
    };
  }, game);
  if (!qaPreflight.pageIdentity.canvas
      || !qaPreflight.renderer.webgpuRenderer
      || !qaPreflight.renderer.webgpuBackend
      || qaPreflight.renderer.webglBackend
      || qaPreflight.renderer.fallbackAdapter
      || (game && (!qaPreflight.bootstrap?.ready || qaPreflight.evaluatorCamera !== '1.0'))) {
    throw new Error(`Strict WebGPU preflight failed: ${JSON.stringify(qaPreflight)}`);
  }
  if (game && (cameraPose || cameraLook)) {
    if (!cameraPose || !cameraLook) throw new Error('Game capture requires --cam and --look together.');
    await page.evaluate(({ position, lookAt, fov }) => {
      const evaluator = window.golf?.evaluatorCamera;
      if (!evaluator || evaluator.version !== '1.0') throw new Error('Evaluator camera API v1.0 is unavailable.');
      evaluator.enter();
      evaluator.setPose({ position, lookAt, fov });
      evaluator.freeze();
    }, { position: cameraPose, lookAt: cameraLook, fov: Number(arg('fov', 40)) });
  }
  if (typeof arg('eval') === 'string') {
    const evaluation = await page.evaluate(arg('eval'));
    // The evaluator hook is also our narrow engine-level diagnostic API. Printing
    // its return value lets a capture prove renderer/range/viewport state instead
    // of relying on a PNG alone. Existing mutating snippets normally return
    // undefined, so they retain their quiet output.
    if (evaluation !== undefined) console.log(`eval ${JSON.stringify(evaluation)}`);
  }
  const canvas = await page.$('canvas');

  // A full-shot regression must observe the terminal state itself. A fixed frame
  // count can stop during a long roll (or pass while the UI is frozen on one frame),
  // so optionally wait on the authoritative Ball lifecycle before capturing.
  if (waitRest) {
    await page.waitForFunction(
      () => window.golf?.ball?.state === 'airborne' || window.golf?.ball?.state === 'rolling',
      { timeout: 5000, polling: 10 },
    );
    await page.waitForFunction(
      () => window.golf?.ball?.state === 'rest',
      { timeout: 45000, polling: 25 },
    );
    const result = await page.evaluate(() => ({
      state: window.golf.ball.state,
      time: window.golf.ball.time,
      carryYards: window.golf.ball.carryYards,
      totalYards: window.golf.ball.totalYards,
    }));
    console.log(`shot ${JSON.stringify(result)}`);
  }

  // Capture the user-facing result-orbit -> automatic return -> address path.
  // This is intentionally engine-state driven: the sequence begins only once the
  // ball reports rest, then spans the app's real hold timer and damped return. It
  // catches camera cuts, repeated temporal resets, and viewport churn that a frozen
  // evaluator-camera probe cannot exercise.
  if (shotTransitionSequence || shotFlightSequence) {
    // Investor-facing continuous captures use the renderer's highest authored
    // presentation contract by default. Dynamic sub-native scaling is useful for
    // live device adaptation, but it turns narrow trunks and the tracer into
    // avoidable one-pixel stair steps in recorded footage.
    const captureQualityMode = String(arg('capture-quality', 'ultra'));
    const captureRenderScale = Number(arg('capture-scale', 1));
    if (captureRenderScale !== undefined && !Number.isFinite(captureRenderScale)) {
      throw new Error('--capture-scale must be finite');
    }
    const presentationLock = await page.evaluate(({ mode, renderScale }) => {
      const quality = window.golf?.quality;
      if (typeof quality?.acquirePresentationLock !== 'function'
          || typeof quality?.releasePresentationLock !== 'function') {
        throw new Error('Quality presentation-lock API is unavailable.');
      }
      return quality.acquirePresentationLock({ mode, renderScale });
    }, { mode: captureQualityMode, renderScale: captureRenderScale });
    console.log(`presentation-lock ${JSON.stringify(presentationLock.presentationLock)}`);
    // Applying a production render-resolution policy can invalidate/reallocate the
    // full-screen targets on the following frame. Let that one intentional change
    // settle before launch so every recorded shot frame has the same signature.
    await page.evaluate(() => new Promise((resolve) => {
      let frame = 0;
      const tick = () => (++frame >= 4 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }));
    try {
    // The engine API owns camera/live scene state, but the existing narrow public
    // shot boundary is the launch-monitor control. Dispatch it in-page so an
    // off-screen browser never depends on hit-testing an overlaid element.
    await page.evaluate(() => document.querySelector('#gs-hit')?.click());
    await page.waitForFunction(
      () => window.golf?.ball?.state === 'airborne' || window.golf?.ball?.state === 'rolling',
      { timeout: 5000, polling: 10 },
    );
    if (!shotFlightSequence) {
      await page.waitForFunction(
        () => window.golf?.ball?.state === 'rest',
        { timeout: 45000, polling: 25 },
      );
    }
    const sequenceName = shotFlightSequence ? 'flight' : 'transition';
    const sequenceArg = shotFlightSequence ? 'shot-flight-seq' : 'shot-transition-seq';
    const dir = out.replace(/\.png$/, `-${sequenceName}-seq`);
    await mkdir(dir, { recursive: true });
    const requestedSequenceFrames = arg(sequenceArg, 180);
    // A bare sequence flag is the documented/common form. `arg()` returns true
    // when the next token is another option, so preserve the 180-frame default
    // instead of coercing true to a one-frame sequence.
    const n = requestedSequenceFrames === true ? 180 : Number(requestedSequenceFrames);
    const stride = Math.max(1, Number(arg('transition-stride', 2)));
    const states = [];
    for (let i = 0; i < n; i++) {
      await page.evaluate((frameStride) => new Promise((resolve) => {
        let frame = 0;
        const tick = () => (++frame >= frameStride ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }), stride);
      const [state, buffer] = await Promise.all([
        page.evaluate(() => ({
          phase: window.golf.director.phase,
          ballState: window.golf.ball.state,
          cameraPosition: window.golf.sm.camera.position.toArray(),
          ballPosition: window.golf.ball.position.toArray(),
          viewport: window.golf.sm.readViewportDiagnostics(),
          invalidation: window.golf.sm._lastTemporalInvalidation || null,
          temporal: {
            cameraMoving: window.golf.sm._cameraMoving,
            cameraJitterEnabled: window.golf.sm._traa?.cameraJitterEnabled,
            jitterIndex: window.golf.sm._traa?._jitterIndex,
            historyAge: window.golf.sm._traa?._historyAge?.value,
          },
        })),
        canvas.screenshot(),
      ]);
      states.push(state);
      await writeFile(`${dir}/f${String(i).padStart(3, '0')}.png`, buffer);
      if (shotFlightSequence ? state.phase === 'result' && i > 8 : state.phase === 'address' && i > 8) break;
    }
    const signatures = new Set(states.map((state) => JSON.stringify({
      revision: state.viewport.revision,
      authoritative: state.viewport.authoritative,
      canvasClientPx: state.viewport.canvasClientPx,
      canvasBackingPx: state.viewport.canvasBackingPx,
      internalTargets: state.viewport.internalTargets,
    })));
    const phases = [...new Set(states.map((state) => state.phase))];
    const phaseChanges = states.flatMap((state, index) => (
      index > 0 && state.phase !== states[index - 1].phase
        ? [{ frame: index, from: states[index - 1].phase, to: state.phase }]
        : []
    ));
    console.log(`shot-${sequenceName} frames=${states.length} phases=${phases.join(',')} viewportSignatures=${signatures.size} changes=${JSON.stringify(phaseChanges)}`);
    if (signatures.size !== 1) throw new Error('Shot transition changed viewport/backing-store dimensions.');
    const jitteredMotionFrames = states.filter((state) => state.temporal.cameraMoving
      && state.temporal.cameraJitterEnabled !== false);
    if (jitteredMotionFrames.length) {
      throw new Error(`Shot transition exposed projection jitter on ${jitteredMotionFrames.length} moving-camera frames.`);
    }
    } finally {
      await page.evaluate((lockId) => {
        window.golf.quality.releasePresentationLock(lockId);
      }, presentationLock.presentationLock.id);
    }
  }

  // Wait for real drawn frames, not for a timer. `viewer.frames` only advances inside
  // the render loop, so this cannot pass on a stalled device. The game has no such
  // counter, so fall back to counting rAF ticks there.
  if (game) {
    await page.evaluate((n) => new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }), frames);
  } else {
    await page.waitForFunction(
      (n) => window.viewer?.sm?._ready && window.viewer.frames > n,
      { timeout: 90000, polling: 100 }, frames,
    );
  }

  if (has('gpu')) {
    const requested = Math.max(1, Math.min(30, Number(arg('gpu', 12)) || 12));
    const gpu = await page.evaluate(async (frameCount) => {
      const { sm } = window.golf;
      sm.freezeSimulation = true;
      sm.pauseRendering();
      try {
        const capture = sm.gpuProfiler.capture(frameCount);
        for (let frame = 0; frame < frameCount; frame += 1) sm.renderSingleFrame();
        const result = await capture;
        return {
          available: result.available,
          complete: result.complete,
          reason: result.reason,
          framesCaptured: result.framesCaptured,
          trackedGpuMsPerFrame: result.captureThroughput?.trackedGpuMsPerFrame,
          completionP95Ms: result.captureThroughput?.completionDeltaP95Ms,
          passes: result.passes?.map(({ label, type, mean, p95, max }) => (
            { label, type, mean, p95, max }
          )),
        };
      } finally {
        sm.freezeSimulation = false;
        sm.resumeRendering();
      }
    }, requested);
    console.log(`gpu ${JSON.stringify(gpu)}`);
  }

  const err = await page.$eval('#err', (el) => el.textContent).catch(() => '');
  if (err) logs.push(`[viewer] ${err}`);

  await mkdir(dirname(out), { recursive: true });
  const buf = await canvas.screenshot();
  await writeFile(out, buf);
  const rendered = decodePNG(buf);
  let nearBlack = 0;
  let luminance = 0;
  let luminanceSq = 0;
  for (let pixel = 0; pixel < rendered.width * rendered.height; pixel++) {
    const index = pixel * rendered.channels;
    const value = 0.2126 * rendered.pixels[index]
      + 0.7152 * rendered.pixels[index + 1]
      + 0.0722 * rendered.pixels[index + 2];
    luminance += value;
    luminanceSq += value * value;
    if (value < 4) nearBlack++;
  }
  const pixelCount = rendered.width * rendered.height;
  const meanLuminance = luminance / pixelCount;
  const luminanceStdDev = Math.sqrt(Math.max(0, luminanceSq / pixelCount - meanLuminance ** 2));
  const nonBlank = nearBlack / pixelCount < 0.99 && luminanceStdDev > 1;
  const healthErrors = logs.filter((entry) => /^\[(pageerror|requestfailed|http|error)\]/.test(entry));
  console.log(`qa ${JSON.stringify({
    ...qaPreflight,
    content: {
      width: rendered.width,
      height: rendered.height,
      nonBlank,
      nearBlackPct: +(100 * nearBlack / pixelCount).toFixed(3),
      meanLuminance: +meanLuminance.toFixed(2),
      luminanceStdDev: +luminanceStdDev.toFixed(2),
    },
    health: { consoleNetworkErrors: healthErrors },
  })}`);
  if (!nonBlank) throw new Error('Rendered screenshot is blank or lacks meaningful image variation.');
  if (healthErrors.length) throw new Error(`Console/network health failed: ${healthErrors.join('; ')}`);

  // Isolated asset silhouette probe. Compare the fully rendered subject against
  // the same production-lit scene with only that subject hidden; unlike a colour
  // key this remains valid across sky, terrain, exposure, and future palettes.
  // It is deliberately viewer-only and diagnostic: strict game benchmarks never
  // alter the production workload.
  if (!game && has('subject-mask')) {
    const hidden = await page.evaluate(() => {
      const current = window.viewer?.current;
      const subject = current?.treeBeauty?.group;
      if (!subject) return false;
      subject.visible = false;
      window.viewer.sm.invalidateTemporalHistory('isolated subject-mask baseline');
      return true;
    });
    if (!hidden) throw new Error('--subject-mask requires an isolated tree asset');
    await page.evaluate(() => new Promise((resolve) => {
      let frame = 0;
      const tick = () => (++frame >= 8 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }));
    const baseline = await canvas.screenshot();
    await page.evaluate(() => { window.viewer.current.treeBeauty.group.visible = true; });
    const foreground = decodePNG(buf);
    const background = decodePNG(baseline);
    if (foreground.width !== background.width || foreground.height !== background.height) {
      throw new Error('Subject-mask baseline dimensions changed');
    }
    const { width: maskW, height: maskH, channels: maskChannels } = foreground;
    let changed = 0;
    let minX = maskW, minY = maskH, maxX = -1, maxY = -1;
    const rowWidths = new Uint32Array(maskH);
    for (let y = 0; y < maskH; y++) {
      let rowMin = maskW, rowMax = -1;
      for (let x = 0; x < maskW; x++) {
        const index = (y * maskW + x) * maskChannels;
        const delta = Math.max(
          Math.abs(foreground.pixels[index] - background.pixels[index]),
          Math.abs(foreground.pixels[index + 1] - background.pixels[index + 1]),
          Math.abs(foreground.pixels[index + 2] - background.pixels[index + 2]),
        );
        if (delta <= 8) continue;
        changed++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        rowMin = Math.min(rowMin, x); rowMax = Math.max(rowMax, x);
      }
      if (rowMax >= rowMin) rowWidths[y] = rowMax - rowMin + 1;
    }
    const boxWidth = maxX >= minX ? maxX - minX + 1 : 0;
    const boxHeight = maxY >= minY ? maxY - minY + 1 : 0;
    const occupiedRows = [...rowWidths].filter((value) => value > 0).sort((a, b) => a - b);
    const medianRowWidth = occupiedRows.length ? occupiedRows[Math.floor(occupiedRows.length / 2)] : 0;
    console.log(`subject-mask ${JSON.stringify({
      changedPixels: changed,
      changedPct: +(100 * changed / (maskW * maskH)).toFixed(3),
      boundsPx: [minX, minY, maxX, maxY],
      boxWidth,
      boxHeight,
      boxAspect: boxHeight ? +(boxWidth / boxHeight).toFixed(3) : 0,
      fillPct: boxWidth && boxHeight ? +(100 * changed / (boxWidth * boxHeight)).toFixed(3) : 0,
      medianRowWidth,
    })}`);
  }

  if (has('probe')) {
    // Analyse the SCREENSHOT, not the live canvas. Reading a WebGPU canvas back through
    // a 2D context (drawImage + getImageData) returns all zeros — it looks exactly like
    // a black render and will send you chasing a shader bug that isn't there. The PNG
    // Chrome hands back is the only readback that tells the truth.
    const { width: W, height: H, channels: ch, pixels: px } = decodePNG(buf);
    const band = (f0, f1) => {
      let r = 0, g = 0, b = 0, n = 0, dark = 0;
      for (let y = Math.floor(H * f0); y < Math.floor(H * f1); y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * ch;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
          if (px[i] + px[i + 1] + px[i + 2] < 12) dark++;
        }
      }
      return { rgb: [r / n | 0, g / n | 0, b / n | 0], pctNearBlack: +(100 * dark / n).toFixed(1) };
    };
    // Silhouette speckle: dark pixels that sit directly against a bright one. That is
    // exactly the sub-pixel-blade-against-sky failure, and a mean colour can't see it —
    // it is a handful of pixels with enormous local contrast, which is why it reads so
    // badly to the eye and so mildly in an average.
    const lum = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    let speckle = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * ch;
        if (lum(i) > 40) continue;
        for (const o of [-ch, ch, -W * ch, W * ch]) {
          if (lum(i + o) > 120) { speckle++; break; }
        }
      }
    }
    console.log('probe ' + JSON.stringify({
      top: band(0, 1 / 3), middle: band(1 / 3, 2 / 3), bottom: band(2 / 3, 1),
      speckle: +(100 * speckle / (W * H)).toFixed(3),
    }));
  }

  // ---- Sequence capture. Grass shimmer is a TEMPORAL artifact: sub-pixel blades that
  // flip between covered and uncovered from frame to frame. It is glaring in motion and
  // close to invisible in a still, so a single screenshot — and any metric computed from
  // one — will tell you the render is fine when it is crawling. Capture N frames, write
  // a gif to look at, and reduce them to numbers: how much each pixel moves frame to
  // frame, and a heatmap PNG of where.
  if (has('seq')) {
    const n = Number(arg('seq', 12));
    const dir = out.replace(/\.png$/, '-seq');
    await mkdir(dir, { recursive: true });
    const frames = [];
    const sequenceStates = [];
    for (let i = 0; i < n; i++) {
      if (cameraSweepPose) {
        const t = n <= 1 ? 1 : i / (n - 1);
        await page.evaluate(({ fromPosition, toPosition, fromLookAt, toLookAt, alpha, fov, gameView }) => {
          const lerp = (a, b) => a.map((value, index) => value + (b[index] - value) * alpha);
          const position = lerp(fromPosition, toPosition);
          const lookAt = lerp(fromLookAt, toLookAt);
          if (gameView) window.golf.evaluatorCamera.setPose({ position, lookAt, fov });
          else window.viewer.setCamera(position, lookAt);
        }, {
          fromPosition: cameraPose,
          toPosition: cameraSweepPose,
          fromLookAt: cameraLook,
          toLookAt: cameraSweepLook,
          alpha: t,
          fov: Number(arg('fov', 40)),
          gameView: game,
        });
      }
      await page.evaluate(() => new Promise((r) => {
        let k = 0; const t = () => (++k >= 3 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t);
      }));
      const [b, state] = await Promise.all([
        canvas.screenshot(),
        page.evaluate((gameView) => gameView ? {
          cameraPosition: window.golf.sm.camera.position.toArray(),
          diagnostics: null,
        } : {
          cameraPosition: window.viewer.sm.camera.position.toArray(),
          diagnostics: window.viewer.treeDiagnostics(),
        }, game),
      ]);
      await writeFile(`${dir}/f${String(i).padStart(3, '0')}.png`, b);
      const decoded = decodePNG(b);
      frames.push({ W: decoded.width, H: decoded.height, ch: decoded.channels, px: decoded.pixels });
      sequenceStates.push({ frame: i, ...state });
    }
    const { W, H, ch } = frames[0];
    const maxD = new Uint8Array(W * H);
    let sum = 0;
    for (let f = 1; f < frames.length; f++) {
      const a = frames[f - 1].px, b = frames[f].px;
      for (let p = 0; p < W * H; p++) {
        const i = p * ch;
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d > maxD[p]) maxD[p] = d;
        sum += d;
      }
    }
    const mean = sum / (W * H * (frames.length - 1));
    let hot = 0;
    for (let p = 0; p < W * H; p++) if (maxD[p] > 60) hot++;
    console.log(`flicker meanDelta=${mean.toFixed(2)} pctPixelsUnstable=${(100 * hot / (W * H)).toFixed(2)}`);
    // Heatmap of WHERE it moves, so the cause is identifiable rather than just scored.
    const heat = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const v = Math.min(255, maxD[p] * 3);
      heat[p * 3] = v; heat[p * 3 + 1] = Math.max(0, v - 128) * 2; heat[p * 3 + 2] = 0;
    }
    await writeFile(out.replace(/\.png$/, '-flicker.png'), encodePNG(W, H, heat));
    await writeFile(`${dir}/report.json`, `${JSON.stringify({
      asset: game ? 'production-range' : asset,
      camera: { from: cameraPose, to: cameraSweepPose, lookFrom: cameraLook, lookTo: cameraSweepLook },
      frames: sequenceStates,
      meanDelta: Number(mean.toFixed(4)),
      pctPixelsUnstable: Number((100 * hot / (W * H)).toFixed(4)),
    }, null, 2)}\n`);
    console.log(`wrote ${dir}/ and -flicker.png`);
  }

  console.log(`wrote ${out}`);
} finally {
  if (game) {
    try { await page.evaluate(() => window.golf?.evaluatorCamera?.exit()); } catch { /* page may be gone */ }
  }
  const noise = /Autofill|DevTools|Download the React|has been renamed/;
  const interesting = logs.filter((l) => !noise.test(l));
  if (interesting.length) console.log('console:\n  ' + interesting.join('\n  '));
  try {
    await browser.close();
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}
