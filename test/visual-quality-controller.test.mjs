import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_QUALITY_MODE_PROFILES,
  VISUAL_QUALITY_STORAGE_KEY,
  VisualQualityController,
} from '../src/scene/VisualQualityController.js';

const MiB = 1024 * 1024;
const highLimits = (overrides = {}) => ({
  maxStorageBufferBindingSize: 128 * MiB,
  maxBufferSize: 256 * MiB,
  maxTextureDimension2D: 8192,
  maxStorageBuffersPerShaderStage: 8,
  maxComputeWorkgroupsPerDimension: 65535,
  ...overrides,
});

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key) ?? null; },
  };
};

test('profiles preserve native scene resolution and expose the two frame budgets', () => {
  assert.deepEqual(Object.keys(VISUAL_QUALITY_MODE_PROFILES), ['battery', 'balanced', 'quality', 'ultra']);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.battery.targetMs, 33.3);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.balanced.targetMs, 33.3);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.quality.targetMs, 33.3);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.ultra.targetMs, 16.7);

  for (const profile of Object.values(VISUAL_QUALITY_MODE_PROFILES)) {
    assert.deepEqual(profile.renderScale, { min: 1, max: 1, initial: 1 });
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.renderScale));
  }
});

test('auto mode uses the capability-derived start and explicit modes remain selectable', () => {
  const ultra = new VisualQualityController({
    limits: highLimits(),
    hardwareConcurrency: 12,
    deviceMemoryGiB: 32,
    persist: false,
  });
  assert.equal(ultra.mode, 'auto');
  assert.equal(ultra.activeMode, 'ultra');
  assert.equal(ultra.snapshot().targetMs, 33.3);

  const conservative = new VisualQualityController({
    tier: 'conservative',
    persist: false,
  });
  assert.equal(conservative.activeMode, 'battery');
  assert.equal(conservative.snapshot().targetMs, 33.3);

  const selected = conservative.setMode('quality', { persist: false });
  assert.equal(selected.mode, 'quality');
  assert.equal(selected.activeMode, 'quality');
  assert.equal(selected.renderScale, VISUAL_QUALITY_MODE_PROFILES.quality.renderScale.initial);
});

test('EWMA ingests GPU and frame samples and uses the slower signal as pressure', () => {
  const controller = new VisualQualityController({
    mode: 'ultra',
    ewmaAlpha: 0.5,
    persist: false,
  });

  controller.ingestSample({ gpuMs: 10, frameMs: 12 }, 0);
  const second = controller.ingestSample({ gpuMs: 20, frameMs: 20 }, 16.7);
  assert.equal(second.gpuMs, 15);
  assert.equal(second.frameMs, 16);
  assert.equal(second.pressureMs, 16);
  assert.equal(second.ewma.pressureMs, 16);
  assert.equal(second.sampleCount, 2);

  const ignored = controller.ingestSample({ gpuMs: -1, frameMs: Number.NaN }, 33.4);
  assert.equal(ignored.sampleCount, 2);
});

test('manual mode selection starts a fresh pressure observation window', () => {
  const controller = new VisualQualityController({
    mode: 'quality', ewmaAlpha: 1, persist: false,
  });
  controller.ingestSample({ gpuMs: 48, frameMs: 52 }, 100);
  const before = controller.snapshot();
  assert.equal(before.pressureMs, 52);
  assert.equal(before.sampleCount, 1);

  const reset = controller.setMode('quality', { persist: false, resetScale: true });
  assert.equal(reset.gpuMs, null);
  assert.equal(reset.frameMs, null);
  assert.equal(reset.pressureMs, null);
  assert.equal(reset.lastSampleAt, null);
  assert.equal(reset.sampleCount, 1, 'cumulative diagnostics remain monotonic');

  const fresh = controller.ingestSample({ frameMs: 14 }, 200);
  assert.equal(fresh.pressureMs, 14);
  assert.equal(fresh.sampleCount, 2);
});

test('fixed quality mode stays native under overload', () => {
  const controller = new VisualQualityController({
    mode: 'quality',
    renderScale: 1,
    ewmaAlpha: 1,
    degradeAfterSamples: 3,
    cooldownMs: 1000,
    persist: false,
  });

  controller.ingestSample({ frameMs: 40 }, 0);
  controller.ingestSample({ frameMs: 40 }, 10);
  const firstChange = controller.ingestSample({ frameMs: 40 }, 20);
  assert.equal(firstChange.activeMode, 'quality');
  assert.equal(firstChange.renderScale, 1);
  assert.equal(firstChange.lastAdaptation.kind, 'bounded');

  const duringCooldown = controller.ingestSample({ frameMs: 40 }, 500);
  assert.equal(duringCooldown.renderScale, 1);
  controller.ingestSample({ frameMs: 40 }, 1020);
  const afterCooldown = controller.ingestSample({ frameMs: 40 }, 1030);
  assert.equal(afterCooldown.renderScale, 1);
  assert.equal(afterCooldown.lastAdaptation.direction, 'down');
});

