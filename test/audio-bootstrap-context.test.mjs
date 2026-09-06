import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { GolfAudio, prepareGolfAudioContext } from '../src/audio/GolfAudio.js';

test('early native context is created once without downloads or resume and handed off once', () => {
  let creates = 0, closes = 0, resumes = 0;
  const context = { state: 'suspended', close: () => { closes++; return Promise.resolve(); },
    resume: () => { resumes++; } };
  const pending = prepareGolfAudioContext(() => { creates++; return context; });
  assert.equal(pending.supported, true);
  assert.equal(creates, 1);
  assert.equal(resumes, 0);
  assert.equal(pending.contextFactory(), context);
  pending.dispose();
  assert.equal(closes, 0, 'only GolfAudio owns the claimed context');
  assert.throws(() => pending.contextFactory(), /no longer available/);
  assert.equal(creates, 1);
});

test('unclaimed bootstrap context closes once and temporary failure listeners are removed', () => {
  const oldAdd = globalThis.addEventListener;
  const events = [];
  globalThis.addEventListener = (name, callback, options) => events.push({ name, callback, signal: options.signal });
  try {
    let closes = 0;
    const pending = prepareGolfAudioContext(() => ({ state: 'suspended',
      close: () => { closes++; return Promise.resolve(); } }));
    assert.deepEqual(events.map(event => event.name), ['error', 'unhandledrejection', 'pagehide']);
    events[0].callback();
    pending.dispose();
    assert.equal(closes, 1);
    assert.ok(events.every(event => event.signal.aborted));
    assert.throws(() => pending.contextFactory(), /no longer available/);
  } finally {
    if (oldAdd === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = oldAdd;
  }
});

test('unsupported audio preserves optional fallback without a second native allocation attempt', async () => {
  let creates = 0, downloads = 0;
  const failure = new Error('AudioContext unavailable');
  const pending = prepareGolfAudioContext(() => { creates++; throw failure; });
  const audio = new GolfAudio({ camera: { position: new Vector3() }, storage: null,
    contextFactory: pending.contextFactory, fetchImpl: () => { downloads++; } });
  await audio.ready;
  assert.equal(creates, 1);
  assert.equal(downloads, 0);
  assert.equal(audio.snapshot().supported, false);
  assert.match(audio.snapshot().failedAssets[0].error, /AudioContext unavailable/);
  audio.dispose();
});

test('audio graph setup failure closes the claimed native context instead of leaking it', async () => {
  let closes = 0;
  const pending = prepareGolfAudioContext(() => ({ state: 'suspended',
    createGain() { throw new Error('graph setup failed'); },
    close: () => { closes++; return Promise.resolve(); } }));
  const audio = new GolfAudio({ camera: { position: new Vector3() }, storage: null,
    contextFactory: pending.contextFactory, fetchImpl: null });
  await audio.ready;
  pending.dispose(); audio.dispose();
  assert.equal(closes, 1);
  assert.equal(audio.snapshot().supported, false);
});
