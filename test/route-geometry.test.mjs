import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inverseSitePoint, polylineDistance, polylinesCross, routeProjection, routeCorridorSignedDistance, compileRouteCorridor,
  transformLocalPoint, transformTee,
} from '../src/course/RouteGeometry.js';

test('site transforms round-trip points and preserve an oriented tee polygon', () => {
  const placement = { origin: { x: 80, z: -40 }, bearingDegrees: 127 };
  const local = { x: -12.5, z: -186.25 };
  const world = transformLocalPoint(local, placement);
  const roundTrip = inverseSitePoint(world, placement);
  assert.ok(Math.abs(roundTrip.x - local.x) < 1e-9);
  assert.ok(Math.abs(roundTrip.z - local.z) < 1e-9);
  const tee = transformTee({ x: 0, z: 2, boxHalfX: 4, z0: -3, z1: 7 }, placement);
  assert.equal(tee.shape.length, 4);
  assert.notEqual(tee.shape[0].x, tee.shape[1].x, 'bearing must affect the tee footprint');
});

test('route projection reports the shared closest point, tangent, progress, width, and SDF', () => {
  const route = { points: [{ x: 0, z: 0 }, { x: 0, z: -50 }, { x: 30, z: -80 }], c0: 10, k: 0.1, rough: 6 };
  const projection = routeProjection(route, 8, -25);
  assert.deepEqual(projection.closest, { x: 0, z: -25 });
  assert.deepEqual(projection.tangent, { x: 0, z: -1 });
  assert.ok(Math.abs(projection.progress - 25 / (50 + Math.hypot(30, 30))) < 1e-9);
  assert.equal(projection.halfWidth, 12.5);
  assert.equal(projection.signedDistance, 4.5);
});

test('routing geometry distinguishes actual crossings from separated envelopes', () => {
  const west = [{ x: -80, z: 100 }, { x: -70, z: -200 }];
  const east = [{ x: 90, z: -200 }, { x: 80, z: 100 }];
  const crossing = [{ x: -100, z: 0 }, { x: 100, z: 0 }];
  assert.equal(polylinesCross(west, east), false);
  assert.equal(polylinesCross(west, crossing), true);
  assert.ok(polylineDistance(west, east) > 140);
});

test('fairway start preserves the strategic route while leaving a native tee carry', () => {
  const route = { points: [{x:0,z:0},{x:0,z:-50},{x:30,z:-80}], c0:6,k:.035,rough:4 };
  const delayed = {...route, fairwayStartMeters:60};
  assert.deepEqual(routeProjection(delayed,3,-10), routeProjection(route,3,-10));
  assert.equal(compileRouteCorridor(delayed).length, compileRouteCorridor(route).length);
  assert.ok(routeCorridorSignedDistance(delayed,0,-10) < -4, 'native grass survives between isolated tees');
  const cut = compileRouteCorridor(delayed).surfaceSegments[0];
  assert.equal(cut.start,60);
  assert.ok(Math.abs(cut.a.x - Math.sqrt(50)) < 1e-9);
  assert.ok(Math.abs(cut.a.z + 50 + Math.sqrt(50)) < 1e-9);
  assert.equal(routeCorridorSignedDistance(delayed,cut.a.x,cut.a.z),8.1);
  for (const [x,z] of [[0,0],[8,-25],[20,-65],[200,200]]) {
    assert.equal(routeCorridorSignedDistance({...route,fairwayStartMeters:0},x,z),routeCorridorSignedDistance(route,x,z));
  }
  assert.equal(routeCorridorSignedDistance({...route,fairwayStartMeters:compileRouteCorridor(route).length},0,0),-Infinity);
});
