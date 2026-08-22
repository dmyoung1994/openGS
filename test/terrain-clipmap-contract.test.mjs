import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('terrain clipmap keeps exact ring radii while removing low-value display vertices', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /\{ half: 36, step: 0\.9, inner: 0 \}/);
  assert.match(source, /\{ half: 72, step: 1\.8, inner: 36 \}/);
  assert.match(source, /\{ half: 144, step: 3\.6, inner: 72 \}/);
  assert.match(source, /\{ half: 384, step: 4\.8, inner: 144 \}/,
    'outer ring must cover the full flight view while preserving the camera snap step');
  assert.match(source, /authoritative 0\.6 m height texture remains intact/,
    'display tessellation reduction must not weaken physics/render height sampling');
});

test('isolated turf viewer uses the production WebGPU terrain material path', async () => {
  const source = await readFile(new URL('src/viewer/assets.js', ROOT), 'utf8');
  assert.match(source, /const terrain = new Terrain\(\{[\s\S]*?renderer,\s*\n\s*\}\);/,
    'viewer turf patches must pass the live renderer to Terrain');
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
