// Dump the WGSL and generated MSL for every shader this app compiles.
//
// WHY THIS EXISTS
// TSL is a shader *generator*. When a material looks wrong the first question is whether
// the code you think you wrote is the code that ran — and on WebGPU there are two
// translations between them (TSL -> WGSL by three.js, WGSL -> MSL by Tint). This dumps
// both, so "did my Else branch actually emit an assignment" is a grep instead of a guess.
//
//   node scripts/dumpshaders.mjs
//   node scripts/dumpshaders.mjs --asset "turf: fairway" --out shaders/fairway
//   node scripts/dumpshaders.mjs --game --grep TurfTier
//
// HOW IT WORKS
// Chrome passes Dawn toggles through --enable-dawn-features. `dump_shaders` makes Dawn log
// each shader module's WGSL and the MSL Tint generated from it; `disable_symbol_renaming`
// stops Tint mangling identifiers, which is what keeps your own struct names (TurfTier,
// …) in the MSL and therefore greppable. Dawn emits these as device *log messages*, which
// Chrome surfaces on the page console — so they arrive over CDP, not on Chrome's stderr.
//
// OUTPUT
// One file per shader module in --out: NNN.wgsl and NNN.msl, plus index.txt listing each
// module's size and the user-defined struct names found in it (how you identify which
// module is which — TSL names uniforms nodeUniform0.., so structs are the only signal).
import { launch } from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const has = (n) => argv.includes(`--${n}`);

const asset = arg('asset', 'turf: rough');
const outDir = resolve(arg('out', 'shaders'));
const base = arg('url', process.env.VIEWER_URL || 'http://localhost:5173');
const frames = Number(arg('frames', 5));
const grep = arg('grep', null);
const game = has('game');
const feats = arg('feats', 'dump_shaders,disable_symbol_renaming');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(outDir, { recursive: true });

const url = new URL(game ? '/index.html' : '/viewer.html', base);
if (game) url.searchParams.set('view', arg('view', 'practice'));
else url.searchParams.set('asset', asset);
if (arg('cam')) url.searchParams.set('cam', arg('cam'));
if (arg('look')) url.searchParams.set('look', arg('look'));

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
    `--enable-dawn-features=${feats}`,
    '--hide-scrollbars',
    '--mute-audio',
  ],
  defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();
const mods = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('// Dumped WGSL:')) mods.push({ kind: 'wgsl', code: t });
  else if (t.startsWith('/* Dumped generated MSL */')) mods.push({ kind: 'msl', code: t });
});
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
  }
} catch (e) {
  console.log('[dumpshaders] ERR', e.message);
} finally {
  await browser.close();
}

// Dawn dumps WGSL when a shader module is created and MSL when a pipeline is created, so
// the two streams do NOT interleave one-to-one — number them independently rather than
// inventing a pairing that would be wrong.
const files = [];
const index = [];
for (const kind of ['wgsl', 'msl']) {
  let n = 0;
  for (const m of mods.filter((x) => x.kind === kind)) {
    const id = `${kind}-${String(n++).padStart(3, '0')}`;
    const structs = [...new Set([...m.code.matchAll(/struct\s+([A-Za-z_][\w]*)/g)].map((x) => x[1]))]
      .filter((s) => !/^(VarysStruct|Varyings|Output|object|render|tint_|Node)/.test(s));
    await writeFile(join(outDir, `${id}.${kind}`), m.code);
    files.push({ id, code: m.code });
    index.push(`${id}  ${(m.code.length / 1024).toFixed(1)}k  structs=[${structs.join(' ')}]`);
  }
}
await writeFile(join(outDir, 'index.txt'), index.join('\n') + '\n');

console.log(index.join('\n'));
console.log(`[dumpshaders] ${files.length} dumps -> ${outDir}`);
if (grep) {
  const hits = files.filter((f) => f.code.includes(grep)).map((f) => f.id);
  console.log(`[dumpshaders] "${grep}" found in: ${hits.join(', ') || '(none)'}`);
}
