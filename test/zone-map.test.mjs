import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DataUtils } from 'three';
import { buildZoneMap, zoneAt } from '../src/terrain/ZoneMap.js';

const bounds = { minX: -30, maxX: 30, minZ: -80, maxZ: 20 };
const zones = {
  greens: [{ x: -8, z: -45, r: 6 }],
  sands: [{ x: 11, z: -37, r: 4 }],
  corridor: { c0: 8, k: 0.08, rough: 12 },
  tee: { x: 4, z0: -2, z1: 5 },
  fringeW: 2,
};

test('fairway start leaves native tee separators in the exact rendered zone field', () => {
  const routed = {...zones, greens:[], sands:[], waters:[],
    routes:[{points:[{x:0,z:0},{x:0,z:-75}],c0:6,k:0,rough:4,fairwayStartMeters:50}],
  };
  const map=buildZoneMap(routed,bounds);
  const at=(x,z)=>zoneAt(map,Math.floor((x-bounds.minX)*2),Math.floor((z-bounds.minZ)*2),routed);
  try {
    assert.equal(at(0,0),'tee');
    assert.equal(at(0,-20),'deepRough');
    assert.equal(at(0,-60),'fairway');
    assert.equal(at(8,-60),'rough');
  } finally {
    map.texture.dispose();map.auxTexture.dispose();map.waterTexture.dispose();map.arrayTexture.dispose();
  }
});

test('zone worker transfers byte-identical fields and preserves shared array layers', async () => {
  const workerUrl = new URL('../src/terrain/ZoneMap.worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (value, transfer) => parentPort.postMessage(value, transfer) };
    import(${JSON.stringify(workerUrl)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
    });
  `, { eval: true });
  const expected = buildZoneMap(zones, bounds);
  try {
    const response = new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    worker.postMessage({ zones, bounds });
    const { packed, error } = await response;
    assert.equal(error, undefined);
    for (const key of ['data', 'auxData', 'waterData', 'water', 'potOuter', 'potOuterData']) {
      assert.deepEqual(packed[key], expected[key], key);
    }
    for (const key of ['data', 'auxData', 'waterData']) assert.equal(packed[key].buffer, packed.layerData.buffer);
    assert.equal(packed.layerData.length, packed.width * packed.height * 4 * 3);
    assert.equal(expected.arrayTexture.image.data, expected.layerData);
  } finally {
    await worker.terminate();
    for (const key of ['texture', 'auxTexture', 'waterTexture', 'arrayTexture']) expected[key].dispose();
  }
});

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
    map.auxTexture.dispose();
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
    map.auxTexture.dispose();
    map.waterTexture.dispose();
  }
});

test('pine-straw beds reuse the filtered auxiliary SDF instead of tree-scatter silhouettes', () => {
  const bedZones = {
    ...zones,
    forestFloors: [{ id: 'bed', shape: [
      { x: -25, z: -65 }, { x: -5, z: -65 }, { x: -5, z: -25 }, { x: -25, z: -25 },
    ] }],
  };
  const map = buildZoneMap(bedZones, bounds);
  const distanceAt = (x, z) => {
    const i = Math.min(map.width - 1, Math.floor((x - bounds.minX) * map.texelsPerM));
    const j = Math.min(map.height - 1, Math.floor((z - bounds.minZ) * map.texelsPerM));
    return DataUtils.fromHalfFloat(map.auxData[(j * map.width + i) * 4 + 2]);
  };
  try {
    assert.ok(distanceAt(-15, -45) > 0, 'authored bed interior must be positive');
    assert.ok(distanceAt(10, -45) < 0, 'ground outside the bed must remain turf');
  } finally {
    map.texture.dispose(); map.auxTexture.dispose(); map.waterTexture.dispose();
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
    map.auxTexture.dispose();
    map.waterTexture.dispose();
  }
});

test('shared-site zone fields keep separated routes, oriented tees, and per-hole collars authoritative', () => {
  const routed = {
    corridor: zones.corridor,
    routes: [
      { points: [{ x: -18, z: 10 }, { x: -18, z: -65 }], c0: 4, k: 0, rough: 3 },
      { points: [{ x: 18, z: -65 }, { x: 18, z: 10 }], c0: 5, k: 0, rough: 7 },
    ],
    tees: [{ x: 18, z: -60, shape: [
      { x: 14, z: -64 }, { x: 22, z: -64 }, { x: 22, z: -56 }, { x: 14, z: -56 },
    ] }],
    greens: [
      { x: -18, z: -58, r: 5, fringeWidth: 2 },
      { x: 18, z: 4, r: 5, fringeWidth: 6 },
    ],
    sands: [], waters: [], fringeW: 2,
  };
  const map = buildZoneMap(routed, bounds);
  const at = (x, z) => {
    const i = Math.min(map.width - 1, Math.floor((x - bounds.minX) / (bounds.maxX - bounds.minX) * map.width));
    const j = Math.min(map.height - 1, Math.floor((z - bounds.minZ) / (bounds.maxZ - bounds.minZ) * map.height));
    return zoneAt(map, i, j, routed);
  };
  try {
    assert.equal(at(-18, -20), 'fairway');
    assert.equal(at(18, -60), 'tee');
    assert.equal(at(0, -20), 'deepRough', 'forest separation between routes must not become a merged fairway');
    assert.equal(at(25, -20), 'rough', 'the second route retains its own wider rough band');
    assert.equal(at(18, 11), 'fringe', 'the second green retains its own six-metre collar');
  } finally {
    map.texture.dispose(); map.auxTexture.dispose(); map.waterTexture.dispose();
  }
});
