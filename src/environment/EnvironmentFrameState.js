// Authoritative deterministic fair-weather state shared by gameplay and GPU
// rendering.  This module deliberately has no implicit configuration: callers
// must author every environmental input so invalid content fails closed.

export const ENVIRONMENT_FRAME_STATE_VERSION = 1;
export const ENVIRONMENT_WIND_ALGORITHM_VERSION = 'environment-wind-v1';
export const ENVIRONMENT_GPU_UNIFORM_FLOATS = 48;

const TWO_PI = Math.PI * 2;
const MAX_WIND_SPEED_MPS = 15.6464; // 35 mph, fair-weather contract limit.
const MAX_TICK = 0xffffffff;

function fail(message) {
  throw new TypeError(`Invalid EnvironmentFrameState config: ${message}`);
}

function finite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} is required.`);
  return value;
}

function unitColor(value, name) {
  const color = object(value, name);
  return Object.freeze({
    r: finite(color.r, `${name}.r`, 0, 64),
    g: finite(color.g, `${name}.g`, 0, 64),
    b: finite(color.b, `${name}.b`, 0, 64),
  });
}

function hashUint32(value) {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function hashString(value, seed) {
  let hash = (seed ^ 2166136261) >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hashUint32(hash);
}

function hashFloat(seed, stream) {
  return hashUint32((seed + Math.imul(stream + 1, 0x9e3779b9)) >>> 0) / 4294967296;
}

function signedHashFloat(seed, stream) {
  return hashFloat(seed, stream) * 2 - 1;
}

function createCoefficient(seed, stream) {
  // Unit 3D direction plus a deterministic phase.  These are written into the
  // GPU uniform snapshot verbatim so a shader can evaluate the same field.
  const z = signedHashFloat(seed, stream);
  const azimuth = hashFloat(seed, stream + 1) * TWO_PI;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return new Float32Array([
    Math.cos(azimuth) * radial,
    z,
    Math.sin(azimuth) * radial,
    hashFloat(seed, stream + 2) * TWO_PI,
  ]);
}

function validateConfig(config) {
  const root = object(config, 'config');
  if (root.version !== ENVIRONMENT_FRAME_STATE_VERSION) {
    fail(`version must equal ${ENVIRONMENT_FRAME_STATE_VERSION}.`);
  }
  if (root.algorithmVersion !== ENVIRONMENT_WIND_ALGORITHM_VERSION) {
    fail(`algorithmVersion must equal ${ENVIRONMENT_WIND_ALGORITHM_VERSION}.`);
  }
  if (!Number.isInteger(root.seed) || root.seed < 0 || root.seed > MAX_TICK) {
    fail(`seed must be an unsigned 32-bit integer.`);
  }

  const sun = object(root.sun, 'sun');
  const atmosphere = object(root.atmosphere, 'atmosphere');
  const clouds = object(root.clouds, 'clouds');
  const wind = object(root.wind, 'wind');

  const normalized = {
    version: root.version,
    algorithmVersion: root.algorithmVersion,
    seed: root.seed >>> 0,
    tickSeconds: finite(root.tickSeconds, 'tickSeconds', 1 / 1000, 1),
    sun: Object.freeze({
      azimuthRadians: finite(sun.azimuthRadians, 'sun.azimuthRadians', 0, TWO_PI),
      elevationRadians: finite(sun.elevationRadians, 'sun.elevationRadians', 0.001, Math.PI / 2),
      intensity: finite(sun.intensity, 'sun.intensity', 0, 100000),
      color: unitColor(sun.color, 'sun.color'),
    }),
    atmosphere: Object.freeze({
      turbidity: finite(atmosphere.turbidity, 'atmosphere.turbidity', 1, 10),
      rayleigh: finite(atmosphere.rayleigh, 'atmosphere.rayleigh', 0, 8),
      mieCoefficient: finite(atmosphere.mieCoefficient, 'atmosphere.mieCoefficient', 0, 0.1),
      mieDirectionalG: finite(atmosphere.mieDirectionalG, 'atmosphere.mieDirectionalG', 0, 0.999),
      exposure: finite(atmosphere.exposure, 'atmosphere.exposure', 0.05, 20),
    }),
    clouds: Object.freeze({
      coverage: finite(clouds.coverage, 'clouds.coverage', 0, 0.7),
      density: finite(clouds.density, 'clouds.density', 0, 1),
      baseHeight: finite(clouds.baseHeight, 'clouds.baseHeight', 250, 6000),
      thickness: finite(clouds.thickness, 'clouds.thickness', 50, 4000),
      advectionScale: finite(clouds.advectionScale, 'clouds.advectionScale', 0, 4),
    }),
    wind: Object.freeze({
      speed: finite(wind.speed, 'wind.speed', 0, MAX_WIND_SPEED_MPS),
      directionRadians: finite(wind.directionRadians, 'wind.directionRadians', 0, TWO_PI),
      referenceHeight: finite(wind.referenceHeight, 'wind.referenceHeight', 0.1, 100),
      shearExponent: finite(wind.shearExponent, 'wind.shearExponent', 0, 1.5),
      gustStrength: finite(wind.gustStrength, 'wind.gustStrength', 0, 1),
      turbulenceStrength: finite(wind.turbulenceStrength, 'wind.turbulenceStrength', 0, MAX_WIND_SPEED_MPS),
      gustSpatialFrequency: finite(wind.gustSpatialFrequency, 'wind.gustSpatialFrequency', 0.0001, 4),
      gustTemporalFrequency: finite(wind.gustTemporalFrequency, 'wind.gustTemporalFrequency', 0, 4),
    }),
  };
  return Object.freeze(normalized);
}

function assertPosition(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    throw new TypeError('sampleWind requires a finite { x, y, z } position.');
  }
}

function assertOutput(out) {
  if (!out || typeof out !== 'object') throw new TypeError('sampleWind requires an output object.');
}

function assertTime(time) {
  if (!Number.isFinite(time) || time < 0) throw new TypeError('sampleWind requires a non-negative finite time.');
}

function writeUniformSnapshot(state) {
  const data = new Float32Array(ENVIRONMENT_GPU_UNIFORM_FLOATS);
  const { sun, atmosphere, clouds, wind } = state.config;
  const sunCos = Math.cos(sun.elevationRadians);
  data[0] = state.time;
  data[1] = state.tick;
  data[2] = state.config.version;
  data[3] = state.config.seed & 0xffff;
  data[4] = Math.sin(sun.azimuthRadians) * sunCos;
  data[5] = Math.sin(sun.elevationRadians);
  data[6] = Math.cos(sun.azimuthRadians) * sunCos;
  data[7] = sun.intensity;
  data[8] = sun.color.r;
  data[9] = sun.color.g;
  data[10] = sun.color.b;
  data[11] = atmosphere.exposure;
  data[12] = atmosphere.turbidity;
  data[13] = atmosphere.rayleigh;
  data[14] = atmosphere.mieCoefficient;
  data[15] = atmosphere.mieDirectionalG;
  data[16] = clouds.coverage;
  data[17] = clouds.density;
  data[18] = clouds.baseHeight;
  data[19] = clouds.thickness;
  data[20] = clouds.advectionScale;
  data[21] = state.baseWindX;
  data[22] = state.baseWindZ;
  data[23] = state.config.seed >>> 16;
  data[24] = wind.referenceHeight;
  data[25] = wind.shearExponent;
  data[26] = wind.gustStrength;
  data[27] = wind.turbulenceStrength;
  data[28] = wind.gustSpatialFrequency;
  data[29] = wind.gustTemporalFrequency;
  data.set(state.coefficientA, 32);
  data.set(state.coefficientB, 36);
  data.set(state.coefficientC, 40);
  data[44] = state.coefficientD[0];
  data[45] = state.coefficientD[1];
  data[46] = state.coefficientD[2];
  data[47] = state.coefficientD[3];
  return Object.freeze({ version: ENVIRONMENT_FRAME_STATE_VERSION, tick: state.tick, time: state.time, data });
}

/**
 * Versioned deterministic environment state.  `sampleWind` is pure relative to
 * this state and writes into the caller's output vector without allocating.
 */
export class EnvironmentFrameState {
  constructor(config) {
    this.config = validateConfig(config);
    this.tick = 0;
    this.time = 0;
    this.previousTime = 0;
    this.eventSequence = 0;
    this._eventCounts = new Map();
    this.baseWindX = Math.sin(this.config.wind.directionRadians) * this.config.wind.speed;
    // Golf convention: 0 radians is a helping wind down-range (-Z), increasing
    // clockwise so pi/2 is left-to-right (+X).
    this.baseWindZ = -Math.cos(this.config.wind.directionRadians) * this.config.wind.speed;
    this.coefficientA = createCoefficient(this.config.seed, 1);
    this.coefficientB = createCoefficient(this.config.seed, 11);
    this.coefficientC = createCoefficient(this.config.seed, 21);
    this.coefficientD = createCoefficient(this.config.seed, 31);
    this.currentGpuUniforms = writeUniformSnapshot(this);
    this.previousGpuUniforms = writeUniformSnapshot(this);
  }

  advanceFixedTicks(ticks = 1) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > MAX_TICK) {
      throw new TypeError('advanceFixedTicks requires an unsigned integer tick count.');
    }
    if (ticks === 0) return this.currentGpuUniforms;
    if (this.tick > MAX_TICK - ticks) throw new RangeError('EnvironmentFrameState tick overflow.');
    this.previousTime = this.time;
    this.previousGpuUniforms = this.currentGpuUniforms;
    this.tick += ticks;
    this.time = this.tick * this.config.tickSeconds;
    if (!Number.isFinite(this.time)) throw new RangeError('EnvironmentFrameState time overflow.');
    this.currentGpuUniforms = writeUniformSnapshot(this);
    return this.currentGpuUniforms;
  }

  gpuUniformSnapshots() {
    return Object.freeze({ previous: this.previousGpuUniforms, current: this.currentGpuUniforms });
  }

  nextEvent(name) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(name)) {
      throw new TypeError('Environment event name must be a stable lowercase identifier.');
    }
    const namedIndex = this._eventCounts.get(name) ?? 0;
    this._eventCounts.set(name, namedIndex + 1);
    const sequence = this.eventSequence++;
    const id = hashUint32(hashString(name, this.config.seed) ^ hashUint32(namedIndex) ^ hashUint32(this.tick));
    return Object.freeze({ name, namedIndex, sequence, tick: this.tick, time: this.time, id });
  }

  sampleWind(position, time, out) {
    assertPosition(position);
    assertTime(time);
    assertOutput(out);
    const { wind } = this.config;
    const height = Math.max(position.y, 0.1);
    const shear = Math.pow(height / wind.referenceHeight, wind.shearExponent);
    const a = this.coefficientA;
    const b = this.coefficientB;
    const c = this.coefficientC;
    const d = this.coefficientD;
    const spatial = wind.gustSpatialFrequency;
    const temporal = wind.gustTemporalFrequency;
    const phaseA = (position.x * a[0] + position.y * a[1] + position.z * a[2]) * spatial + time * temporal + a[3];
    const phaseB = (position.x * b[0] + position.y * b[1] + position.z * b[2]) * spatial * 1.73 - time * temporal * 0.61 + b[3];
    const phaseC = (position.x * c[0] + position.y * c[1] + position.z * c[2]) * spatial * 2.41 + time * temporal * 1.37 + c[3];
    const gust = (Math.sin(phaseA) + Math.sin(phaseB) * 0.5 + Math.sin(phaseC) * 0.25) / 1.75;
    const turbulenceX = Math.sin(phaseB + d[3]) * d[0] + Math.cos(phaseC) * c[0] * 0.5;
    const turbulenceY = Math.sin(phaseC + a[3]) * d[1] + Math.cos(phaseA) * b[1] * 0.5;
    const turbulenceZ = Math.sin(phaseA + b[3]) * d[2] + Math.cos(phaseB) * a[2] * 0.5;
    const baseScale = shear * (1 + wind.gustStrength * gust);
    out.x = this.baseWindX * baseScale + turbulenceX * wind.turbulenceStrength;
    out.y = turbulenceY * wind.turbulenceStrength * 0.25;
    out.z = this.baseWindZ * baseScale + turbulenceZ * wind.turbulenceStrength;
    return out;
  }
}
