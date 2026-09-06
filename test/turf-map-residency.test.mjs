import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireTurfMaps } from '../src/terrain/TurfMapResidency.js';

function maps(ready = Promise.resolve()) {
  const texture = () => ({ userData: {}, disposals: 0, dispose() { this.disposals++; } });
  return { albedoArray: texture(), nrhArray: texture(), ready };
}

test('loading and course owners share live immutable arrays, never a disposed resource', () => {
  const renderer = { isWebGPURenderer: true };
  let created = 0;
  const create = () => { created++; return maps(); };
  const loading = acquireTurfMaps(renderer, create);
  const course = acquireTurfMaps(renderer, create);
  assert.equal(created, 1);
  assert.equal(loading.albedoArray, course.albedoArray);
  assert.equal(course.albedoArray.userData.sharedWebGPUAsset, true);
  assert.equal(course.release(), true);
  assert.equal(course.release(), false);
  assert.equal(loading.albedoArray.disposals, 0);
  const rebuilt = acquireTurfMaps(renderer, create);
  assert.equal(rebuilt.nrhArray, loading.nrhArray);
  loading.release();
  assert.equal(rebuilt.nrhArray.disposals, 0);
  rebuilt.release();
  assert.equal(rebuilt.albedoArray.disposals, 1);
  assert.equal(rebuilt.nrhArray.disposals, 1);
  const fresh = acquireTurfMaps(renderer, create);
  assert.equal(created, 2);
  assert.notEqual(fresh.albedoArray, rebuilt.albedoArray);
  fresh.release();
});

test('GPU arrays are isolated between renderer devices', () => {
  const first = acquireTurfMaps({ isWebGPURenderer: true }, maps);
  const second = acquireTurfMaps({ isWebGPURenderer: true }, maps);
  assert.notEqual(first.albedoArray, second.albedoArray);
  first.release(); second.release();
  assert.throws(() => acquireTurfMaps({}, maps), /WebGPU/);
});

test('failed packs evict; a late old release cannot evict a successful retry', async () => {
  const renderer = { isWebGPURenderer: true };
  const error = new Error('required turf unavailable');
  const failed = acquireTurfMaps(renderer, () => maps(Promise.reject(error)));
  await assert.rejects(failed.ready, error);
  const retry = acquireTurfMaps(renderer, maps);
  failed.release();
  const sibling = acquireTurfMaps(renderer, () => { throw new Error('unexpected duplicate'); });
  assert.equal(sibling.albedoArray, retry.albedoArray);
  assert.equal(retry.albedoArray.disposals, 0);
  retry.release(); sibling.release();
  assert.equal(retry.albedoArray.disposals, 1);
});
