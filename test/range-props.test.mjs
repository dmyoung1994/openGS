import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const source = await readFile(new URL('../src/scene/PlayableCourseScene.js', import.meta.url), 'utf8');

test('range target furniture uses recessed cups and one merged cloth draw', () => {
  assert.match(source, /poleGeometry: new CylinderGeometry\(0\.006, 0\.0075, 2\.48, 16\)/);
  assert.match(source, /premium_walnut_albedo_1k\.png/);
  assert.match(source, /poleMaterial: new MeshPhysicalMaterial/);
  assert.match(source, /clearcoat: 0\.62/);
  assert.match(source, /clearcoatRoughness: 0\.24/);
  assert.match(source, /targetPropsReady/);
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

test('tee markers use the required carved Rangeform GLB and complete stone PBR set', () => {
  assert.doesNotMatch(source, /markerGeometry: new CylinderGeometry\(0\.11/);
  assert.match(source, /rangeform-limestone-tee-marker\.glb/);
  assert.match(source, /travertine_009_color_1k\.jpg/);
  assert.match(source, /travertine_009_normal_gl_1k\.jpg/);
  assert.match(source, /travertine_009_roughness_1k\.jpg/);
  assert.match(source, /travertine_009_ao_1k\.jpg/);
  assert.match(source, /normalScale: new Vector2\(0\.58, 0\.58\)/);
  assert.match(source, /const TEE_MARKER_LINE_OFFSET = 0\.4/);
  assert.match(source, /tee\.x \+ aim\.x \* TEE_MARKER_LINE_OFFSET \+ right\.x \* side/);
  assert.match(source, /tee\.z \+ aim\.z \* TEE_MARKER_LINE_OFFSET \+ right\.z \* side/);
  assert.match(source, /markerDummy\.position\.set\(x, this\.terrain\.heightAt\(x, z\), z\)/);
  assert.match(source, /markerMesh\.visible = false/);
  assert.match(source, /markerMesh\.visible = true/);
  assert.match(source, /markerMesh\.computeBoundingSphere\(\)/);
  assert.match(source, /invalidateShadow\(true, \{ reason: 'tee-marker-ready' \}\)/);
  assert.match(source, /this\.routing \? this\.teePads/);
});

test('Rangeform marker is one bounded indexed crest mesh with pinned source assets', async () => {
  const modelUrl = new URL('../public/assets/props/rangeform-tee-marker/rangeform-limestone-tee-marker.glb', import.meta.url);
  const document = await new NodeIO().read(fileURLToPath(modelUrl));
  const meshes = document.getRoot().listMeshes();
  assert.equal(meshes.length, 1);
  const primitives = meshes[0].listPrimitives();
  assert.equal(primitives.length, 1);
  const primitive = primitives[0];
  assert.ok(primitive.getIndices());
  assert.ok(primitive.getAttribute('NORMAL'));
  assert.ok(primitive.getAttribute('TEXCOORD_0'));
  assert.ok(primitive.getAttribute('TEXCOORD_1'));
  assert.ok(primitive.getAttribute('COLOR_0'));
  assert.ok(primitive.getIndices().getCount() / 3 < 9000);

  const position = primitive.getAttribute('POSITION');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const value = [0, 0, 0];
  for (let index = 0; index < position.getCount(); index++) {
    position.getElement(index, value);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], value[axis]);
      max[axis] = Math.max(max[axis], value[axis]);
    }
  }
  assert.ok(Math.abs((max[0] - min[0]) - 0.21) < 1e-4);
  assert.ok(Math.abs(min[1] + 0.03) < 1e-4);
  const extras = document.getRoot().listNodes()[0].getExtras();
  assert.equal(extras.faceAngleDegrees, 45);
  assert.equal(extras.burialMeters, 0.03);
  assert.equal(extras.crestRecessMeters, 0.002);

  const expectedHashes = new Map([
    ['../public/assets/branding/rangeform-crest-imagegen.png', '13085bd8980b60a6999880cdb76279c3110efa8fe61f9ebcd64e4a280b770ae0'],
    ['../public/assets/props/rangeform-tee-marker/rangeform-limestone-tee-marker.glb', 'aaff1acaee6c112cf704774afe562d4af6446da0de39d70429263ffb495f4569'],
    ['../public/assets/materials/travertine_009/travertine_009_color_1k.jpg', '6561c87d92aef321aef4095fbcc5518cec4d711e642be6beaa90d13829e6cd2b'],
    ['../public/assets/materials/travertine_009/travertine_009_normal_gl_1k.jpg', '635256a78537253a2d2bc5fef5fcda6e4e03349b960c57f15cf721b7cf5ba098'],
    ['../public/assets/materials/travertine_009/travertine_009_roughness_1k.jpg', 'f4094c2149e257f4b6e17e5c5da70101fcbffaf0ce4016ab5d6aac7e45112e37'],
    ['../public/assets/materials/travertine_009/travertine_009_ao_1k.jpg', '6333a47aa0ee5007da41f095aad67536658a68cdd88a3d21e7dd4469fdb6389b'],
  ]);
  for (const [relativePath, expected] of expectedHashes) {
    const bytes = await readFile(new URL(relativePath, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, relativePath);
  }
});
