// Capture a Metal GPU frame trace (.gputrace) of this app's WebGPU rendering, openable in
// Xcode's Metal debugger.
//
// WHY THIS EXISTS
// Some questions are about GPU *state*, not shader math: at this pixel, which draw call's
// fragment won, in what depth/blend state, against which bound resources. No screenshot
// and no amount of reading TSL answers that. RenderDoc cannot help on this machine — there
// is no macOS build and it has no Metal or WebGPU backend. Chrome's WebGPU here is
// Dawn -> Metal, so Xcode's Metal frame capture is the tool that applies.
//
//   node scripts/gputrace.mjs
//   node scripts/gputrace.mjs --asset "turf: fairway" --frames 3 --out traces
//   node scripts/gputrace.mjs --game --view practice
//
// HOW TO OPEN THE RESULT
//   open -a Xcode traces/golfsim-<timestamp>-c000.gputrace
// Xcode opens it as a "Debugging GPU Workload" document: Summary (command buffer / encoder
// / draw-call counts), then the navigator on the left listing every command buffer and
// encoder. Click a draw call to see its bound resources, pipeline state and attachments;
// the shader debugger works from there too. This part is Xcode's UI — there is no CLI that
// opens or replays a .gputrace, so this last step is yours, not the script's.
//
// HOW IT WORKS (and why the flags are what they are)
// Dawn has a built-in Metal capture driven by two environment variables, DAWN_TRACE_FILE_BASE
// and DAWN_TRACE_DEVICE_FILTER. Three things have to line up:
//   1. MTL_CAPTURE_ENABLED=1 must be set on the process that owns the MTLDevice — the GPU
//      process. Chrome passes its environment to its children, so setting it on the browser
//      is enough; no --in-process-gpu needed.
//   2. The GPU sandbox denies writing the .gputrace ("Operation not permitted"), so
//      --disable-gpu-sandbox is required. Run --probe to see this failure deliberately: it
//      logs every capture Dawn *would* start without writing gigabytes.
//   3. DAWN_TRACE_DEVICE_FILTER matches a Dawn device's LABEL (not an index — indices and
//      substrings both match nothing). This matters because Chrome's own compositor creates
//      a Dawn device before the page does, and only one Metal capture can run at a time, so
//      an unfiltered run captures Chrome's device and the page's device loses with
//      "Already capturing." The script forces a known label onto the page's GPUDevice by
//      patching GPUAdapter.requestDevice from the harness (no app source change), then
//      filters on it.
// The capture spans the device's whole lifetime — Dawn starts it at device creation, and
// there is no way to scope it to one frame. So it includes all of scene init, which is why
// traces are ~1 GB even at --frames 1 (asset uploads dominate; frame count barely matters).
// Check you have the disk. The device must be destroyed for the capture to be finalised —
// killing Chrome leaves a truncated bundle Xcode will not open — so the script navigates to
// about:blank and waits for Dawn to log "Metal trace saved" before quitting.
import { launch } from 'puppeteer-core';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const has = (n) => argv.includes(`--${n}`);

const asset = arg('asset', 'turf: rough');
const outDir = resolve(arg('out', 'traces'));
const base = arg('url', process.env.VIEWER_URL || 'http://localhost:5173');
const frames = Number(arg('frames', 3));
const label = arg('label', 'golfsim-trace');
const probe = has('probe');
const game = has('game');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(outDir, { recursive: true });

const url = new URL(game ? '/index.html' : '/viewer.html', base);
if (game) url.searchParams.set('view', arg('view', 'practice'));
else url.searchParams.set('asset', asset);
if (arg('cam')) url.searchParams.set('cam', arg('cam'));
if (arg('look')) url.searchParams.set('look', arg('look'));

const env = {
  ...process.env,
  MTL_CAPTURE_ENABLED: '1',
  DAWN_TRACE_FILE_BASE: join(outDir, 'golfsim'),
  DAWN_TRACE_DEVICE_FILTER: label,
};

const browser = await launch({
  executablePath: chrome,
  headless: false,
  dumpio: false,
  env,
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-position=-4000,-4000',
    '--window-size=1280,810',
    '--enable-unsafe-webgpu',
    '--hide-scrollbars',
    '--mute-audio',
    ...(probe ? [] : ['--disable-gpu-sandbox']),
    ...(arg('extra') ? String(arg('extra')).split(',') : []),
  ],
  defaultViewport: { width: 1280, height: 720 },
});

// Watch the GPU process's stderr for Dawn/Metal's own capture messages. This is the only
// place the capture reports success, so we both echo it and wait on it.
let gpuLog = '';
const proc = browser.process();
for (const s of [proc.stderr, proc.stdout]) {
  s?.on('data', (b) => {
    const t = String(b);
    gpuLog += t;
    for (const line of t.split('\n')) {
      if (/Metal (trace|capture)|gputrace/i.test(line)) console.log(`[metal] ${line.replace(/UserInfo=.*/, '').trim()}`);
    }
  });
}
const waitFor = async (re, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(gpuLog)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const page = await browser.newPage();
// Force a known label onto the page's GPUDevice so DAWN_TRACE_DEVICE_FILTER can single it
// out. Without this the filter would also match Chrome's own compositor Dawn device, which
// is created first and would win the capture (only one capture can run at a time).
await page.evaluateOnNewDocument((L) => {
  if (typeof GPUAdapter === 'undefined') return;   // about:blank has no WebGPU
  const rd = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (desc = {}) { return rd.call(this, { ...desc, label: L }); };
}, label);
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

try {
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (game) {
    await page.waitForFunction(() => window.golf?.sm?._ready, { timeout: 90000, polling: 100 });
    await page.evaluate((n) => new Promise((res) => {
      let i = 0; const tick = () => (++i >= n ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick);
    }), frames);
  } else {
    await page.waitForFunction(
      (n) => window.viewer?.sm?._ready && window.viewer.frames > n,
      { timeout: 90000, polling: 100 }, frames,
    );
    console.log('[gputrace] frames drawn:', await page.evaluate(() => window.viewer.frames));
  }

  // Destroying the device is what makes Dawn stop the capture and finalise the document.
  // Killing Chrome instead leaves a truncated .gputrace that Xcode will not open.
  await page.evaluate(() => {
    window.viewer?.sm?.renderer?.dispose?.();
    window.golf?.sm?.renderer?.dispose?.();
  }).catch(() => {});
  await page.goto('about:blank', { timeout: 15000 }).catch(() => {});
  const ok = await waitFor(/Metal trace saved/, 120000);
  console.log(ok ? '[gputrace] capture finalised' : '[gputrace] WARNING: never saw "Metal trace saved"');
} catch (e) {
  console.log('[gputrace] ERR', e.message);
} finally {
  await browser.close();
}

const found = (await readdir(outDir)).filter((f) => f.endsWith('.gputrace'));
for (const f of found) {
  const p = join(outDir, f);
  // A finalised bundle has both the command stream and its index; a truncated one does not.
  const ok = (await stat(join(p, 'capture')).catch(() => null)) && (await stat(join(p, 'index')).catch(() => null));
  console.log(`[gputrace] ${p}${ok ? '' : '  (INCOMPLETE — missing capture/index)'}`);
  console.log(`[gputrace] open with:  open -a Xcode "${p}"`);
}
if (!found.length) console.log('[gputrace] no trace written');
