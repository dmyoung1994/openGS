import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');

test('range target furniture uses recessed cups and one merged cloth draw', () => {
  assert.match(source, /poleGeometry: new CylinderGeometry\(0\.026, 0\.034, 2\.48/);
  assert.match(source, /cupGeometry: new CylinderGeometry\(0\.075, 0\.075, 0\.035/);
  assert.match(source, /dummy\.position\.set\(t\.x, y - 0\.026, t\.z\)/);
  assert.match(source, /new FlagClothSystem/);
  assert.match(source, /this\.flagCloth\?\.update\(\)/);
  assert.doesNotMatch(source, /flagBaseGeometry|signGeometry|postGeometry|_placard/);
  assert.match(source, /flagCloth: 1, recessedCups: 1, paintedYardages: 1/);
  assert.match(source, /targetDraws: 4/);
});

test('yardages reuse one canvas atlas and one terrain-conforming mesh', () => {
  assert.match(source, /painted-yardage-number-atlas/);
  assert.match(source, /terrain-conforming-painted-yardages-merged/);
  assert.match(source, /this\.terrain\.heightAt\(target\.x \+ dx, z \+ dz\) \+ 0\.012/);
  assert.match(source, /new MeshStandardMaterial\(\{ map: tex, transparent: true, alphaTest: 0\.16/);
  assert.match(source, /paintedYardages: count/);
});

test('tee markers stay nearly flush in the address foreground', () => {
  assert.match(source, /markerGeometry: new CylinderGeometry\(0\.11, 0\.105, 0\.025, 24\)/);
  assert.match(source, /heightAt\(sx, 3\.2\) \+ 0\.0125/);
});
