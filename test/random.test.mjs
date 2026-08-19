import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, deriveSeed, normalizeSeed } from '../src/util/random.js';

test('seeded RNG reproduces streams and keeps named streams independent', () => {
  const seed = normalizeSeed('benchmark-course');
  const first = createRng(seed);
  const second = createRng(seed);
  assert.deepEqual(
    Array.from({ length: 16 }, () => first()),
    Array.from({ length: 16 }, () => second()),
  );
  assert.notEqual(deriveSeed(seed, 'trees'), deriveSeed(seed, 'grass'));
});

test('seed normalization is stable and unsigned', () => {
  assert.equal(normalizeSeed('oak-lined-hole'), normalizeSeed('oak-lined-hole'));
  assert.equal(normalizeSeed(-1), 0xffffffff);
  assert.equal(normalizeSeed(undefined), 0x43474f4c);
});
