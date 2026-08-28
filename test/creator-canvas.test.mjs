import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import {
  createCreatorCanvasCourse, createCreatorCanvasOutline, creatorCanvasCameraPose,
} from '../src/course/CreatorCanvas.js';
import { normalizeCourse } from '../src/course/course.js';
import { polygonSelfIntersects, signedDistanceToFeature } from '../src/course/featureGeometry.js';
import { semanticLandformHeight } from '../src/course/SemanticLandforms.js';
import { createCreatorCanvasFrame } from '../src/scene/CreatorCanvasFrame.js';
import { createCreatorFringeGrass } from '../src/scene/CreatorFringeGrass.js';
import {
  createCreatorCup, CREATOR_CUP_DEPTH_M, GOLF_HOLE_DIAMETER_M, GOLF_HOLE_MIN_DEPTH_M,
} from '../src/scene/CreatorCup.js';

test('creator showcase is a deterministic playable green and fringe without authored decoration', () => {
  const course = normalizeCourse(createCreatorCanvasCourse({ seed: 73, variant: 0 }));
  const repeat = normalizeCourse(createCreatorCanvasCourse({ seed: 73, variant: 0 }));
  const reroll = normalizeCourse(createCreatorCanvasCourse({ seed: 73, variant: 1 }));
  assert.deepEqual(course, repeat);
  assert.notDeepEqual(course.greens[0].shape, reroll.greens[0].shape);
  assert.deepEqual(course.bounds, { minX: -18, maxX: 18, minZ: -18, maxZ: 18 });
  assert.equal(course.greens.length, 1);
  assert.equal(course.greens[0].contour, 'crown');
  assert.equal(course.fringeW, 1.8);
  assert.equal(course.landforms.length, 5);
  assert.deepEqual(course.bunkers, []);
  assert.deepEqual(course.ponds, []);
  assert.equal(course.environment.objectCount, 0);
  assert.equal(polygonSelfIntersects(course.greens[0].shape), false);
});

test('creator showcase outline is the exact organic outer fringe boundary', () => {
  for (let variant = 0; variant < 20; variant += 1) {
    const course = normalizeCourse(createCreatorCanvasCourse({ seed: 91, variant }));
    const outline = createCreatorCanvasOutline(course);
    assert.equal(outline.length, 96);
    assert.equal(polygonSelfIntersects(outline), false);
    for (const point of outline) {
      const distance = signedDistanceToFeature(course.greens[0], point.x, point.z);
      assert.ok(distance <= -1.78 && distance >= -1.90, `variant ${variant} fringe offset ${distance}`);
    }
  }
});

test('creator showcase has a compact pin shelf, demanding internal tiers, and a close three-quarter camera', () => {
  const course = normalizeCourse(createCreatorCanvasCourse({ seed: 19 }));
  const green = course.greens[0];
  const heightAt = (x, z) => semanticLandformHeight(course.landforms, x, z);
  const centerHeight = heightAt(green.x, green.z);
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
    assert.ok(Math.abs(heightAt(green.x + Math.cos(angle), green.z + Math.sin(angle)) - centerHeight) < 0.02);
  }
  const samples = [];
  for (let z = green.z - 8; z <= green.z + 8; z += 0.5) {
    for (let x = green.x - 10; x <= green.x + 10; x += 0.5) {
      if (signedDistanceToFeature(green, x, z) > 0.5) samples.push(heightAt(x, z));
    }
  }
  const relief = Math.max(...samples) - Math.min(...samples);
  assert.ok(relief > 0.42 && relief < 0.72,
    'the authored green should expose demanding but plausible internal tier relief');
  const pose = creatorCanvasCameraPose(course, heightAt);
  assert.equal(pose.fov, 24);
  assert.ok(pose.position[0] > pose.lookAt[0]);
  assert.ok(pose.position[1] > pose.lookAt[1]);
  assert.ok(pose.position[2] > pose.lookAt[2]);
});

test('creator canvas carries the shared authored atmosphere without sharing mutation state', () => {
  const atmosphere = { climate: 'temperate-maritime', season: 'summer', localTime: '15:30', weather: 'partly-cloudy', cloudCoverage: 0.25, windSpeedMph: 8, windDirectionDegrees: 250 };
  const canvas = createCreatorCanvasCourse({ atmosphere });
  assert.deepEqual(canvas.atmosphere, atmosphere);
  assert.notEqual(canvas.atmosphere, atmosphere);
});

