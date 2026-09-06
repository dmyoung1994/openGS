// Immutable CPU buffers survive editor rebuilds; GPU resources remain forest-owned.
const cache = new Map();
let bytes = 0;
const MAX_BYTES = 64 * 1024 * 1024;
export async function prepareTree(definition, seed, { signal } = {}) {
  signal?.throwIfAborted();
  const key = JSON.stringify([2, definition, seed]);
  if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return { ...value, cacheHit: true }; }
  if (typeof Worker === 'undefined') throw new Error('Procedural tree production preparation requires Web Workers.');
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./TreeBuild.worker.js', import.meta.url), { type: 'module' });
    const abort = () => finish(reject, signal.reason);
    const finish = (fn, value) => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); fn(value); };
    const timeout = setTimeout(() => finish(reject, new Error('Tree generation timed out')), 60000);
    worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data);
    worker.onerror = event => finish(reject, new Error(event.message));
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage({ definition, seed });
  });
  result.bytes = result.tiers.reduce((n, tier) => n + Object.values(tier).reduce((n, mesh) => n + Object.values(mesh).reduce((n, array) => n + array.byteLength, 0), 0), 0);
  if (result.bytes <= MAX_BYTES) {
    while (bytes + result.bytes > MAX_BYTES || cache.size >= 8) { const oldest = cache.keys().next().value; bytes -= cache.get(oldest).bytes; cache.delete(oldest); }
    cache.set(key, result); bytes += result.bytes;
  }
  return { ...result, cacheHit: false };
}
