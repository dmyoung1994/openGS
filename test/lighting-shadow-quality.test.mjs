import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Vector3 } from 'three';
import { Lighting, resolveShadowQuality } from '../src/scene/Lighting.js';

const direction = new Vector3(-0.5, 0.85, 0.3).normalize();

test('shadow quality resolves map, near-course frustum, texel size, and thresholds', () => {
  const quality = resolveShadowQuality({ shadowMapSize: 2048 }, {
    shadow: {
      mapSize: 4096,
      frustum: { extent: 96, near: 2, far: 420 },
      focusThresholdMeters: 2.25,
      focusSnap: true,
      sunAngleThresholdRadians: 0.01,
      minUpdateIntervalMs: 40,
      maxSunUpdateIntervalMs: 260,
    },
  });

  assert.equal(quality.mapSize, 4096);
  assert.deepEqual(quality.frustum, {
    left: -96, right: 96, top: 96, bottom: -96, near: 2, far: 420,
  });
  assert.equal(quality.focusThresholdMeters, 2.25);
  assert.equal(quality.focusSnap, true);
  assert.equal(quality.sunAngleThresholdRadians, 0.01);
  assert.equal(quality.minUpdateIntervalMs, 40);
  assert.equal(quality.maxSunUpdateIntervalMs, 260);
  assert.equal(quality.texelWidth, 192 / 4096);
  assert.equal(quality.texelHeight, 192 / 4096);
});

test('resolved lighting keeps the exact tree shadow layer and stable focus footprint', () => {
  const lighting = new Lighting(new Scene(), direction, {
    id: 'quality',
    shadowMapSize: 2048,
    shadow: { extent: 96, focusThresholdMeters: 2, focusSnap: true },
  });

  assert.equal(lighting.sun.shadow.mapSize.x, 2048);
  assert.equal(lighting.sun.shadow.camera.left, -96);
  assert.equal(lighting.sun.shadow.camera.right, 96);
  assert.equal(lighting.sun.shadow.camera.near, 5);
  assert.equal(lighting.sun.shadow.camera.far, 700);
  assert.ok((lighting.sun.shadow.camera.layers.mask & (1 << 0)) !== 0);
  assert.ok((lighting.sun.shadow.camera.layers.mask & (1 << 1)) !== 0);

  lighting.sun.shadow.needsUpdate = false;
  lighting.follow(0, 0, { now: 0 });
  assert.equal(lighting.sun.shadow.needsUpdate, true);
  const firstTarget = lighting.sun.target.position.clone();

  lighting.sun.shadow.needsUpdate = false;
  lighting.markShadowRendered(1);
  lighting.follow(0.5, 0.5, { now: 2 });
  assert.equal(lighting.sun.shadow.needsUpdate, false, 'sub-threshold ball motion must retain the map');
  assert.deepEqual(lighting.sun.target.position.toArray(), firstTarget.toArray());

  lighting.follow(10, 10, {
    camera: { position: { x: 20, z: 20 } },
    cameraWeight: 0.5,
    now: 3,
  });
  assert.equal(lighting.sun.shadow.needsUpdate, true);
  assert.equal(lighting.readDiagnostics().focus.x, 15);
  assert.equal(lighting.readDiagnostics().focus.z, 15);
  lighting.dispose();
});

test('continuous sun updates direct-light direction without per-frame shadow redraws', () => {
  const lighting = new Lighting(new Scene(), direction, {
    shadowMapSize: 2048,
    shadow: {
      focusThresholdMeters: 2,
      sunAngleThresholdRadians: 0.01,
      minUpdateIntervalMs: 40,
      maxSunUpdateIntervalMs: 260,
    },
  });
  lighting.sun.shadow.needsUpdate = false;
  lighting.follow(0, 0, { now: 0 });
  lighting.sun.shadow.needsUpdate = false;
  lighting.markShadowRendered(1);

  const tinySunMove = direction.clone().applyAxisAngle(new Vector3(0, 1, 0), 0.002);
  assert.equal(lighting.setSunDirection(tinySunMove, { now: 10 }), false);
  assert.equal(lighting.sun.shadow.needsUpdate, false);
  assert.ok(lighting.sun.position.distanceTo(lighting.sun.target.position) > 100);

  const thresholdMove = direction.clone().applyAxisAngle(new Vector3(0, 1, 0), 0.02);
  assert.equal(lighting.setSunDirection(thresholdMove, { now: 20 }), false,
    'the minimum interval staggers a threshold crossing that arrives too soon');
  assert.equal(lighting.sun.shadow.needsUpdate, false);

  assert.equal(lighting.setSunDirection(thresholdMove, { now: 50 }), true);
  assert.equal(lighting.sun.shadow.needsUpdate, true);
  const diagnostics = lighting.readDiagnostics();
  assert.equal(diagnostics.lastShadowReason, 'sun-direction');
  assert.equal(diagnostics.shadowUpdateRequests, 2, 'one focus build plus one angular refresh');
  assert.ok(diagnostics.sunAngleSinceShadowRadians >= 0.01,
    'diagnostics retain the angle until the renderer reports completion');

  lighting.sun.shadow.needsUpdate = false;
  lighting.markShadowRendered(51);
  const updates = [];
  const unsubscribe = lighting.onShadowUpdate((event) => updates.push(event));
  const maxIntervalMove = thresholdMove.clone().applyAxisAngle(new Vector3(0, 1, 0), 0.002);
  assert.equal(lighting.setSunDirection(maxIntervalMove, { now: 320 }), true,
    'continuous motion receives a bounded refresh even when each step is small');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, 'shadow-update-requested');
  assert.equal(updates[0].reason, 'sun-direction');
  unsubscribe();

  const json = JSON.stringify(lighting.readDiagnostics());
  assert.ok(json.includes('shadowUpdateRequests'));
  lighting.dispose();
});
