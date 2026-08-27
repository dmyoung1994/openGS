import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CIVIL_TWILIGHT_ELEVATION_RADIANS,
  ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
  ENVIRONMENT_TIMELINE_VERSION,
  EnvironmentTimeline,
  EnvironmentTimelineError,
  fromStaticEnvironmentConfig,
  toEnvironmentFrameStateConfig,
  validateEnvironmentTimelineConfig,
} from '../src/environment/EnvironmentTimeline.js';
import {
  ENVIRONMENT_FRAME_STATE_VERSION,
  ENVIRONMENT_WIND_ALGORITHM_VERSION,
} from '../src/environment/EnvironmentFrameState.js';

const WEATHER = {
  atmosphere: { turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005, mieDirectionalG: 0.76, exposure: 1 },
  clouds: { coverage: 0.26, density: 0.44, baseHeight: 1100, thickness: 1200, advectionScale: 1 },
  wind: {
    speed: 4, directionRadians: 0.4, referenceHeight: 10, shearExponent: 0.18,
    gustStrength: 0.28, turbulenceStrength: 0.4, gustSpatialFrequency: 0.035, gustTemporalFrequency: 0.27,
  },
};

function config(overrides = {}) {
  return {
    version: ENVIRONMENT_TIMELINE_VERSION,
    algorithmVersion: ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
    latitude: 37.7749,
    longitude: -122.4194,
    date: '2026-06-21',
    time: '19:00:00.000Z',
    playback: { paused: true, rate: 3600 },
    seed: 0x12345678,
    tickSeconds: 1 / 120,
    weather: WEATHER,
    ...overrides,
  };
}

test('versioned config normalizes UTC clock, aliases location, and freezes its boundary', () => {
  const normalized = validateEnvironmentTimelineConfig({
    ...config(),
    latitude: undefined,
    longitude: undefined,
    location: { latitudeDegrees: 37.7749, longitudeDegrees: -122.4194 },
  });
  assert.equal(normalized.latitude, 37.7749);
  assert.equal(normalized.longitude, -122.4194);
  assert.equal(normalized.date, '2026-06-21');
  assert.equal(normalized.time, '19:00:00.000Z');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.weather.keyframes));
  assert.equal(normalized.weather.keyframes.length, 1);
});

test('same timeline produces deterministic solar and weather snapshots', () => {
  const first = new EnvironmentTimeline(config());
  const second = new EnvironmentTimeline(config());
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.equal(first.snapshot().solar.algorithmVersion, 'noaa-solar-position-v1');
  assert.ok(first.snapshot().solar.elevationRadians > 0);
  assert.ok(first.snapshot().solar.intensity > 0);
});

test('solar position is physically ordered through daylight and uses true-north azimuth', () => {
  const timeline = new EnvironmentTimeline(config({ latitude: 37, longitude: 0, date: '2026-06-21', time: '12:00:00Z' }));
  const noon = timeline.snapshot().solar;
  assert.ok(noon.elevationRadians > 1.25, `expected summer noon, got ${noon.elevationRadians}`);
  assert.ok(Math.abs(noon.azimuthRadians - Math.PI) < 0.08, `expected sun south at noon, got ${noon.azimuthRadians}`);

  timeline.seek({ date: '2026-06-21', time: '06:00:00Z' });
  const morning = timeline.snapshot().solar;
  timeline.seek({ date: '2026-06-21', time: '18:00:00Z' });
  const evening = timeline.snapshot().solar;
  assert.ok(morning.elevationRadians < noon.elevationRadians);
  assert.ok(evening.elevationRadians < noon.elevationRadians);
  assert.ok(morning.azimuthRadians < Math.PI);
  assert.ok(evening.azimuthRadians > Math.PI);
});

test('dawn and night are finite, direct sun is extinguished, and frame mapping clamps only the legacy boundary', () => {
  const timeline = new EnvironmentTimeline(config({ latitude: 75, longitude: 0, date: '2026-12-21', time: '12:00:00Z' }));
  const snapshot = timeline.snapshot();
  assert.ok(snapshot.solar.elevationRadians < CIVIL_TWILIGHT_ELEVATION_RADIANS);
  assert.equal(snapshot.solar.intensity, 0);
  assert.ok(Number.isFinite(snapshot.solar.azimuthRadians));
  assert.ok(Number.isFinite(snapshot.solar.direction.y));
  const frame = timeline.frameStateConfig();
  assert.equal(frame.sun.elevationRadians, 0.001);
  assert.equal(frame.sun.intensity, 0);
  assert.ok(frame.sun.color.r >= 0 && frame.sun.color.b <= 64);
});

