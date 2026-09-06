import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CANONICAL_LAUNCH_UNITS,
  LAUNCH_MONITOR_STATES,
  LaunchMonitorAdapter,
  createLaunchMonitorCapabilities,
  launchShotToBallParams,
  normalizeLaunchShot,
} from '../src/input/LaunchMonitorInput.js';
import {
  DEVELOPMENT_LAUNCH_PRESETS,
  DevelopmentLaunchMonitorAdapter,
} from '../src/input/DevelopmentLaunchMonitorAdapter.js';

function canonical(overrides = {}) {
  return {
    ballSpeed: 167,
    launchAngle: 10.9,
    launchDirection: -1.5,
    spinRate: 2686,
    spinAxis: -2,
    timestamp: 1_724_000_000_000,
    ...overrides,
  };
}

test('normalizes SDK units into one immutable canonical shot contract', () => {
  const shot = normalizeLaunchShot({
    ballSpeed: 74.657,
    launchAngle: 0.2,
    launchDirection: -0.03,
    spinRate: 281.277,
    spinAxis: -0.04,
    timestamp: 1_724_000_000,
    optional: { clubSpeed: 50.515, clubLabel: ' Driver ', deviceShotId: ' sdk-42 ' },
  }, { units: {
    ballSpeed: 'm/s',
    clubSpeed: 'm/s',
    launchAngle: 'rad',
    launchDirection: 'rad',
    spinRate: 'rad/s',
    spinAxis: 'rad',
    timestamp: 's',
  } });

  assert.ok(Math.abs(shot.ballSpeed - 166.999) < 0.01);
  assert.ok(Math.abs(shot.optional.clubSpeed - 112.999) < 0.01);
  assert.ok(Math.abs(shot.launchAngle - 11.459) < 0.01);
  assert.ok(Math.abs(shot.launchDirection + 1.719) < 0.01);
  assert.ok(Math.abs(shot.spinRate - 2685.999) < 0.01);
  assert.ok(Math.abs(shot.spinAxis + 2.292) < 0.01);
  assert.equal(shot.timestamp, 1_724_000_000_000);
  assert.deepEqual(shot.optional, { clubSpeed: shot.optional.clubSpeed, clubLabel: 'Driver', deviceShotId: 'sdk-42' });
  assert.ok(Object.isFrozen(shot));
  assert.ok(Object.isFrozen(shot.optional));
});

test('fails closed on missing, non-finite, out-of-range, and unknown optional data', () => {
  assert.equal(normalizeLaunchShot(canonical({ ballSpeed: 0.2, launchAngle: 0, spinRate: 0 })).ballSpeed, 0.2);
  assert.throws(() => normalizeLaunchShot(canonical({ ballSpeed: 0 })), /greater than zero/);
  assert.throws(() => normalizeLaunchShot(canonical({ ballSpeed: undefined })), /ballSpeed must be a finite number/);
  assert.throws(() => normalizeLaunchShot(canonical({ spinRate: NaN })), /spinRate must be a finite number/);
  assert.throws(() => normalizeLaunchShot(canonical({ ballSpeed: 251 })), /ballSpeed must be between/);
  assert.throws(() => normalizeLaunchShot(canonical({ spinAxis: 181 })), /spinAxis must be between/);
  assert.throws(() => normalizeLaunchShot(canonical({ optional: { clubSpeed: 181 } })), /clubSpeed must be between/);
  assert.throws(() => normalizeLaunchShot(canonical({ optional: { smashFactor: 1.48 } })), /unsupported optional/);
  assert.throws(() => normalizeLaunchShot(canonical(), { units: { ballSpeed: 'knots' } }), /unsupported ballSpeed unit/);
});

test('maps canonical direction and optional measured club speed to Ball.launch exactly once', () => {
  const params = launchShotToBallParams(canonical({ optional: { clubSpeed: 91, clubLabel: '7-iron' } }));
  assert.deepEqual(params, {
    ballSpeed: 167,
    launchAngle: 10.9,
    azimuth: -1.5,
    spinRate: 2686,
    spinAxis: -2,
    clubSpeed: 91,
    club: '7-iron',
  });
  assert.ok(Object.isFrozen(params));
});

