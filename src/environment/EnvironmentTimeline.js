import {
  ENVIRONMENT_FRAME_STATE_VERSION,
  ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from './EnvironmentFrameState.js';

/**
 * Versioned, renderer-independent daylight and weather clock.
 *
 * The timeline uses UTC for its authored clock.  `longitude` is degrees east of
 * Greenwich and the solar azimuth convention is the same one used by the
 * environment GPU snapshot: 0 is true north (+Z), increasing clockwise toward
 * +X/east.  Keeping the astronomical clock here, rather than in a renderer,
 * makes lighting, atmosphere, water, captures, and physics consume one answer.
 */

export const ENVIRONMENT_TIMELINE_VERSION = 1;
export const ENVIRONMENT_TIMELINE_ALGORITHM_VERSION = 'environment-timeline-v1';
export const ENVIRONMENT_TIMELINE_SOLAR_ALGORITHM_VERSION = 'noaa-solar-position-v1';
export const ENVIRONMENT_TIMELINE_WEATHER_ALGORITHM_VERSION = 'weather-keyframes-v1';
export const ENVIRONMENT_TIMELINE_CONFIG_VERSION = ENVIRONMENT_TIMELINE_VERSION;

export const MIN_FRAME_SUN_ELEVATION_RADIANS = 0.001;
export const CIVIL_TWILIGHT_ELEVATION_RADIANS = -6 * Math.PI / 180;
export const SOLAR_DAYLIGHT_ELEVATION_RADIANS = 0;

const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MIN_SUPPORTED_YEAR = 1;
const MAX_SUPPORTED_YEAR = 9999;
const MAX_WIND_SPEED_MPS = 15.6464;
const MAX_PLAYBACK_RATE = 86400;
const MAX_DATE_MILLISECONDS = 8.64e15;

const ATMOSPHERE_DEFAULTS = Object.freeze({
  turbidity: 2.3,
  rayleigh: 1.7,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.76,
  exposure: 1,
});

const CLOUD_DEFAULTS = Object.freeze({
  coverage: 0.26,
  density: 0.44,
  baseHeight: 1100,
  thickness: 1200,
  advectionScale: 1,
});

const WIND_DEFAULTS = Object.freeze({
  speed: 0,
  directionRadians: 0,
  referenceHeight: 10,
  shearExponent: 0.18,
  gustStrength: 0.28,
  turbulenceStrength: 0,
  gustSpatialFrequency: 0.035,
  gustTemporalFrequency: 0.27,
});

const ROOT_KEYS = new Set([
  'version', 'algorithmVersion',
  'latitude', 'longitude', 'latitudeDegrees', 'longitudeDegrees', 'elevationMeters', 'location',
  'date', 'time', 'clock', 'playback',
  'seed', 'tickSeconds', 'solar', 'weather',
]);
const LOCATION_KEYS = new Set(['latitude', 'longitude', 'latitudeDegrees', 'longitudeDegrees', 'elevationMeters']);
const CLOCK_KEYS = new Set(['date', 'time', 'playback']);
const PLAYBACK_KEYS = new Set(['rate', 'paused']);
const SOLAR_KEYS = new Set(['mode', 'azimuthRadians', 'elevationRadians', 'intensity', 'color']);
const WEATHER_KEYS = new Set(['interpolation', 'keyframes', 'atmosphere', 'clouds', 'wind', 'default']);
const WEATHER_FRAME_KEYS = new Set(['at', 'time', 'atmosphere', 'clouds', 'wind']);
const ATMOSPHERE_KEYS = new Set(Object.keys(ATMOSPHERE_DEFAULTS));
const CLOUD_KEYS = new Set(Object.keys(CLOUD_DEFAULTS));
const WIND_KEYS = new Set(Object.keys(WIND_DEFAULTS));
const COLOR_KEYS = new Set(['r', 'g', 'b']);

export class EnvironmentTimelineError extends Error {
  constructor(message) {
    super(`EnvironmentTimeline config invalid: ${message}`);
    this.name = 'EnvironmentTimelineError';
  }
}

function fail(message) {
  throw new EnvironmentTimelineError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value, name) {
  if (!isObject(value)) fail(`${name} is required.`);
  return value;
}

function rejectUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${name}.${key} is not supported.`);
  }
}

function finite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}].`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean.`);
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(value) {
  const result = ((value % TAU) + TAU) % TAU;
  return result === TAU ? 0 : result;
}

function normalizeDirection(value) {
  // EnvironmentFrameState historically accepts exactly TAU. Preserve that
  // authored spelling for static compatibility even though it is equivalent to 0.
  if (value === TAU) return TAU;
  if (value >= 0 && value <= TAU) return value;
  return normalizeAngle(value);
}

function shortestAngleDelta(from, to) {
  return ((to - from + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

function interpolateAngle(from, to, amount) {
  return normalizeAngle(from + shortestAngleDelta(from, to) * amount);
}

function smoothstep(amount) {
  return amount * amount * (3 - 2 * amount);
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function color(value, name, fallback = null) {
  const source = value === undefined ? fallback : object(value, name);
  if (!source) fail(`${name} is required.`);
  rejectUnknown(source, COLOR_KEYS, name);
  return freeze({
    r: finite(source.r, `${name}.r`, 0, 64),
    g: finite(source.g, `${name}.g`, 0, 64),
    b: finite(source.b, `${name}.b`, 0, 64),
  });
}

function normalizedDateParts(value, name) {
  if (typeof value !== 'string') fail(`${name} must be an ISO UTC date string (YYYY-MM-DD).`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail(`${name} must be an ISO UTC date string (YYYY-MM-DD).`);
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (parts.year < MIN_SUPPORTED_YEAR || parts.year > MAX_SUPPORTED_YEAR) {
    fail(`${name} year must be in [${MIN_SUPPORTED_YEAR}, ${MAX_SUPPORTED_YEAR}].`);
  }
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    fail(`${name} is not a valid calendar date.`);
  }
  const epoch = utcEpoch(parts, { hour: 0, minute: 0, second: 0, millisecond: 0 });
  const check = new Date(epoch);
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) {
    fail(`${name} is not a valid calendar date.`);
  }
  return parts;
}

function normalizedTimeParts(value, name) {
  if (typeof value === 'number') {
    finite(value, name, 0, 86400 - 0.001);
    const millisecondsSinceMidnight = Math.round(value * 1000);
    if (millisecondsSinceMidnight >= 86400000) fail(`${name} must remain within the authored UTC day.`);
    const wholeSeconds = Math.floor(millisecondsSinceMidnight / 1000);
    const millisecond = millisecondsSinceMidnight % 1000;
    return {
      hour: Math.floor(wholeSeconds / 3600),
      minute: Math.floor((wholeSeconds % 3600) / 60),
      second: wholeSeconds % 60,
      millisecond,
    };
  }
  if (typeof value !== 'string') fail(`${name} must be a UTC time string (HH:mm:ss[.sss]Z).`);
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(value);
  if (!match) fail(`${name} must be a UTC time string (HH:mm:ss[.sss]Z).`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const millisecond = match[4] ? Number(match[4].padEnd(3, '0')) : 0;
  if (hour > 23 || minute > 59 || second > 59 || millisecond > 999) {
    fail(`${name} is not a valid UTC time.`);
  }
  return { hour, minute, second, millisecond };
}

function utcEpoch(dateParts, timeParts) {
  // Date.UTC maps years 0..99 to 1900..1999. Constructing from epoch and then
  // setting the full year keeps the supported ISO range deterministic.
  const date = new Date(0);
  date.setUTCFullYear(dateParts.year, dateParts.month - 1, dateParts.day);
  date.setUTCHours(timeParts.hour, timeParts.minute, timeParts.second, timeParts.millisecond);
  return date.getTime();
}

function assertSupportedEpoch(epoch, name) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || Math.abs(epoch) > MAX_DATE_MILLISECONDS) {
    fail(`${name} must identify a supported UTC instant.`);
  }
  const year = new Date(epoch).getUTCFullYear();
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
    fail(`${name} must identify a year in [${MIN_SUPPORTED_YEAR}, ${MAX_SUPPORTED_YEAR}].`);
  }
  return epoch;
}

function formatInstant(epoch) {
  const iso = new Date(epoch).toISOString();
  return Object.freeze({ date: iso.slice(0, 10), time: iso.slice(11) });
}

function parseIsoInstant(value, name) {
  if (typeof value !== 'string') fail(`${name} must be an ISO UTC instant.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) fail(`${name} must be an ISO UTC instant ending in Z.`);
  const date = normalizedDateParts(`${match[1]}-${match[2]}-${match[3]}`, `${name}.date`);
  const time = normalizedTimeParts(`${match[4]}:${match[5]}:${match[6]}${match[7] ? `.${match[7]}` : ''}Z`, `${name}.time`);
  return assertSupportedEpoch(utcEpoch(date, time), name);
}

