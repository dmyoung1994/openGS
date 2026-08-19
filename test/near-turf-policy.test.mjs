import test from 'node:test';
import assert from 'node:assert/strict';
import {
  footprintUsesNearTurfGeometry,
  renderedBallSitDepth,
  usesNearTurfGeometry,
} from '../src/scene/NearTurfPolicy.js';

test('near-turf geometry is restricted to long grass', () => {
  assert.equal(usesNearTurfGeometry('rough'), true);
  assert.equal(usesNearTurfGeometry('deepRough'), true);

  for (const surface of ['tee', 'fairway', 'fringe', 'green', 'sand', 'water', 'cartpath']) {
    assert.equal(usesNearTurfGeometry(surface), false, `${surface} must remain texture-only`);
  }
});

test('near-turf footprint rejects geometry that would cross onto mown turf', () => {
  const terrain = {
    surfaceAt(x) {
      return x > 0.7 ? 'fairway' : 'rough';
    },
  };

  assert.equal(footprintUsesNearTurfGeometry(terrain, 0, 0, 0.5), true);
  assert.equal(footprintUsesNearTurfGeometry(terrain, 0, 0, 1), false);
});

test('near-turf footprint accepts rough and deep-rough transitions', () => {
  const terrain = {
    surfaceAt(x) {
      return x < 0 ? 'rough' : 'deepRough';
    },
  };

  assert.equal(footprintUsesNearTurfGeometry(terrain, 0, 0, 1), true);
});

test('mown turf keeps only a shallow ball-contact offset', () => {
  assert.equal(renderedBallSitDepth('rough', 0.02), 0.02);
  assert.equal(renderedBallSitDepth('fairway', 0.00396), 0.00297);
  assert.equal(renderedBallSitDepth('fringe', 0.008), 0.003);
  assert.equal(renderedBallSitDepth('sand', 0), 0);
});
