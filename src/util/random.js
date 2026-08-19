// Small deterministic RNG utilities for authored/procedural environment content.
// Rendering benchmarks must rebuild the same course dressing on every load; using
// Math.random() makes both image deltas and draw-workload deltas meaningless.
export function normalizeSeed(value, fallback = 0x43474f4c) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string' && value.length) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  return fallback >>> 0;
}

export function deriveSeed(seed, stream) {
  let hash = normalizeSeed(seed) ^ 2166136261;
  const text = String(stream);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Mulberry32: compact, deterministic, and more than adequate for visual placement.
export function createRng(seed) {
  let state = normalizeSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