function parseTimelineInstant(value, name, initialEpoch = null) {
  if (typeof value === 'number') {
    finite(value, name, -MAX_DATE_MILLISECONDS / 1000, MAX_DATE_MILLISECONDS / 1000);
    if (initialEpoch === null) return assertSupportedEpoch(value, name);
    return assertSupportedEpoch(initialEpoch + value * 1000, name);
  }
  if (value instanceof Date) {
    return assertSupportedEpoch(value.getTime(), name);
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = normalizedDateParts(value, name);
      return assertSupportedEpoch(utcEpoch(date, { hour: 0, minute: 0, second: 0, millisecond: 0 }), name);
    }
    return parseIsoInstant(value, name);
  }
  fail(`${name} must be a Date, epoch milliseconds, or ISO UTC instant.`);
}

function normalizedSection(raw, defaults, keys, ranges, name) {
  const source = raw === undefined ? {} : object(raw, name);
  rejectUnknown(source, keys, name);
  const output = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    output[key] = finite(source[key] ?? defaults[key], `${name}.${key}`, min, max);
  }
  return output;
}

function normalizedWeatherState(raw, fallback, name) {
  const source = raw === undefined ? {} : object(raw, name);
  rejectUnknown(source, new Set(['atmosphere', 'clouds', 'wind']), name);
  const atmosphere = normalizedSection(
    source.atmosphere,
    fallback.atmosphere,
    ATMOSPHERE_KEYS,
    {
      turbidity: [1, 10], rayleigh: [0, 8], mieCoefficient: [0, 0.1],
      mieDirectionalG: [0, 0.999], exposure: [0.05, 20],
    },
    `${name}.atmosphere`,
  );
  const clouds = normalizedSection(
    source.clouds,
    fallback.clouds,
    CLOUD_KEYS,
    { coverage: [0, 0.7], density: [0, 1], baseHeight: [250, 6000], thickness: [50, 4000], advectionScale: [0, 4] },
    `${name}.clouds`,
  );
  const wind = normalizedSection(
    source.wind,
    fallback.wind,
    WIND_KEYS,
    {
      speed: [0, MAX_WIND_SPEED_MPS], directionRadians: [-64 * TAU, 64 * TAU],
      referenceHeight: [0.1, 100], shearExponent: [0, 1.5], gustStrength: [0, 1],
      turbulenceStrength: [0, MAX_WIND_SPEED_MPS], gustSpatialFrequency: [0.0001, 4],
      gustTemporalFrequency: [0, 4],
    },
    `${name}.wind`,
  );
  wind.directionRadians = normalizeDirection(wind.directionRadians);
  return freeze({ atmosphere: freeze(atmosphere), clouds: freeze(clouds), wind: freeze(wind) });
}

