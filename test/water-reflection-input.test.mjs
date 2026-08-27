import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DataTexture, Matrix4, RGBAFormat, UnsignedByteType,
} from 'three';
import {
  EnvironmentFrameState,
  ENVIRONMENT_FRAME_STATE_VERSION,
  ENVIRONMENT_WIND_ALGORITHM_VERSION,
} from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';
import {
  WATER_REFLECTION_PROFILES,
  WaterSurface,
  normalizeWaterReflectionInput,
} from '../src/scene/WaterSurface.js';

function environment() {
  return new EnvironmentGpuBindings(new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 17,
    tickSeconds: 1 / 120,
    sun: {
      azimuthRadians: 0.8, elevationRadians: 0.7, intensity: 85000,
      color: { r: 1, g: 0.94, b: 0.82 },
    },
    atmosphere: {
      turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005,
      mieDirectionalG: 0.76, exposure: 1,
    },
    clouds: {
      coverage: 0.34, density: 0.58, baseHeight: 1300,
      thickness: 720, advectionScale: 1,
    },
    wind: {
      speed: 2, directionRadians: 0.4, referenceHeight: 10,
      shearExponent: 0.18, gustStrength: 0.2, turbulenceStrength: 0.2,
      gustSpatialFrequency: 0.035, gustTemporalFrequency: 0.27,
    },
  }));
}

function texture(r = 24, g = 48, b = 72) {
  const value = new DataTexture(
    new Uint8Array([r, g, b, 255]), 1, 1, RGBAFormat, UnsignedByteType,
  );
  value.needsUpdate = true;
  return value;
}

function water() {
  return new WaterSurface({
    environment: environment(),
    pond: { x: 0, z: 0, r: 8, depth: 1.6 },
    level: 0,
    detailTexture: texture(128, 128, 0),
  });
}

test('reflection profiles encode the scalable premium workload', () => {
  assert.equal(WATER_REFLECTION_PROFILES.ultra.source, 'planar');
  assert.equal(WATER_REFLECTION_PROFILES.ultra.resolutionScale, 0.5);
  assert.equal(WATER_REFLECTION_PROFILES.ultra.updateIntervalFrames, 1);
  assert.equal(WATER_REFLECTION_PROFILES.quality.source, 'planar');
  assert.equal(WATER_REFLECTION_PROFILES.quality.resolutionScale, 0.25);
  assert.equal(WATER_REFLECTION_PROFILES.quality.updateIntervalFrames, 2);
  assert.equal(WATER_REFLECTION_PROFILES.mobile.source, 'analytic-local-probe');
  assert.equal(WATER_REFLECTION_PROFILES.mobile.resolutionScale, 0);
});

test('missing planar inputs fail closed to analytic sky', () => {
  const normalized = normalizeWaterReflectionInput({ mode: 'ultra' });
  assert.equal(normalized.mode, 'ultra');
  assert.equal(normalized.planarRequested, true);
  assert.equal(normalized.planarReady, false);
  assert.equal(normalized.source, 'analytic-sky');
  assert.equal(normalized.degradedReason, 'missing-color-texture');
  assert.equal(normalized.resolutionScale, 0.5);

  const aliased = normalizeWaterReflectionInput({ mode: 'quarter-resolution' });
  assert.equal(aliased.mode, 'quality');
  assert.equal(aliased.planarReady, false);
});

test('planar input carries color, depth, matrix, cadence, and temporal history', () => {
  const colorTexture = texture(180, 200, 220);
  const depthTexture = texture(255, 255, 255);
  const historyTexture = texture(160, 180, 210);
  const matrix = new Matrix4().makeTranslation(1, 2, 3);
  const previousMatrix = new Matrix4().makeTranslation(0.5, 2, 3);
  const normalized = normalizeWaterReflectionInput({
    mode: 'ultra',
    colorTexture,
    depthTexture,
    historyTexture,
    viewProjectionMatrix: matrix,
    previousViewProjectionMatrix: previousMatrix,
    width: 960,
    height: 540,
    revision: 12,
    frame: 20,
    lastUpdatedFrame: 19,
    historyWeight: 0.91,
    depthTolerance: 0.12,
    flipY: true,
  });

  assert.equal(normalized.source, 'planar');
  assert.equal(normalized.planarReady, true);
  assert.equal(normalized.currentValid, true);
  assert.equal(normalized.depthAvailable, true);
  assert.equal(normalized.historyValid, true);
  assert.equal(normalized.historyWeight, 0.91);
  assert.equal(normalized.staleFrames, 1);
  assert.deepEqual(normalized.viewProjectionElements, matrix.elements);
  assert.deepEqual(normalized.previousViewProjectionElements, previousMatrix.elements);
  assert.equal(normalized.width, 960);
  assert.equal(normalized.height, 540);
  assert.equal(normalized.flipY, true);
});

test('camera cuts invalidate reflection history', () => {
  const normalized = normalizeWaterReflectionInput({
    mode: 'quality',
    colorTexture: texture(),
    historyTexture: texture(),
    viewProjectionMatrix: new Matrix4(),
    frame: 10,
    lastUpdatedFrame: 10,
    cameraCut: true,
  });
  assert.equal(normalized.planarReady, true);
  assert.equal(normalized.historyValid, false);
  assert.equal(normalized.historyWeight, 0);
});

test('WaterSurface binds external planar input without owning the scene pass', () => {
  const surface = water();
  const colorTexture = texture(220, 220, 220);
  const input = {
    mode: 'ultra',
    colorTexture,
    depthTexture: texture(255, 255, 255),
    historyTexture: texture(200, 200, 200),
    viewProjectionMatrix: new Matrix4(),
    previousViewProjectionMatrix: new Matrix4(),
    size: { width: 1024, height: 512 },
    revision: 4,
    frame: 8,
    lastUpdatedFrame: 8,
  };

  assert.equal(surface.captureReflection(), false);
  assert.equal(surface.captureReflection(input), true);
  assert.equal(surface.getReflectionInput().colorTexture, colorTexture);
  const diagnostics = surface.reflectionDiagnostics();
  assert.equal(diagnostics.mode, 'ultra');
  assert.equal(diagnostics.source, 'planar');
  assert.deepEqual(diagnostics.size, { width: 1024, height: 512 });
  assert.equal(diagnostics.resolutionScale, 0.5);
  assert.equal(diagnostics.updateIntervalFrames, 1);
  assert.equal(diagnostics.depthAvailable, true);
  assert.equal(diagnostics.temporal.historyValid, true);
  assert.equal(diagnostics.ownership, 'external-scene-pass');

  surface.clearReflectionInput();
  assert.equal(surface.reflectionDiagnostics().mode, 'analytic');
  assert.equal(surface.reflectionDiagnostics().fixedCanvas, true);
  surface.dispose();
});

test('mobile local-probe mode keeps analytic sky as the fallback source', () => {
  const surface = water();
  surface.setReflectionInput({
    mode: 'mobile',
    localProbeTexture: texture(96, 124, 152),
  });
  const diagnostics = surface.reflectionInputDiagnostics();
  assert.equal(diagnostics.mode, 'analytic');
  assert.equal(diagnostics.requestedMode, 'mobile');
  assert.equal(diagnostics.source, 'local-probe+analytic-sky');
  assert.equal(diagnostics.planarReady, false);
  assert.equal(diagnostics.localProbe.available, true);
  assert.equal(diagnostics.localProbe.projection, 'equirectangular');
  assert.equal(diagnostics.fixedCanvas, true);
  surface.dispose();
});
