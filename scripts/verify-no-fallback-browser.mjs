// Runtime proof that unsupported devices fail closed. This complements the static
// no-fallback contract tests with two real browser boots: WebGPU unavailable, and a
// deterministic adapter explicitly marked as fallback/software.
import { launch } from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const base = String(arg('url', process.env.BENCHMARK_URL || 'http://127.0.0.1:5173'));
const outDir = resolve(String(arg('out', 'benchmarks/no-fallback-browser')));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const report = {
  schemaVersion: 1,
  kind: 'no-fallback-browser-integration',
  startedAt: new Date().toISOString(),
  cases: [],
  validation: { passed: false, errors: [] },
};
const activeBrowsers = new Set();

function fail(message) {
  report.validation.errors.push(String(message));
}

async function runCase({ id, browserArgs, injectMode = null }) {
  const browser = await launch({
    executablePath: chrome,
    headless: false,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=-4000,-4000',
      '--window-size=1000,690',
      '--hide-scrollbars',
      ...browserArgs,
    ],
    defaultViewport: { width: 1000, height: 600, deviceScaleFactor: 1 },
  });
  activeBrowsers.add(browser);
  const page = await browser.newPage();
  const consoleEntries = [];
  const pageErrors = [];
  page.on('console', (message) => consoleEntries.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.evaluateOnNewDocument((mode) => {
    const requestedContexts = [];
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function instrumentedGetContext(type, ...args) {
      requestedContexts.push(String(type));
      return originalGetContext.call(this, type, ...args);
    };
    window.__requestedCanvasContexts = requestedContexts;

    if (mode === 'missing') {
      Object.defineProperty(Navigator.prototype, 'gpu', {
        configurable: true,
        get: () => undefined,
      });
    }

    if (mode === 'fallback') {
      const stats = { adapterRequests: 0, deviceRequests: 0 };
      const fallbackAdapter = {
        isFallbackAdapter: true,
        info: {
          vendor: 'Deterministic Test',
          architecture: 'software',
          device: 'Fallback Adapter',
          description: 'Software adapter injected by no-fallback integration test',
        },
        features: new Set(),
        limits: {},
        requestDevice: async () => {
          stats.deviceRequests++;
          throw new Error('Strict backend must reject before requesting a fallback device.');
        },
      };
      const fakeGpu = {
        requestAdapter: async () => {
          stats.adapterRequests++;
          return fallbackAdapter;
        },
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
      window.__fakeGpuStats = stats;
      Object.defineProperty(Navigator.prototype, 'gpu', {
        configurable: true,
        get: () => fakeGpu,
      });
    }
  }, injectMode);

  const url = new URL('/index.html', base);
  url.searchParams.set('view', 'practice');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => {
    const bootstrap = window.golfBootstrap;
    return bootstrap?.sm?._initError && document.querySelector('.webgpu-required, #environment-fatal');
  }, { timeout: 15_000, polling: 50 });

  const before = await page.evaluate(() => ({
    ready: window.golfBootstrap.sm._ready,
    frame: window.golfBootstrap.sm.renderer.info.frame,
    initError: window.golfBootstrap.sm._initError?.message || String(window.golfBootstrap.sm._initError),
    backendWebgl: window.golfBootstrap.sm.renderer.backend?.isWebGLBackend === true,
    productionApiInstalled: !!window.golf,
    contexts: [...window.__requestedCanvasContexts],
    fakeGpuStats: window.__fakeGpuStats ? { ...window.__fakeGpuStats } : null,
    fatalText: document.querySelector('.webgpu-required, #environment-fatal')?.textContent || null,
  }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 2100));
  const after = await page.evaluate(() => ({
    ready: window.golfBootstrap.sm._ready,
    frame: window.golfBootstrap.sm.renderer.info.frame,
    contexts: [...window.__requestedCanvasContexts],
    fakeGpuStats: window.__fakeGpuStats ? { ...window.__fakeGpuStats } : null,
  }));
  const result = { id, before, after, console: consoleEntries, pageErrors };
  report.cases.push(result);

  if (before.ready || after.ready) fail(`${id}: SceneManager became ready`);
  if (!before.initError) fail(`${id}: initialization error was not retained`);
  if (!before.fatalText) fail(`${id}: fatal WebGPU UI did not appear`);
  if (before.productionApiInstalled) fail(`${id}: production environment API installed after fatal initialization`);
  if (before.frame !== after.frame) fail(`${id}: renderer frame advanced ${before.frame} -> ${after.frame}`);
  if (before.backendWebgl) fail(`${id}: WebGL backend became active`);
  const forbiddenContexts = after.contexts.filter((type) => type === 'webgl' || type === 'webgl2'
    || type === 'experimental-webgl');
  if (forbiddenContexts.length) fail(`${id}: requested forbidden canvas contexts: ${forbiddenContexts.join(', ')}`);
  if (injectMode === 'fallback') {
    if (after.fakeGpuStats?.adapterRequests !== 1) {
      fail(`${id}: adapter requests=${after.fakeGpuStats?.adapterRequests}, expected exactly 1`);
    }
    if (after.fakeGpuStats?.deviceRequests !== 0) {
      fail(`${id}: fallback adapter requestDevice was called ${after.fakeGpuStats?.deviceRequests} times`);
    }
    if (!/software|fallback/i.test(before.initError)) fail(`${id}: fallback rejection was not explicit: ${before.initError}`);
  }
  await browser.close();
  activeBrowsers.delete(browser);
}

try {
  await mkdir(outDir, { recursive: true });
  await runCase({
    id: 'webgpu-disabled',
    browserArgs: ['--disable-webgpu', '--disable-features=WebGPU'],
    injectMode: 'missing',
  });
  await runCase({
    id: 'fallback-adapter',
    browserArgs: ['--enable-unsafe-webgpu'],
    injectMode: 'fallback',
  });
  report.validation.passed = report.validation.errors.length === 0;
  if (!report.validation.passed) process.exitCode = 1;
} catch (error) {
  fail(error.stack || error.message || String(error));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...activeBrowsers].map((browser) => browser.close()));
  activeBrowsers.clear();
  report.finishedAt = new Date().toISOString();
  report.validation.passed = report.validation.errors.length === 0;
  const path = join(outDir, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`no-fallback browser report: ${path}`);
  console.log(report.validation.passed ? 'no-fallback browser: PASS' : 'no-fallback browser: FAIL');
}
