import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { validateAudioManifest, groupAudioAssets } from '../src/audio/AudioManifest.js';
import {
  AUDIO_SETTINGS_STORAGE_KEY,
  DEFAULT_AUDIO_SETTINGS,
  GolfAudio,
  audioVariation,
  classifyClubSound,
  classifyStrikeSound,
  classifySurfaceSound,
  loadAudioSettings,
  nearestMarineAnchor,
  selectAudioVariant,
} from '../src/audio/GolfAudio.js';
import { Ball } from '../src/physics/Ball.js';
import { makeEnv } from '../src/physics/ballistics.js';

const manifestUrl = new URL('../public/assets/audio/manifest.json', import.meta.url);
const manifest = validateAudioManifest(JSON.parse(await readFile(manifestUrl, 'utf8')));

test('audio manifest is CC0-only and every mastered recording matches its pinned hash', async () => {
  assert.equal(manifest.licensePolicy, 'CC0-1.0');
  assert.equal(manifest.sampleRate, 48000);
  assert.ok(manifest.sources.every((source) => source.license === 'CC0-1.0'));
  assert.ok(manifest.assets.length >= 35);
  for (const asset of manifest.assets) {
    const bytes = await readFile(new URL(`../public/assets/audio/${asset.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.file);
  }
});

test('recording groups cover ambience, club families, terrain, water, roll, and flag wind', () => {
  const groups = groupAudioAssets(manifest);
  for (const required of [
    'ambience.maritime', 'ambience.alpine', 'ambience.wind', 'ambience.rain', 'ambience.surf',
    'strike.wood', 'strike.iron', 'strike.wedge', 'strike.putter', 'strike.neutral',
    'impact.shortTurf', 'impact.longGrass', 'impact.sand', 'impact.hard',
    'roll.shortTurf', 'roll.longGrass', 'roll.sand', 'roll.hard',
    'water.splash', 'water.skip', 'cup.drop', 'flag.low', 'flag.medium', 'flag.high',
  ]) assert.ok(groups.has(required), required);
  assert.ok(groups.get('strike.wood').length >= 3);
  assert.ok(groups.get('strike.iron').length >= 3);
});

test('cup completion queues its recording at the physical ball position', () => {
  const audio = Object.create(GolfAudio.prototype);
  Object.assign(audio, { eventCounts: { holed: 0 }, _eventSequence: 0,
    unlocked: false, _pendingEvents: [] });
  const position = new Vector3(12, -0.1, 30);
  audio.handleHoled({ position });
  position.set(0, 0, 0);
  assert.equal(audio.eventCounts.holed, 1);
  assert.equal(audio._pendingEvents.length, 1);
  assert.equal(audio._pendingEvents[0].group, 'cup.drop');
  assert.deepEqual(audio._pendingEvents[0].position.toArray(), [12, -0.1, 30]);
});

test('audio classification and deterministic variant selection do not change physics inputs', () => {
  assert.equal(classifyClubSound('Driver (tour)'), 'wood');
  assert.equal(classifyClubSound('7-iron'), 'iron');
  assert.equal(classifyClubSound('Pitching wedge'), 'wedge');
  assert.equal(classifyClubSound('Putter'), 'putter');
  assert.equal(classifyClubSound(undefined), 'neutral');
  assert.equal(classifySurfaceSound('green'), 'shortTurf');
  assert.equal(classifySurfaceSound('deepRough'), 'longGrass');
  assert.equal(classifySurfaceSound('cartpath'), 'hard');
  assert.equal(selectAudioVariant(3, 81234), selectAudioVariant(3, 81234));
  assert.ok(selectAudioVariant(3, 81234) < 3);
  assert.equal(audioVariation(991, 2), audioVariation(991, 2));
  assert.notEqual(audioVariation(991, 2), audioVariation(992, 2));
  assert.ok(audioVariation(991, 2) >= -1 && audioVariation(991, 2) <= 1);
  assert.throws(() => selectAudioVariant(0, 1), /positive/);
});

test('strike family follows measured speed and launch data without requiring a club selection', () => {
  assert.equal(classifyStrikeSound({
    ballSpeed: 167, clubSpeed: 113, launchAngle: 10.9, spinRate: 2686, club: '7-iron',
  }), 'wood', 'measurements must override stale or absent labels');
  assert.equal(classifyStrikeSound({
    ballSpeed: 112, clubSpeed: 88, launchAngle: 14, spinRate: 3400,
  }), 'wood', 'club speed disambiguates a slower driver swing');
  assert.equal(classifyStrikeSound({
    ballSpeed: 132, clubSpeed: 94, launchAngle: 14.3, spinRate: 5361,
  }), 'iron');
  assert.equal(classifyStrikeSound({
    ballSpeed: 108, clubSpeed: 84, launchAngle: 20.4, spinRate: 8647,
  }), 'iron');
  assert.equal(classifyStrikeSound({
    ballSpeed: 102, clubSpeed: 80, launchAngle: 24.2, spinRate: 9304,
  }), 'wedge');
  assert.equal(classifyStrikeSound({
    ballSpeed: 12, clubSpeed: 8, launchAngle: 2, spinRate: 600,
  }), 'putter');
  assert.equal(classifyStrikeSound({ ballSpeed: 10, launchAngle: 1, spinRate: 400 }), 'putter');
  assert.equal(classifyStrikeSound({ club: 'Pitching wedge' }), 'wedge', 'label is a last-resort fallback');
});

test('audio preferences are versioned, bounded, and recover from invalid storage', () => {
  const values = new Map([[AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify({ muted: true, master: 2, ambience: -1, effects: 0.4 })]]);
  assert.deepEqual(loadAudioSettings({ getItem: (key) => values.get(key) }), {
    muted: true, master: 1, ambience: 0, effects: 0.4,
  });
  assert.deepEqual(loadAudioSettings({ getItem: () => '{broken' }), { ...DEFAULT_AUDIO_SETTINGS });
});

test('marine ambience anchor follows the nearest authored shoreline side', () => {
  const course = {
    bounds: { minX: -100, maxX: 100, minZ: -300, maxZ: 50 },
    biomeTransitions: [{
      to: 'marine-ocean',
      boundary: { kind: 'course-edge', sides: ['min-x', 'max-z'] },
    }],
  };
  assert.deepEqual(nearestMarineAnchor(course, { x: -80, z: -40 }), { x: -100, y: 0, z: -40 });
  assert.deepEqual(nearestMarineAnchor(course, { x: 60, z: 45 }), { x: 60, y: 0, z: 50 });
});

test('rolling contact telemetry is bounded to one event per presented update', () => {
  const terrain = {
    heightAt: () => 0,
    normalAt: () => new Vector3(0, 1, 0),
    surfaceAt: () => 'green',
    waterHeightAt: () => null,
  };
  const env = makeEnv({ sampleWind: (_position, _time, out) => out.set(0, 0, 0) });
  const ball = new Ball(terrain, env);
  ball.placeAt(0, 0);
  ball.state = 'rolling';
  ball.velocity.set(3, 0, 0);
  const contacts = [];
  ball.on('groundContact', (event) => contacts.push(event));
  ball.update(1 / 60);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].surface, 'green');
  assert.ok(contacts[0].speed > 0);
  assert.ok(contacts[0].position instanceof Vector3);
  ball.update(1 / 30);
  assert.equal(contacts.length, 2);
});

test('ball launch forwards measured strike telemetry to audio classification', () => {
  const terrain = {
    heightAt: () => 0,
    normalAt: () => new Vector3(0, 1, 0),
    surfaceAt: () => 'tee',
    waterHeightAt: () => null,
  };
  const env = makeEnv({ sampleWind: (_position, _time, out) => out.set(0, 0, 0) });
  const ball = new Ball(terrain, env);
  ball.placeAt(0, 0);
  let launch;
  ball.on('launch', (event) => { launch = event; });
  ball.launch({
    ballSpeed: 133,
    clubSpeed: 93,
    launchAngle: 12.5,
    azimuth: 0,
    spinRate: 3200,
    spinAxis: 3,
  });
  assert.equal(launch.ballSpeed, 133);
  assert.equal(launch.clubSpeed, 93);
  assert.equal(launch.launchAngle, 12.5);
  assert.equal(launch.spinRate, 3200);
  assert.equal(classifyStrikeSound(launch), 'wood');
});

test('production entrypoint owns audio lifecycle, event wiring, and camera-final listener update', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /new GolfAudio\(\{ camera: sm\.camera, contextFactory: bootstrapAudioContext\.contextFactory \}\)/);
  assert.ok(source.indexOf('prepareGolfAudioContext();') < source.indexOf('new LoadingGreen('));
  assert.ok(source.indexOf('audio = new GolfAudio(') > source.indexOf('await range.assetsReady;'));
  assert.match(source, /function showFatalEnvironmentError\(error\) \{\s*bootstrapAudioContext\?\.dispose\(\)/);
  assert.match(source, /new AudioSettings\(audio\)/);
  assert.match(source, /b\.on\('launch', \(event\) => \{[^}]*audio\?\.handleLaunch\(event\)/);
  assert.match(source, /b\.on\('holed', \(event\) => audio\?\.handleHoled\(event\)\)/);
  assert.match(source, /b\.on\('groundContact', \(event\) => audio\?\.handleGroundContact\(event\)\)/);
  const cameraUpdate = source.indexOf('else director.update(dt, ball)');
  const listenerUpdate = source.indexOf('audio.update(dt', cameraUpdate);
  assert.ok(listenerUpdate > cameraUpdate, 'audio listener must consume the final frame camera pose');
  assert.match(source, /audio: audioApi/);
});
