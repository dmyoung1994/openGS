import { Vector3 } from 'three';
import { classifyBiomeAt } from '../course/BiomeRegistry.js';
import { groupAudioAssets, validateAudioManifest } from './AudioManifest.js';

export const AUDIO_SETTINGS_STORAGE_KEY = 'rangeform.audio.v1';
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  muted: false,
  master: 0.70,
  ambience: 0.55,
  effects: 0.80,
});

const SURFACE_FAMILY = Object.freeze({
  tee: 'shortTurf', fairway: 'shortTurf', green: 'shortTurf', fringe: 'shortTurf',
  rough: 'longGrass', deepRough: 'longGrass', sand: 'sand', hardpan: 'hard', cartpath: 'hard',
});
const MAX_EFFECT_VOICES = 12;
const MAX_FLAG_VOICES = 4;
const CLUB_SOUND_PROFILES = Object.freeze({
  wood: Object.freeze({ rate: 0.98, rateSpread: 0.025, detune: 22, gainDb: 0 }),
  iron: Object.freeze({ rate: 1.02, rateSpread: 0.035, detune: 30, gainDb: -1 }),
  wedge: Object.freeze({ rate: 0.97, rateSpread: 0.04, detune: 34, gainDb: -2 }),
  putter: Object.freeze({ rate: 1.03, rateSpread: 0.025, detune: 20, gainDb: -6 }),
  neutral: Object.freeze({ rate: 1, rateSpread: 0.035, detune: 28, gainDb: -2 }),
});
const IMPACT_SOUND_PROFILES = Object.freeze({
  shortTurf: Object.freeze({ base: 0.07, scale: 0.48, rate: 0.94, spread: 0.05, detune: 30, filterHz: 7200 }),
  longGrass: Object.freeze({ base: 0.05, scale: 0.38, rate: 0.86, spread: 0.07, detune: 42, filterHz: 5200 }),
  sand: Object.freeze({ base: 0.06, scale: 0.42, rate: 0.80, spread: 0.08, detune: 48, filterHz: 4600 }),
  hard: Object.freeze({ base: 0.10, scale: 0.68, rate: 1.04, spread: 0.045, detune: 26, filterHz: 14500 }),
});
const AMBIENCE_GROUPS = Object.freeze([
  'ambience.maritime', 'ambience.alpine', 'ambience.wind', 'ambience.rain', 'ambience.surf',
]);
const _forward = new Vector3();
const _up = new Vector3();
const _wind = { x: 0, y: 0, z: 0 };

const createAudioContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)({ latencyHint: 'interactive' });
function closeAudioContext(context) {
  if (!context || context.state === 'closed') return;
  try { context.close()?.catch(() => {}); } catch { /* Best-effort cleanup of failed initialization. */ }
}

// Native device initialization can block for hundreds of milliseconds. Do it
// before the putting animation starts, without constructing nodes, downloading
// recordings or resuming audio. GolfAudio later takes ownership exactly once.
export function prepareGolfAudioContext(contextFactory = createAudioContext) {
  let context = null, failure = null, consumed = false;
  const cleanupListeners = new AbortController();
  try { context = contextFactory(); } catch (error) { failure = error; }
  const dispose = () => {
    if (consumed) return;
    consumed = true;
    cleanupListeners.abort();
    closeAudioContext(context);
    context = null;
  };
  if (context) for (const event of ['error', 'unhandledrejection', 'pagehide']) {
    globalThis.addEventListener?.(event, dispose, { signal: cleanupListeners.signal });
  }
  return { supported: Boolean(context), dispose, contextFactory() {
    if (consumed) throw new Error('Prepared audio context is no longer available.');
    consumed = true;
    cleanupListeners.abort();
    if (failure) throw failure;
    const owned = context;
    context = null;
    return owned;
  } };
}

function clamp01(value) { return Math.min(1, Math.max(0, Number(value) || 0)); }