function normalizeWeather(raw, initialEpoch) {
  const source = raw === undefined ? {} : object(raw, 'weather');
  rejectUnknown(source, WEATHER_KEYS, 'weather');
  const interpolation = source.interpolation ?? 'smoothstep';
  if (interpolation !== 'linear' && interpolation !== 'smoothstep') {
    fail('weather.interpolation must be "linear" or "smoothstep".');
  }

  const defaultSource = source.default === undefined ? {} : object(source.default, 'weather.default');
  rejectUnknown(defaultSource, new Set(['atmosphere', 'clouds', 'wind']), 'weather.default');
  const directSource = {
    atmosphere: source.atmosphere ?? defaultSource.atmosphere,
    clouds: source.clouds ?? defaultSource.clouds,
    wind: source.wind ?? defaultSource.wind,
  };
  const baseline = normalizedWeatherState(directSource, {
    atmosphere: ATMOSPHERE_DEFAULTS,
    clouds: CLOUD_DEFAULTS,
    wind: WIND_DEFAULTS,
  }, 'weather');

  const rawKeyframes = source.keyframes === undefined ? null : source.keyframes;
  if (rawKeyframes !== null && (!Array.isArray(rawKeyframes) || rawKeyframes.length === 0)) {
    fail('weather.keyframes must be a non-empty array.');
  }
  const entries = rawKeyframes ?? [{ at: new Date(initialEpoch).toISOString(), atmosphere: baseline.atmosphere, clouds: baseline.clouds, wind: baseline.wind }];
  const keyframes = entries.map((rawFrame, index) => {
    const frame = object(rawFrame, `weather.keyframes[${index}]`);
    rejectUnknown(frame, WEATHER_FRAME_KEYS, `weather.keyframes[${index}]`);
    const rawAt = frame.at ?? frame.time;
    if (rawAt === undefined && entries.length > 1) fail(`weather.keyframes[${index}].at is required when multiple keyframes are authored.`);
    const at = rawAt === undefined
      ? initialEpoch
      : typeof rawAt === 'number'
        ? parseTimelineInstant(rawAt, `weather.keyframes[${index}].at`, initialEpoch)
        : parseTimelineInstant(rawAt, `weather.keyframes[${index}].at`);
    const state = normalizedWeatherState({
      atmosphere: frame.atmosphere,
      clouds: frame.clouds,
      wind: frame.wind,
    }, baseline, `weather.keyframes[${index}]`);
    return { at, state };
  }).sort((a, b) => a.at - b.at);
  for (let index = 1; index < keyframes.length; index++) {
    if (keyframes[index - 1].at === keyframes[index].at) {
      fail(`weather.keyframes must not contain duplicate times (${formatInstant(keyframes[index].at).time}).`);
    }
  }

  const publicKeyframes = keyframes.map(({ at, state }) => ({
    at: new Date(at).toISOString(),
    atmosphere: state.atmosphere,
    clouds: state.clouds,
    wind: state.wind,
  }));
  return {
    value: freeze({
      algorithmVersion: ENVIRONMENT_TIMELINE_WEATHER_ALGORITHM_VERSION,
      interpolation,
      keyframes: freeze(publicKeyframes),
    }),
    keyframes: freeze(keyframes),
  };
}

