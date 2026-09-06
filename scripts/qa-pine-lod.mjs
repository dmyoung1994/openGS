#!/usr/bin/env node
// Strict headful-WebGPU proof for the production Pine Tree 01 authored-mesh LOD.
// Captures one deterministic source at 20 m and 60 m while auditing the complete
// immutable source list through both the CPU classifier twin and GPU readback.
import { launch } from 'puppeteer-core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const base = option('url', 'http://127.0.0.1:5173');
const expectedSourceCount = Number(option('expected-source-count', '272'));
const qualityMode = option('quality', 'ultra');
const renderScale = Number(option('render-scale', '1'));
const reportPath = option('report', '/tmp/pine-production-lod-report.json');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'pine-production-lod-chrome-'));
const errors = [];
let browser;

try {
  browser = await launch({
    executablePath: chrome,
    headless: false,
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    args: [
      '--enable-unsafe-webgpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=-4000,-4000',
      '--window-size=1280,810',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) errors.push(`[console:${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
  page.on('requestfailed', (request) => errors.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`[http:${response.status()}] ${response.url()}`);
  });

  await page.goto(`${base}/play.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => window.golfBootstrap?.ready === true || window.golfBootstrap?.stage === 'failed',
    { timeout: 90_000, polling: 100 },
  );
  const failure = await page.evaluate(() => window.golfBootstrap?.stage === 'failed'
    ? window.golfBootstrap?.diagnostics?.error || 'unknown bootstrap failure'
    : null);
  if (failure) throw new Error(`Application bootstrap failed: ${failure}`);
  await page.evaluate(async () => {
    await window.golf.environmentReady;
    document.querySelector('[data-designed-play]')?.click();
  });
  await page.waitForFunction(() => document.body.dataset.view === 'practice', { timeout: 10_000 });

  const preflight = await page.evaluate(() => {
    const golf = window.golf;
    const backend = golf?.sm?.renderer?.backend;
    const pine = golf?.range?.treeBeauties?.find((beauty) => beauty.assetId === 'polyhaven-pine-tree-01');
    return {
      pageIdentity: {
        href: location.href,
        pathname: location.pathname,
        title: document.title,
        canvas: Boolean(document.querySelector('canvas')),
      },
      bootstrap: { ready: window.golfBootstrap?.ready === true, stage: window.golfBootstrap?.stage },
      renderer: {
        webgpuRenderer: golf?.sm?.renderer?.isWebGPURenderer === true,
        webgpuBackend: backend?.isWebGPUBackend === true,
        webglBackend: backend?.isWebGLBackend === true,
        fallbackAdapter: backend?.isFallbackAdapter === true,
      },
      evaluatorCamera: golf?.evaluatorCamera?.version,
      scene: golf?.range?.constructor?.name,
      course: golf?.range?.course?.meta?.name,
      pineSourceCount: pine?.sourceCount ?? null,
      pinePartCount: pine?.partCount ?? null,
      authoredMeshOnly: pine?.authoredMeshOnly === true,
    };
  });
  if (!preflight.pageIdentity.canvas
      || !preflight.bootstrap.ready
      || !preflight.renderer.webgpuRenderer
      || !preflight.renderer.webgpuBackend
      || preflight.renderer.webglBackend
      || preflight.renderer.fallbackAdapter
      || preflight.evaluatorCamera !== '1.0'
      || preflight.scene !== 'PlayScene'
      || preflight.pineSourceCount !== expectedSourceCount
      || preflight.pinePartCount !== 4
      || !preflight.authoredMeshOnly) {
    throw new Error(`Strict Pine Tree 01 preflight failed: ${JSON.stringify(preflight)}`);
  }

  const presentation = await page.evaluate(({ mode, scale }) => {
    const quality = window.golf?.quality;
    if (typeof quality?.acquirePresentationLock !== 'function') {
      throw new Error('Quality presentation-lock API is unavailable.');
    }
    return quality.acquirePresentationLock({ mode, renderScale: scale });
  }, { mode: qualityMode, scale: renderScale });
  await page.evaluate(() => new Promise((resolve) => {
    let frame = 0;
    const tick = () => (++frame >= 12 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));

  const canvas = await page.$('canvas');
  const captures = [];
  for (const distance of [20, 60]) {
    const diagnostics = await page.evaluate(async (cameraDistance) => {
      const golf = window.golf;
      const pine = golf.range.treeBeauties.find((beauty) => beauty.assetId === 'polyhaven-pine-tree-01');
      const x = pine.shadowRecords[0];
      const y = pine.shadowRecords[1];
      const z = pine.shadowRecords[2];
      const height = pine.shadowRecords[3];
      const lookAt = [x, y + height * 0.48, z];
      const position = [x, y + height * 0.48, z + cameraDistance];
      const evaluator = golf.evaluatorCamera;
      if (!evaluator.owned) evaluator.enter();
      evaluator.freeze();
      evaluator.setPose({ position, lookAt, fov: 40 });
      await evaluator.settle(30);
      const estimated = pine.residencyEstimate(golf.sm.camera);
      const gpu = await pine.readDiagnostics();
      return { cameraDistance, target: { x, y, z, height }, position, lookAt, estimated, gpu };
    }, distance);
    if (!diagnostics.estimated.classificationComplete
        || diagnostics.estimated.sourceCount !== expectedSourceCount
        || !diagnostics.gpu.classificationComplete
        || diagnostics.gpu.sourceCount !== expectedSourceCount
        || diagnostics.gpu.distanceRejected !== 0
        || diagnostics.gpu.policyDistanceRejected !== 0
        || diagnostics.gpu.policyBudgetRejected !== 0
        || diagnostics.gpu.invalidMembership !== 0
        || diagnostics.gpu.overflow !== 0
        || !diagnostics.gpu.siblingCountsEqual
        || diagnostics.gpu.visibleCount + diagnostics.gpu.behindRejected + diagnostics.gpu.frustumRejected !== expectedSourceCount) {
      throw new Error(`Pine residency is incomplete at ${distance} m: ${JSON.stringify(diagnostics)}`);
    }
    const path = `/tmp/pine-production-${distance}m.png`;
    await canvas.screenshot({ path });
    captures.push({ ...diagnostics, path });
  }

  const gpuComparison = await page.evaluate(async () => {
    const sm = window.golf.sm;
    const availability = sm.gpuProfiler?.availability?.() ?? {
      available: false,
      reason: 'Native GPU profiler is unavailable.',
    };
    if (!availability.available) return { withPines: availability, withoutPines: availability };
    const wasFrozen = Boolean(sm.freezeSimulation);
    sm.freezeSimulation = true;
    sm.pauseRendering();
    const captureWindow = async () => {
      for (let frame = 0; frame < 30; frame += 1) sm.renderSingleFrame();
      const pending = sm.gpuProfiler.capture(30);
      for (let frame = 0; frame < 30; frame += 1) sm.renderSingleFrame();
      const result = await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        available: result.available,
        complete: result.complete,
        reason: result.reason || null,
        framesCaptured: result.framesCaptured,
        unavailablePassCount: result.unavailablePassCount,
        trackedGpuMsPerFrame: result.captureThroughput?.trackedGpuMsPerFrame ?? null,
        completionP95Ms: result.captureThroughput?.completionDeltaP95Ms ?? null,
        captureThroughput: result.captureThroughput ?? null,
        passes: result.passes?.map(({ label, type, samples, mean, p95, max }) => (
          { label, type, samples, mean, p95, max }
        )) ?? [],
      };
    };
    try {
      const pine = window.golf.range.treeBeauties
        .find((beauty) => beauty.assetId === 'polyhaven-pine-tree-01');
      const withPines = await captureWindow();
      pine.group.visible = false;
      const withoutPines = await captureWindow();
      pine.group.visible = true;
      return { withPines, withoutPines };
    } finally {
      sm.freezeSimulation = wasFrozen;
      sm.resumeRendering();
    }
  });
  const gpu = gpuComparison.withPines;
  if (!gpu.available || !gpu.complete || gpu.unavailablePassCount !== 0) {
    throw new Error(`Pine GPU profile is incomplete: ${JSON.stringify(gpu)}`);
  }

  const report = {
    preflight,
    presentation: presentation.presentationLock,
    captures,
    gpu: {
      ...gpu,
      budgetMs: 33.3,
      idealBudgetMs: 30,
      withinBudget: gpu.completionP95Ms <= 33.3,
      withinIdealBudget: gpu.completionP95Ms <= 30,
    },
    noPineBaseline: gpuComparison.withoutPines,
    errors: [...new Set(errors)],
  };
  if (report.errors.length) throw new Error(`Console/network health failed: ${JSON.stringify(report.errors)}`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
}
