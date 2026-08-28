import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Vector3 } from 'three';
import { Lighting } from '../src/scene/Lighting.js';
import { TreeShadowProxy } from '../src/scene/Trees.js';
import {
  ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';

const tier = { shadowMapSize: 2048 };

test('directional shadow starts dirty and follow invalidates the retained map', () => {
  const lighting = new Lighting(new Scene(), new Vector3(-0.5, 0.85, 0.3).normalize(), tier);

  assert.equal(lighting.sun.shadow.autoUpdate, false);
  assert.equal(lighting.sun.shadow.needsUpdate, true);

  lighting.sun.shadow.needsUpdate = false;
  lighting.follow(37, -142);

  assert.equal(lighting.sun.shadow.needsUpdate, true);
  assert.equal(lighting.sun.target.position.x, 37);
  assert.equal(lighting.sun.target.position.z, -142);
});

test('flight follow coalesces the pre-follow ball invalidation and sub-texel motion', () => {
  const lighting = new Lighting(new Scene(), new Vector3(-0.5, 0.85, 0.3).normalize(), tier);
  lighting.sun.shadow.needsUpdate = false;
  lighting.follow(0, 0);
  assert.equal(lighting.sun.shadow.needsUpdate, true);

  // This is the order used by the gameplay loop: the ball upload invalidates
  // first, then follow() decides whether the shadow frustum really moved.
  lighting.sun.shadow.needsUpdate = false;
  lighting.invalidateShadow();
  assert.equal(lighting.sun.shadow.needsUpdate, false);
  lighting.follow(0.5, 0.5);
  assert.equal(lighting.sun.shadow.needsUpdate, false);
  lighting.follow(7, 0);
  assert.equal(lighting.sun.shadow.needsUpdate, true);
});

test('course coverage keeps one stable shadow projection throughout a ball flight', () => {
  const lighting = new Lighting(new Scene(), new Vector3(-0.72, 0.60, -0.32).normalize(), tier);
  lighting.sun.shadow.needsUpdate = false;
  lighting.setCourseShadowCoverage({ minX: -110, maxX: 110, minZ: -340, maxZ: 30 }, { now: 0 });
  const initial = lighting.readDiagnostics();
  const target = lighting.sun.target.position.clone();
  assert.ok(initial.frustum.right > 200, 'the complete course must fit across the light-space X axis');
  assert.ok(initial.texelSizeMeters.x > 0.2,
    'diagnostics must report the fitted map density rather than the pre-coverage default');
  assert.equal(initial.courseCoverage.anchor.z, -155);

  lighting.sun.shadow.needsUpdate = false;
  lighting.markShadowRendered(1);
  assert.equal(lighting.follow(0, 0, { now: 2 }), false);
  assert.equal(lighting.follow(18, -285, { now: 3 }), false);
  assert.equal(lighting.sun.shadow.needsUpdate, false);
  assert.deepEqual(lighting.sun.target.position.toArray(), target.toArray(),
    'ball motion must not reproject cached terrain and tree shadows');
  assert.equal(lighting.readDiagnostics().focus.z, -285,
    'diagnostics still report the live point of interest');
});

test('lighting key direction, color, and intensity consume shared daylight state', () => {
  const state = new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 9, tickSeconds: 1 / 120,
    sun: { azimuthRadians: 0.7, elevationRadians: 0.65, intensity: 42500, color: { r: 1, g: 0.8, b: 0.6 } },
    moon: { azimuthRadians: 4.0, elevationRadians: -0.4, intensity: 0, color: { r: 0.78, g: 0.84, b: 1 }, illuminatedFraction: 0.8, angularRadiusRadians: 0.0045, phaseAngleRadians: 0.6 },
    atmosphere: { turbidity: 2.4, rayleigh: 1.5, mieCoefficient: 0.004, mieDirectionalG: 0.76, exposure: 1 },
    clouds: { coverage: 0.3, density: 0.5, baseHeight: 1200, thickness: 650, advectionScale: 1 },
    wind: { speed: 0, directionRadians: 0, referenceHeight: 10, shearExponent: 0.2, gustStrength: 0, turbulenceStrength: 0, gustSpatialFrequency: 0.035, gustTemporalFrequency: 0.27 },
  });
  const environment = new EnvironmentGpuBindings(state);
  const lighting = new Lighting(new Scene(), new Vector3(0, 1, 0), tier).configureEnvironment(environment);
  assert.ok(lighting._offset.clone().normalize().distanceTo(environment.sunDirection.value) < 1e-6);
  assert.equal(lighting.sun.intensity, 1.675);
  assert.ok(Math.abs(lighting.sun.color.r - 1) < 1e-6);
  assert.ok(Math.abs(lighting.sun.color.g - 0.8) < 1e-6);
  assert.ok(lighting.hemi.intensity > 0.28 && lighting.hemi.intensity < 0.29);
  assert.ok(lighting.sun.intensity / lighting.hemi.intensity > 5.5,
    'the shared directional key must remain legible over hemispherical sky return');
  assert.equal(lighting.scene.children.filter((child) => child.isDirectionalLight).length, 1,
    'daylight rig must not add a counter-fill direction');
  assert.ok(lighting.hemi.groundColor.r > 0.10 && lighting.hemi.groundColor.b > 0.17);
  lighting.dispose();
});

test('tree shadow compaction dispatches only for ShadowNode dirty frames', () => {
  const lighting = new Lighting(new Scene(), new Vector3(-0.5, 0.85, 0.3).normalize(), tier);
  const dispatches = [];
  const proxy = Object.create(TreeShadowProxy.prototype);
  proxy.light = lighting.sun;
  proxy.renderer = { compute: (node) => dispatches.push(node) };
  proxy._clearCompute = { name: 'clear' };
  proxy._compactCompute = { name: 'compact' };
  proxy.uLightViewProjection = { value: lighting.sun.shadow.camera.projectionMatrix.clone() };

  lighting.sun.shadow.needsUpdate = false;
  assert.equal(proxy.update(), false);
  assert.equal(dispatches.length, 0);

  lighting.invalidateShadow();
  assert.equal(proxy.update(), true);
  assert.deepEqual(dispatches, [proxy._clearCompute, proxy._compactCompute]);
});