function normalizeSolar(raw) {
  const source = raw === undefined ? { mode: 'computed' } : object(raw, 'solar');
  rejectUnknown(source, SOLAR_KEYS, 'solar');
  const mode = source.mode ?? 'computed';
  if (mode !== 'computed' && mode !== 'fixed') fail('solar.mode must be "computed" or "fixed".');
  if (mode === 'computed') return freeze({ mode, algorithmVersion: ENVIRONMENT_TIMELINE_SOLAR_ALGORITHM_VERSION });
  return freeze({
    mode,
    azimuthRadians: finite(source.azimuthRadians, 'solar.azimuthRadians', -64 * TAU, 64 * TAU),
    elevationRadians: finite(source.elevationRadians, 'solar.elevationRadians', -Math.PI / 2, Math.PI / 2),
    intensity: finite(source.intensity, 'solar.intensity', 0, 100000),
    color: color(source.color, 'solar.color'),
  });
}

function normalizeTimelineConfig(raw) {
  const root = object(raw, 'config');
  rejectUnknown(root, ROOT_KEYS, 'config');
  if (root.version !== ENVIRONMENT_TIMELINE_VERSION) {
    fail(`version must equal ${ENVIRONMENT_TIMELINE_VERSION}.`);
  }
  if (root.algorithmVersion !== ENVIRONMENT_TIMELINE_ALGORITHM_VERSION) {
    fail(`algorithmVersion must equal ${ENVIRONMENT_TIMELINE_ALGORITHM_VERSION}.`);
  }

  const location = root.location === undefined ? {} : object(root.location, 'config.location');
  rejectUnknown(location, LOCATION_KEYS, 'config.location');
  const latitude = root.latitude ?? root.latitudeDegrees ?? location.latitude ?? location.latitudeDegrees;
  const longitude = root.longitude ?? root.longitudeDegrees ?? location.longitude ?? location.longitudeDegrees;
  if (latitude === undefined || longitude === undefined) fail('latitude and longitude are required.');
  const normalizedLatitude = finite(latitude, 'latitude', -90, 90);
  const normalizedLongitude = finite(longitude, 'longitude', -180, 180);
  const elevationMeters = finite(root.elevationMeters ?? location.elevationMeters ?? 0, 'elevationMeters', -500, 10000);

  const clock = root.clock === undefined ? {} : object(root.clock, 'config.clock');
  rejectUnknown(clock, CLOCK_KEYS, 'config.clock');
  const dateValue = root.date ?? clock.date;
  const timeValue = root.time ?? clock.time;
  if (dateValue === undefined || timeValue === undefined) fail('date and time are required.');
  const date = normalizedDateParts(dateValue, 'date');
  const time = normalizedTimeParts(timeValue, 'time');
  const initialEpoch = assertSupportedEpoch(utcEpoch(date, time), 'date/time');

  const playbackSource = root.playback ?? clock.playback ?? {};
  const playback = object(playbackSource, 'playback');
  rejectUnknown(playback, PLAYBACK_KEYS, 'playback');
  const playbackRate = finite(playback.rate ?? 1, 'playback.rate', -MAX_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  const paused = playback.paused === undefined ? false : boolean(playback.paused, 'playback.paused');

  const seed = integer(root.seed ?? 0, 'seed', 0, 0xffffffff) >>> 0;
  const tickSeconds = finite(root.tickSeconds ?? 1 / 120, 'tickSeconds', 1 / 1000, 1);
  const weather = normalizeWeather(root.weather, initialEpoch);
  const solar = normalizeSolar(root.solar);
  const formatted = formatInstant(initialEpoch);

  return {
    value: freeze({
      version: root.version,
      algorithmVersion: root.algorithmVersion,
      latitude: normalizedLatitude,
      longitude: normalizedLongitude,
      elevationMeters,
      date: formatted.date,
      time: formatted.time,
      playback: freeze({ rate: playbackRate, paused }),
      seed,
      tickSeconds,
      solar,
      weather: weather.value,
    }),
    epochMilliseconds: initialEpoch,
    weatherKeyframes: weather.keyframes,
  };
}

function relativeAirMass(elevationDegrees) {
  if (elevationDegrees <= -5) return Infinity;
  const corrected = Math.max(elevationDegrees, -4.9);
  const radians = corrected * DEG_TO_RAD;
  return 1 / (Math.sin(radians) + 0.50572 * Math.pow(corrected + 6.07995, -1.6364));
}

function refractionDegrees(elevationDegrees) {
  if (elevationDegrees > 85 || elevationDegrees < -5) return 0;
  let arcSeconds;
  if (elevationDegrees > 5) {
    const tangent = Math.tan(elevationDegrees * DEG_TO_RAD);
    arcSeconds = 58.1 / tangent - 0.07 / (tangent ** 3) + 0.000086 / (tangent ** 5);
  } else {
    arcSeconds = 1735 + elevationDegrees * (-518.2 + elevationDegrees * (103.4 + elevationDegrees * (-12.79 + elevationDegrees * 0.711)));
  }
  return arcSeconds / 3600;
}

function blackbodyColor(kelvin) {
  const temperature = clamp(kelvin, 1000, 40000) / 100;
  let red;
  let green;
  let blue;
  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * ((temperature - 60) ** -0.1332047592);
    green = 288.1221695283 * ((temperature - 60) ** -0.0755148492);
    blue = 255;
  }
  return freeze({
    r: clamp(red / 255, 0, 1),
    g: clamp(green / 255, 0, 1),
    b: clamp(blue / 255, 0, 1),
  });
}

