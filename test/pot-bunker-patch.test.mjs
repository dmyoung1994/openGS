import test from 'node:test';
import assert from 'node:assert/strict';
import { DataUtils } from 'three';
import { buildHazardPatchGeometry } from '../src/scene/Bunkers.js';
import { roundedHazardFeature, signedDistanceToFeature } from '../src/course/featureGeometry.js';
import { buildZoneMap } from '../src/terrain/ZoneMap.js';

test('pot bunker patch is fixed, dense, wall-concentrated, and follows the rounded outline', () => {
  const pot = roundedHazardFeature({ x: 1, z: -99, r: 3, depth: 2, pot: true }, { kind: 'bunker', index: 0 });
  const geometry = buildHazardPatchGeometry(pot);
  assert.ok(geometry.userData.radialSegments >= 96);
  assert.ok(geometry.userData.radialRings >= 28);
  assert.equal(geometry.userData.worldAnchored, true);
  assert.equal(geometry.getAttribute('position').count, 1 + 96 * 28);
  const positions = geometry.getAttribute('position');
  for (let segment = 0; segment < 96; segment += 12) {
    const index = 1 + (28 - 1) * 96 + segment;
    assert.ok(signedDistanceToFeature(pot, positions.getX(index), positions.getZ(index)) < 0,
      'outer collar must close just outside the exact grade-flush outline');
  }
  geometry.dispose();
});

test('zone field carries the pot outer SDF separately from the inset sand floor', () => {
  const pot = { x: 0, z: 0, r: 3, inset: 0.84, pot: true };
  const map = buildZoneMap({ greens: [], sands: [pot], waters: [], corridor: { c0: 1, k: 0, rough: 1 }, tee: null }, { minX: -5, maxX: 5, minZ: -5, maxZ: 5 });
  const i = Math.floor(map.width / 2), j = Math.floor(map.height / 2);
  const sand = DataUtils.fromHalfFloat(map.data[(j * map.width + i) * 4 + 2]);
  assert.ok(map.potOuter[j * map.width + i] > sand + 0.7);
  const packedOuter = DataUtils.fromHalfFloat(map.waterData[(j * map.width + i) * 4 + 3]);
  assert.ok(Math.abs(packedOuter - map.potOuter[j * map.width + i]) < 0.01);
  assert.equal(map.potOuterTexture, undefined,
    'pot outer authority must reuse water alpha instead of consuming another fragment sampler');
  map.texture.dispose(); map.waterTexture.dispose();
});