test('capability metadata reports whether a provider can drive simulation', () => {
  const complete = createLaunchMonitorCapabilities({ transport: 'usb' });
  const partial = createLaunchMonitorCapabilities({ metrics: ['ballSpeed'], transport: 'bluetooth' });
  assert.equal(complete.simulationReady, true);
  assert.equal(partial.simulationReady, false);
  assert.deepEqual(complete.units, CANONICAL_LAUNCH_UNITS);
  assert.ok(Object.isFrozen(complete.metrics));
  assert.throws(() => createLaunchMonitorCapabilities({ metrics: ['clubSpeed'] }), /unsupported metrics value/);
});

test('adapter exposes deterministic lifecycle and suppresses duplicate device shots', async () => {
  const adapter = new LaunchMonitorAdapter({
    providerId: 'sdk-test',
    capabilities: createLaunchMonitorCapabilities({ optionalMetrics: ['deviceShotId'], transport: 'test' }),
  });
  const states = [];
  const shots = [];
  adapter.subscribeState(({ state }) => states.push(state));
  adapter.subscribeShots((shot) => shots.push(shot));

  await adapter.connect();
  const source = canonical({ optional: { deviceShotId: '42' } });
  const accepted = adapter.ingest(source);
  const duplicate = adapter.ingest(source);

  assert.equal(accepted.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(shots.length, 1);
  assert.deepEqual(states, [
    LAUNCH_MONITOR_STATES.DISCONNECTED,
    LAUNCH_MONITOR_STATES.CONNECTING,
    LAUNCH_MONITOR_STATES.READY,
    LAUNCH_MONITOR_STATES.RECEIVING,
    LAUNCH_MONITOR_STATES.READY,
    LAUNCH_MONITOR_STATES.RECEIVING,
    LAUNCH_MONITOR_STATES.READY,
  ]);
  await adapter.disconnect();
  assert.equal(adapter.state, LAUNCH_MONITOR_STATES.DISCONNECTED);
});

test('invalid provider packets transition the adapter to error until reconnect', async () => {
  const adapter = new LaunchMonitorAdapter({ providerId: 'sdk-test' });
  await adapter.connect();
  assert.throws(() => adapter.ingest(canonical({ spinRate: -1 })), /spinRate must be between/);
  assert.equal(adapter.state, LAUNCH_MONITOR_STATES.ERROR);
  assert.match(adapter.snapshot().error, /spinRate/);
  assert.throws(() => adapter.ingest(canonical()), /provider is error/);
  await adapter.connect();
  assert.equal(adapter.state, LAUNCH_MONITOR_STATES.READY);
});

test('development adapter emits the existing presets through the same shot path', async () => {
  const adapter = new DevelopmentLaunchMonitorAdapter({ now: () => 1_724_000_000_000 });
  const received = [];
  adapter.subscribeShots((shot) => received.push(shot));
  await adapter.connect();

  const first = adapter.emitPreset('7-iron');
  const second = adapter.emitPreset('7-iron');
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(received.length, 2);
  assert.equal(received[0].ballSpeed, DEVELOPMENT_LAUNCH_PRESETS['7-iron'].ballSpeed);
  assert.equal(received[0].optional.clubSpeed, DEVELOPMENT_LAUNCH_PRESETS['7-iron'].clubSpeed);
  assert.equal(received[0].launchDirection, DEVELOPMENT_LAUNCH_PRESETS['7-iron'].launchDirection);
  assert.notEqual(received[0].optional.deviceShotId, received[1].optional.deviceShotId);
  assert.deepEqual(adapter.listPresets(), Object.keys(DEVELOPMENT_LAUNCH_PRESETS));
});

test('production runtime routes Lab, keyboard, and SDK input through the canonical adapter boundary', async () => {
  const [main, panel] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/MetricsPanel.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /new DevelopmentLaunchMonitorAdapter\(\)/);
  assert.match(main, /subscribeShots\(\(shot\) => hit\(launchShotToBallParams\(shot\)\)\)/);
  assert.match(main, /launchMonitor\.emitShot\(panel\.getLaunchInput\(\)\)/);
  assert.match(main, /launchMonitor: launchMonitorApi/);
  assert.match(main, /ingest: submitLaunchShot/);
  assert.match(main, /submit: submitLaunchShot/);
  assert.match(panel, /DEVELOPMENT_LAUNCH_PRESETS/);
  assert.match(panel, /getLaunchInput\(\)/);
  assert.doesNotMatch(panel, /const PRESETS =/,
    'the Lab must consume the development adapter presets instead of duplicating them');
});
