import assert from 'node:assert/strict';
import { launch } from 'puppeteer-core';
import { fitBrowserViewport } from './lib/browser-viewport.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

// Synthetic packets exercise the real Play workflow; these are directional
// invariants, not measured outdoor flight calibration or an FPS acceptance run.
const directory = await mkdtemp('/tmp/play-conditions-');
const profile = await mkdtemp('/tmp/play-conditions-chrome-');
const errors = [], shots = [];
console.log(`Evidence: ${directory}`);
const browser = await launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false, userDataDir: profile, defaultViewport: null,
  args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--window-position=8,40', '--window-size=960,640'],
});
try {
  const page = await browser.newPage();
  await fitBrowserViewport(page, 1920, 1080, { benchmark: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await page.goto(new URL('/play.html?course=current&start=1', process.env.VIEWER_URL || 'http://127.0.0.1:4173').href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.golfBootstrap?.ready && window.golf, { timeout: 180000 });
  const identity = await page.evaluate(() => {
    const g = window.golf;
    g.ball.on('carry', (event, ball) => { window.conditionShot.carry = { ...event, position: ball.position.toArray() }; });
    g.ball.on('rest', event => { window.conditionShot.rest = event; });
    return { url: location.href, title: document.title, ready: window.golfBootstrap.ready,
      webgpu: g.sm.renderer.backend.isWebGPUBackend, scene: g.range.sceneKind,
      holeId: g.play.snapshot().holeId, windLabel: document.body.textContent.includes('Wind toward') };
  });
  assert.equal(identity.webgpu, true); assert.equal(identity.scene, 'play'); assert.equal(identity.windLabel, true);
  const cases = [
    { name: 'calm', speed: 0, direction: 0 },
    { name: 'tailwind', speed: 15, direction: 0 },
    { name: 'headwind', speed: 15, direction: 180 },
    { name: 'cross-right', speed: 15, direction: 90 },
    { name: 'cross-left', speed: 15, direction: 270 },
    { name: 'curve-right', speed: 0, direction: 0, spinAxis: 17 },
    { name: 'curve-left', speed: 0, direction: 0, spinAxis: -17 },
    { name: 'high-loft', speed: 0, direction: 0, ballSpeed: 80, launchAngle: 35, spinRate: 8000 },
  ];
  for (const entry of cases) {
    const submitted = await page.evaluate(({ entry, holeId }) => {
      const g = window.golf;
      g.selectHole(holeId);
      g.panel.setEnv({ windSpeed: entry.speed, windDir: entry.direction }, { notify: true });
      g.aim.setTarget({ x: g.ball.cup.x, z: g.ball.cup.z });
      window.conditionShot = { origin: g.ball.position.toArray(), aim: g.aim.getState(), conditions: g.panel.getEnv() };
      const result = g.launchMonitor.submit({ ballSpeed: entry.ballSpeed ?? 150,
        launchAngle: entry.launchAngle ?? 12, launchDirection: 0,
        spinRate: entry.spinRate ?? 2700, spinAxis: entry.spinAxis ?? 0, timestamp: Date.now() });
      return { result, origin: window.conditionShot.origin };
    }, { entry, holeId: identity.holeId });
    assert.equal(submitted.result.accepted, true);
    await page.waitForFunction(() => !!window.conditionShot?.rest, { timeout: 90000 });
    const result = await page.evaluate(() => ({ ...window.conditionShot,
      play: window.golf.play.snapshot(), position: window.golf.ball.position.toArray(),
      carryHUD: document.querySelector('#gs-result-carry')?.textContent,
      resolution: [window.golf.sm.renderer.domElement.width, window.golf.sm.renderer.domElement.height] }));
    assert.ok(result.carry && result.rest);
    assert.equal(result.play.strokes, 1);
    assert.deepEqual(result.resolution, [1920, 1080]);
    assert.equal(result.carryHUD, result.rest.carryYards.toFixed(1));
    assert.ok(result.position.every(Number.isFinite));
    const shot = { entry, submitted, result };
    shots.push(shot);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-shot-view="results"]')).opacity === '1');
    await page.screenshot({ path: `${directory}/${entry.name}.png` });
    if (entry.name === 'cross-right' || entry.name === 'curve-right') {
      assert.equal(result.rest.surface, entry.name === 'cross-right' ? 'rough' : 'deepRough');
      const followup = await page.evaluate(() => {
        const g = window.golf;
        g.panel.setEnv({ windSpeed: 0 }, { notify: true });
        g.aim.setTarget({ x: g.ball.cup.x, z: g.ball.cup.z });
        window.conditionShot = { origin: g.ball.position.toArray(), aim: g.aim.getState() };
        const accepted = g.launchMonitor.submit({ ballSpeed: 65, launchAngle: 30,
          launchDirection: 0, spinRate: 6000, spinAxis: 0, timestamp: Date.now() });
        return { accepted, origin: window.conditionShot.origin, launchStart: g.ball.start.toArray() };
      });
      assert.equal(followup.accepted.accepted, true);
      assert.deepEqual(followup.origin, result.position);
      assert.deepEqual(followup.launchStart, result.position);
      await page.waitForFunction(() => !!window.conditionShot?.rest, { timeout: 90000 });
      followup.result = await page.evaluate(() => ({ ...window.conditionShot,
        play: window.golf.play.snapshot(), position: window.golf.ball.position.toArray(),
        carryHUD: document.querySelector('#gs-result-carry')?.textContent }));
      assert.equal(followup.result.play.strokes, 2);
      assert.equal(followup.result.carryHUD, followup.result.rest.carryYards.toFixed(1));
      assert.ok(followup.result.position.every(Number.isFinite));
      shot.followup = followup;
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-shot-view="results"]')).opacity === '1');
      await page.screenshot({ path: `${directory}/${entry.name}-followup.png` });
    }
    await writeFile(`${directory}/report.json`, JSON.stringify({ identity, shots, errors }, null, 2));
    console.log(JSON.stringify({ name: entry.name, carry: result.rest.carryYards, offline: result.rest.offlineYards, surface: result.rest.surface }));
  }
  const byName = Object.fromEntries(shots.map(shot => [shot.entry.name, shot.result]));
  assert.ok(byName.tailwind.rest.carryYards > byName.calm.rest.carryYards);
  assert.ok(byName.headwind.rest.carryYards < byName.calm.rest.carryYards);
  assert.ok(byName['cross-right'].rest.offlineYards > byName.calm.rest.offlineYards + 5);
  assert.ok(byName['cross-left'].rest.offlineYards < byName.calm.rest.offlineYards - 5);
  assert.ok(byName['curve-right'].rest.offlineYards > 5);
  assert.ok(byName['curve-left'].rest.offlineYards < -5);
  assert.ok(byName['high-loft'].rest.carryYards < byName.calm.rest.carryYards);
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify({ identity, shots, invariantsPassed: true, errors }, null, 2));
} finally {
  await browser.close(); await rm(profile, { recursive: true, force: true });
}
