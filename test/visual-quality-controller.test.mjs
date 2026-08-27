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

test('profiles expose bounded render scales and the two frame budgets', () => {
  assert.deepEqual(Object.keys(VISUAL_QUALITY_MODE_PROFILES), ['battery', 'balanced', 'quality', 'ultra']);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.battery.targetMs, 33.3);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.balanced.targetMs, 33.3);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.quality.targetMs, 33.3);
  assert.equal(VISUAL_QUALITY_MODE_PROFILES.ultra.targetMs, 16.7);

  for (const profile of Object.values(VISUAL_QUALITY_MODE_PROFILES)) {
    assert.ok(profile.renderScale.min > 0);
    assert.ok(profile.renderScale.min < profile.renderScale.initial);
    assert.ok(profile.renderScale.initial < profile.renderScale.max);
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
  assert.equal(ultra.snapshot().targetMs, 16.7);

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

test('overload changes resolution first, then respects the slow cooldown', () => {
  const controller = new VisualQualityController({
    mode: 'quality',
    renderScale: 0.82,
    ewmaAlpha: 1,
    degradeAfterSamples: 3,
    cooldownMs: 1000,
    persist: false,
  });

  controller.ingestSample({ frameMs: 40 }, 0);
  controller.ingestSample({ frameMs: 40 }, 10);
  const firstChange = controller.ingestSample({ frameMs: 40 }, 20);
  assert.equal(firstChange.activeMode, 'quality');
  assert.equal(firstChange.renderScale, 0.74);
  assert.equal(firstChange.lastAdaptation.kind, 'resolution');

  const duringCooldown = controller.ingestSample({ frameMs: 40 }, 500);
  assert.equal(duringCooldown.renderScale, 0.74);
  controller.ingestSample({ frameMs: 40 }, 1020);
  const afterCooldown = controller.ingestSample({ frameMs: 40 }, 1030);
  assert.equal(afterCooldown.renderScale, 0.66);
  assert.equal(afterCooldown.lastAdaptation.direction, 'down');
});

test('recovery also changes resolution first and requires sustained headroom', () => {
  const controller = new VisualQualityController({
    mode: 'balanced',
    renderScale: 0.70,
    ewmaAlpha: 1,
    upgradeAfterSamples: 3,
    cooldownMs: 1000,
    persist: false,
  });

  controller.ingestSample({ gpuMs: 10 }, 0);
  controller.ingestSample({ gpuMs: 10 }, 10);
  const firstChange = controller.ingestSample({ gpuMs: 10 }, 20);
  assert.equal(firstChange.renderScale, 0.74);
  assert.equal(firstChange.lastAdaptation.kind, 'resolution');

  controller.ingestSample({ gpuMs: 10 }, 30);
  controller.ingestSample({ gpuMs: 10 }, 40);
  const afterCooldown = controller.ingestSample({ gpuMs: 10 }, 1020);
  assert.equal(afterCooldown.renderScale, 0.78);
});

test('auto changes workload only after reaching a render-scale bound', () => {
  const controller = new VisualQualityController({
    limits: highLimits(),
    hardwareConcurrency: 12,
    deviceMemoryGiB: 32,
    renderScale: 0.67,
    ewmaAlpha: 1,
    degradeAfterSamples: 1,
    cooldownMs: 0,
    persist: false,
  });

  const snapshot = controller.ingestSample({ frameMs: 30 }, 0);
  assert.equal(snapshot.activeMode, 'quality');
  assert.equal(snapshot.renderScale, 0.67);
  assert.equal(snapshot.lastAdaptation.kind, 'workload');
  assert.equal(snapshot.lastAdaptation.fromMode, 'ultra');
  assert.equal(snapshot.lastAdaptation.toMode, 'quality');
});

test('auto demotes a bounded workload after sustained exact-target misses', () => {
  const controller = new VisualQualityController({
    tier: 'high', hardwareConcurrency: 6, deviceMemoryGiB: 8,
    renderScale: 0.60, ewmaAlpha: 1, degradeAfterSamples: 3,
    cooldownMs: 0, persist: false,
  });
  assert.equal(controller.activeMode, 'quality');

  controller.ingestSample({ frameMs: 33.45 }, 0);
  controller.ingestSample({ frameMs: 33.45 }, 1);
  const snapshot = controller.ingestSample({ frameMs: 33.45 }, 2);

  assert.equal(snapshot.activeMode, 'balanced');
  assert.equal(snapshot.lastAdaptation.kind, 'workload');
  assert.equal(snapshot.lastAdaptation.reason, 'performance');
});

test('auto recovery never exceeds the capability-derived starting ceiling', () => {
  const controller = new VisualQualityController({
    tier: 'high', hardwareConcurrency: 6, deviceMemoryGiB: 8,
    renderScale: 0.90, ewmaAlpha: 1, upgradeAfterSamples: 1,
    cooldownMs: 0, persist: false,
  });
  assert.equal(controller.activeMode, 'quality');
  const snapshot = controller.ingestSample({ frameMs: 8 }, 0);
  assert.equal(snapshot.activeMode, 'quality');
  assert.equal(snapshot.lastAdaptation.kind, 'bounded');
});

test('auto promotion requires headroom against the destination frame budget', () => {
  const controller = new VisualQualityController({
    limits: highLimits(), hardwareConcurrency: 12, deviceMemoryGiB: 32,
    ewmaAlpha: 1, degradeAfterSamples: 1, upgradeAfterSamples: 1,
    cooldownMs: 0, persist: false,
  });

  // Begin in Ultra, force one workload demotion at the lower resolution bound,
  // then place Quality at its upper bound. Twenty milliseconds is strong Quality
  // performance but is not enough headroom for a 16.7 ms Ultra destination.
  controller.setRenderScale(VISUAL_QUALITY_MODE_PROFILES.ultra.renderScale.min);
  controller.ingestSample({ frameMs: 30 }, 0);
  assert.equal(controller.activeMode, 'quality');
  controller.setRenderScale(VISUAL_QUALITY_MODE_PROFILES.quality.renderScale.max);
  const held = controller.ingestSample({ frameMs: 20 }, 1);
  assert.equal(held.activeMode, 'quality');
  assert.equal(held.lastAdaptation.kind, 'bounded');

  const promoted = controller.ingestSample({ frameMs: 10 }, 2);
  assert.equal(promoted.activeMode, 'ultra');
  assert.equal(promoted.lastAdaptation.kind, 'workload');
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
  assert.equal(controller.setRenderScale(99).renderScale, 0.70);
  assert.equal(controller.setRenderScale(-1).renderScale, 0.50);
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
    renderScale: 0.9,
  });
  assert.equal(locked.mode, 'quality');
  assert.equal(locked.activeMode, 'quality');
  assert.equal(locked.renderScale, 0.9);

  for (let sample = 0; sample < 100; sample += 1) {
    controller.ingestSample({ frameMs: 200 }, sample * 200);
  }
  const pressured = controller.snapshot();
  assert.equal(pressured.renderScale, 0.9);
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
