import assert from 'node:assert/strict';
import { launch } from 'puppeteer-core';
import { fitBrowserViewport } from './lib/browser-viewport.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

// Offset authored pins through the normal preview/rebuild path. No terrain,
// ball state or rendered object is substituted by this verification harness.
const directory = await mkdtemp('/tmp/play-pins-');
const profile = await mkdtemp('/tmp/play-pins-chrome-');
const errors = [], placements = [];
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
  const raw = await page.evaluate(async () => {
    const response = await fetch('/course.json');
    if (!response.ok) throw Error('Course request failed');
    return response.json();
  });
  const snapshot = () => page.evaluate(async () => {
    const g = window.golf, t = g.range.terrain, green = g.range.targets[0];
    const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
    const pole = g.range.group.children.find(child => child.geometry?.name === 'premium-hardwood-flagstick-12-15mm');
    return { url: location.href, ready: window.golfBootstrap.ready,
      webgpu: g.sm.renderer.backend.isWebGPUBackend, scene: g.range.sceneKind,
      green, heightHash: await hash(t.heights), surfaceHash: await hash(t._growableData),
      cup: g.ball.cup, cupMesh: g.range.playCup.position.toArray(),
      cutout: t.activeCup.value.toArray(), pole: Array.from(pole.instanceMatrix.array.slice(12, 15)),
      flag: g.range.flagCloth.anchors[0], aim: g.minimap.shotPlan.at(-1),
      pinHeight: t.heightAt(g.ball.cup.x, g.ball.cup.z), surface: t.surfaceAt(g.ball.cup.x, g.ball.cup.z),
      resolution: [g.sm.renderer.domElement.width, g.sm.renderer.domElement.height] };
  });
  const baseline = await snapshot();
  assert.equal(baseline.webgpu, true); assert.equal(baseline.scene, 'play');
  for (const [dx, dz] of [[3, -2], [-3, 3]]) {
    const course = structuredClone(raw);
    const pin = { x: course.greens[0].x + dx, z: course.greens[0].z + dz };
    course.greens[0].pin = pin;
    await page.evaluate(course => window.golf.previewCourse(course), course);
    const result = await snapshot();
    await writeFile(`${directory}/report.json`, JSON.stringify({ baseline, placements: [...placements, result], errors }, null, 2));
    assert.equal(result.ready, true); assert.equal(result.webgpu, true);
    assert.equal(result.scene, 'play'); assert.equal(result.surface, 'green');
    assert.equal(result.heightHash, baseline.heightHash);
    assert.equal(result.surfaceHash, baseline.surfaceHash);
    assert.deepEqual(result.resolution, [1920, 1080]);
    assert.equal(result.cup.x, pin.x); assert.equal(result.cup.z, pin.z);
    assert.equal(result.cup.y, result.pinHeight);
    assert.deepEqual(result.cupMesh, [pin.x, result.pinHeight, pin.z]);
    assert.deepEqual(result.cutout, [pin.x, result.cup.radius, pin.z]);
    assert.deepEqual(result.aim, { ...pin, role: 'green' });
    assert.equal(result.flag.x, pin.x); assert.equal(result.flag.z, pin.z);
    assert.ok(Math.abs(result.pole[0] - pin.x) < 1e-5 && Math.abs(result.pole[2] - pin.z) < 1e-5);
    assert.ok(Math.abs(result.pole[1] - result.pinHeight - 1.16) < 1e-5);
    await page.evaluate(async () => {
      const g = window.golf, c = g.ball.cup;
      g.evaluatorCamera.enter();
      g.evaluatorCamera.setPose({ position: [c.x + .45, c.y + .5, c.z + .45], lookAt: [c.x, c.y - .04, c.z], fov: 42 });
      await g.evaluatorCamera.waitForFrames(30);
    });
    await page.screenshot({ path: `${directory}/pin-${placements.length + 1}.png` });
    result.launch = await page.evaluate(pin => {
      const g = window.golf;
      g.evaluatorCamera.restore();
      g.aim.setTarget(pin);
      return g.launchMonitor.submit({ ballSpeed: 80, launchAngle: 35,
        launchDirection: 0, spinRate: 8000, spinAxis: 0, timestamp: Date.now() });
    }, pin);
    assert.equal(result.launch.accepted, true);
    await page.waitForFunction(() => window.golf.ball.state === 'rest', { timeout: 90000 });
    result.afterShot = await page.evaluate(() => ({ play: window.golf.play.snapshot(), aim: window.golf.aim.getState() }));
    assert.equal(result.afterShot.play.strokes, 1);
    assert.deepEqual(result.afterShot.aim.target, { ...pin, role: 'green' });
    placements.push(result);
    await writeFile(`${directory}/report.json`, JSON.stringify({ baseline, placements, errors }, null, 2));
    console.log(JSON.stringify({ pin, terrainUnchanged: true, cup: result.cup }));
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify({ baseline, placements, passed: true, errors }, null, 2));
} finally {
  await browser.close(); await rm(profile, { recursive: true, force: true });
}