test('fixed balanced mode stays native under sustained headroom', () => {
  const controller = new VisualQualityController({
    mode: 'balanced',
    renderScale: 1,
    ewmaAlpha: 1,
    upgradeAfterSamples: 3,
    cooldownMs: 1000,
    persist: false,
  });

  controller.ingestSample({ gpuMs: 10 }, 0);
  controller.ingestSample({ gpuMs: 10 }, 10);
  const firstChange = controller.ingestSample({ gpuMs: 10 }, 20);
  assert.equal(firstChange.renderScale, 1);
  assert.equal(firstChange.lastAdaptation.kind, 'bounded');

  controller.ingestSample({ gpuMs: 10 }, 30);
  controller.ingestSample({ gpuMs: 10 }, 40);
  const afterCooldown = controller.ingestSample({ gpuMs: 10 }, 1020);
  assert.equal(afterCooldown.renderScale, 1);
});

function observe(controller, from, to, metrics) {
  for (let atMs = from; atMs <= to; atMs += 20) controller.ingestSample(metrics, atMs);
  return controller.snapshot();
}

test('Auto keeps 30 fps across tiers and demotes after two complete overloaded windows', () => {
  const controller = new VisualQualityController({ limits: highLimits(), hardwareConcurrency: 12, deviceMemoryGiB: 32, persist: false });
  assert.equal(observe(controller, 0, 2000, { frameMs: 40 }).activeMode, 'ultra');
  const changed = observe(controller, 2020, 4000, { frameMs: 40 });
  assert.equal(changed.activeMode, 'quality'); assert.equal(changed.targetMs, 33.3);
  assert.equal(changed.renderScale, 1); assert.equal(changed.lastAdaptation.reason, 'performance');
  assert.equal(controller.setMode('ultra').targetMs, 16.7, 'manual Ultra retains its explicit target');
});

test('Auto catches sustained small target misses and ignores loading windows', () => {
  const controller = new VisualQualityController({ tier: 'high', hardwareConcurrency: 6, persist: false });
  observe(controller, 0, 2000, { frameMs: 33.45 });
  controller.ingestSample({ eligible: false });
  assert.equal(observe(controller, 4000, 6000, { frameMs: 33.45 }).activeMode, 'balanced');
  assert.equal(observe(controller, 6020, 8000, { frameMs: 33.45 }).activeMode, 'battery');
});

test('Auto requires ten seconds of headroom, trials promotion, and delays failed retries', () => {
  const controller = new VisualQualityController({ limits: highLimits(), hardwareConcurrency: 12, deviceMemoryGiB: 32, persist: false });
  observe(controller, 0, 4000, { frameMs: 40, gpuMs: 38, cpuMs: 8 });
  assert.equal(observe(controller, 4020, 13980, { frameMs: 20, gpuMs: 20, cpuMs: 8 }).activeMode, 'quality');
  const trial = observe(controller, 14000, 14000, { frameMs: 20, gpuMs: 20, cpuMs: 8 });
  assert.equal(trial.activeMode, 'ultra'); assert.ok(trial.promotionTrial);
  const failed = observe(controller, 14020, 16000, { frameMs: 40, gpuMs: 38, cpuMs: 8 });
  assert.equal(failed.activeMode, 'quality'); assert.equal(failed.lastAdaptation.reason, 'promotion-trial-failed');
  assert.equal(failed.promotionRetryAfter, 46000);
  assert.equal(observe(controller, 16020, 44000, { frameMs: 20, gpuMs: 20, cpuMs: 8 }).activeMode, 'quality');
  assert.equal(observe(controller, 44020, 46000, { frameMs: 20, gpuMs: 20, cpuMs: 8 }).activeMode, 'ultra');
  const accepted = observe(controller, 46020, 52000, { frameMs: 20, gpuMs: 20, cpuMs: 8 });
  assert.equal(accepted.activeMode, 'ultra'); assert.equal(accepted.promotionTrial, null);
});

test('Auto respects hardware ceiling and CPU bottlenecks', () => {
  const controller = new VisualQualityController({ tier: 'high', hardwareConcurrency: 6, persist: false });
  assert.equal(controller.activeMode, 'balanced');
  assert.equal(observe(controller, 0, 12000, { frameMs: 8, gpuMs: 6, cpuMs: 4 }).activeMode, 'quality');
  const limited = observe(controller, 12020, 16000, { frameMs: 40, gpuMs: 8, cpuMs: 38 });
  assert.equal(limited.activeMode, 'balanced'); assert.equal(limited.observation.limitingWork, 'cpu');
});