function solarColor(elevationRadians, atmosphere, airMass) {
  const path = Number.isFinite(airMass) ? Math.max(1, airMass) : 40;
  const temperature = clamp(
    5800 - (path - 1) * 850 - (atmosphere.turbidity - 2) * 120,
    3000,
    6500,
  );
  // Keep a barely visible twilight chromaticity for diagnostics while direct
  // illuminance is zero below the geometric horizon.
  void elevationRadians;
  return blackbodyColor(temperature);
}

function computeSolarPosition(epochMilliseconds, latitudeDegrees, longitudeDegrees, atmosphere, clouds) {
  const date = new Date(epochMilliseconds);
  const julianDay = epochMilliseconds / 86400000 + 2440587.5;
  const century = (julianDay - 2451545.0) / 36525;
  const meanLongitude = normalizeAngle((280.46646 + century * (36000.76983 + century * 0.0003032)) * DEG_TO_RAD);
  const meanAnomaly = (357.52911 + century * (35999.05029 - 0.0001537 * century)) * DEG_TO_RAD;
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const equationCenter = (
    Math.sin(meanAnomaly) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * century)
    + Math.sin(3 * meanAnomaly) * 0.000289
  ) * DEG_TO_RAD;
  const trueLongitude = meanLongitude + equationCenter;
  const omega = (125.04 - 1934.136 * century) * DEG_TO_RAD;
  const apparentLongitude = trueLongitude - 0.00569 * DEG_TO_RAD - 0.00478 * Math.sin(omega) * DEG_TO_RAD;
  const meanObliquity = (
    23 + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60
  ) * DEG_TO_RAD;
  const obliquity = meanObliquity + 0.00256 * DEG_TO_RAD * Math.cos(omega);
  const declination = Math.asin(clamp(Math.sin(obliquity) * Math.sin(apparentLongitude), -1, 1));
  const y = Math.tan(obliquity / 2) ** 2;
  const equationOfTimeMinutes = 4 * RAD_TO_DEG * (
    y * Math.sin(2 * meanLongitude)
    - 2 * eccentricity * Math.sin(meanAnomaly)
    + 4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * meanLongitude)
    - 0.5 * y * y * Math.sin(4 * meanLongitude)
    - 1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly)
  );
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  const trueSolarMinutes = ((utcMinutes + equationOfTimeMinutes + longitudeDegrees * 4) % 1440 + 1440) % 1440;
  let hourAngleDegrees = trueSolarMinutes / 4 - 180;
  if (hourAngleDegrees < -180) hourAngleDegrees += 360;
  const hourAngle = hourAngleDegrees * DEG_TO_RAD;
  const latitude = latitudeDegrees * DEG_TO_RAD;
  const cosineZenith = clamp(
    Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
    -1,
    1,
  );
  const geometricElevation = Math.asin(cosineZenith);
  const azimuth = normalizeAngle(
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
    ) + Math.PI,
  );
  const geometricElevationDegrees = geometricElevation * RAD_TO_DEG;
  const apparentElevation = geometricElevation + refractionDegrees(geometricElevationDegrees) * DEG_TO_RAD;
  const airMass = relativeAirMass(geometricElevationDegrees);
  const cloudTransmission = 1 - 0.55 * clouds.coverage * clouds.density;
  const opticalDepth = (0.075 + (atmosphere.turbidity - 1) * 0.015 + atmosphere.rayleigh * 0.005) * (Number.isFinite(airMass) ? airMass : 40);
  const atmosphericTransmission = Math.exp(-Math.max(0, opticalDepth));
  const intensity = geometricElevation > SOLAR_DAYLIGHT_ELEVATION_RADIANS
    ? 110000 * atmosphericTransmission * cloudTransmission
    : 0;
  const directionElevation = geometricElevation;
  const horizontal = Math.cos(directionElevation);
  const direction = freeze({
    x: Math.sin(azimuth) * horizontal,
    y: Math.sin(directionElevation),
    z: Math.cos(azimuth) * horizontal,
  });
  const daylightFactor = smoothstep(0, 8 * DEG_TO_RAD, geometricElevation);
  return freeze({
    algorithmVersion: ENVIRONMENT_TIMELINE_SOLAR_ALGORITHM_VERSION,
    azimuthRadians: azimuth,
    elevationRadians: geometricElevation,
    apparentElevationRadians: apparentElevation,
    direction,
    intensity,
    color: solarColor(geometricElevation, atmosphere, airMass),
    airMass: Number.isFinite(airMass) ? airMass : null,
    atmosphericTransmission,
    cloudTransmission,
    aboveHorizon: geometricElevation > SOLAR_DAYLIGHT_ELEVATION_RADIANS,
    civilTwilight: geometricElevation >= CIVIL_TWILIGHT_ELEVATION_RADIANS,
    daylightFactor,
  });
}

