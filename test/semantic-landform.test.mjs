import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticLandformHeight } from '../src/course/SemanticLandforms.js';

test('semantic landforms are smooth signed collision-authoritative contributions', () => {
  const ridge = [{ kind: 'ridge', points: [{ x: 0, z: 0 }, { x: 0, z: -80 }], width: 20, height: 3, falloff: 15 }];
  assert.equal(semanticLandformHeight(ridge, 0, -40), 3);
  assert.ok(semanticLandformHeight(ridge, 8, -40) > 0);
  assert.equal(semanticLandformHeight(ridge, 30, -40), 0);
  const swale = [{ ...ridge[0], kind: 'swale', height: -2 }];
  assert.equal(semanticLandformHeight(swale, 0, -40), -2);
});