test('mode persistence is versioned and browser storage is optional', () => {
  const storage = memoryStorage();
  const first = new VisualQualityController({ storage, persist: true, tier: 'balanced' });
  first.setMode('battery');
  assert.equal(storage.value(VISUAL_QUALITY_STORAGE_KEY), JSON.stringify({ version: 1, mode: 'battery' }));

  const restored = new VisualQualityController({ storage, tier: 'balanced' });
  assert.equal(restored.mode, 'battery');
  assert.equal(restored.activeMode, 'battery');

  // This is intentionally a normal Node construction: no window/localStorage
  // shim is required for the production default.
  const nodeSafe = new VisualQualityController({ tier: 'balanced' });
  assert.equal(nodeSafe.snapshot().persistenceAvailable, false);
});

test('invalid inputs are rejected without allowing an unbounded scale', () => {
  assert.throws(() => new VisualQualityController({ mode: 'cinematic' }), /Unknown visual quality mode/);
  const controller = new VisualQualityController({ mode: 'battery', persist: false });
  assert.equal(controller.setRenderScale(99).renderScale, 1);
  assert.equal(controller.setRenderScale(-1).renderScale, 1);
  assert.throws(() => controller.setRenderScale(Number.NaN), /finite/);
});

test('presentation lock freezes one fixed mode and scale under frame pressure', () => {
  const controller = new VisualQualityController({
    mode: 'auto',
    tier: 'high',
    ewmaAlpha: 1,
    degradeAfterSamples: 1,
    cooldownMs: 0,
    persist: false,
  });
  const before = controller.snapshot();
  const locked = controller.acquirePresentationLock({ mode: 'quality', renderScale: 0.9 });

  assert.deepEqual(locked.presentationLock, {
    active: true,
    id: 'presentation-1',
    mode: 'quality',
    renderScale: 1,
  });
  assert.equal(locked.mode, 'quality');
  assert.equal(locked.activeMode, 'quality');
  assert.equal(locked.renderScale, 1);

  for (let sample = 0; sample < 100; sample += 1) {
    controller.ingestSample({ frameMs: 200 }, sample * 200);
  }
  const pressured = controller.snapshot();
  assert.equal(pressured.renderScale, 1);
  assert.equal(pressured.activeMode, 'quality');
  assert.equal(pressured.sampleCount, before.sampleCount,
    'capture samples must not perturb the live estimator that will be restored');
  assert.throws(() => controller.setMode('battery'), /presentation lock/);
  assert.throws(() => controller.setRenderScale(0.7), /presentation lock/);
});

test('presentation lock is token-scoped and restores the complete prior policy state', () => {
  const controller = new VisualQualityController({
    mode: 'auto', tier: 'high', ewmaAlpha: 1, persist: false,
  });
  controller.ingestSample({ gpuMs: 21, frameMs: 24 }, 100);
  const before = controller.snapshot();
  const locked = controller.acquirePresentationLock({ mode: 'ultra', renderScale: 1 });

  assert.throws(() => controller.acquirePresentationLock(), /already locked/);
  assert.throws(() => controller.releasePresentationLock('presentation-wrong'), /does not match/);
  assert.equal(controller.snapshot().presentationLock.id, locked.presentationLock.id);

  const restored = controller.releasePresentationLock(locked.presentationLock);
  assert.equal(restored.presentationLock, null);
  for (const key of [
    'mode', 'activeMode', 'renderScale', 'gpuMs', 'frameMs', 'pressureMs',
    'sampleCount', 'highPressureSamples', 'lowPressureSamples', 'lastSampleAt',
    'lastAdaptationAt', 'adaptationCount',
  ]) {
    assert.deepEqual(restored[key], before[key], `restored ${key}`);
  }
  assert.deepEqual(restored.lastAdaptation, before.lastAdaptation);
  assert.throws(() => controller.releasePresentationLock(locked.presentationLock.id), /not locked/);
});

test('presentation lock rejects adaptive mode and clamps scale through the selected profile', () => {
  const controller = new VisualQualityController({ mode: 'quality', persist: false });
  assert.throws(() => controller.acquirePresentationLock({ mode: 'auto' }), /fixed visual quality mode/);
  const locked = controller.acquirePresentationLock({ mode: 'battery', renderScale: 99 });
  assert.equal(locked.renderScale, VISUAL_QUALITY_MODE_PROFILES.battery.renderScale.max);
});