test('creator canvas frame adds tapered presentation depth without changing terrain bounds', () => {
  const course = normalizeCourse(createCreatorCanvasCourse({ seed: 37 }));
  const outline = createCreatorCanvasOutline(course);
  const heightAt = (x, z) => semanticLandformHeight(course.landforms, x, z);
  const frame = createCreatorCanvasFrame({ outline, heightAt });
  assert.equal(frame.name, 'creator-canvas-earth-frame');
  assert.equal(frame.userData.creatorCanvasFrame, true);
  assert.equal(frame.userData.organicOutline, true);
  assert.equal(frame.userData.thickness, 1.2);
  assert.equal(frame.userData.verticalSegments, 4);
  assert.equal(frame.position.y, 0);
  frame.geometry.computeBoundingBox();
  const size = frame.geometry.boundingBox.getSize(new Vector3());
  assert.ok(size.x > 18 && size.x < 30);
  assert.ok(size.y >= 1.2 && size.y < 1.6);
  assert.ok(size.z > 15 && size.z < 30);
  assert.equal(frame.geometry.attributes.position.count, (outline.length + 1) * 5);
  assert.equal(frame.geometry.attributes.color.count, (outline.length + 1) * 5);
  assert.equal(frame.geometry.attributes.uv.count, (outline.length + 1) * 5);
  const positions = frame.geometry.attributes.position;
  for (let index = 0; index < outline.length; index += 1) {
    assert.ok(Math.abs(positions.getY(index * 5) - positions.getY(index * 5 + 4) - 1.2) < 1e-6);
  }
  assert.equal(frame.material.roughness, 0.94);
  assert.equal(frame.material.vertexColors, true);
  assert.equal(frame.material.map.colorSpace, 'srgb');
  assert.equal(frame.material.emissiveMap, frame.material.map);
  assert.equal(frame.material.emissiveIntensity, 0.62);
  assert.equal(frame.userData.materialSource, 'polyhaven:dirt');
  assert.equal(frame.userData.materialWidthM, 2.0);
  frame.geometry.dispose();
  frame.material.map.dispose();
  frame.material.normalMap.dispose();
  frame.material.roughnessMap.dispose();
  frame.material.dispose();
});

test('creator fringe has a deterministic physical blade canopy on the exact collar', () => {
  const course = normalizeCourse(createCreatorCanvasCourse({ seed: 37 }));
  const heightAt = (x, z) => semanticLandformHeight(course.landforms, x, z);
  const first = createCreatorFringeGrass({
    green: course.greens[0], fringeWidth: course.fringeW, heightAt, seed: course.environmentSeed,
  });
  const repeat = createCreatorFringeGrass({
    green: course.greens[0], fringeWidth: course.fringeW, heightAt, seed: course.environmentSeed,
  });
  assert.equal(first.name, 'creator-fringe-grass-canopy');
  assert.ok(first.userData.bladeCount > 14000 && first.userData.bladeCount < 30000);
  assert.equal(first.userData.bladeCount, repeat.userData.bladeCount);
  assert.deepEqual(first.userData.bladeHeightRangeM, [0.030, 0.050]);
  assert.equal(first.userData.rootClearanceM, 0.035);
  assert.equal(first.geometry.attributes.position.count, 6);
  assert.equal(first.material.roughness, 0.88);
  assert.ok(first.instanceColor);
  for (const mesh of [first, repeat]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

test('creator pin uses a regulation geometry cutout with a recessed rootzone and liner', () => {
  const cup = createCreatorCup({ x: 1.2, z: -0.7, surfaceY: 0.35 });
  assert.equal(GOLF_HOLE_DIAMETER_M, 0.108);
  assert.ok(CREATOR_CUP_DEPTH_M >= GOLF_HOLE_MIN_DEPTH_M);
  assert.equal(cup.name, 'creator-center-pin-cup');
  assert.deepEqual(cup.position.toArray(), [1.2, 0.35, -0.7]);
  assert.equal(cup.userData.geometryCutoutRequired, true);
  assert.equal(cup.userData.diameterM, 0.108);
  assert.equal(cup.userData.depthM, 0.12);
  assert.deepEqual(cup.children.map((child) => child.name), [
    'creator-cup-rootzone-wall', 'creator-cup-liner-wall', 'creator-cup-bottom',
  ]);
  assert.equal(cup.children[0].geometry.parameters.radiusTop, GOLF_HOLE_DIAMETER_M * 0.5);
  cup.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
});
