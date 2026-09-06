import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { bakeDenseCanopyMask } from '../src/terrain/CanopyField.js';

test('canopy worker transfers byte-identical coarse/fine fields and reports invalid input', async () => {
  const url = new URL('../src/terrain/CanopyField.worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
    import(${JSON.stringify(url)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
      parentPort.postMessage('ready');
    });
  `, { eval: true });
  try {
    await once(worker, 'message');
    const placements = [{ x: 0, z: 0, canopyRadius: 8 }, { x: 6, z: 2, canopyRadius: 6 }];
    const fields = [.6, .3].map(spacing => ({ data: new Uint8Array(61 * 41).fill(128),
      nx: 61, nz: 41, grid: { minX: -12, minZ: -6, spacing } }));
    const expected = fields.map(f => bakeDenseCanopyMask(f.data.slice(), f.nx, f.nz, f.grid, placements));
    const response = once(worker, 'message');
    worker.postMessage({ fields, placements }, fields.map(f => f.data.buffer));
    assert.equal(fields[0].data.byteLength, 0, 'input ownership transfers to the worker');
    assert.deepEqual((await response)[0].fields, expected);
    const failure = once(worker, 'message');
    worker.postMessage({ fields: [{ ...fields[0], data: new Uint8Array(1) }], placements });
    assert.match((await failure)[0].error, /one byte per terrain texel/);
  } finally { await worker.terminate(); }
});
