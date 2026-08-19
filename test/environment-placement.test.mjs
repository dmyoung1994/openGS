import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnvironmentPlacements } from '../src/environment/EnvironmentPlacement.js';

const asset = Object.freeze({
  id: 'tree-a', dimensions: { height: 10 }, bounds: { radius: 2, baseY: 0 },
  biomes: ['temperate-alpine'],
  placement: { minSpacing: 3, maxSlopeDegrees: 30 },
});
const catalog = { byId: new Map([['tree-a', asset]]) };
const terrain = { heightAt: (x, z) => x * 0.01 + z * 0.005, normalAt: () => ({ y: 1 }) };
const course = {
  environmentSeed: 17,
  biome: 'temperate-alpine',
  environment: {
    objectCount: 9,
    placements: [{ id: 'hero-tree', assetId: 'tree-a', x: 0, z: 0, rotationY: 0, scale: 1 }],
    scatter: [{ id: 'scatter-a', assetIds: ['tree-a'], seed: 8, count: 4, minSpacing: 3, region: { minX: 20, maxX: 50, minZ: 20, maxZ: 50 } }],
    assembly: [{ id: 'assembly-a', assetIds: ['tree-a'], seed: 9, count: 4, minSpacing: 3, region: { minX: -50, maxX: -20, minZ: -50, maxZ: -20 } }],
    edgeDressing: [],
  },
};

test('semantic environment records resolve exactly and deterministically', () => {
  const first = resolveEnvironmentPlacements(course, catalog, terrain);
  const second = resolveEnvironmentPlacements(course, catalog, terrain);
  assert.equal(first.length, 9);
  assert.deepEqual(first, second);
  assert.ok(first.every((p) => Object.isFrozen(p) && Number.isFinite(p.y)));
});

test('placement fails rather than silently reducing an impossible scatter', () => {
  const impossible = structuredClone(course);
  impossible.environment.placements = [];
  impossible.environment.scatter[0].count = 20;
  impossible.environment.scatter[0].region = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
  impossible.environment.assembly = [];
  impossible.environment.objectCount = 20;
  assert.throws(() => resolveEnvironmentPlacements(impossible, catalog, terrain), /placed \d+\/20/);
});

test('rocks receive deterministic burial and a normalized terrain-following basis', () => {
  const rock = Object.freeze({
    id: 'rock-a', category: 'rock', dimensions: { height: 1 },
    bounds: { radius: 1, baseY: -0.1 }, biomes: ['temperate-alpine'],
    grounding: { burialFraction: 0.2 },
    placement: { minSpacing: 2, maxSlopeDegrees: 40 },
  });
  const rockCatalog = { byId: new Map([['rock-a', rock]]) };
  const slopeNormal = { x: 0.32, y: Math.sqrt(1 - 0.32 ** 2 - 0.18 ** 2), z: 0.18 };
  const slopeTerrain = { heightAt: () => 10, normalAt: () => slopeNormal };
  const rockCourse = {
    environmentSeed: 81,
    biome: 'temperate-alpine',
    environment: {
      objectCount: 1,
      placements: [{ id: 'embedded-rock', assetId: 'rock-a', x: 0, z: 0, rotationY: 0.4, scale: 1 }],
      scatter: [], assembly: [], edgeDressing: [],
    },
  };

  const [placement] = resolveEnvironmentPlacements(rockCourse, rockCatalog, slopeTerrain);
  assert.ok(placement.burialFraction >= 0.12 && placement.burialFraction <= 0.34);
  assert.equal(placement.y, 10.1 - placement.burialFraction);
  assert.ok(placement.normalY < 1);
  assert.ok(Math.abs(Math.hypot(placement.normalX, placement.normalY, placement.normalZ) - 1) < 1e-12);
  assert.deepEqual(
    resolveEnvironmentPlacements(rockCourse, rockCatalog, slopeTerrain),
    resolveEnvironmentPlacements(rockCourse, rockCatalog, slopeTerrain),
  );
});

test('licensed groundcover may overlap a different solid asset as a contact layer', () => {
  const rock = Object.freeze({
    id: 'rock-a', category: 'rock', dimensions: { height: 1 }, bounds: { radius: 1, baseY: 0 },
    biomes: ['temperate-alpine'], grounding: { burialFraction: 0.2 },
    placement: { minSpacing: 2.2, maxSlopeDegrees: 40 },
  });
  const fern = Object.freeze({
    id: 'fern-a', category: 'groundcover', dimensions: { height: 0.4 }, bounds: { radius: 1.4, baseY: 0 },
    biomes: ['temperate-alpine'], grounding: { burialFraction: 0.02 },
    placement: { minSpacing: 1.8, maxSlopeDegrees: 40 },
  });
  const contactCatalog = { byId: new Map([['rock-a', rock], ['fern-a', fern]]) };
  const contactCourse = {
    environmentSeed: 44,
    biome: 'temperate-alpine',
    environment: {
      objectCount: 2,
      placements: [
        { id: 'anchor-rock', assetId: 'rock-a', x: 0, z: 0, rotationY: 0, scale: 1 },
        { id: 'contact-fern', assetId: 'fern-a', x: 0.8, z: 0, rotationY: 1, scale: 1 },
      ],
      scatter: [], assembly: [], edgeDressing: [],
    },
  };

  assert.equal(resolveEnvironmentPlacements(contactCourse, contactCatalog, terrain).length, 2);
});

test('fallen deadwood may occupy the under-canopy habitat without intersecting the trunk', () => {
  const tree = Object.freeze({
    id: 'wide-tree', category: 'tree', dimensions: { height: 18 }, bounds: { radius: 6, baseY: 0 },
    biomes: ['temperate-alpine'], placement: { minSpacing: 7, maxSlopeDegrees: 40 },
  });
  const log = Object.freeze({
    id: 'fallen-log', category: 'deadwood', dimensions: { height: 0.3 }, bounds: { radius: 1.5, baseY: 0 },
    biomes: ['temperate-alpine'], grounding: { burialFraction: 0.05 },
    placement: { minSpacing: 4, maxSlopeDegrees: 40 },
  });
  const habitatCatalog = { byId: new Map([['wide-tree', tree], ['fallen-log', log]]) };
  const habitatCourse = {
    environmentSeed: 92,
    biome: 'temperate-alpine',
    environment: {
      objectCount: 2,
      placements: [
        { id: 'standing-tree', assetId: 'wide-tree', x: 0, z: 0, rotationY: 0, scale: 1 },
        { id: 'under-canopy-log', assetId: 'fallen-log', x: 2, z: 0, rotationY: 1, scale: 1 },
      ],
      scatter: [], assembly: [], edgeDressing: [],
    },
  };

  assert.equal(resolveEnvironmentPlacements(habitatCourse, habitatCatalog, terrain).length, 2);
});
