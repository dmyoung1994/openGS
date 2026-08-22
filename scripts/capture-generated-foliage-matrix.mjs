#!/usr/bin/env node

import { launch } from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const base = arg('url', process.env.VIEWER_URL || 'http://127.0.0.1:5173');
const outDir = resolve(arg('out', 'tmp/foliage-matrix'));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const asset = arg('asset', 'tree candidate: generated Douglas-fir clusters');

const captures = [];
for (const distance of [5, 20, 50, 100, 200]) for (const azimuth of [0, 120, 240]) {
  captures.push({ id: `beauty-${distance}m-${azimuth}deg`, distance, azimuth, debug: 'beauty', bg: 'sky', texture: 'ktx2' });
}
captures.push(
  { id: 'front-alpha-light', distance: 5, azimuth: 0, debug: 'alpha', bg: 'light', texture: 'ktx2' },
  { id: 'back-alpha-dark', distance: 5, azimuth: 180, debug: 'alpha', bg: 'dark', texture: 'ktx2' },
  { id: 'front-beauty-light', distance: 5, azimuth: 0, debug: 'beauty', bg: 'light', texture: 'ktx2' },
  { id: 'back-beauty-dark', distance: 5, azimuth: 180, debug: 'beauty', bg: 'dark', texture: 'ktx2' },
  ...['material', 'normal', 'lod', 'hull', 'overdraw'].map((debug) => (
    { id: `debug-${debug}`, distance: 20, azimuth: 0, debug, bg: 'dark', texture: 'ktx2' }
  )),
  { id: 'png-parity-20m-0deg', distance: 20, azimuth: 0, debug: 'beauty', bg: 'sky', texture: 'png' },
  { id: 'control-alpha-low', distance: 5, azimuth: 0, debug: 'beauty', bg: 'dark', texture: 'ktx2', alphaTest: 0.12 },
  { id: 'control-alpha-high', distance: 5, azimuth: 0, debug: 'beauty', bg: 'dark', texture: 'ktx2', alphaTest: 0.32 },
  { id: 'control-roughness-flat', distance: 5, azimuth: 120, debug: 'beauty', bg: 'light', texture: 'ktx2', roughness: 0 },
  { id: 'control-normal-shaped', distance: 5, azimuth: 120, debug: 'normal', bg: 'dark', texture: 'ktx2', normalShape: 1 },
  { id: 'control-transmission-off', distance: 5, azimuth: 240, debug: 'beauty', bg: 'light', texture: 'ktx2', transmission: 0 },
  { id: 'control-sun-moving', distance: 5, azimuth: 240, debug: 'beauty', bg: 'dark', texture: 'ktx2', sun: 'moving', settleFrames: 240 },
  { id: 'subject-atlas', distance: 5, azimuth: 0, debug: 'beauty', bg: 'dark', texture: 'ktx2', subject: 'atlas' },
  { id: 'subject-cards', distance: 5, azimuth: 0, debug: 'beauty', bg: 'light', texture: 'ktx2', subject: 'cards' },
  { id: 'subject-mip-4', distance: 5, azimuth: 0, debug: 'beauty', bg: 'dark', texture: 'ktx2', subject: 'mip', mip: 4 },
  { id: 'subject-mip-8', distance: 5, azimuth: 0, debug: 'beauty', bg: 'dark', texture: 'ktx2', subject: 'mip', mip: 8 },
);
const only = arg('only', null);
const requestedIds = only ? new Set(only.split(',').map((id) => id.trim()).filter(Boolean)) : null;
const selectedCaptures = requestedIds ? captures.filter(({ id }) => requestedIds.has(id)) : captures;
if (requestedIds && selectedCaptures.length !== requestedIds.size) {
  throw new Error(`Unknown capture id in --only ${only}`);
}

await mkdir(outDir, { recursive: true });
const browser = await launch({
  executablePath: chrome,
  headless: false,
  defaultViewport: { width: 1280, height: 720 },
  args: [
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-position=-4000,-4000', '--window-size=1280,810',
    '--enable-unsafe-webgpu', '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage();
const errors = [];
let activeCapture = 'startup';
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) errors.push(`${activeCapture} [${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`${activeCapture} [pageerror] ${error.message}`));
page.on('requestfailed', (request) => errors.push(`${activeCapture} [requestfailed] ${request.url()}`));

const report = { kind: 'generated-foliage-viewer-matrix', generatedAt: new Date().toISOString(), asset, captures: [], errors };
try {
  for (const capture of selectedCaptures) {
    activeCapture = capture.id;
    const url = new URL('/viewer.html', base);
    url.searchParams.set('asset', asset);
    url.searchParams.set('dist', String(capture.distance));
    url.searchParams.set('az', String(capture.azimuth));
    url.searchParams.set('texture', capture.texture);
    url.searchParams.set('debug', capture.debug);
    url.searchParams.set('bg', capture.bg);
    for (const key of ['alphaTest', 'roughness', 'normalShape', 'transmission', 'sun', 'subject', 'mip']) {
      if (capture[key] !== undefined) url.searchParams.set(key, String(capture[key]));
    }
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction((settleFrames) => window.viewer?.sm?._ready && window.viewer?.current
      && window.viewer.frames >= settleFrames,
    { polling: 100, timeout: 120000 }, capture.settleFrames ?? 48);
    const state = await page.evaluate(async () => ({
      webgpu: window.viewer.sm.renderer.backend?.isWebGPUBackend === true,
      diagnostics: await window.viewer.treeDiagnosticsGpu(),
      error: document.getElementById('err')?.textContent || '',
    }));
    if (!state.webgpu) errors.push(`${capture.id} did not use WebGPU`);
    if (state.error) errors.push(`${capture.id} viewer error: ${state.error}`);
    const canvas = await page.$('#app canvas');
    if (!canvas) throw new Error(`${capture.id}: viewer canvas is missing`);
    const file = `${capture.id}.png`;
    await writeFile(join(outDir, file), await canvas.screenshot());
    report.captures.push({ ...capture, file, diagnostics: state.diagnostics });
  }
} finally {
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

console.log(`generated foliage matrix: ${join(outDir, 'report.json')}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