function fixedSolarPosition(solar) {
  const elevation = solar.elevationRadians;
  const azimuth = solar.azimuthRadians >= 0 && solar.azimuthRadians <= TAU
    ? solar.azimuthRadians
    : normalizeAngle(solar.azimuthRadians);
  const horizontal = Math.cos(elevation);
  return freeze({
    algorithmVersion: 'authored-static-solar-v1',
    azimuthRadians: azimuth,
    elevationRadians: elevation,
    apparentElevationRadians: elevation,
    direction: freeze({
      x: Math.sin(azimuth) * horizontal,
      y: Math.sin(elevation),
      z: Math.cos(azimuth) * horizontal,
    }),
    intensity: solar.intensity,
    color: solar.color,
    airMass: null,
    atmosphericTransmission: null,
    cloudTransmission: null,
    aboveHorizon: elevation > 0,
    civilTwilight: elevation >= CIVIL_TWILIGHT_ELEVATION_RADIANS,
    daylightFactor: smoothstep(0, 8 * DEG_TO_RAD, elevation),
  });
}

function interpolateWeatherState(first, second, amount, mode) {
  const blend = mode === 'smoothstep' ? smoothstep(amount) : amount;
  const atmosphere = {};
  const clouds = {};
  const wind = {};
  for (const key of Object.keys(first.atmosphere)) atmosphere[key] = lerp(first.atmosphere[key], second.atmosphere[key], blend);
  for (const key of Object.keys(first.clouds)) clouds[key] = lerp(first.clouds[key], second.clouds[key], blend);
  for (const key of Object.keys(first.wind)) wind[key] = lerp(first.wind[key], second.wind[key], blend);
  wind.directionRadians = interpolateAngle(first.wind.directionRadians, second.wind.directionRadians, blend);
  return freeze({ atmosphere: freeze(atmosphere), clouds: freeze(clouds), wind: freeze(wind) });
}

function sampleWeather(keyframes, epochMilliseconds, interpolation) {
  if (keyframes.length === 1 || epochMilliseconds <= keyframes[0].at) return keyframes[0].state;
  const last = keyframes[keyframes.length - 1];
  if (epochMilliseconds >= last.at) return last.state;
  let low = 0;
  let high = keyframes.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (keyframes[middle].at <= epochMilliseconds) low = middle;
    else high = middle;
  }
  const first = keyframes[low];
  const second = keyframes[high];
  const amount = clamp((epochMilliseconds - first.at) / (second.at - first.at), 0, 1);
  return interpolateWeatherState(first.state, second.state, amount, interpolation);
}

