// One environment renderer, with capability-derived workload budgets. These values
// never select a renderer, material, shader, AA method, or post-processing branch:
// they only bound the amount of the identical WebGPU workload submitted per frame.

const MIB = 1024 * 1024;

const freezeTier = (tier) => Object.freeze({
  ...tier,
  gtao: Object.freeze({ ...tier.gtao }),
  shadow: Object.freeze({ ...tier.shadow }),
  trees: Object.freeze({ ...tier.trees }),
});

export const ENVIRONMENT_DEVICE_TIERS = Object.freeze({
  high: freezeTier({
    id: 'high',
    pixelRatioCap: 2,
    gtao: { resolutionScale: 0.5, samples: 8 },
    shadowMapSize: 2048,
    shadow: { extent: 60 },
    grassRadius: 43,
    // Base distance budget; Trees.js applies catalog-role residency on top. Mature
    // overstory receives the long foreground/midground range, while native saplings
    // keep a modest band so subpixel regeneration does not consume hero geometry.
    trees: { lodNear: 70, lodFar: 140 },
  }),
  balanced: freezeTier({
    id: 'balanced',
    pixelRatioCap: 1.5,
    gtao: { resolutionScale: 0.5, samples: 6 },
    shadowMapSize: 1536,
    shadow: { extent: 45 },
    grassRadius: 42,
    trees: { lodNear: 52, lodFar: 110 },
  }),
  conservative: freezeTier({
    id: 'conservative',
    pixelRatioCap: 1.25,
    gtao: { resolutionScale: 0.4, samples: 4 },
    shadowMapSize: 1024,
    shadow: { extent: 30 },
    grassRadius: 38,
    trees: { lodNear: 34, lodFar: 80 },
  }),
});

// Visual quality modes are a policy layered above the existing environment
// workload tiers.  Keeping this vocabulary here lets browser bootstrap code and
// the adaptive controller agree on the mode names without changing the shape or
// meaning of the renderer-facing tier objects above.
export const VISUAL_QUALITY_MODES = Object.freeze([
  'auto',
  'battery',
  'balanced',
  'quality',
  'ultra',
]);

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

// Pure policy: browser integration snapshots adapter/device limits and navigator
// hints before calling this. Memory/core hints only promote when present; an omitted
// privacy-restricted hint never demotes otherwise capable hardware.
export function selectEnvironmentDeviceTier({ limits = {}, adapterLimits, deviceLimits, hardwareConcurrency, deviceMemoryGiB } = {}) {
  // Adapter limits are the hardware capability signal. Device limits are included
  // as a defensive lower bound if a browser/device negotiation ever reduces one.
  const limit = (name) => {
    const values = [adapterLimits?.[name], deviceLimits?.[name], limits?.[name]].filter(Number.isFinite);
    return values.length ? Math.min(...values) : 0;
  };
  const storageBytes = limit('maxStorageBufferBindingSize');
  const bufferBytes = limit('maxBufferSize');
  const textureDimension = limit('maxTextureDimension2D');
  const storageBuffers = limit('maxStorageBuffersPerShaderStage');
  const workgroups = limit('maxComputeWorkgroupsPerDimension');
  const cores = finite(hardwareConcurrency);
  const memoryGiB = finite(deviceMemoryGiB);

  const highGpu = storageBytes >= 128 * MIB
    && bufferBytes >= 256 * MIB
    && textureDimension >= 8192
    && storageBuffers >= 8
    && workgroups >= 65535;
  const balancedGpu = storageBytes >= 64 * MIB
    && bufferBytes >= 128 * MIB
    && textureDimension >= 4096
    && storageBuffers >= 8
    && workgroups >= 65535;
  // Chrome reports six logical cores on the current Apple Metal desktop even
  // though its adapter exposes the full high-tier WebGPU limits. Treat that real
  // hardware profile as high; the adapter limits remain the primary gate.
  const highHints = (cores === 0 || cores >= 6) && (memoryGiB === 0 || memoryGiB >= 8);
  const balancedHints = (cores === 0 || cores >= 4) && (memoryGiB === 0 || memoryGiB >= 4);

  if (highGpu && highHints) return ENVIRONMENT_DEVICE_TIERS.high;
  if (balancedGpu && balancedHints) return ENVIRONMENT_DEVICE_TIERS.balanced;
  return ENVIRONMENT_DEVICE_TIERS.conservative;
}

// Auto starts from the capability-derived environment tier, then uses the
// optional CPU/memory hints to decide whether the high tier has enough headroom
// for the Ultra policy. Chromium deliberately quantizes and caps deviceMemory at
// 8 GiB, so a 16 GiB threshold can never identify a normal Chrome desktop. A
// high core count separates that capped desktop signal from current phones while
// the high WebGPU limits remain the primary GPU capability gate. Privacy-restricted
// hints deliberately do not promote a device to Ultra.
export function selectInitialVisualQualityMode({
  tier,
  environmentTier,
  limits = {},
  adapterLimits,
  deviceLimits,
  hardwareConcurrency,
  deviceMemoryGiB,
} = {}) {
  const resolvedTier = tier ?? environmentTier ?? selectEnvironmentDeviceTier({
    limits,
    adapterLimits,
    deviceLimits,
    hardwareConcurrency,
    deviceMemoryGiB,
  });
  const tierId = typeof resolvedTier === 'string' ? resolvedTier : resolvedTier?.id;
  const cores = finite(hardwareConcurrency);
  const memoryGiB = finite(deviceMemoryGiB);

  if (tierId === 'high' && cores >= 12 && memoryGiB >= 8) return 'ultra';
  if (tierId === 'high') return 'quality';
  if (tierId === 'balanced') return 'balanced';
  return 'battery';
}

// Readable alias for callers that do not need to distinguish this from the
// existing renderer-tier selector.  Both names intentionally return a mode
// string, never a renderer-facing tier object.
export const selectVisualQualityMode = selectInitialVisualQualityMode;

export function environmentTierSnapshot(tier) {
  if (!tier || !ENVIRONMENT_DEVICE_TIERS[tier.id]) throw new Error('Environment device tier is required.');
  return {
    id: tier.id,
    pixelRatioCap: tier.pixelRatioCap,
    gtao: { ...tier.gtao },
    shadowMapSize: tier.shadowMapSize,
    shadow: { ...tier.shadow },
    grassRadius: tier.grassRadius,
    trees: { ...tier.trees },
  };
}