test('weather keyframes interpolate atmosphere and wrap wind direction over the shortest arc', () => {
  const timeline = new EnvironmentTimeline(config({
    time: '12:00:00Z',
    weather: {
      interpolation: 'linear',
      keyframes: [
        { at: '2026-06-21T12:00:00.000Z', atmosphere: { turbidity: 2 }, wind: { directionRadians: 6.1, speed: 2 } },
        { at: '2026-06-21T14:00:00.000Z', atmosphere: { turbidity: 6 }, wind: { directionRadians: 0.2, speed: 8 } },
      ],
    },
  }));
  timeline.seek('2026-06-21T13:00:00.000Z');
  const weather = timeline.snapshot().weather;
  assert.equal(weather.atmosphere.turbidity, 4);
  assert.equal(weather.wind.speed, 5);
  assert.ok(weather.wind.directionRadians < 0.2 || weather.wind.directionRadians > 6.0,
    `expected shortest wrap around north, got ${weather.wind.directionRadians}`);
});

test('pause, play, rate, seek, and advance have explicit deterministic semantics', () => {
  const timeline = new EnvironmentTimeline(config({ playback: { paused: true, rate: 60 } }));
  const start = timeline.snapshot();
  timeline.advance(10);
  assert.equal(timeline.snapshot().iso, start.iso);
  timeline.play();
  timeline.advance(10);
  assert.equal(timeline.snapshot().epochMilliseconds - start.epochMilliseconds, 600000);
  timeline.pause();
  timeline.advance(10);
  assert.equal(timeline.snapshot().epochMilliseconds, start.epochMilliseconds + 600000);
  timeline.advanceSimulation(30);
  assert.equal(timeline.snapshot().epochMilliseconds, start.epochMilliseconds + 630000);
  timeline.setPlaybackRate(-60).play();
  timeline.advance(5);
  assert.equal(timeline.snapshot().epochMilliseconds, start.epochMilliseconds + 330000);
});

test('static EnvironmentFrameState config maps to an exact paused timeline boundary', () => {
  const staticConfig = {
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 42,
    tickSeconds: 1 / 120,
    sun: { azimuthRadians: 1.2, elevationRadians: 0.8, intensity: 85000, color: { r: 1, g: 0.93, b: 0.78 } },
    atmosphere: WEATHER.atmosphere,
    clouds: WEATHER.clouds,
    wind: WEATHER.wind,
  };
  const timeline = fromStaticEnvironmentConfig(staticConfig, {
    latitude: 37.7, longitude: -122.4, date: '2026-06-21', time: '19:00:00Z',
  });
  assert.equal(timeline.paused, true);
  assert.equal(timeline.playbackRate, 0);
  assert.deepEqual(timeline.frameStateConfig(), staticConfig);
  assert.deepEqual(toEnvironmentFrameStateConfig(timeline.snapshot()), staticConfig);
});

test('invalid location, clock, weather, and solar configs fail closed', () => {
  assert.throws(() => new EnvironmentTimeline(config({ latitude: 91 })), EnvironmentTimelineError);
  assert.throws(() => new EnvironmentTimeline(config({ date: '2026-02-30' })), EnvironmentTimelineError);
  assert.throws(() => new EnvironmentTimeline(config({ time: '24:00:00Z' })), EnvironmentTimelineError);
  assert.throws(() => new EnvironmentTimeline(config({ weather: { keyframes: [] } })), EnvironmentTimelineError);
  assert.throws(() => new EnvironmentTimeline(config({ solar: { mode: 'fixed', azimuthRadians: 0, elevationRadians: 0.5, intensity: 1 } })), EnvironmentTimelineError);
  assert.throws(() => new EnvironmentTimeline(config({ playback: { paused: 'yes', rate: 1 } })), EnvironmentTimelineError);
});
