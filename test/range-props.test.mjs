import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');

test('range target furniture uses grounded shared PBR geometry buckets', () => {
  assert.match(source, /this\._targetPropAssets = null/);
  assert.match(source, /_targetProps\(\)/);
  assert.match(source, /poleGeometry: new CylinderGeometry\(0\.026, 0\.034, 2\.4/);
  assert.match(source, /flagGeometry: makeTargetFlagGeometry\(\)/);
  assert.match(source, /new BoxGeometry\(width, 0\.40, 0\.016, 4, 2, 1\)/);
  assert.match(source, /position\.getY\(index\) \* \(1 - 0\.10 \* t\)/);
  assert.match(source, /Math\.sin\(t \* Math\.PI\) \* 0\.026/);
  assert.match(source, /flagBaseGeometry: new CylinderGeometry\(0\.13, 0\.10, 0\.07/);
  assert.match(source, /signGeometry: new BoxGeometry\(1\.08, 0\.48, 0\.055\)/);
  assert.match(source, /postGeometry: new CylinderGeometry\(0\.035, 0\.045, 0\.40/);
  assert.match(source, /markerGeometry: new CylinderGeometry\(0\.105, 0\.078, 0\.10/);
  assert.match(source, /MeshStandardMaterial\(\{ map: tex, side: DoubleSide, roughness: 0\.84/);
  assert.match(source, /ctx\.fillStyle = '#707969'/,
    'yardage boards must use a subdued painted face rather than a near-black billboard');
  assert.match(source, /flagMaterial: new MeshStandardMaterial/);
  assert.match(source, /poleMaterial: new MeshStandardMaterial/);
  assert.doesNotMatch(source, /new PlaneGeometry\(0\.7, 0\.45\)/);
  assert.match(source, /new InstancedMesh\(assets\.flagGeometry, assets\.flagMaterial, count\)/);
  assert.match(source, /new InstancedMesh\(assets\.postGeometry, assets\.postMaterial, count \* 2\)/);
  assert.match(source, /new InstancedMesh\(assets\.markerGeometry, assets\.markerMaterial, 2\)/);
  assert.match(source, /flagMesh\.setColorAt\(index/);
  assert.match(source, /targetDraws: count \+ 5/);
  assert.match(source, /targetPropDiagnostics\(\)/);
  assert.match(source, /drawBuckets,/);
  assert.match(source, /signBoards: count/);
  assert.match(source, /signDraws: count/);
  assert.match(source, /targetDraws: count \+ 5/);
});

test('target labels and positions remain authored course data', () => {
  assert.match(source, /this\.targets\.forEach\(\(t, index\) =>/);
  assert.match(source, /const signZ = t\.z \+ t\.r \+ 4/,
    'yardage labels must retain their authored plan-view position');
  assert.match(source, /const signY = this\.terrain\.heightAt\(t\.x, signZ\)/,
    'each board and its posts must use the actual terrain beneath the sign');
  assert.match(source, /dummy\.position\.set\(t\.x \+ postX, signY \+ 0\.18, signZ\)/);
  assert.match(source, /this\.group\.add\(this\._placard\(t\.x, signY, signZ, `\$\{t\.yards\}`\)\)/);
  assert.match(source, /postMesh\.setMatrixAt\(index \* 2/);
  assert.match(source, /mesh\.castShadow = true;[\s\S]*mesh\.receiveShadow = true/);
  assert.match(source, /sign\.castShadow = true;[\s\S]*sign\.receiveShadow = true/);
  assert.match(source, /disposeMaterialTextures\(materials\);[\s\S]*this\._targetPropAssets = null/);
});
