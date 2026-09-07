import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('terrain clipmap keeps every level registered and covers the routed site', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /\{ half: 36, step: 0\.6, inner: 0 \}/);
  assert.match(source, /\{ half: 72, step: 1\.2, inner: 36 \}/);
  assert.match(source, /\{ half: 144, step: 2\.4, inner: 72 \}/);
  assert.match(source, /\{ half: 768, step: 9\.6, inner: 144 \}/,
    'same-budget outer ring must cover the full site so no filler band is visible');
  assert.match(source, /exact multiple of the authoritative 0\.6 m height grid/);
  assert.match(source, /const boundsOverlap = level === rings\.length - 1 \? spec\.step : 0/,
    'the real outer terrain must overlap the mountain join by one cell');
  assert.match(source, /this\.bounds\.minX - boundsOverlap/);
});

test('isolated turf viewer uses the production WebGPU terrain material path', async () => {
  const source = await readFile(new URL('src/viewer/assets.js', ROOT), 'utf8');
  const terrain = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /const terrain = new Terrain\(\{[\s\S]*?finiteCanvas: true,[\s\S]*?renderer,\s*\n\s*\}\);/,
    'viewer turf patches must pass the live renderer to Terrain');
  assert.match(terrain, /this\.heightAt\(worldX, worldZ\)[\s\S]*?_buildTurfMaterial\(origin, \{ useGeometrySurface: true \}\)/,
    'an exposed finite boundary must use its exact CPU geometry instead of clipmap height reconstruction');
});

test('terrain low-frequency breakup reuses the baked macro channels', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  const executable = source.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /mowWarp|stripCoordinate[\s\S]{0,160}macroVariation/,
    'straight fairway passes must not inherit macro warp or phase perturbation');
  assert.match(source, /const stripLay = zones\.stripLay;/,
    'albedo must reuse the normal path leaf-lay node rather than rebuilding it');
  assert.match(source, /const mesoA = macroVariation\.b;/,
    'meso albedo must reuse the baked macro colour field');
  assert.match(source, /const soilDrift = macroVariation\.a;/,
    'soil drift must reuse the baked moisture field');
  assert.doesNotMatch(executable, /mowFineAlbedoA = mx_noise_float/,
    'mowing must not evaluate duplicate full-screen noise');
});
