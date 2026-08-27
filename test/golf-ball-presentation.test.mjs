import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ballPresentationScale } from '../src/scene/BallPresentation.js';

test('ball presentation scale preserves close views and caps distant broadcast readability', () => {
  const fov = 40 * Math.PI / 180;
  assert.equal(ballPresentationScale({
    distance: 4.7, verticalFovRadians: fov, viewportHeight: 1080,
  }), 1, 'address and native-resolution closeups must retain regulation visual scale');

  const chaseScale = ballPresentationScale({
    distance: 13, verticalFovRadians: fov, viewportHeight: 720,
  });
  assert.ok(chaseScale > 1 && chaseScale < 1.85,
    'a 720p chase should receive a restrained readability correction');

  assert.equal(ballPresentationScale({
    distance: 100, verticalFovRadians: fov, viewportHeight: 360,
  }), 1.85, 'the presentation correction must remain tightly bounded');
});

test('invalid projection inputs fail closed to physical ball scale', () => {
  assert.equal(ballPresentationScale({ distance: 0, verticalFovRadians: 1, viewportHeight: 720 }), 1);
  assert.equal(ballPresentationScale({ distance: 10, verticalFovRadians: 0, viewportHeight: 720 }), 1);
  assert.equal(ballPresentationScale({ distance: 10, verticalFovRadians: 1, viewportHeight: 0 }), 1);
});

test('presentation scaling never enlarges the regulation shadow silhouette', async () => {
  const source = await readFile(new URL('../src/scene/GolfBall.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!camera\.isPerspectiveCamera\) \{\s*mesh\.scale\.setScalar\(1\);\s*return;/);
});
