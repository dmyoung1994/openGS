import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DEVICE_TIERS, selectEnvironmentDeviceTier, environmentTierSnapshot } from '../src/scene/EnvironmentDeviceTier.js';

const MiB = 1024 * 1024;
const limits = (overrides = {}) => ({
  maxStorageBufferBindingSize: 128 * MiB,
  maxBufferSize: 256 * MiB,
  maxTextureDimension2D: 8192,
  maxStorageBuffersPerShaderStage: 8,
  maxComputeWorkgroupsPerDimension: 65535,
  ...overrides,
});

test('high tier accepts a capable Apple-Metal-class WebGPU limit set without privacy hints', () => {
  const tier = selectEnvironmentDeviceTier({ limits: limits(), hardwareConcurrency: 6, deviceMemoryGiB: 8 });
  assert.equal(tier, ENVIRONMENT_DEVICE_TIERS.high);
  assert.equal(tier.id, 'high');
});

test('policy steps down by workload only as hardware limits decline', () => {
  assert.equal(selectEnvironmentDeviceTier({
    limits: limits({ maxStorageBufferBindingSize: 64 * MiB, maxBufferSize: 128 * MiB, maxTextureDimension2D: 4096 }),
    hardwareConcurrency: 4,
    deviceMemoryGiB: 4,
  }).id, 'balanced');
  assert.equal(selectEnvironmentDeviceTier({
    limits: limits({ maxStorageBufferBindingSize: 32 * MiB }), hardwareConcurrency: 16, deviceMemoryGiB: 32,
  }).id, 'conservative');
});

test('tier snapshots are serializable workload data, not renderer alternatives', () => {
  const snapshot = environmentTierSnapshot(ENVIRONMENT_DEVICE_TIERS.balanced);
  assert.deepEqual(snapshot, {
    id: 'balanced', pixelRatioCap: 1.5,
    gtao: { resolutionScale: 0.5, samples: 6 },
    shadowMapSize: 1536, grassRadius: 42,
    trees: { lodNear: 52, lodFar: 110 },
  });
  assert.throws(() => environmentTierSnapshot(null), /tier is required/);
});