function hash32(value) {
  let result = Number(value) >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function hashText(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function audioVariation(eventId, stream = 0) {
  return hash32((Number(eventId) ^ Math.imul(stream + 1, 0x9e3779b1)) >>> 0) / 0xffffffff * 2 - 1;
}

export function classifyClubSound(label) {
  const value = String(label || '').toLowerCase();
  if (/putter|putt/.test(value)) return 'putter';
  if (/wedge|pitch|lob|sand/.test(value)) return 'wedge';
  if (/driver|wood|hybrid/.test(value)) return 'wood';
  if (/iron/.test(value)) return 'iron';
  return 'neutral';
}

// Strike timbre follows the measured swing, not a player-selected club. Launch
// monitors do not all report club speed, so the required ball metrics provide a
// deterministic fallback. A label is consulted only when no usable measurements
// exist (for example, a direct developer call outside the canonical shot path).
export function classifyStrikeSound(event = {}) {
  const ballSpeed = Number(event.ballSpeed);
  const clubSpeed = Number(event.clubSpeed);
  const launchAngle = Number(event.launchAngle);
  const spinRate = Number(event.spinRate);
  const hasBallSpeed = Number.isFinite(ballSpeed) && ballSpeed > 0;
  const hasClubSpeed = Number.isFinite(clubSpeed) && clubSpeed >= 0;
  const hasLaunchAngle = Number.isFinite(launchAngle);
  const hasSpinRate = Number.isFinite(spinRate) && spinRate >= 0;

  if (!hasBallSpeed && !hasClubSpeed) return classifyClubSound(event.club);

  const ball = hasBallSpeed ? ballSpeed : Infinity;
  const club = hasClubSpeed ? clubSpeed : Infinity;
  const launch = hasLaunchAngle ? launchAngle : 0;
  const spin = hasSpinRate ? spinRate : 0;

  if (ball <= 30 && (!hasClubSpeed || club <= 24) && launch <= 8 && spin <= 2500) return 'putter';

  const loftedFlight = launch >= 21.5 || spin >= 8500;
  if (loftedFlight && (ball <= 105 || club <= 78)) return 'wedge';
  if (ball <= 80 && (launch >= 15 || spin >= 4500)) return 'wedge';

  const penetratingFlight = launch <= 18 && (!hasSpinRate || spin <= 4500);
  if (ball >= 145 || (penetratingFlight && (ball >= 125 || club >= 84))) return 'wood';

  return 'iron';
}

export function classifySurfaceSound(surface) {
  return SURFACE_FAMILY[surface] || 'shortTurf';
}

export function selectAudioVariant(length, eventId) {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('Audio variant length must be positive.');
  return hash32(eventId) % length;
}

export function loadAudioSettings(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(AUDIO_SETTINGS_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_AUDIO_SETTINGS };
    return {
      muted: parsed.muted === true,
      master: clamp01(parsed.master ?? DEFAULT_AUDIO_SETTINGS.master),
      ambience: clamp01(parsed.ambience ?? DEFAULT_AUDIO_SETTINGS.ambience),
      effects: clamp01(parsed.effects ?? DEFAULT_AUDIO_SETTINGS.effects),
    };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function nearestMarineAnchor(course, position) {
  if (!course?.bounds || !position) return null;
  const candidates = [];
  const { minX, maxX, minZ, maxZ } = course.bounds;
  const pushSide = (side) => {
    if (side === 'min-x') candidates.push({ x: minX, y: 0, z: Math.min(maxZ, Math.max(minZ, position.z)) });
    if (side === 'max-x') candidates.push({ x: maxX, y: 0, z: Math.min(maxZ, Math.max(minZ, position.z)) });
    if (side === 'min-z') candidates.push({ x: Math.min(maxX, Math.max(minX, position.x)), y: 0, z: minZ });
    if (side === 'max-z') candidates.push({ x: Math.min(maxX, Math.max(minX, position.x)), y: 0, z: maxZ });
  };
  for (const transition of course.biomeTransitions || []) {
    if (transition.to !== 'marine-ocean') continue;
    if (transition.boundary.kind === 'course-edge') {
      for (const side of transition.boundary.sides) pushSide(side);
    } else {
      for (const point of transition.boundary.points || []) candidates.push({ x: point.x, y: 0, z: point.z });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.hypot(a.x - position.x, a.z - position.z)
    - Math.hypot(b.x - position.x, b.z - position.z));
  return candidates[0];
}

function setParam(param, value, now, seconds = 0.08) {
  if (!param) return;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, seconds);
}

function setPosition(node, position, now) {
  if (!node || !position) return;
  node.positionX.setValueAtTime(position.x, now);
  node.positionY.setValueAtTime(position.y, now);
  node.positionZ.setValueAtTime(position.z, now);
}

function createPanner(context, { refDistance = 2, maxDistance = 180, rolloffFactor = 1.1 } = {}) {
  const panner = new PannerNode(context, {
    panningModel: 'HRTF', distanceModel: 'inverse', refDistance, maxDistance, rolloffFactor,
  });
  return panner;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class GolfAudio {
  constructor({
    camera,
    manifestUrl = '/assets/audio/manifest.json',
    storage = globalThis.localStorage,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    contextFactory = createAudioContext,
  } = {}) {
    if (!camera) throw new TypeError('GolfAudio requires the authoritative camera.');
    this.camera = camera;
    this.manifestUrl = manifestUrl;
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.settings = loadAudioSettings(storage);
    this.buffers = new Map();
    this.groups = new Map();
    this.failures = [];
    this.effects = new Set();
    this.ambience = new Map();
    this.flags = new Map();
    this.roll = null;
    this.course = null;
    this.range = null;
    this.environment = null;
    this.weather = 'clear';
    this.unlocked = false;
    this._disposed = false;
    this._eventSequence = 0;
    this._pendingEvents = [];
    this._lastVariants = new Map();
    this._flagAccumulator = 0;
    this._lastContact = null;
    this._analyserData = null;
    this.recentEvents = [];
    this.eventCounts = { launch: 0, bounce: 0, groundContact: 0, waterImpact: 0, rest: 0, holed: 0 };

    try {
      this.context = contextFactory();
      this.masterGain = this.context.createGain();
      this.ambienceGain = this.context.createGain();
      this.effectsGain = this.context.createGain();
      this.limiter = this.context.createDynamicsCompressor();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 2;
      this.limiter.ratio.value = 16;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.18;
      this.ambienceGain.connect(this.masterGain);
      this.effectsGain.connect(this.masterGain);
      this.masterGain.connect(this.limiter).connect(this.analyser).connect(this.context.destination);
      this._applySettings(false);
      this.ready = this._load();
    } catch (error) {
      closeAudioContext(this.context);
      this.context = null;
      this.failures.push({ id: 'audio-context', error: String(error?.message || error) });
      this.ready = Promise.resolve(this.snapshot());
    }

    this._unlockListener = () => { this.unlock(); };
    globalThis.addEventListener?.('pointerdown', this._unlockListener, { capture: true, passive: true });
    globalThis.addEventListener?.('keydown', this._unlockListener, { capture: true });
    this._visibilityListener = () => this._onVisibility();
    globalThis.document?.addEventListener?.('visibilitychange', this._visibilityListener);
  }

  async _load() {
    if (!this.context || !this.fetchImpl) return this.snapshot();
    try {
      const response = await this.fetchImpl(this.manifestUrl);
      if (!response.ok) throw new Error(`manifest request returned ${response.status}`);
      this.manifest = validateAudioManifest(await response.json());
      const grouped = groupAudioAssets(this.manifest);
      const results = await Promise.allSettled(this.manifest.assets.map(async (asset) => {
        const url = new URL(asset.file, new URL(this.manifestUrl, globalThis.location?.href || 'http://localhost/')).href;
        const assetResponse = await this.fetchImpl(url);
        if (!assetResponse.ok) throw new Error(`${asset.file} returned ${assetResponse.status}`);
        const bytes = await assetResponse.arrayBuffer();
        const hash = await sha256Hex(bytes);
        if (hash !== asset.sha256) throw new Error(`${asset.file} checksum mismatch`);
        const decoded = await this.context.decodeAudioData(bytes.slice(0));
        if (decoded.sampleRate !== this.manifest.sampleRate) throw new Error(`${asset.file} decoded at ${decoded.sampleRate} Hz`);
        if (decoded.numberOfChannels !== asset.channels) throw new Error(`${asset.file} channel layout mismatch`);
        this.buffers.set(asset.id, decoded);
        return asset.id;
      }));
      results.forEach((result, index) => {
        if (result.status === 'rejected') this.failures.push({
          id: this.manifest.assets[index].id,
          error: String(result.reason?.message || result.reason),
        });
      });
      for (const [name, assets] of grouped) {
        const available = assets.filter((asset) => this.buffers.has(asset.id));
        if (available.length) this.groups.set(name, available);
      }
      if (this.unlocked) {
        this._ensureAmbience();
        this._flushPending();
      }
    } catch (error) {
      this.failures.push({ id: 'manifest', error: String(error?.message || error) });
    }
    return this.snapshot();
  }

  async unlock() {
    if (!this.context || this._disposed) return false;
    try {
      await this.context.resume();
      this.unlocked = this.context.state === 'running';
      if (this.unlocked) {
        globalThis.removeEventListener?.('pointerdown', this._unlockListener, true);
        globalThis.removeEventListener?.('keydown', this._unlockListener, true);
        await this.ready;
        this._ensureAmbience();
        this._flushPending();
      }
      return this.unlocked;
    } catch (error) {
      this.failures.push({ id: 'unlock', error: String(error?.message || error) });
      return false;
    }
  }

  setCourse({ course, range, environment, weather } = {}) {
    this.course = course || null;
    this.range = range || null;
    this.environment = environment || null;
    this.weather = weather || course?.atmosphere?.weather || 'clear';
    for (const voice of this.flags.values()) this._stopLoop(voice);
    this.flags.clear();
    this._stopRoll();
    return this.snapshot();
  }

  setMuted(muted) {
    this.settings.muted = Boolean(muted);
    this._applySettings();
    return this.snapshot();
  }

  setVolume(category, value) {
    if (!['master', 'ambience', 'effects'].includes(category)) throw new RangeError(`Unknown audio category "${category}".`);
    this.settings[category] = clamp01(value);
    this._applySettings();
    return this.snapshot();
  }

  _applySettings(persist = true) {
    if (this.context) {
      const now = this.context.currentTime;
      setParam(this.masterGain?.gain, this.settings.muted ? 0 : this.settings.master, now, 0.02);
      setParam(this.ambienceGain?.gain, this.settings.ambience, now, 0.02);
      setParam(this.effectsGain?.gain, this.settings.effects, now, 0.02);
    }
    if (persist) {
      try { this.storage?.setItem?.(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    }
  }

  handleLaunch(event) {
    this.eventCounts.launch++;
    const family = classifyStrikeSound(event);
    const profile = CLUB_SOUND_PROFILES[family];
    const speed = Math.max(1, Number(event.ballSpeed) || (event.velocity?.length?.() ?? 30) / 0.44704);
    const eventId = this._nextEventId(`strike.${family}`);
    const gainVariation = 10 ** ((profile.gainDb + audioVariation(eventId, 1) * 1.25) / 20);
    this._queueOneShot(`strike.${family}`, event.position, {
      gain: (0.42 + clamp01((speed - 25) / 160) * 0.5) * gainVariation,
      rate: profile.rate + audioVariation(eventId, 2) * profile.rateSpread,
      detune: audioVariation(eventId, 3) * profile.detune,
      classification: Object.freeze({
        family,
        ballSpeed: speed,
        clubSpeed: Number.isFinite(Number(event.clubSpeed)) ? Number(event.clubSpeed) : null,
      }),
      eventId,
      refDistance: 3,
      maxDistance: 220,
    });
  }

  handleBounce(event) {
    this.eventCounts.bounce++;
    const family = classifySurfaceSound(event.surface);
    const profile = IMPACT_SOUND_PROFILES[family];
    const normalSpeed = Math.max(0, Number(event.normalSpeed) || Number(event.impactSpeed) || 0);
    const eventId = this._nextEventId(`impact.${family}`);
    this._queueOneShot(`impact.${family}`, event.position, {
      gain: (profile.base + clamp01(normalSpeed / 28) * profile.scale)
        * 10 ** (audioVariation(eventId, 1) * 1.5 / 20),
      rate: profile.rate + audioVariation(eventId, 2) * profile.spread,
      detune: audioVariation(eventId, 3) * profile.detune,
      filterHz: profile.filterHz,
      eventId,
      refDistance: 1.4,
      maxDistance: 150,
    });
  }

  handleWaterImpact(event) {
    this.eventCounts.waterImpact++;
    const group = event.kind === 'skip' ? 'water.skip' : 'water.splash';
    const eventId = this._nextEventId(group);
    this._queueOneShot(group, event.position, {
      gain: 0.18 + clamp01((event.impactSpeed || 0) / 45) * 0.62,
      rate: 0.98 + audioVariation(eventId, 2) * 0.045,
      detune: audioVariation(eventId, 3) * 24,
      eventId, refDistance: 2.5, maxDistance: 190,
    });
  }

  handleHoled(event) {
    this.eventCounts.holed++;
    this._queueOneShot('cup.drop', event.position, {
      gain: 0.7, rate: 1, eventId: this._nextEventId('cup.drop'),
      refDistance: 2, maxDistance: 40,
    });
  }

  _nextEventId(group) {
    const sequence = ++this._eventSequence;
    return hash32((this.course?.environmentSeed || 1) ^ hashText(group) ^ Math.imul(sequence, 0x9e3779b1));
  }

  handleGroundContact(event) {
    this.eventCounts.groundContact++;
    this._lastContact = event;
  }

  handleRest() {
    this.eventCounts.rest++;
    this._lastContact = null;
    this._stopRoll();
  }

  _queueOneShot(group, position, options) {
    const request = { group, position: position?.clone?.() || { ...position }, options };
    if (!this.unlocked || !this.groups.has(group)) {
      this._pendingEvents.push(request);
      if (this._pendingEvents.length > 8) this._pendingEvents.shift();
      return;
    }
    this._playOneShot(request);
  }

  _flushPending() {
    const pending = this._pendingEvents.splice(0);
    for (const request of pending) if (this.groups.has(request.group)) this._playOneShot(request);
  }

  _playOneShot({ group, position, options }) {
    if (!this.context || this.context.state !== 'running') return;
    while (this.effects.size >= MAX_EFFECT_VOICES) {
      const oldest = this.effects.values().next().value;
      oldest.source.stop();
      this.effects.delete(oldest);
    }
    const assets = this.groups.get(group);
    if (!assets?.length) return;
    let variant = selectAudioVariant(assets.length, options.eventId);
    const previous = this._lastVariants.get(group);
    if (assets.length > 1 && variant === previous) {
      variant = (variant + 1 + (hash32(options.eventId ^ 0xa511e9b3) % (assets.length - 1))) % assets.length;
    }
    this._lastVariants.set(group, variant);
    const asset = assets[variant];
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const panner = createPanner(this.context, options);
    source.buffer = this.buffers.get(asset.id);
    source.playbackRate.value = options.rate || 1;
    source.detune.value = options.detune || 0;
    gain.gain.value = Math.max(0, options.gain || 0);
    setPosition(panner, position, this.context.currentTime);
    let filter = null;
    if (options.filterHz) {
      filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = options.filterHz;
      filter.Q.value = 0.35;
      source.connect(filter).connect(gain).connect(panner).connect(this.effectsGain);
    } else source.connect(gain).connect(panner).connect(this.effectsGain);
    const voice = { source, gain, filter, panner, group, asset: asset.id, variant };
    this.recentEvents.push(Object.freeze({
      group, asset: asset.id, variant, eventId: options.eventId,
      gain: options.gain, rate: source.playbackRate.value, detune: source.detune.value,
      ...(options.classification ? { classification: options.classification } : {}),
    }));
    if (this.recentEvents.length > 12) this.recentEvents.shift();
    this.effects.add(voice);
    source.onended = () => {
      this.effects.delete(voice);
      source.disconnect(); gain.disconnect(); filter?.disconnect(); panner.disconnect();
    };
    source.start();
  }

  _createLoop(group, { spatial = false, bus = this.ambienceGain, position = null, refDistance, maxDistance, rolloffFactor } = {}) {
    const asset = this.groups.get(group)?.[0];
    if (!asset || !this.context || this.context.state !== 'running') return null;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = this.buffers.get(asset.id);
    source.loop = true;
    gain.gain.value = 0;
    let panner = null;
    if (spatial) {
      panner = createPanner(this.context, { refDistance, maxDistance, rolloffFactor });
      setPosition(panner, position, this.context.currentTime);
      source.connect(gain).connect(panner).connect(bus);
    } else source.connect(gain).connect(bus);
    source.start(0, (hash32(this.course?.environmentSeed || 1) / 0xffffffff) * Math.max(0, source.buffer.duration - 0.1));
    return { source, gain, panner, group, asset: asset.id };
  }

  _stopLoop(voice) {
    if (!voice) return;
    try { voice.source.stop(); } catch { /* already stopped */ }
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.panner?.disconnect();
  }

  _ensureAmbience() {
    if (!this.unlocked || !this.groups.size) return;
    for (const group of AMBIENCE_GROUPS) {
      if (this.ambience.has(group)) continue;
      const surf = group === 'ambience.surf';
      const anchor = surf ? nearestMarineAnchor(this.course, this.camera.position) : null;
      if (surf && !anchor) continue;
      const voice = this._createLoop(group, surf
        ? { spatial: true, position: anchor, refDistance: 22, maxDistance: 600, rolloffFactor: 0.7 }
        : {});
      if (voice) this.ambience.set(group, voice);
    }
  }

  update(dt, { camera = this.camera, ball, range = this.range, environment = this.environment } = {}) {
    if (!this.context || this._disposed) return;
    this.camera = camera || this.camera;
    this.range = range || this.range;
    this.environment = environment || this.environment;
    this._updateListener();
    if (!this.unlocked || this.context.state !== 'running') return;
    this._ensureAmbience();
    this._updateAmbience();
    this._updateRoll(ball);
    this._flagAccumulator += Math.max(0, dt || 0);
    if (this._flagAccumulator >= 0.1) {
      this._flagAccumulator %= 0.1;
      this._updateFlags();
    }
  }

  _updateListener() {
    const listener = this.context.listener;
    const now = this.context.currentTime;
    this.camera.getWorldDirection(_forward);
    _up.copy(this.camera.up).applyQuaternion(this.camera.quaternion).normalize();
    listener.positionX.setValueAtTime(this.camera.position.x, now);
    listener.positionY.setValueAtTime(this.camera.position.y, now);
    listener.positionZ.setValueAtTime(this.camera.position.z, now);
    listener.forwardX.setValueAtTime(_forward.x, now);
    listener.forwardY.setValueAtTime(_forward.y, now);
    listener.forwardZ.setValueAtTime(_forward.z, now);
    listener.upX.setValueAtTime(_up.x, now);
    listener.upY.setValueAtTime(_up.y, now);
    listener.upZ.setValueAtTime(_up.z, now);
  }

  _updateAmbience() {
    const now = this.context.currentTime;
    let alpine = this.course?.biome === 'temperate-alpine' ? 1 : 0;
    let coast = 0;
    if (this.course) {
      const classification = classifyBiomeAt(this.course, this.camera.position.x, this.camera.position.z);
      alpine = Math.max(alpine, classification.weights.alpine || 0);
      coast = (classification.weights.drySand || 0) + (classification.weights.wetSand || 0)
        + (classification.weights.shallowShelf || 0) + (classification.weights.deepOcean || 0);
      const shore = nearestMarineAnchor(this.course, this.camera.position);
      if (shore) {
        const distance = Math.hypot(shore.x - this.camera.position.x, shore.z - this.camera.position.z);
        coast = Math.max(coast, clamp01((280 - distance) / 220));
      }
    }
    const windSpeed = this.environment?.config?.wind?.speed || 0;
    const targets = {
      'ambience.maritime': (1 - clamp01(alpine)) * 0.24,
      'ambience.alpine': clamp01(alpine) * 0.38,
      'ambience.wind': clamp01((windSpeed - 1.5) / 10) * 0.34,
      'ambience.rain': this.weather === 'light-rain' ? 0.42 : 0,
      'ambience.surf': clamp01(coast * 1.2) * 0.48,
    };
    for (const [group, voice] of this.ambience) {
      setParam(voice.gain.gain, targets[group] || 0, now, 0.8);
      if (group === 'ambience.surf') {
        const anchor = nearestMarineAnchor(this.course, this.camera.position);
        if (anchor) setPosition(voice.panner, anchor, now);
      }
    }
  }

  _updateRoll(ball) {
    if (!ball || ball.state !== 'rolling' || !this._lastContact) {
      this._stopRoll();
      return;
    }
    const family = classifySurfaceSound(this._lastContact.surface);
    const group = `roll.${family}`;
    if (!this.groups.has(group)) return this._stopRoll();
    if (this.roll?.group !== group) {
      this._stopRoll();
      this.roll = this._createLoop(group, {
        spatial: true, bus: this.effectsGain, position: this._lastContact.position,
        refDistance: 1, maxDistance: 85, rolloffFactor: 1.25,
      });
    }
    if (!this.roll) return;
    const now = this.context.currentTime;
    const speed = Math.max(0, this._lastContact.speed || 0);
    const slip = Math.max(0, this._lastContact.slipSpeed || 0);
    setPosition(this.roll.panner, this._lastContact.position, now);
    setParam(this.roll.gain.gain, clamp01(speed / 9) * (0.12 + clamp01(slip / 8) * 0.16), now, 0.04);
    setParam(this.roll.source.playbackRate, 0.72 + clamp01(speed / 14) * 0.72, now, 0.05);
  }

  _stopRoll() {
    if (!this.roll) return;
    this._stopLoop(this.roll);
    this.roll = null;
  }

  _updateFlags() {
    const anchors = this.range?.flagCloth?.anchors || [];
    const environment = this.environment;
    if (!environment?.sampleWind || !anchors.length) {
      for (const voice of this.flags.values()) this._stopLoop(voice);
      this.flags.clear();
      return;
    }
    const nearest = anchors.map((anchor, index) => ({ anchor, index, distance: this.camera.position.distanceTo(new Vector3(anchor.x, anchor.y, anchor.z)) }))
      .filter((entry) => entry.distance <= 140)
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, MAX_FLAG_VOICES);
    const active = new Set(nearest.map((entry) => entry.index));
    for (const [index, voice] of this.flags) if (!active.has(index)) {
      this._stopLoop(voice);
      this.flags.delete(index);
    }
    const now = this.context.currentTime;
    for (const { anchor, index } of nearest) {
      environment.sampleWind(anchor, environment.time, _wind);
      const speed = Math.hypot(_wind.x, _wind.y, _wind.z);
      if (speed < 0.75) {
        const prior = this.flags.get(index);
        if (prior) this._stopLoop(prior);
        this.flags.delete(index);
        continue;
      }
      const tier = speed < 3.5 ? 'low' : speed < 7.5 ? 'medium' : 'high';
      const group = `flag.${tier}`;
      let voice = this.flags.get(index);
      if (!voice || voice.group !== group) {
        if (voice) this._stopLoop(voice);
        voice = this._createLoop(group, {
          spatial: true, position: anchor, refDistance: 1.5, maxDistance: 105, rolloffFactor: 1.2,
        });
        if (voice) this.flags.set(index, voice);
      }
      if (voice) {
        setPosition(voice.panner, anchor, now);
        setParam(voice.gain.gain, 0.04 + clamp01((speed - 0.75) / 10) * 0.22, now, 0.12);
        setParam(voice.source.playbackRate, 0.82 + clamp01(speed / 12) * 0.38, now, 0.12);
      }
    }
  }

  _onVisibility() {
    if (!this.context || !this.unlocked) return;
    if (globalThis.document?.hidden) this.context.suspend();
    else this.context.resume().then(() => this._ensureAmbience()).catch(() => {});
  }

  _outputRms() {
    if (!this.analyser) return 0;
    if (!this._analyserData || this._analyserData.length !== this.analyser.fftSize) {
      this._analyserData = new Float32Array(this.analyser.fftSize);
    }
    this.analyser.getFloatTimeDomainData(this._analyserData);
    let energy = 0;
    for (const sample of this._analyserData) energy += sample * sample;
    return Math.sqrt(energy / this._analyserData.length);
  }

  snapshot() {
    return Object.freeze({
      supported: Boolean(this.context),
      unlocked: this.unlocked,
      contextState: this.context?.state || 'unavailable',
      settings: Object.freeze({ ...this.settings }),
      manifestVersion: this.manifest?.version ?? null,
      decodedAssets: this.buffers.size,
      totalAssets: this.manifest?.assets.length ?? 0,
      failedAssets: Object.freeze(this.failures.map((failure) => Object.freeze({ ...failure }))),
      activeVoices: Object.freeze({
        effects: this.effects.size,
        ambience: this.ambience.size,
        flags: this.flags.size,
        roll: this.roll ? 1 : 0,
        total: this.effects.size + this.ambience.size + this.flags.size + (this.roll ? 1 : 0),
      }),
      listener: Object.freeze({
        position: Object.freeze({ x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }),
        forward: Object.freeze({ x: _forward.x, y: _forward.y, z: _forward.z }),
      }),
      outputRms: this._outputRms(),
      eventCounts: Object.freeze({ ...this.eventCounts }),
      recentEvents: Object.freeze(this.recentEvents.slice()),
    });
  }

  diagnostics() { return this.snapshot(); }

  dispose() {
    this._disposed = true;
    globalThis.removeEventListener?.('pointerdown', this._unlockListener, true);
    globalThis.removeEventListener?.('keydown', this._unlockListener, true);
    globalThis.document?.removeEventListener?.('visibilitychange', this._visibilityListener);
    for (const voice of this.effects) { try { voice.source.stop(); } catch { /* stopped */ } }
    for (const voice of this.ambience.values()) this._stopLoop(voice);
    for (const voice of this.flags.values()) this._stopLoop(voice);
    this._stopRoll();
    this.effects.clear(); this.ambience.clear(); this.flags.clear();
    this.context?.close();
  }
}
