// Provider-neutral launch-monitor boundary.
//
// Hardware SDK adapters are responsible only for mapping their payload field
// names into this module's canonical names. Unit conversion, validation,
// duplicate suppression, connection state, and simulation handoff live here so
// every provider follows the same fail-closed path.

export const LAUNCH_MONITOR_STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  READY: 'ready',
  RECEIVING: 'receiving',
  ERROR: 'error',
});

export const CANONICAL_LAUNCH_UNITS = Object.freeze({
  ballSpeed: 'mph',
  launchAngle: 'deg',
  launchDirection: 'deg',
  spinRate: 'rpm',
  spinAxis: 'deg',
  timestamp: 'ms',
});

export const REQUIRED_LAUNCH_METRICS = Object.freeze([
  'ballSpeed',
  'launchAngle',
  'launchDirection',
  'spinRate',
  'spinAxis',
]);

export const OPTIONAL_LAUNCH_METRICS = Object.freeze(['clubLabel', 'deviceShotId']);

const VALID_STATES = new Set(Object.values(LAUNCH_MONITOR_STATES));
const VALID_METRICS = new Set(REQUIRED_LAUNCH_METRICS);
const VALID_OPTIONAL_METRICS = new Set(OPTIONAL_LAUNCH_METRICS);
const BALL_SPEED_TO_MPH = Object.freeze({
  mph: 1,
  mps: 2.2369362920544,
  'm/s': 2.2369362920544,
  kph: 0.62137119223733,
  'km/h': 0.62137119223733,
});
const ANGLE_TO_DEGREES = Object.freeze({
  deg: 1,
  degree: 1,
  degrees: 1,
  rad: 180 / Math.PI,
  radians: 180 / Math.PI,
});
const SPIN_TO_RPM = Object.freeze({
  rpm: 1,
  'rad/s': 60 / (Math.PI * 2),
  rads: 60 / (Math.PI * 2),
});
const TIMESTAMP_TO_MS = Object.freeze({ ms: 1, s: 1000 });

const FIELD_LIMITS = Object.freeze({
  ballSpeed: Object.freeze([1, 250]),
  launchAngle: Object.freeze([-20, 90]),
  launchDirection: Object.freeze([-90, 90]),
  spinRate: Object.freeze([0, 20000]),
  spinAxis: Object.freeze([-180, 180]),
  timestamp: Object.freeze([0, Number.MAX_SAFE_INTEGER]),
});

function assertPlainObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function assertFinite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function assertRange(name, value) {
  const [minimum, maximum] = FIELD_LIMITS[name];
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum} ${CANONICAL_LAUNCH_UNITS[name]}`);
  }
  return value;
}

function convert(name, value, unit, factors) {
  assertFinite(name, value);
  const factor = factors[unit];
  if (!Number.isFinite(factor)) {
    throw new RangeError(`unsupported ${name} unit: ${String(unit)}`);
  }
  return value * factor;
}

function normalizeTimestamp(value, unit) {
  if (unit === 'iso') {
    if (typeof value !== 'string') throw new TypeError('timestamp must be an ISO date string when timestamp unit is iso');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new RangeError('timestamp must be a valid ISO date string');
    return parsed;
  }
  return convert('timestamp', value, unit, TIMESTAMP_TO_MS);
}

function optionalString(name, value, maximumLength) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`optional.${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximumLength) {
    throw new RangeError(`optional.${name} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function normalizeOptional(optional) {
  if (optional === undefined) return undefined;
  assertPlainObject('optional', optional);
  for (const key of Object.keys(optional)) {
    if (!VALID_OPTIONAL_METRICS.has(key)) throw new TypeError(`unsupported optional launch field: ${key}`);
  }
  const clubLabel = optionalString('clubLabel', optional.clubLabel, 80);
  const deviceShotId = optionalString('deviceShotId', optional.deviceShotId, 128);
  if (clubLabel === undefined && deviceShotId === undefined) return undefined;
  return Object.freeze({
    ...(clubLabel === undefined ? {} : { clubLabel }),
    ...(deviceShotId === undefined ? {} : { deviceShotId }),
  });
}

/**
 * Convert a provider-mapped shot into the immutable simulator contract.
 * Canonical output units are mph, degrees, rpm, and Unix epoch milliseconds.
 */
export function normalizeLaunchShot(input, { units = CANONICAL_LAUNCH_UNITS } = {}) {
  assertPlainObject('launch shot', input);
  assertPlainObject('launch units', units);
  const resolvedUnits = { ...CANONICAL_LAUNCH_UNITS, ...units };
  const shot = {
    ballSpeed: convert('ballSpeed', input.ballSpeed, resolvedUnits.ballSpeed, BALL_SPEED_TO_MPH),
    launchAngle: convert('launchAngle', input.launchAngle, resolvedUnits.launchAngle, ANGLE_TO_DEGREES),
    launchDirection: convert(
      'launchDirection', input.launchDirection, resolvedUnits.launchDirection, ANGLE_TO_DEGREES,
    ),
    spinRate: convert('spinRate', input.spinRate, resolvedUnits.spinRate, SPIN_TO_RPM),
    spinAxis: convert('spinAxis', input.spinAxis, resolvedUnits.spinAxis, ANGLE_TO_DEGREES),
    timestamp: normalizeTimestamp(input.timestamp, resolvedUnits.timestamp),
  };
  for (const name of Object.keys(shot)) shot[name] = assertRange(name, shot[name]);
  const optional = normalizeOptional(input.optional);
  return Object.freeze({ ...shot, ...(optional ? { optional } : {}) });
}

/** The single translation between launch-monitor language and Ball.launch(). */
export function launchShotToBallParams(shot) {
  const canonical = normalizeLaunchShot(shot);
  return Object.freeze({
    ballSpeed: canonical.ballSpeed,
    launchAngle: canonical.launchAngle,
    azimuth: canonical.launchDirection,
    spinRate: canonical.spinRate,
    spinAxis: canonical.spinAxis,
    ...(canonical.optional?.clubLabel ? { club: canonical.optional.clubLabel } : {}),
  });
}

function normalizeStringList(name, values, validValues) {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
  const unique = [];
  for (const value of values) {
    if (!validValues.has(value)) throw new RangeError(`unsupported ${name} value: ${String(value)}`);
    if (!unique.includes(value)) unique.push(value);
  }
  return Object.freeze(unique);
}

export function createLaunchMonitorCapabilities({
  metrics = REQUIRED_LAUNCH_METRICS,
  optionalMetrics = [],
  units = CANONICAL_LAUNCH_UNITS,
  transport = 'development',
} = {}) {
  if (typeof transport !== 'string' || !transport.trim()) throw new TypeError('transport must be a non-empty string');
  const normalizedMetrics = normalizeStringList('metrics', metrics, VALID_METRICS);
  const normalizedOptional = normalizeStringList('optionalMetrics', optionalMetrics, VALID_OPTIONAL_METRICS);
  const normalizedUnits = Object.freeze({ ...CANONICAL_LAUNCH_UNITS, ...assertPlainObject('units', units) });
  // Exercise unit validation now, before a provider reports itself ready.
  convert('ballSpeed', 1, normalizedUnits.ballSpeed, BALL_SPEED_TO_MPH);
  convert('launchAngle', 1, normalizedUnits.launchAngle, ANGLE_TO_DEGREES);
  convert('launchDirection', 1, normalizedUnits.launchDirection, ANGLE_TO_DEGREES);
  convert('spinRate', 1, normalizedUnits.spinRate, SPIN_TO_RPM);
  convert('spinAxis', 1, normalizedUnits.spinAxis, ANGLE_TO_DEGREES);
  normalizeTimestamp(normalizedUnits.timestamp === 'iso' ? '1970-01-01T00:00:00.000Z' : 1, normalizedUnits.timestamp);
  return Object.freeze({
    metrics: normalizedMetrics,
    optionalMetrics: normalizedOptional,
    units: normalizedUnits,
    transport: transport.trim(),
    simulationReady: REQUIRED_LAUNCH_METRICS.every((metric) => normalizedMetrics.includes(metric)),
  });
}

function duplicateKey(providerId, shot) {
  const deviceShotId = shot.optional?.deviceShotId;
  if (deviceShotId) return `${providerId}:device:${deviceShotId}`;
  return `${providerId}:shot:${shot.timestamp}:${shot.ballSpeed}:${shot.launchAngle}:`
    + `${shot.launchDirection}:${shot.spinRate}:${shot.spinAxis}`;
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Base adapter for SDK-backed and development launch sources. Subclasses may
 * override open()/close(), then call ingest() for each mapped provider packet.
 */
export class LaunchMonitorAdapter {
  constructor({
    providerId,
    capabilities = createLaunchMonitorCapabilities(),
    maxRecentShots = 512,
  }) {
    if (typeof providerId !== 'string' || !providerId.trim()) throw new TypeError('providerId must be a non-empty string');
    if (!Number.isInteger(maxRecentShots) || maxRecentShots < 1 || maxRecentShots > 4096) {
      throw new RangeError('maxRecentShots must be an integer between 1 and 4096');
    }
    this.providerId = providerId.trim();
    this.capabilities = capabilities;
    this.maxRecentShots = maxRecentShots;
    this.state = LAUNCH_MONITOR_STATES.DISCONNECTED;
    this.error = null;
    this._stateListeners = new Set();
    this._shotListeners = new Set();
    this._recentKeys = new Set();
    this._recentOrder = [];
    this._connectPromise = null;
  }

  snapshot() {
    return Object.freeze({
      providerId: this.providerId,
      state: this.state,
      error: this.error?.message ?? null,
      capabilities: this.capabilities,
    });
  }

  subscribeState(listener) {
    if (typeof listener !== 'function') throw new TypeError('state listener must be a function');
    this._stateListeners.add(listener);
    listener(this.snapshot());
    return () => this._stateListeners.delete(listener);
  }

  subscribeShots(listener) {
    if (typeof listener !== 'function') throw new TypeError('shot listener must be a function');
    this._shotListeners.add(listener);
    return () => this._shotListeners.delete(listener);
  }

  async connect() {
    if (this.state === LAUNCH_MONITOR_STATES.READY) return this.snapshot();
    if (this.state === LAUNCH_MONITOR_STATES.CONNECTING) return this._connectPromise;
    if (this.state === LAUNCH_MONITOR_STATES.RECEIVING) {
      throw new Error('cannot connect while a shot is being received');
    }
    this._setState(LAUNCH_MONITOR_STATES.CONNECTING);
    this._connectPromise = (async () => {
      try {
        await this.open();
        this.error = null;
        this._setState(LAUNCH_MONITOR_STATES.READY);
        return this.snapshot();
      } catch (error) {
        this.fail(error);
        throw this.error;
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  async disconnect() {
    try {
      await this.close();
      this.error = null;
      this._recentKeys.clear();
      this._recentOrder.length = 0;
      this._setState(LAUNCH_MONITOR_STATES.DISCONNECTED);
      return this.snapshot();
    } catch (error) {
      this.fail(error);
      throw this.error;
    }
  }

  // SDK adapters override these hooks; the base methods intentionally perform
  // no I/O so test/development providers remain deterministic.
  async open() {}
  async close() {}

  ingest(input, { units = this.capabilities.units } = {}) {
    if (this.state !== LAUNCH_MONITOR_STATES.READY) {
      throw new Error(`cannot receive a shot while provider is ${this.state}`);
    }
    this._setState(LAUNCH_MONITOR_STATES.RECEIVING);
    try {
      const shot = normalizeLaunchShot(input, { units });
      const key = duplicateKey(this.providerId, shot);
      if (this._recentKeys.has(key)) {
        this._setState(LAUNCH_MONITOR_STATES.READY);
        return Object.freeze({ accepted: false, reason: 'duplicate', shot });
      }
      this._remember(key);
      for (const listener of this._shotListeners) listener(shot, this);
      this._setState(LAUNCH_MONITOR_STATES.READY);
      return Object.freeze({ accepted: true, reason: null, shot });
    } catch (error) {
      this.fail(error);
      throw this.error;
    }
  }

  fail(error) {
    this.error = normalizeError(error);
    this._setState(LAUNCH_MONITOR_STATES.ERROR);
    return this.snapshot();
  }

  _remember(key) {
    this._recentKeys.add(key);
    this._recentOrder.push(key);
    while (this._recentOrder.length > this.maxRecentShots) {
      this._recentKeys.delete(this._recentOrder.shift());
    }
  }

  _setState(state) {
    if (!VALID_STATES.has(state)) throw new RangeError(`invalid launch-monitor state: ${String(state)}`);
    this.state = state;
    const snapshot = this.snapshot();
    for (const listener of this._stateListeners) listener(snapshot);
  }
}