function snapshotFrameStateConfig(snapshot, { seed = snapshot.seed ?? 0, tickSeconds = snapshot.tickSeconds ?? 1 / 120 } = {}) {
  const solar = snapshot.solar ?? snapshot.sun;
  const weather = snapshot.weather ?? snapshot;
  if (!solar || !weather?.atmosphere || !weather?.clouds || !weather?.wind) {
    throw new TypeError('toEnvironmentFrameStateConfig requires an EnvironmentTimeline snapshot.');
  }
  const frameElevation = clamp(solar.elevationRadians, MIN_FRAME_SUN_ELEVATION_RADIANS, Math.PI / 2);
  const frameAzimuth = solar.algorithmVersion === 'authored-static-solar-v1'
    && solar.azimuthRadians >= 0 && solar.azimuthRadians <= TAU
    ? solar.azimuthRadians
    : normalizeAngle(solar.azimuthRadians);
  return freeze({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: integer(seed, 'seed', 0, 0xffffffff) >>> 0,
    tickSeconds: finite(tickSeconds, 'tickSeconds', 1 / 1000, 1),
    sun: freeze({
      azimuthRadians: frameAzimuth,
      elevationRadians: frameElevation,
      intensity: finite(solar.intensity, 'sun.intensity', 0, 100000),
      color: color(solar.color, 'sun.color'),
    }),
    atmosphere: weather.atmosphere,
    clouds: weather.clouds,
    wind: weather.wind,
  });
}

/**
 * Normalize a versioned timeline config without constructing a clock.
 * The returned object is immutable and safe to use as a serialization boundary.
 */
export function validateEnvironmentTimelineConfig(config) {
  return normalizeTimelineConfig(config).value;
}

export const normalizeEnvironmentTimelineConfig = validateEnvironmentTimelineConfig;

/**
 * Convert a current timeline snapshot into the existing fixed-tick environment
 * contract.  Night-time geometric elevations are clamped only at this boundary
 * because EnvironmentFrameState intentionally requires a positive sun height.
 */
export function toEnvironmentFrameStateConfig(snapshot, options = {}) {
  return snapshotFrameStateConfig(snapshot, options);
}

/**
 * A deterministic timeline over astronomical daylight and interpolated weather.
 * `advance(seconds)` consumes wall-clock seconds and applies the current playback
 * rate; it is a no-op while paused. `seek` consumes epoch milliseconds, a Date,
 * an ISO UTC instant, or `{ date, time }`.
 */
export class EnvironmentTimeline {
  constructor(config) {
    const normalized = normalizeTimelineConfig(config);
    this.config = normalized.value;
    this._epochMilliseconds = normalized.epochMilliseconds;
    this._weatherKeyframes = normalized.weatherKeyframes;
    this._paused = this.config.playback.paused;
    this._playbackRate = this.config.playback.rate;
  }

  static fromStaticEnvironmentConfig(staticConfig, options = {}) {
    return fromStaticEnvironmentConfig(staticConfig, options);
  }

  get paused() {
    return this._paused;
  }

  get isPaused() {
    return this._paused;
  }

  get playbackRate() {
    return this._playbackRate;
  }

  get epochMilliseconds() {
    return this._epochMilliseconds;
  }

  get currentTime() {
    return new Date(this._epochMilliseconds).toISOString();
  }

  pause() {
    this._paused = true;
    return this.snapshot();
  }

  play(rate = undefined) {
    if (rate !== undefined) this.setPlaybackRate(rate);
    this._paused = false;
    return this.snapshot();
  }

  resume(rate = undefined) {
    return this.play(rate);
  }

