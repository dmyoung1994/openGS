import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const panel = await readFile(new URL('src/ui/MetricsPanel.js', ROOT), 'utf8');
const main = await readFile(new URL('src/main.js', ROOT), 'utf8');
const shot = await readFile(new URL('scripts/shot.mjs', ROOT), 'utf8');

test('canonical shot harness activates the authored Creator scene before posing and can profile live frames', () => {
  assert.match(shot, /const authoredCourse = game && has\('authored-course'\)/);
  assert.match(shot, /--authored-course is only valid on \/creator\.html/);
  assert.match(shot, /showAuthoredCreatorCourse/);
  assert.match(shot, /treeSourceCount/);
  assert.match(shot, /const liveGpuCapture = game && has\('gpu-live'\)/);
  assert.match(shot, /liveProductionFrames: true/);
  assert.match(shot, /evaluator\.waitForFrames\(frameCount \+ 2\)/);
  assert.match(shot, /const benchmarkPresentationMode/);
  assert.match(shot, /benchmark-presentation-lock/);
  assert.match(shot, /settled >= 8/);
  assert.match(shot, /assignment\.slice\(flag\.length \+ 1\)/,
    'camera and benchmark flags must accept --name=value as well as --name value');
  assert.match(shot, /terrain\.heightAt\(position\[0\], position\[2\]\) \+ cameraLift/);
  assert.match(shot, /const targetHoleId/);
  assert.match(shot, /window\.golf\.selectHole\(holeId\)/);
  assert.match(shot, /activeHoleId/);
  assert.match(shot, /evaluatorCamera: window\.golf\?\.evaluatorCamera\?\.getState/);
  assert.match(shot, /evaluatorCamera\.movePose/);
  assert.match(shot, /page\.metrics\(\)/);
  assert.match(shot, /taskDurationMsPerFrame/);
  assert.match(shot, /activeGpu: summarize/);
  assert.match(shot, /Performance sentinel changed during capture/);
});

test('shot presentation has explicit address, flight, and results states', () => {
  assert.match(panel, /data-shot-view="address"/);
  assert.match(panel, /data-shot-view="flight"/);
  assert.match(panel, /data-shot-view="results"/);
  assert.match(main, /panel\.beginShot\(params\)/);
  assert.match(main, /panel\.showFlight\(\{/);
  assert.match(main, /panel\.showResult\(r\)/);
  assert.match(main, /panel\.showAddress\(\)/);
});

test('results hold for ten seconds; Play retains the lie while Practice resets to the tee', () => {
  assert.match(main, /const RESULT_HOLD_MS = 10_000/);
  assert.match(main, /setTimeout\(\(\) => \{[\s\S]*?\}, RESULT_HOLD_MS\)/);
  const hit = main.slice(main.indexOf('function hit('), main.indexOf('// The course builder'));
  assert.match(hit, /clearTimeout\(_resetTimer\)/);
  assert.match(hit, /director\.phase === 'result' \|\| director\.phase === 'return'/);
  assert.match(hit, /toAddress\(\);[\s\S]*?ball\.launch\(worldParams\)/);
  assert.match(main, /if \(fromTee \|\| range\?\.sceneKind !== 'play'\) ball\.placeAt\(tee\.x, tee\.z\)/);
  assert.match(main, /range\?\.sceneKind === 'play' \? ball\.position/);
});

test('live telemetry freezes impact ball speed and swaps height for total after landing', () => {
  assert.match(panel, /this\.shotParams\?\.ballSpeed/,
    'ball speed must come from the immutable launch snapshot, not current velocity');
  assert.match(panel, /landed \? 'Total' : 'Height'/);
  assert.match(main, /const landed = ball\.carryYards > 0/);
  assert.match(main, /carryYards: landed \? ball\.carryYards : dist/);
  assert.match(main, /totalYards: dist/);
  assert.match(main, /if \(flying\) \{[\s\S]*?panel\.showFlight\(\{/,
    'a synchronous rest event must not be overwritten by stale telemetry in the same frame');
  assert.doesNotMatch(main, /speedMph: toMph\(speed\)/);
});

test('player-facing shot data is unified and does not depend on a club label', () => {
  const playerMarkup = panel.slice(
    panel.indexOf("root.innerHTML = `"),
    panel.indexOf('document.body.appendChild(root)'),
  );
  for (const label of [
    'Carry', 'Total', 'Offline', 'Ball speed', 'Launch', 'Spin', 'Spin axis',
    'Apex', 'Descent', 'Landing', 'Rollout',
  ]) assert.match(playerMarkup, new RegExp(label));
  assert.doesNotMatch(playerMarkup, /7 Iron|7-iron|Club|Measured|Simulated/i);
});

test('launch inputs live behind a separate accessible Lab control', () => {
  assert.match(panel, /id = 'gs-lab-toggle'/);
  assert.match(panel, /aria-controls', 'gs-launch-lab'/);
  assert.match(panel, /panel\.classList\.toggle\('open', open\)/);
  assert.match(panel, /Test profile/);
  assert.match(panel, /Development inputs/);
});

test('glass styling remains sparse, adaptive, responsive, and motion-safe', () => {
  assert.match(panel, /backdrop-filter: blur\(12px\) saturate\(1\.24\) brightness\(\.90\)/);
  assert.match(panel, /--shot-glass-top: rgba\(255,255,255,\.105\)/);
  assert.match(panel, /grid-template-columns: minmax\(330px,3fr\) minmax\(0,8fr\)/);
  assert.match(panel, /\.gs-result-rule \{ display: none; \}/);
  assert.doesNotMatch(panel, /min-height: 238px/);
  assert.match(panel, /@media \(max-width: 620px\)/);
  assert.match(panel, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(panel, /@media \(prefers-reduced-transparency: reduce\), \(forced-colors: active\)/);
  assert.doesNotMatch(panel, /neon|bento|Measured|Simulated/);
});

test('held results use one stable glass composite over the moving result camera', () => {
  assert.match(panel, /data-state="results"\] \[data-shot-view="flight"\][\s\S]*?transition: none/);
  assert.match(panel, /\.gs-results[\s\S]*?-webkit-backdrop-filter: none; backdrop-filter: none/);
  assert.match(panel, /linear-gradient\(180deg,rgba\(24,43,31,\.86\),rgba\(8,20,13,\.82\)\)/);
  assert.doesNotMatch(panel, /\.gs-results[^}]*blur\(16px\)/);
});
