// Explicit checkpoints between CPU preparation batches, never a substitute for
// moving a single indivisible raster/decode task to its worker.
export function yieldToRendering() {
  // A scheduler continuation alone can run batch after batch before a paint.
  // Resume in a task after the next animation frame so the putting scene paints.
  if (typeof requestAnimationFrame === 'function') {
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  return globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0));
}
