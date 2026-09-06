import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSceneTextures } from '../src/scene/prepareSceneTextures.js';

test('staged texture preparation uses exact existing maps once and leaves ownership untouched', async () => {
  const map = { isTexture: true }, owned = { isTexture: true };
  const target = { isTexture: true, isRenderTargetTexture: true };
  const material = { map, normalMap: map, userData: { ownedTextures: [owned, target] } };
  const scene = { traverse: callback => {
    callback({ material }); callback({ material: [material, { map }] });
  } };
  const uploaded = [];
  const count = await prepareSceneTextures({ initTexture: texture => uploaded.push(texture) }, scene);
  assert.equal(count, 2);
  assert.deepEqual(uploaded, [map, owned]);
  assert.equal(material.map, map);
  assert.equal(material.userData.ownedTextures[0], owned);
});

test('native upload failure propagates without disposing or substituting authored maps', async () => {
  const map = { isTexture: true };
  const scene = { traverse: callback => callback({ material: { map } }) };
  const error = new Error('device upload failed');
  await assert.rejects(prepareSceneTextures({ initTexture() { throw error; } }, scene), error);
});