  setPlaybackRate(rate) {
    this._playbackRate = finite(rate, 'playback.rate', -MAX_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    return this;
  }

  seek(value) {
    let epoch;
    if (isObject(value) && !(value instanceof Date)) {
      if (value.epochMilliseconds !== undefined) epoch = parseTimelineInstant(value.epochMilliseconds, 'seek.epochMilliseconds');
      else {
        const date = normalizedDateParts(value.date, 'seek.date');
        const time = normalizedTimeParts(value.time, 'seek.time');
        epoch = assertSupportedEpoch(utcEpoch(date, time), 'seek');
      }
    } else {
      epoch = parseTimelineInstant(value, 'seek');
    }
    this._epochMilliseconds = epoch;
    return this.snapshot();
  }

  advance(seconds) {
    finite(seconds, 'advance seconds', -MAX_DATE_MILLISECONDS / 1000, MAX_DATE_MILLISECONDS / 1000);
    if (this._paused || this._playbackRate === 0 || seconds === 0) return this.snapshot();
    const next = this._epochMilliseconds + seconds * this._playbackRate * 1000;
    this._epochMilliseconds = assertSupportedEpoch(next, 'advance result');
    return this.snapshot();
  }

  /** Advance simulation time directly, ignoring pause and playback rate. */
  advanceSimulation(seconds) {
    finite(seconds, 'advanceSimulation seconds', -MAX_DATE_MILLISECONDS / 1000, MAX_DATE_MILLISECONDS / 1000);
    const next = this._epochMilliseconds + seconds * 1000;
    this._epochMilliseconds = assertSupportedEpoch(next, 'advanceSimulation result');
    return this.snapshot();
  }

  sampleWeather() {
    return sampleWeather(this._weatherKeyframes, this._epochMilliseconds, this.config.weather.interpolation);
  }

  snapshot() {
    const weather = this.sampleWeather();
    const solar = this.config.solar.mode === 'fixed'
      ? fixedSolarPosition(this.config.solar)
      : computeSolarPosition(
        this._epochMilliseconds,
        this.config.latitude,
        this.config.longitude,
        weather.atmosphere,
        weather.clouds,
      );
    const instant = formatInstant(this._epochMilliseconds);
    return freeze({
      version: ENVIRONMENT_TIMELINE_VERSION,
      algorithmVersion: ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
      solarAlgorithmVersion: solar.algorithmVersion,
      weatherAlgorithmVersion: ENVIRONMENT_TIMELINE_WEATHER_ALGORITHM_VERSION,
      latitude: this.config.latitude,
      longitude: this.config.longitude,
      elevationMeters: this.config.elevationMeters,
      epochMilliseconds: this._epochMilliseconds,
      date: instant.date,
      time: instant.time,
      iso: `${instant.date}T${instant.time}`,
      playback: freeze({ paused: this._paused, rate: this._playbackRate }),
      seed: this.config.seed,
      tickSeconds: this.config.tickSeconds,
      solar,
      // `sun` is a deliberate compatibility/readability alias.  `solar` also
      // carries astronomical diagnostics such as refraction and air mass.
      sun: solar,
      weather,
      atmosphere: weather.atmosphere,
      clouds: weather.clouds,
      wind: weather.wind,
    });
  }

  frameStateConfig() {
    return snapshotFrameStateConfig(this.snapshot(), {
      seed: this.config.seed,
      tickSeconds: this.config.tickSeconds,
    });
  }

  toEnvironmentFrameStateConfig() {
    return this.frameStateConfig();
  }
}

/**
 * Preserve an existing EnvironmentFrameState config exactly at a paused point.
 * Static configs have no geographic clock, so the supplied/default location and
 * date are metadata only and the authored sun remains a fixed solar source.
 */
export function fromStaticEnvironmentConfig(staticConfig, {
  latitude = 0,
  longitude = 0,
  elevationMeters = 0,
  date = '2000-01-01',
  time = '12:00:00.000Z',
} = {}) {
  const state = staticConfig instanceof EnvironmentFrameState
    ? staticConfig
    : new EnvironmentFrameState(staticConfig);
  const normalized = state.config;
  const dateParts = normalizedDateParts(date, 'static date');
  const timeParts = normalizedTimeParts(time, 'static time');
  const epoch = utcEpoch(dateParts, timeParts);
  const timeline = new EnvironmentTimeline({
    version: ENVIRONMENT_TIMELINE_VERSION,
    algorithmVersion: ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
    latitude,
    longitude,
    elevationMeters,
    date: datePartsToString(dateParts),
    time: timePartsToString(timeParts),
    playback: { paused: true, rate: 0 },
    seed: normalized.seed,
    tickSeconds: normalized.tickSeconds,
    solar: {
      mode: 'fixed',
      azimuthRadians: normalized.sun.azimuthRadians,
      elevationRadians: normalized.sun.elevationRadians,
      intensity: normalized.sun.intensity,
      color: normalized.sun.color,
    },
    weather: {
      interpolation: 'linear',
      keyframes: [{
        at: new Date(epoch).toISOString(),
        atmosphere: normalized.atmosphere,
        clouds: normalized.clouds,
        wind: normalized.wind,
      }],
    },
  });
  return timeline;
}

export const timelineFromStaticEnvironmentConfig = fromStaticEnvironmentConfig;
export const createEnvironmentTimelineFromStaticConfig = fromStaticEnvironmentConfig;

function datePartsToString(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function timePartsToString(parts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}.${String(parts.millisecond).padStart(3, '0')}Z`;
}
