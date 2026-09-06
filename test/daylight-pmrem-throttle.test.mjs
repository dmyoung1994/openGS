import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Vector4 } from 'three';
import {
  DAYLIGHT_PMREM_ATMOSPHERIC_THRESHOLD,
  DAYLIGHT_PMREM_MAX_INTERVAL_MS,
  DAYLIGHT_PMREM_SUN_ANGLE_THRESHOLD_RADIANS,
  SceneManager,
  readDaylightPmremState,
  resolveDaylightPmremUpdate,
} from '../src/scene/SceneManager.js';

function daylightEnvironment(daylightRevision, {
  angle = 0,
  atmosphere = [2.3, 1.7, 0.005, 0.76],
  sunIlluminanceScale = 1,
  sunColor = [1, 1, 1],
} = {}) {
  const direction = new Vector3(Math.sin(angle), 0.8, Math.cos(angle)).normalize();
  return {
    daylightRevision,
    sunDirection: { value: direction },
    sunIlluminanceScale: { value: sunIlluminanceScale },
    sunColor: { value: new Vector3(...sunColor) },
    atmosphereExposure: { value: 1 },
    atmosphere: { value: new Vector4(...atmosphere) },
    horizonColor: { value: new Vector3(0.29, 0.48, 0.78) },
    zenithColor: { value: new Vector3(0.004, 0.052, 0.62) },
  };
}

function testManager(clock) {
  const calls = [];
  const manager = Object.create(SceneManager.prototype);
  manager.renderer = { toneMappingExposure: 1 };
  manager.camera = { position: { y: 2 } };
  manager.scene = {
    fog: { color: { setRGB() {} }, density: 0 },
    environmentIntensity: 0,
  };
  manager._environmentBindings = null;
  manager._sceneDaylightRevision = -1;
  manager._daylightPmremRevision = -1;
  manager._daylightPmremLastCaptureAt = null;
  manager._daylightPmremLastCaptureState = null;
  manager._daylightPmremLastDecision = null;
  manager._daylightPmremSuppressedUpdates = 0;
  manager._daylightPmremNow = () => clock.value;
  manager._rebuildDaylightPmrem = function rebuild({ now, reason }) {
    calls.push({ revision: this._environmentBindings.daylightRevision, now, reason });
    this._daylightPmremRevision = this._environmentBindings.daylightRevision;
    this._recordDaylightPmremCapture(this._environmentBindings, now, reason);
    return true;
  };
  return { manager, calls };
}

test('continuous daylight coalesces small timeline revisions and refreshes on the bounded interval', () => {
  const clock = { value: 0 };
  const { manager, calls } = testManager(clock);

  manager._environmentBindings = daylightEnvironment(1);
  manager._applyEnvironmentDaylight();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'initial');

  for (let revision = 2; revision <= 7; revision++) {
    clock.value = (revision - 1) * 2000;
    manager._environmentBindings = daylightEnvironment(revision, {
      angle: (revision - 1) * 0.0005,
    });
    manager._applyEnvironmentDaylight();
  }

  assert.equal(clock.value, 12_000);
  assert.equal(calls.length, 1, 'two-second daylight samples must not recapture PMREM');
  assert.equal(manager.readDaylightPmremDiagnostics().suppressedUpdates, 6);

  clock.value = DAYLIGHT_PMREM_MAX_INTERVAL_MS + 1;
  manager._environmentBindings = daylightEnvironment(8, { angle: 0.0035 });
  manager._applyEnvironmentDaylight();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].reason, 'max-interval');
  assert.equal(calls[1].now, DAYLIGHT_PMREM_MAX_INTERVAL_MS + 1);
  assert.equal(manager.readDaylightPmremDiagnostics().pending, false);
});

test('angular and atmospheric changes bypass the cadence throttle', () => {
  const clock = { value: 0 };
  const { manager, calls } = testManager(clock);

  manager._environmentBindings = daylightEnvironment(1);
  manager._applyEnvironmentDaylight();

  const angularInput = (DAYLIGHT_PMREM_SUN_ANGLE_THRESHOLD_RADIANS + 0.001) / 0.6;
  clock.value = 100;
  manager._environmentBindings = daylightEnvironment(2, {
    // The test direction is elevated, so its world-space angular response is
    // the horizontal input multiplied by roughly 0.6.
    angle: angularInput,
  });
  manager._applyEnvironmentDaylight();
  assert.equal(calls.at(-1).reason, 'sun-angle');

  clock.value = 200;
  manager._environmentBindings = daylightEnvironment(3, {
    angle: angularInput,
    atmosphere: [2.3 + DAYLIGHT_PMREM_ATMOSPHERIC_THRESHOLD * 4.1, 1.7, 0.005, 0.76],
  });
  manager._applyEnvironmentDaylight();
  assert.equal(calls.at(-1).reason, 'atmosphere');
  assert.equal(calls.length, 3);
});

test('initial and explicit rebuild requests remain forced, and policy is measurable', () => {
  const current = readDaylightPmremState(daylightEnvironment(4));
  const belowThreshold = resolveDaylightPmremUpdate({
    previous: current,
    current: readDaylightPmremState(daylightEnvironment(5, { angle: 0.001 })),
    lastCaptureAt: 0,
    now: 2000,
  });
  assert.equal(belowThreshold.shouldRebuild, false);

  const initial = resolveDaylightPmremUpdate({ current, now: 0 });
  assert.equal(initial.shouldRebuild, true);
  assert.equal(initial.reason, 'initial');

  const forced = resolveDaylightPmremUpdate({ previous: current, current, force: true });
  assert.equal(forced.shouldRebuild, true);
  assert.equal(forced.reason, 'explicit');

  const manager = Object.create(SceneManager.prototype);
  manager._daylightPmremRevision = 42;
  manager._daylightPmremNow = () => 1234;
  let request;
  manager._rebuildDaylightPmrem = (options) => { request = options; };
  manager.rebuildDaylightPmrem();
  assert.equal(manager._daylightPmremRevision, -1);
  assert.deepEqual(request, { force: true, reason: 'explicit', now: 1234 });
});


test('daylight refresh reuses the native PMREM target and keeps its texture alive', () => {
  const target = { texture: {}, dispose() { assert.fail('An active PMREM target was disposed'); } };
  const calls = [];
  const manager = Object.assign(Object.create(SceneManager.prototype), {
    renderer: { isWebGPURenderer: true, _background: new Map() },
    scene: { environmentRotation: { set() {} } }, weatherSky: { iblBackgroundNode: {} },
    _environmentBindings: daylightEnvironment(1), _daylightPmremTarget: null,
    _pmremGenerator: { fromScene(_scene, _sigma, _near, _far, options) {
      calls.push(options.renderTarget); return options.renderTarget ?? target;
    } },
  });
  for (const revision of [1, 2, 3]) {
    manager._environmentBindings.daylightRevision = revision;
    assert.equal(manager._rebuildDaylightPmrem({ now: revision * 1000 }), true);
    assert.equal(manager.scene.environment, target.texture);
  }
  assert.deepEqual(calls, [null, target, target]);
});
