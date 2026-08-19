import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZoneMap, zoneAt } from '../src/terrain/ZoneMap.js';

const bounds = { minX: -30, maxX: 30, minZ: -80, maxZ: 20 };
const zones = {
  greens: [{ x: -8, z: -45, r: 6 }],
  sands: [{ x: 11, z: -37, r: 4 }],
  corridor: { c0: 8, k: 0.08, rough: 12 },
  tee: { x: 4, z0: -2, z1: 5 },
  fringeW: 2,
};

function sampleWorld(map, x, z) {
  const u = Math.max(0, Math.min(1, (x - bounds.minX) / (bounds.maxX - bounds.minX)));
  const v = Math.max(0, Math.min(1, (z - bounds.minZ) / (bounds.maxZ - bounds.minZ)));
  const i = Math.min(map.width - 1, Math.floor(u * map.width));
  const j = Math.min(map.height - 1, Math.floor(v * map.height));
  return zoneAt(map, i, j, zones);
}

test('baked zone field keeps authored feature centers and boundaries registered', () => {
  const map = buildZoneMap(zones, bounds);
  try {
    assert.equal(sampleWorld(map, 11, -37), 'sand', 'authored bunker center must remain sand');
    assert.notEqual(sampleWorld(map, 16, -37), 'sand', 'outside authored bunker radius must not spill sand');
    assert.equal(sampleWorld(map, -8, -45), 'green', 'authored green center must remain green');
    assert.equal(sampleWorld(map, 0, 1), 'tee', 'authored tee center must remain tee');
  } finally {
    map.texture.dispose();
    map.waterTexture.dispose();
  }
});

test('baked zone field follows an authored non-circular outline', () => {
  const shapedZones = {
    ...zones,
    greens: [{ x: -8, z: -45, r: 6, shape: [
      { x: -14, z: -44 }, { x: -11, z: -51 }, { x: -5, z: -50 },
      { x: -2, z: -44 }, { x: -6, z: -39 }, { x: -12, z: -39 },
    ] }],
  };
  const map = buildZoneMap(shapedZones, bounds);
  try {
    assert.equal(sampleWorld(map, -8, -45), 'green');
    assert.notEqual(sampleWorld(map, -3, -48), 'green', 'point inside legacy radius but outside authored shape must not be green');
  } finally {
    map.texture.dispose();
    map.waterTexture.dispose();
  }
});

test('pond SDF is exposed as a compact filtered GPU channel without changing turf channels', () => {
  const pondZones = {
    ...zones,
    waters: [{ x: 12, z: -54, r: 7, shape: [
      { x: 5, z: -54 }, { x: 8, z: -61 }, { x: 17, z: -60 },
      { x: 20, z: -53 }, { x: 16, z: -47 }, { x: 8, z: -48 },
    ] }],
  };
  const map = buildZoneMap(pondZones, bounds);
  try {
    assert.ok(map.waterTexture, 'terrain must receive an explicit pond SDF texture');
    assert.equal(map.waterTexture.image.width, map.width);
    assert.equal(map.waterTexture.image.height, map.height);
    assert.equal(map.waterTexture.image.data.length, map.width * map.height * 4,
      'water SDF and baked bank signals must stay in one compact RGBA channel set');
    assert.equal(map.waterTexture.minFilter, map.waterTexture.magFilter,
      'shore interpolation must be filterable in both directions');
    assert.equal(map.waterTexture.name, 'terrain-water-bank-sdf-rgba16f');
    assert.ok(map.water.some((value) => value > 0), 'pond interior must be represented in the CPU SDF');
    assert.ok(map.water.some((value) => value < 0), 'pond exterior shelf must be represented in the CPU SDF');
  } finally {
    map.texture.dispose();
    map.waterTexture.dispose();
  }
});
