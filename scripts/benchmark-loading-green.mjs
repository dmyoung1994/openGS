import { launch } from 'puppeteer-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fitBrowserViewport } from './lib/browser-viewport.mjs';

const label = process.argv[2] || 'loading-green';
const route = new URL(process.env.BENCHMARK_ROUTE || '/range.html', process.env.VIEWER_URL || 'http://localhost:5173').href;
const directory = await mkdtemp(join(tmpdir(), `${label}-`));
const browser = await launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false, userDataDir: join(directory, 'chrome'),
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-position=8,40', '--window-size=960,640',
    '--enable-unsafe-webgpu', '--hide-scrollbars', '--mute-audio'],
  defaultViewport: { width: 1280, height: 720 },
});
try {
  const page = await browser.newPage();
  await fitBrowserViewport(page, 1280, 720);
  const errors = [];
  const expectedErrors = [];
  let expectedFailure = false;
  const recordError = message => (expectedFailure ? expectedErrors : errors).push(message);
  page.on('pageerror', error => recordError(String(error)));
  page.on('console', message => { if (message.type() === 'error') recordError(message.text()); });
  page.on('response', response => { if (response.status() >= 400) recordError(`${response.status()} ${response.url()}`); });
  await page.evaluateOnNewDocument(() => {
    window.loadingPhaseStart = 0;
    window.loadingAudioContexts = [];
    const audioConstructor = window.AudioContext ? 'AudioContext' : 'webkitAudioContext';
    const NativeAudioContext = window[audioConstructor];
    if (NativeAudioContext) window[audioConstructor] = new Proxy(NativeAudioContext, {
      construct(target, args, newTarget) {
        const start = performance.now();
        const context = Reflect.construct(target, args, newTarget);
        const record = { start, duration: performance.now() - start, context, closes: 0 };
        const close = context.close;
        context.close = function (...closeArgs) { record.closes++; return close.apply(this, closeArgs); };
        window.loadingAudioContexts.push(record);
        return context;
      },
    });
    window.loadingPerformance = { frames: [], longTasks: [], stages: [] };
    window.loadingRenderCosts = [];
    // Read-only timing wrappers around the actual renderer/native queue. No
    // pass is removed, resized or substituted, and arguments/returns are intact.
    Object.defineProperty(window, 'golf', { configurable: true, set(golf) {
      Object.defineProperty(window, 'golf', { configurable: true, writable: true, value: golf });
      const renderer = golf.sm.renderer;
      const passStack = [];
      function measure(owner, key, category, label = () => '') {
        const original = owner[key];
        owner[key] = function (...args) {
          const started = performance.now();
          const name = label(args);
          if (category === 'render') passStack.push(name);
          try { return original.apply(this, args); }
          finally {
            const duration = performance.now() - started;
            if (duration >= 1 && window.loadingRenderCosts.length < 2000) {
              window.loadingRenderCosts.push({ start: started, duration, category, name, passes: [...passStack],
                active: !!window.golfBootstrap?.loadingGreen?.active, stage: window.golfBootstrap?.stage });
            }
            if (category === 'render') passStack.pop();
          }
        };
      }
      measure(renderer, 'render', 'render', args => `${args[0]?.name || args[0]?.type || 'unnamed'}:${args[1]?.type || 'camera'}:${renderer.getRenderTarget()?.texture?.name || 'target'}`);
      measure(renderer._nodes, 'getForRender', 'node-build', args => args[0]?.object?.name || args[0]?.material?.name || 'unnamed');
      for (const key of ['createAttribute', 'createStorageAttribute']) {
        measure(renderer.backend, key, 'attribute-upload', args => JSON.stringify({
          name: args[0]?.name, bytes: args[0]?.array?.byteLength, itemSize: args[0]?.itemSize,
        }));
      }
      const queue = renderer.backend.device.queue;
      measure(queue, 'copyExternalImageToTexture', 'image-upload', args => JSON.stringify({
        size: args[2], source: args[0]?.source?.currentSrc || args[0]?.source?.src || args[1]?.texture?.label || '',
      }));
      measure(queue, 'writeTexture', 'data-upload', args => JSON.stringify(args[3]));
    } });
    let lastTime = null, lastStage = null, activeTail = 0;
    new PerformanceObserver(list => {
      for (const task of list.getEntries()) {
        window.loadingPerformance.longTasks.push({ start: task.startTime, duration: task.duration,
          stage: window.golfBootstrap?.stage, active: !!window.golfBootstrap?.loadingGreen?.active });
      }
    }).observe({ type: 'longtask', buffered: true });
    function tick(now) {
      const loading = window.golfBootstrap?.loadingGreen;
      const stage = window.golfBootstrap?.stage;
      if (stage !== lastStage) window.loadingPerformance.stages.push({ start: now, stage });
      if (activeTail > 0 && lastTime !== null) {
        window.loadingPerformance.frames.push({ start: lastTime, duration: now - lastTime, stage,
          putting: (loading?.putts ?? 0) > (loading?.made ?? 0), handoff: !loading?.active });
      }
      lastTime = now; lastStage = stage;
      activeTail = loading?.active ? 3 : Math.max(0, activeTail - 1);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  const client = await page.createCDPSession();
  await client.send('Profiler.enable');
  const runs = [];
  for (const phase of ['cold', 'warm-page', 'warm-course']) {
    await client.send('Profiler.start');
    if (phase === 'cold') await page.goto(route, { waitUntil: 'domcontentloaded' });
    else if (phase === 'warm-page') await page.reload({ waitUntil: 'domcontentloaded' });
    else await page.evaluate(() => {
      window.loadingPhaseStart = performance.now();
      window.loadingPerformance = { frames: [], longTasks: [], stages: [] };
      window.loadingRenderCosts = [];
      window.loadingTurfOwners = ['albedoArray', 'nrhArray'].map(key => {
        const texture = window.golf.range.terrain._turfMaps[key];
        const record = { key, texture, version: texture.version, disposals: 0 };
        texture.addEventListener('dispose', () => record.disposals++);
        return record;
      });
      window.loadingRebuild = window.golf.rebuild();
    });
    await page.waitForFunction(() => window.golfBootstrap?.loadingGreen?.active, { timeout: 120000 });
    const loadingPresentation = await page.evaluate(() => ({
      active: window.golfBootstrap.loadingGreen.active,
      shotHUD: [...document.querySelectorAll('.gs-shot-ui')].map(element => ({
        display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility,
        descendantRects: [...element.querySelectorAll('[data-shot-view]')]
          .reduce((count, child) => count + child.getClientRects().length, 0),
      })),
    }));
    await page.screenshot({ path: join(directory, `${phase}-active.png`) });
    await page.waitForFunction(() => window.golfBootstrap?.ready && window.golf?.evaluatorCamera
      && !window.golfBootstrap.loadingGreen.active, { timeout: 120000 });
    if (phase === 'warm-course') await page.evaluate(() => window.loadingRebuild);
    // Include the first visible course frame after the loader stops, not only
    // the ready flag observed before native upload/first rendering completes.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const { profile } = await client.send('Profiler.stop');
    await writeFile(join(directory, `${phase}.cpuprofile`), JSON.stringify(profile));
    const result = await page.evaluate(() => {
      const renderer = window.golf.sm.renderer;
      return { ...window.loadingPerformance, renderCosts: window.loadingRenderCosts, loading: { ...window.golfBootstrap.loadingGreen },
        audioPreparation: window.golfBootstrap.diagnostics.audioDevice ?? null,
        audioContexts: window.loadingAudioContexts.map(({ start, duration, closes, context }) => ({ start, duration, closes, state: context.state })),
        audioFirstRequestMs: performance.getEntriesByType('resource').find(entry => entry.name.includes('/assets/audio/'))?.startTime ?? null,
        phaseStartMs: window.loadingPhaseStart,
        residentTurf: window.loadingTurfOwners?.map(record => ({ key: record.key,
          sameTexture: record.texture === window.golf.range.terrain._turfMaps[record.key],
          sameVersion: record.version === record.texture.version, disposals: record.disposals,
        })) ?? null,
        title: document.title, href: location.href, ready: window.golfBootstrap.ready,
        webgpu: renderer.isWebGPURenderer && renderer.backend.isWebGPUBackend,
        fallback: renderer.backend.adapter?.info?.isFallbackAdapter ?? false,
        course: window.golf.range.course.meta.name };
    });
    const durations = result.frames.map(frame => frame.duration).sort((a, b) => a - b);
    result.cadence = { samples: durations.length, p50: durations[Math.floor(durations.length * .5)],
      p95: durations[Math.floor(durations.length * .95)], max: durations.at(-1),
      over50ms: durations.filter(ms => ms > 50).length };
    const activeDurations = result.frames.filter(frame => !frame.handoff).map(frame => frame.duration).sort((a, b) => a - b);
    result.activeCadence = { samples: activeDurations.length,
      p95: activeDurations[Math.floor(activeDurations.length * .95)], max: activeDurations.at(-1),
      over50ms: activeDurations.filter(ms => ms > 50).length };
    const finalFrame = result.frames.at(-1);
    result.handoffCompletedMs = finalFrame ? finalFrame.start + finalFrame.duration - result.phaseStartMs : null;
    runs.push({ phase, loadingPresentation, ...result });
    await writeFile(join(directory, 'report.json'), JSON.stringify({ runs, errors }, null, 2));
    console.log(JSON.stringify({ phase, cadence: result.cadence, activeCadence: result.activeCadence, longTasks: result.longTasks,
      loading: result.loading }));
    await page.evaluate(() => {
      window.golf.evaluatorCamera.enter();
      window.golf.evaluatorCamera.setPose({ position: [0, 2, 3], lookAt: [0, 0, -40], fov: 40 });
    });
    await page.evaluate(() => window.golf.evaluatorCamera.waitForFrames(45));
    await page.screenshot({ path: join(directory, `${phase}-ready.png`) });
    if (!result.webgpu || result.fallback || !result.ready || errors.length) throw new Error(`Invalid production QA: ${JSON.stringify(errors)}`);
    if (result.residentTurf?.some(record => !record.sameTexture || !record.sameVersion || record.disposals !== 0)) {
      throw new Error(`Turf residency failed across actual course disposal: ${JSON.stringify(result.residentTurf)}`);
    }
    if (loadingPresentation.shotHUD.some(hud => hud.descendantRects > 0)) {
      throw new Error(`Shot HUD remains laid out over loading presentation: ${JSON.stringify(loadingPresentation.shotHUD)}`);
    }
    if (result.audioPreparation?.supported && (result.audioContexts.length !== 1 || result.audioContexts[0].closes !== 0
      || result.audioContexts[0].start + result.audioContexts[0].duration > result.loading.preparedAtMs
      || (result.audioFirstRequestMs !== null && result.audioFirstRequestMs < result.loading.preparedAtMs))) {
      throw new Error(`Audio preparation/download ownership mismatch: ${JSON.stringify(result.audioContexts)}`);
    }
  }
  await page.evaluate(() => window.golf.audio.ready);
  const beforeGesture = await page.evaluate(() => window.golf.audio.snapshot());
  if (beforeGesture.supported) {
    if (beforeGesture.unlocked) throw new Error('Audio unlocked before a trusted input gesture.');
    await page.mouse.click(8, 8);
    await page.waitForFunction(() => window.golf.audio.snapshot().unlocked, { timeout: 30000 });
  }
  const afterGesture = await page.evaluate(() => window.golf.audio.snapshot());
  await writeFile(join(directory, 'audio-unlock.json'), JSON.stringify({ beforeGesture, afterGesture }, null, 2));
  await writeFile(join(directory, 'report.json'), JSON.stringify({ runs, errors }, null, 2));
  console.log(`report ${directory}/report.json`);
  if (process.env.BENCHMARK_AUDIO_FAILURE === '1') {
    // Negative ownership test after all timing: the real bootstrap must fail
    // closed and close its unclaimed native audio context. No substitute scene.
    expectedFailure = true;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/assets/environment/catalog.json') request.abort();
      else request.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.golfBootstrap?.stage === 'failed'
      && window.loadingAudioContexts?.[0]?.context.state === 'closed', { timeout: 120000 });
    const failure = await page.evaluate(() => ({
      stage: window.golfBootstrap.stage, ready: window.golfBootstrap.ready,
      webgpu: window.golfBootstrap.sm.renderer.backend.isWebGPUBackend,
      courseInstalled: Boolean(window.golf), loadingActive: window.golfBootstrap.loadingGreen?.active,
      contexts: window.loadingAudioContexts.map(record => ({ closes: record.closes, state: record.context.state })),
      message: document.getElementById('environment-fatal')?.textContent,
    }));
    await page.screenshot({ path: join(directory, 'expected-audio-bootstrap-failure.png') });
    await writeFile(join(directory, 'expected-audio-bootstrap-failure.json'), JSON.stringify({ ...failure, expectedErrors }, null, 2));
    if (failure.ready || !failure.webgpu || failure.courseInstalled || failure.loadingActive
      || failure.contexts.length !== 1 || failure.contexts[0].closes !== 1 || !failure.message) {
      throw new Error(`Failed bootstrap leaked or handed off audio: ${JSON.stringify(failure)}`);
    }
  }
} catch (error) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({
    route, error: String(error), stack: error.stack,
  }, null, 2));
  console.error(`failure ${directory}/failure.json`);
  throw error;
} finally { await browser.close(); }
