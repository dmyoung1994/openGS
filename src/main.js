import { Vector3 } from 'three';
import { SceneManager } from './scene/SceneManager.js';
import { Lighting } from './scene/Lighting.js';
import { Range } from './scene/Range.js';
import { Tracer } from './scene/Tracer.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { FreeCamera } from './camera/FreeCamera.js';
import { EvaluatorCamera } from './camera/EvaluatorCamera.js';
import { MetricsPanel } from './ui/MetricsPanel.js';
import { BuilderPanel } from './ui/BuilderPanel.js';
import { Menu } from './ui/Menu.js';
import { TurfPanel } from './ui/TurfPanel.js';
import { Minimap } from './ui/Minimap.js';
import { Ball } from './physics/Ball.js';
import { makeEnv } from './physics/ballistics.js';
import { GOLF_BALL_WATER_ENTRY_MODEL } from './physics/waterInteraction.js';
import { sitDepth } from './physics/groundInteraction.js';
import { BallLie } from './scene/BallLie.js';
import { renderedBallSitDepth } from './scene/NearTurfPolicy.js';
import { airDensity, airViscosity } from './physics/constants.js';
import { loadCourse } from './course/course.js';
import { MPH_TO_MS, DEG_TO_RAD, M_TO_YARD } from './util/units.js';
import {
  ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from './environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from './environment/EnvironmentGpuBindings.js';
import { VisualQualityController } from './scene/VisualQualityController.js';
import {
  ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
  ENVIRONMENT_TIMELINE_VERSION,
  EnvironmentTimeline,
  toEnvironmentFrameStateConfig,
} from './environment/EnvironmentTimeline.js';
import { createRng } from './util/random.js';
import {
  loadEnvironmentCatalog, verifyEnvironmentCatalogAssets, collectEnvironmentAssetIds,
} from './environment/EnvironmentCatalog.js';
import { createVisualAssetResidency } from './assets/VisualAssetResidency.js';
import { launchShotToBallParams } from './input/LaunchMonitorInput.js';
import { DevelopmentLaunchMonitorAdapter } from './input/DevelopmentLaunchMonitorAdapter.js';

// Clear alpine late-morning key from the left/downrange: a 37° elevation keeps
// the source plausible while its lateral component gives terrain relief and
// tree shadows a readable rake across the broadcast route. Every daylight
// consumer receives this same authored direction through EnvironmentGpuBindings.
const SUN = new Vector3(-0.72, 0.60, -0.32).normalize();
const QUALITY_OUTPUT_PIXEL_CAPS = Object.freeze({
  battery: 2_300_000,
  balanced: 3_700_000,
  quality: 5_760_000,
  ultra: 8_300_000,
});
const VISUAL_ASSET_MANIFEST_URL = '/assets/visual-quality-manifest.json';
const VISUAL_ASSET_VARIANT_FOR_MODE = Object.freeze({
  critical: 'critical',
  battery: 'critical',
  balanced: 'balanced',
  quality: 'quality',
  ultra: 'ultra',
});
// Grass is the one scene workload with a safe, public runtime policy hook. Keep
// the same material/compute graph and only reduce the bounded rough/deep-rough
// population on lower modes. Maintained fairway and green turf are unaffected.
const QUALITY_GRASS_WORKLOADS = Object.freeze({
  battery: Object.freeze({ densityScale: 0.58, radiusScale: 0.68, farTierScale: 0.28 }),
  balanced: Object.freeze({ densityScale: 0.74, radiusScale: 0.82, farTierScale: 0.55 }),
  quality: Object.freeze({ densityScale: 0.90, radiusScale: 0.94, farTierScale: 0.82 }),
  ultra: Object.freeze({ densityScale: 1.00, radiusScale: 1.00, farTierScale: 1.00 }),
});
const QUALITY_TREE_WORKLOADS = Object.freeze({
  battery: 'battery',
  balanced: 'balanced',
  quality: 'quality',
  ultra: 'ultra',
});
// WeatherSky keeps one volumetric representation across every mode. Quality only
// selects one of its fixed ray/probe/detail budgets, and graph ownership changes at
// the same infrequent mode boundary as the other runtime workloads.
const QUALITY_WEATHER_WORKLOADS = Object.freeze({
  battery: 'conservative',
  balanced: 'balanced',
  quality: 'high',
  ultra: 'high',
});
const TIMELINE_RENDER_UPDATE_SECONDS = 2;
const RESULT_HOLD_MS = 10_000;
const MAX_ENVIRONMENT_WIND_SPEED_MPS = 15.6464;
const DEFAULT_TIMELINE_LOCATION = Object.freeze({
  latitude: 46.5,
  longitude: 7.5,
  elevationMeters: 1200,
});
const DEFAULT_TIMELINE_CLOCK = Object.freeze({
  date: '2026-06-21',
  time: '14:00:00.000Z',
  // Real-time playback keeps the daylight continuous without turning every
  // animation frame into a PMREM rebuild. Captures and time-lapse tooling can
  // explicitly choose a faster rate through window.golf.timeline.
  playback: Object.freeze({ paused: false, rate: 1 }),
});
const startupQuery = new URL(window.location.href).searchParams;
const coursePath = startupQuery.get('course') === 'premium-range' ? '/premium-range.json' : '/course.json';

const app = document.getElementById('app');
const sm = new SceneManager(app);
// Available even when strict WebGPU initialization rejects before the production
// `window.golf` API is installed. Browser integration tests use this narrow handle to
// prove that failure is terminal: no frame loop, retry, or alternate renderer starts.
const bootstrapStartedAt = performance.now();
const bootstrapDiagnostics = {
  stage: 'webgpu-initializing', completed: 0, total: 0, error: null,
  stages: [],
  visualAssets: {
    manifest: 'pending',
    critical: 'pending',
    activeVariant: null,
    criticalRequiredFiles: 0,
    criticalVerifiedFiles: 0,
  },
};
function setBootstrapStage(stage, { detail = '', completed = 0, total = 0 } = {}) {
  bootstrapDiagnostics.stage = stage;
  bootstrapDiagnostics.completed = completed;
  bootstrapDiagnostics.total = total;
  bootstrapDiagnostics.stages.push(Object.freeze({ stage, completed, total, atMs: Math.round(performance.now() - bootstrapStartedAt) }));
  const loading = document.getElementById('loading');
  const stageEl = document.getElementById('loading-stage');
  const detailEl = document.getElementById('loading-detail');
  const progress = document.getElementById('loading-progress');
  if (stageEl) stageEl.textContent = stage.replaceAll('-', ' ');
  if (detailEl) detailEl.textContent = detail || 'The first frame is built from verified course assets.';
  if (progress) {
    progress.max = Math.max(1, total);
    progress.value = Math.min(progress.max, completed);
    progress.hidden = total <= 0;
  }
  if (loading) loading.dataset.stage = stage;
}
window.golfBootstrap = Object.freeze({
  sm,
  diagnostics: bootstrapDiagnostics,
  get stage() { return bootstrapDiagnostics.stage; },
  get ready() { return bootstrapDiagnostics.stage === 'ready'; },
  get elapsedMs() { return Math.round(performance.now() - bootstrapStartedAt); },
});
let lighting;
// Declared before the initial quality application: WebGPU is ready before the
// course exists, so the first pass must be able to record the pending policy
// without touching a not-yet-initialized lexical binding.
let range = null;
let qualityController = null;
let appliedQualityState = null;
let visualAssetResidency = null;
let visualAssetManifestReady = Promise.resolve(null);
let visualCriticalAssetsReady = Promise.resolve(null);
let visualAssetManifestError = null;
let visualCriticalAssetError = null;
let visualAssetCriticalReady = false;
let visualAssetCriticalPlan = null;
let visualAssetCriticalVerified = new Set();
let visualAssetActiveVariant = null;
const visualAssetRequestPromises = new Map();
const visualAssetRequestRecords = new Map();

function setVisualAssetBootstrapStatus(patch) {
  bootstrapDiagnostics.visualAssets = {
    ...bootstrapDiagnostics.visualAssets,
    ...patch,
  };
}

function visualAssetVariantForMode(mode) {
  return VISUAL_ASSET_VARIANT_FOR_MODE[mode] ?? 'balanced';
}

function visualAssetRequestKey(variantName, includeOptional) {
  return `${variantName}:${includeOptional ? 'all' : 'required'}`;
}

function visualAssetRequestDiagnostic(variantName, includeOptional) {
  const record = visualAssetRequestRecords.get(
    visualAssetRequestKey(variantName, includeOptional),
  );
  return record ? { ...record } : null;
}

/**
 * Start one manifest profile request and retain only JSON-safe request state.
 * VisualAssetResidency owns file/profile coalescing; this wrapper only connects
 * it to runtime mode changes and keeps optional failures observable without
 * turning them into a placeholder or a startup fallback.
 */
function requestVisualAssetProfile(
  variantName,
  { includeOptional = variantName !== 'critical', projectedNeed, signal, onStage, background = false } = {},
) {
  const variant = visualAssetVariantForMode(variantName);
  const key = visualAssetRequestKey(variant, includeOptional);
  if (visualAssetRequestPromises.has(key)) return visualAssetRequestPromises.get(key);

  if (!visualAssetResidency) {
    const error = new Error('Visual asset residency is not initialized.');
    const rejected = Promise.reject(error);
    rejected.catch(() => {});
    return rejected;
  }

  const record = {
    variant,
    includeOptional,
    state: 'loading',
    requestedAt: performance.now(),
    completedAt: null,
    error: null,
  };
  visualAssetRequestRecords.set(key, record);
  const options = { includeOptional };
  if (projectedNeed !== undefined) options.projectedNeed = projectedNeed;
  if (signal !== undefined) options.signal = signal;
  if (onStage !== undefined) options.onStage = onStage;

  let request;
  try {
    request = visualAssetResidency.request(variant, options);
  } catch (error) {
    request = Promise.reject(error);
  }
  const promise = Promise.resolve(request)
    .then((snapshot) => {
      record.state = 'ready';
      record.completedAt = performance.now();
      return snapshot;
    })
    .catch((error) => {
      record.state = 'failed';
      record.completedAt = performance.now();
      record.error = String(error?.message || error);
      throw error;
    });
  visualAssetRequestPromises.set(key, promise);
  if (background) promise.catch(() => {});
  return promise;
}

function requestActiveVisualAssets() {
  if (!visualAssetResidency || !qualityController) return null;
  const activeMode = qualityController.snapshot().activeMode;
  const variant = visualAssetVariantForMode(activeMode);
  visualAssetActiveVariant = variant;
  setVisualAssetBootstrapStatus({ activeVariant: variant });
  // Battery maps to the required-only critical profile. Every richer profile
  // includes its optional authored derivatives, but this promise is deliberately
  // detached from the first-frame barrier.
  return requestVisualAssetProfile(variant, {
    includeOptional: variant !== 'critical',
    background: true,
  });
}

function visualAssetReadiness(variantName = null, options = {}) {
  const requestedModeOrVariant = variantName ?? qualityController?.snapshot()?.activeMode ?? 'critical';
  const variant = visualAssetVariantForMode(requestedModeOrVariant);
  const includeOptional = options.includeOptional ?? variant !== 'critical';
  return requestVisualAssetProfile(variant, {
    ...options,
    includeOptional,
  });
}

function visualAssetDiagnostics() {
  const quality = qualityController?.snapshot?.() ?? null;
  const activeMode = quality?.activeMode ?? null;
  const activeVariant = activeMode ? visualAssetVariantForMode(activeMode) : visualAssetActiveVariant;
  return {
    version: 1,
    manifest: {
      url: VISUAL_ASSET_MANIFEST_URL,
      state: visualAssetResidency ? 'validated' : visualAssetManifestError ? 'failed' : 'loading',
      version: visualAssetResidency?.manifest?.version ?? null,
      manifestId: visualAssetResidency?.manifest?.manifestId ?? null,
      error: visualAssetManifestError ? String(visualAssetManifestError?.message || visualAssetManifestError) : null,
    },
    startup: {
      criticalReady: visualAssetCriticalReady,
      criticalRequiredFiles: visualAssetCriticalPlan?.files.length ?? 0,
      criticalVerifiedFiles: visualAssetCriticalVerified.size,
      error: visualCriticalAssetError ? String(visualCriticalAssetError?.message || visualCriticalAssetError) : null,
    },
    active: {
      mode: activeMode,
      variant: activeVariant,
      readiness: visualAssetResidency && activeVariant
        ? visualAssetResidency.snapshot(activeVariant)
        : null,
      request: activeVariant
        ? visualAssetRequestDiagnostic(activeVariant, activeVariant !== 'critical')
        : null,
    },
    critical: {
      readiness: visualAssetResidency ? visualAssetResidency.snapshot('critical') : null,
      request: visualAssetRequestDiagnostic('critical', false),
    },
    residency: visualAssetResidency?.snapshot() ?? null,
  };
}

const visualAssetsApi = Object.freeze({
  diagnostics: visualAssetDiagnostics,
  snapshot: visualAssetDiagnostics,
  request: visualAssetReadiness,
  readiness: visualAssetReadiness,
  ready: visualAssetReadiness,
});

function qualityOutputPixelCap(mode) {
  return QUALITY_OUTPUT_PIXEL_CAPS[mode] ?? QUALITY_OUTPUT_PIXEL_CAPS.balanced;
}

function applyVisualQuality(snapshot = qualityController?.snapshot()) {
  if (!qualityController || !snapshot) return snapshot;
  const outputPixelCap = qualityOutputPixelCap(snapshot.activeMode);
  const previous = appliedQualityState;
  const modeChanged = !previous || previous.activeMode !== snapshot.activeMode;
  const resolutionChanged = !previous
    || previous.activeMode !== snapshot.activeMode
    || previous.renderScale !== snapshot.renderScale
    || previous.outputPixelCap !== outputPixelCap;
  if (resolutionChanged) {
    sm.setRenderResolution({ outputPixelCap, internalRenderScale: snapshot.renderScale });
  }

  const grass = range?.grass;
  const grassPolicy = QUALITY_GRASS_WORKLOADS[snapshot.activeMode]
    ?? QUALITY_GRASS_WORKLOADS.balanced;
  const grassChanged = Boolean(
    grass?.setWorkloadPolicy
    && (!previous
      || previous.activeMode !== snapshot.activeMode
      || previous.grassTarget !== grass),
  );
  if (grassChanged) {
    // Grass.setWorkloadPolicy is deliberately bounded by its own normalizer and
    // updates uniforms on the next Range.update; no graph or GPU allocation churn.
    grass.setWorkloadPolicy(grassPolicy);
  }

  const treePolicy = QUALITY_TREE_WORKLOADS[snapshot.activeMode] ?? 'balanced';
  const treeChanged = Boolean(
    range?.setTreeWorkloadPolicy
    && (!previous
      || previous.activeMode !== snapshot.activeMode
      || previous.treeTarget !== range),
  );
  if (treeChanged) {
    range.setTreeWorkloadPolicy(treePolicy);
    sm.invalidateTemporalHistory('tree workload policy');
  }

  const weatherPolicy = QUALITY_WEATHER_WORKLOADS[snapshot.activeMode] ?? 'balanced';
  const weatherChanged = Boolean(
    sm.weatherSky?.workload
    && typeof sm.setWeatherSkyWorkload === 'function'
    && (!previous
      || previous.activeMode !== snapshot.activeMode
      || previous.weatherTarget !== sm.weatherSky
      || previous.weatherPolicy !== weatherPolicy),
  );
  if (weatherChanged) sm.setWeatherSkyWorkload(weatherPolicy);

  if (resolutionChanged || grassChanged || treeChanged || weatherChanged || !previous) {
    appliedQualityState = {
      activeMode: snapshot.activeMode,
      renderScale: snapshot.renderScale,
      outputPixelCap,
      grassTarget: grassChanged ? grass : previous?.grassTarget ?? null,
      grassPolicy: grassChanged ? { ...grassPolicy } : previous?.grassPolicy ?? null,
      treeTarget: treeChanged ? range : previous?.treeTarget ?? null,
      treePolicy: treeChanged ? treePolicy : previous?.treePolicy ?? null,
      weatherTarget: weatherChanged ? sm.weatherSky : previous?.weatherTarget ?? null,
      weatherPolicy: weatherChanged ? weatherPolicy : previous?.weatherPolicy ?? null,
    };
  }
  if (modeChanged && visualAssetCriticalReady) requestActiveVisualAssets();
  return snapshot;
}

function qualitySnapshot() {
  const snapshot = qualityController.snapshot();
  return {
    ...snapshot,
    renderResolution: sm.readRenderResolutionDiagnostics(),
    runtimeWorkloads: {
      grass: range?.grass?.workloadPolicy ? { ...range.grass.workloadPolicy } : null,
      trees: range?.treeWorkloadDiagnostics?.() ?? null,
      waterReflections: range?.waterReflection?.diagnostics?.() ?? null,
      weatherSky: sm.readWeatherSkyDiagnostics?.() ?? null,
      supported: ['grass', 'trees', 'shadows', 'waterReflections', 'weatherSky'],
      unsupported: [],
    },
  };
}

const qualityApi = Object.freeze({
  setMode(mode, options) {
    const snapshot = qualityController.setMode(mode, options ?? undefined);
    applyVisualQuality(snapshot);
    // A requested mode can change while its resolved active mode stays the
    // same (for example auto -> quality). Let residency coalesce the request.
    if (visualAssetCriticalReady) requestActiveVisualAssets();
    return qualitySnapshot();
  },
  setRenderScale(scale) {
    applyVisualQuality(qualityController.setRenderScale(scale));
    return qualitySnapshot();
  },
  acquirePresentationLock(options) {
    applyVisualQuality(qualityController.acquirePresentationLock(options));
    return qualitySnapshot();
  },
  releasePresentationLock(lockId) {
    applyVisualQuality(qualityController.releasePresentationLock(lockId));
    return qualitySnapshot();
  },
  snapshot: qualitySnapshot,
  // Workload consumers included in qualitySnapshot diagnostics must not call the
  // full snapshot recursively. This view exposes controller policy only.
  policySnapshot: () => qualityController.snapshot(),
});

function showFatalEnvironmentError(error) {
  console.error('Required environment initialization failed.', error);
  bootstrapDiagnostics.error = String(error?.message || error);
  setBootstrapStage('failed', { detail: 'Required environment or visual assets could not be verified. Reload after fixing the asset or course.' });
  let notice = document.getElementById('environment-fatal');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'environment-fatal';
    notice.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:24px;'
      + 'background:#111e;color:#fff;font:600 18px/1.45 system-ui;text-align:center;z-index:99999;';
    app.appendChild(notice);
  }
  notice.textContent = `The complete course environment could not be loaded. ${error?.message || error}`;
}

// Acquire the single strict WebGPU device before building any environment workload.
// The resulting tier changes budgets only; it never selects a different renderer,
// shader set, AA mode, or partial environment.
try {
  setBootstrapStage('webgpu-initializing', { detail: 'Acquiring the strict WebGPU device…' });
  await sm.initialize();
  const navigatorHints = globalThis.navigator ?? {};
  qualityController = new VisualQualityController({
    environmentTier: sm.environmentTier,
    hardwareConcurrency: navigatorHints.hardwareConcurrency,
    deviceMemoryGiB: navigatorHints.deviceMemory,
  });
  applyVisualQuality();
  setBootstrapStage('webgpu-ready', { detail: 'WebGPU ready. Loading the visual asset manifest…' });
  lighting = new Lighting(sm.scene, SUN, sm.environmentTier);

  // Load and validate the renderer-independent visual manifest only after the
  // strict WebGPU device exists. This path verifies bytes; it never creates a
  // second loader, mutates an authored GLB, or supplies a visual substitute.
  setVisualAssetBootstrapStatus({ manifest: 'loading' });
  setBootstrapStage('visual-manifest-loading', {
    detail: 'Loading and validating the versioned visual asset manifest…',
  });
  visualAssetManifestReady = createVisualAssetResidency(VISUAL_ASSET_MANIFEST_URL);
  try {
    visualAssetResidency = await visualAssetManifestReady;
    setVisualAssetBootstrapStatus({
      manifest: 'validated',
      manifestVersion: visualAssetResidency.manifest.version,
      manifestId: visualAssetResidency.manifest.manifestId,
    });
  } catch (error) {
    visualAssetManifestError = error;
    setVisualAssetBootstrapStatus({ manifest: 'failed' });
    throw error;
  }

  // Critical is required-only by design. It is the startup/readiness barrier;
  // the single optional critical entry and every richer profile remain outside
  // the first valid frame contract.
  visualAssetCriticalPlan = visualAssetResidency.plan('critical', { includeOptional: false });
  visualAssetCriticalVerified = new Set();
  setVisualAssetBootstrapStatus({
    critical: 'loading',
    criticalRequiredFiles: visualAssetCriticalPlan.files.length,
    criticalVerifiedFiles: 0,
  });
  setBootstrapStage('visual-critical-assets', {
    detail: `Verifying ${visualAssetCriticalPlan.files.length} required visual asset${visualAssetCriticalPlan.files.length === 1 ? '' : 's'}…`,
    completed: 0,
    total: visualAssetCriticalPlan.files.length,
  });
  visualCriticalAssetsReady = requestVisualAssetProfile('critical', {
    includeOptional: false,
    onStage: ({ stage, fileId }) => {
      if (stage === 'verified' && fileId) visualAssetCriticalVerified.add(fileId);
      setVisualAssetBootstrapStatus({ criticalVerifiedFiles: visualAssetCriticalVerified.size });
      setBootstrapStage('visual-critical-assets', {
        detail: `Verifying ${visualAssetCriticalPlan.files.length} required visual asset${visualAssetCriticalPlan.files.length === 1 ? '' : 's'}…`,
        completed: visualAssetCriticalVerified.size,
        total: visualAssetCriticalPlan.files.length,
      });
    },
  }).then((snapshot) => {
    visualAssetCriticalReady = true;
    setVisualAssetBootstrapStatus({ critical: 'ready', criticalVerifiedFiles: visualAssetCriticalPlan.files.length });
    setBootstrapStage('visual-critical-ready', {
      detail: 'Required visual assets verified. Continuing with progressive quality residency…',
      completed: visualAssetCriticalPlan.files.length,
      total: visualAssetCriticalPlan.files.length,
    });
    return snapshot;
  }).catch((error) => {
    visualCriticalAssetError = error;
    setVisualAssetBootstrapStatus({ critical: 'failed' });
    throw error;
  });
  await visualCriticalAssetsReady;
} catch (error) {
  showFatalEnvironmentError(error);
  throw error;
}

// The verified CC0 environment catalog is part of the startup barrier. The dynamic
// analytic atmosphere is configured from the same SUN/environment state as lighting,
// wind, clouds, turf, and physics; no static-sky or partial-asset path exists.
let environmentLoadError = null;
// Manifest validation is intentionally metadata-only. The course is normalized
// next so the binary barrier can be limited to assets this exact course can use.
const environmentCatalogReady = loadEnvironmentCatalog('/assets/environment/catalog.json', {
  assetIds: [],
  onStage: ({ stage }) => setBootstrapStage(stage, { detail: 'Reading the versioned environment manifest…' }),
}).catch((e) => {
  environmentLoadError = e;
  throw e;
});
let environmentCatalog = null;
let environmentAssetIntegrityReady = Promise.resolve();

const tracer = new Tracer(sm.scene, { renderer: sm.renderer });
const director = new CameraDirector(sm.camera);

// One deterministic environment clock is authoritative for physics and rendering.
// Conditions can be previewed while the ball is at rest; once a shot starts the
// immutable configuration is locked until the ball rests again. The GPU binding
// object remains stable for every material that references it.
let environmentState = null;
let environmentBindings = null;
let environmentTickRemainder = 0;
let environmentTickCount = 0;
let environmentTimeline = null;
let environmentTimelineIso = null;
let environmentTimelineRenderRemainder = 0;
let env = null;

// Broken alpine cumulus is the authored default: a low, sparse layer above the
// valley that reads as separate billows from golfer height instead of clipped
// crowns at the top of frame or a uniform overcast.
// The Conditions panel drives `cloudCoverage`; 0 is a real setting and costs nothing,
// because WeatherSky then compiles the clear analytic sky with no cloud grade at all.
const DEFAULT_CLOUD_COVERAGE = 0.26;

function hydrateEnvironmentState(state, tickCount) {
  const ticks = Math.max(0, Math.floor(Number.isFinite(tickCount) ? tickCount : 0));
  if (ticks === 0) return state;
  // Reconstruct both sides of the temporal pair at the absolute fixed-tick
  // position. This lets a timeline update replace the authored daylight config
  // without resetting wind phase or making foliage jump back to time zero.
  if (ticks > 1) state.advanceFixedTicks(ticks - 1);
  state.advanceFixedTicks(1);
  return state;
}

function makeEnvironmentState(seed, {
  windSpeedMph = 0, windDirectionDegrees = 0, cloudCoverage = DEFAULT_CLOUD_COVERAGE,
  timelineSnapshot = environmentTimeline?.snapshot(),
  tickCount = environmentTickCount,
} = {}) {
  const azimuth = Math.atan2(SUN.x, SUN.z);
  const fallbackConfig = {
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: seed >>> 0,
    tickSeconds: 1 / 120,
    sun: {
      azimuthRadians: (azimuth + Math.PI * 2) % (Math.PI * 2),
      elevationRadians: Math.asin(SUN.y),
      intensity: 85000,
      color: { r: 1.0, g: 0.955, b: 0.87 },
    },
    atmosphere: { turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005, mieDirectionalG: 0.76, exposure: 1.0 },
    clouds: { coverage: cloudCoverage, density: 0.44, baseHeight: 1100, thickness: 1200, advectionScale: 1.0 },
    wind: {
      speed: windSpeedMph * MPH_TO_MS,
      directionRadians: windDirectionDegrees * DEG_TO_RAD,
      referenceHeight: 10,
      shearExponent: 0.18,
      gustStrength: 0.28,
      turbulenceStrength: Math.min(1.4, windSpeedMph * MPH_TO_MS * 0.12),
      gustSpatialFrequency: 0.035,
      gustTemporalFrequency: 0.27,
    },
  };
  const timelineConfig = timelineSnapshot
    ? toEnvironmentFrameStateConfig(timelineSnapshot, { seed: seed >>> 0, tickSeconds: 1 / 120 })
    : fallbackConfig;
  const windSpeed = Math.min(MAX_ENVIRONMENT_WIND_SPEED_MPS, Math.max(0, windSpeedMph * MPH_TO_MS));
  const windDirectionRadians = Math.min(Math.PI * 2, Math.max(0, windDirectionDegrees * DEG_TO_RAD));
  const config = {
    ...timelineConfig,
    clouds: {
      ...timelineConfig.clouds,
      // Conditions-panel cloud coverage remains authoritative. Timeline weather
      // can still supply the other atmospheric/cloud parameters continuously.
      coverage: cloudCoverage,
    },
    wind: {
      ...timelineConfig.wind,
      // The panel owns shot conditions. These values are deliberately copied into
      // the timeline-derived frame so physics and GPU wind share one answer.
      speed: windSpeed,
      directionRadians: windDirectionRadians,
      turbulenceStrength: Math.min(1.4, windSpeed * 0.12),
    },
  };
  return hydrateEnvironmentState(new EnvironmentFrameState(config), tickCount);
}

// `ball` and the camera helpers are (re)created every time the course spec changes
// — the prompt-driven builder edits course.json, and the whole course is rebuilt.
// Kept as `let` so every closure below sees the current instance after a rebuild.
let ball = null;
let freeCam = null;
let evaluatorCamera = null;
let ballLie = [];
let flying = false;
let _resetTimer = null;
let _rangeRetentionProbe = null;

// The Lab is a provider adapter, not a privileged simulation path. Future SDK
// integrations map their packets into LaunchMonitorAdapter and subscribe this same
// canonical handoff; Ball.launch never needs provider-specific branches.
const launchMonitor = new DevelopmentLaunchMonitorAdapter();
launchMonitor.subscribeShots((shot) => hit(launchShotToBallParams(shot)));
await launchMonitor.connect();
const panel = new MetricsPanel({ onHit: hit, onEnvironmentChange: previewEnvironment });
const turfPanel = new TurfPanel();
const minimap = new Minimap();   // M to toggle; drawn from the same baked zone field as the turf

const launchMonitorApi = Object.freeze({
  snapshot: () => launchMonitor.snapshot(),
  connect: () => launchMonitor.connect(),
  disconnect: () => launchMonitor.disconnect(),
  ingest: (shot, options) => launchMonitor.ingest(shot, options),
  submit: (shot, options) => launchMonitor.ingest(shot, options),
  get state() { return launchMonitor.state; },
  get capabilities() { return launchMonitor.capabilities; },
});

function createEnvironmentTimeline(seed) {
  const previous = environmentTimeline?.snapshot();
  const conditions = panel.getEnv();
  return new EnvironmentTimeline({
    version: ENVIRONMENT_TIMELINE_VERSION,
    algorithmVersion: ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
    ...DEFAULT_TIMELINE_LOCATION,
    date: previous?.date ?? DEFAULT_TIMELINE_CLOCK.date,
    time: previous?.time ?? DEFAULT_TIMELINE_CLOCK.time,
    playback: previous?.playback ?? DEFAULT_TIMELINE_CLOCK.playback,
    seed: seed >>> 0,
    tickSeconds: 1 / 120,
    weather: {
      atmosphere: {
        turbidity: 2.3,
        rayleigh: 1.7,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.76,
        exposure: 1.0,
      },
      clouds: {
        coverage: conditions.cloudCover / 100,
        density: 0.44,
        baseHeight: 1100,
        thickness: 1200,
        advectionScale: 1.0,
      },
      wind: {
        speed: Math.min(MAX_ENVIRONMENT_WIND_SPEED_MPS, conditions.windSpeed * MPH_TO_MS),
        directionRadians: conditions.windDir * DEG_TO_RAD,
        referenceHeight: 10,
        shearExponent: 0.18,
        gustStrength: 0.28,
        turbulenceStrength: Math.min(1.4, conditions.windSpeed * MPH_TO_MS * 0.12),
        gustSpatialFrequency: 0.035,
        gustTemporalFrequency: 0.27,
      },
    },
  });
}

function updateTerrainSun() {
  if (range?.terrain?.uSunDir && environmentBindings?.sunDirection?.value) {
    range.terrain.uSunDir.value.copy(environmentBindings.sunDirection.value);
  }
}

function syncTimelineEnvironment(snapshot = environmentTimeline?.snapshot(), { force = false } = {}) {
  if (!snapshot || !range || !ball || !environmentBindings || flying) return snapshot;
  if (!force && snapshot.iso === environmentTimelineIso) return snapshot;
  const conditions = panel.getEnv();
  environmentState = makeEnvironmentState(range.environmentSeed, {
    windSpeedMph: conditions.windSpeed,
    windDirectionDegrees: conditions.windDir,
    cloudCoverage: conditions.cloudCover / 100,
    timelineSnapshot: snapshot,
    tickCount: environmentTickCount,
  });
  environmentBindings.update(environmentState);
  updateTerrainSun();
  sm.refreshWeatherSkyClouds();
  environmentTimelineIso = snapshot.iso;
  environmentTimelineRenderRemainder = 0;
  return snapshot;
}

function requireEnvironmentTimeline() {
  if (!environmentTimeline) throw new Error('Environment timeline is not ready.');
  return environmentTimeline;
}

const timelineApi = Object.freeze({
  play(rate) {
    const timeline = requireEnvironmentTimeline();
    const snapshot = timeline.play(rate);
    return syncTimelineEnvironment(snapshot, { force: true }) ?? snapshot;
  },
  pause() {
    const timeline = requireEnvironmentTimeline();
    const snapshot = timeline.pause();
    return syncTimelineEnvironment(snapshot, { force: true }) ?? snapshot;
  },
  resume(rate) {
    const timeline = requireEnvironmentTimeline();
    const snapshot = timeline.resume(rate);
    return syncTimelineEnvironment(snapshot, { force: true }) ?? snapshot;
  },
  seek(value) {
    const timeline = requireEnvironmentTimeline();
    const snapshot = timeline.seek(value);
    return syncTimelineEnvironment(snapshot, { force: true }) ?? snapshot;
  },
  advance(seconds) {
    const timeline = requireEnvironmentTimeline();
    const snapshot = timeline.advance(seconds);
    return syncTimelineEnvironment(snapshot, { force: true }) ?? snapshot;
  },
  advanceSimulation(seconds) {
    const timeline = requireEnvironmentTimeline();
    const snapshot = timeline.advanceSimulation(seconds);
    return syncTimelineEnvironment(snapshot, { force: true }) ?? snapshot;
  },
  setPlaybackRate(rate) {
    const timeline = requireEnvironmentTimeline();
    timeline.setPlaybackRate(rate);
    return timeline.snapshot();
  },
  snapshot() { return requireEnvironmentTimeline().snapshot(); },
  // The timeline clock remains independently inspectable through snapshot(), but
  // this boundary must return the state actually consumed by physics and GPU. The
  // Conditions panel intentionally overrides timeline wind/cloud coverage, and an
  // in-flight shot must never expose a newer daylight config to a caller using this
  // value for deterministic replay.
  frameStateConfig() {
    requireEnvironmentTimeline();
    return environmentState?.config ?? environmentTimeline.frameStateConfig();
  },
  get config() { return requireEnvironmentTimeline().config; },
  get paused() { return requireEnvironmentTimeline().paused; },
  get playbackRate() { return requireEnvironmentTimeline().playbackRate; },
  get currentTime() { return requireEnvironmentTimeline().currentTime; },
  get epochMilliseconds() { return requireEnvironmentTimeline().epochMilliseconds; },
  get shotLocked() { return flying; },
});

// Attach the physics event handlers to a (freshly built) ball.
function wireBall(b) {
  b.on('rest', (r) => {
    // Capture the terminal sample before the shot leaves the active stream. The
    // update loop checks `flying` again after Ball.update(), so this point is not
    // submitted twice when the rest event fires during the frame.
    if (tracer.count < tracer.max) tracer.push(b.position);
    flying = false;
    director.onRest(b);
    panel.showResult(r);
    // Driving range: hold the rotating result view, then glide back to the tee for
    // the next shot (so you hit from the mat every time). Skipped if a new shot is
    // already in the air, the free-fly cam is active, or we've left the range view.
    clearTimeout(_resetTimer);
    _resetTimer = setTimeout(() => {
      if (!flying && !freeCam?.active && shell.view === 'practice') toAddress({ smooth: true });
    }, RESULT_HOLD_MS);
  });
  b.on('hazard', (event) => {
    panel.setLive('— in the water —');
  });
  b.on('waterImpact', (event) => {
    range.addWaterImpact(event.position, event.impactSpeed);
  });
}

// Put the ball mesh where the ball IS, then apply a render-only contact offset. Long
// grass receives its full canopy-derived sink because blades occlude the lower edge;
// texture-only mown turf receives only a shallow capped offset so the ball contacts the
// ground without looking buried in a surface that cannot geometrically overlap it.
function syncBallMesh() {
  range.ballMesh.position.copy(ball.position);
  const surf = range.terrain.surfaceAt(ball.position.x, ball.position.z);
  if (ball.state !== 'airborne') {
    range.ballMesh.position.y -= renderedBallSitDepth(surf, sitDepth(surf));
  }
  // The ball collar is additionally surface-gated by BallLie.update(); this flag only
  // suppresses the otherwise-valid rough collar while the ball is airborne.
  if (ballLie[0]) ballLie[0].visible = ball.state !== 'airborne';
  // The ball is a real layer-0 shadow caster. A flight step or address teleport
  // invalidates the retained directional map; Lighting.follow() below also moves
  // the frustum for flight, while this covers the caster mutation itself.
  lighting.invalidateShadow();
}

// A bad shot state must never abort SceneManager's frame callback forever. The
// primary simulation paths are validated and deterministic, but an unexpected
// runtime error is contained to the current shot so the next animation frame can
// still submit a render and the player can recover without reloading the app.
function containShotFailure(error) {
  const x = Number.isFinite(ball?.position.x) ? ball.position.x : 0;
  const z = Number.isFinite(ball?.position.z) ? ball.position.z : 2;
  flying = false;
  try {
    ball.placeAt(x, z);
    syncBallMesh();
  } catch (recoveryError) {
    console.error('Shot recovery also failed.', recoveryError);
  }
  panel.setLive('Shot stopped — simulation error');
  sm.invalidateTemporalHistory('shot simulation error');
  console.error('Shot simulation failed; the ball was returned to a safe lie.', error);
}

// Drive the two rough-only near-field blade patches.
//
// The camera-anchored one is the interesting part: the ground area you can actually
// SEE scales with how low the camera is, so the patch radius tracks camera height.
// Down at the ball a small radius packs the fixed blade budget to ~15k blades/m^2 —
// genuinely dense long grass. Mown surfaces never enable either patch and rely on the
// scale-correct ground texture at every camera height.
const _fwd = new Vector3();
function updateNearTurf(t) {
  if (!ballLie.length) return;
  const cam = sm.camera;
  const camH = Math.max(0.01, cam.position.y - range.terrain.heightAt(cam.position.x, cam.position.z));
  const fade = 1 - Math.min(1, Math.max(0, (camH - 0.55) / (1.7 - 0.55)));
  const radius = Math.min(0.95, Math.max(0.14, camH * 1.7));

  const [collar, near] = ballLie;
  const bs = range.terrain.surfaceAt(ball.position.x, ball.position.z);
  collar.update(t, ball.position.x, ball.position.z, bs);

  // Centre the camera patch on the ground ahead of the camera so it fills the frame
  // rather than sitting behind the near clip plane.
  cam.getWorldDirection(_fwd);
  const fx = cam.position.x + _fwd.x * radius * 0.6;
  const fz = cam.position.z + _fwd.z * radius * 0.6;
  near.update(t, fx, fz, range.terrain.surfaceAt(fx, fz), { radius, fade });
}

// Address framing looking down the target line (-Z).
function toAddress({ smooth = false } = {}) {
  ball.placeAt(0, 2);
  syncBallMesh();
  // A completed shot leaves the shadow frustum centered down-range. Move the
  // unchanged-direction sun rig back with the teleported ball before caching the
  // next address map.
  lighting.follow(ball.position.x, ball.position.z);
  if (smooth) director.returnToAddress(ball.position, new Vector3(0, 0, -1));
  else director.setAddress(ball.position, new Vector3(0, 0, -1));
  panel.showAddress();
  // Only explicit/initial address changes are cuts. The automatic result return keeps
  // temporal history because CameraDirector continuously damps the whole move.
  if (!smooth) sm.invalidateTemporalHistory('address camera cut');
}

// Build (or rebuild) the entire course from a normalized spec. Disposes the old
// course first so repeated agent rebuilds don't leak GPU resources. The terrain is
// baked from the spec's FEATURES — this is the only path course data takes into the
// scene, so there is no terrain-editing surface to expose.
function buildCourse(course) {
  tracer.clearHistory();
  if (range) {
    if (_rangeRetentionProbe) {
      Object.defineProperty(range, '__rangeRetentionProbeMarker', { value: true });
      _rangeRetentionProbe.push(new WeakRef(range));
    }
    range.dispose();
  }
  flying = false;
  const seedChanged = !environmentTimeline || environmentTimeline.config.seed !== course.environmentSeed;
  if (seedChanged) {
    environmentTimeline = createEnvironmentTimeline(course.environmentSeed);
    environmentTimelineIso = null;
    environmentTimelineRenderRemainder = 0;
    environmentTickRemainder = 0;
    environmentTickCount = 0;
    environmentState = null;
  }
  if (!environmentState || environmentState.config.seed !== course.environmentSeed) {
    // Carry the panel's current cloud setting across a course rebuild so a slider
    // change is not silently reverted by loading an edited course.json.
    const conditions = panel.getEnv();
    environmentState = makeEnvironmentState(course.environmentSeed, {
      windSpeedMph: conditions.windSpeed,
      windDirectionDegrees: conditions.windDir,
      cloudCoverage: conditions.cloudCover / 100,
      timelineSnapshot: environmentTimeline.snapshot(),
      tickCount: environmentTickCount,
    });
    if (environmentBindings) environmentBindings.update(environmentState);
    else environmentBindings = new EnvironmentGpuBindings(environmentState);
    environmentTickRemainder = 0;
    env = makeEnv({
      sampleWind: (position, time, out) => environmentState.sampleWind(position, time, out),
      waterEntryModel: GOLF_BALL_WATER_ENTRY_MODEL,
      groundFirmness: panel.getEnv().groundFirmness,
    });
    sm.configureWeather(environmentBindings, sm.skyManifest);
    environmentTimelineIso = environmentTimeline.snapshot().iso;
  }
  range = new Range(sm.scene, sm.camera, course, {
    renderer: sm.renderer, motionHistory: sm.motionHistory, lighting,
    environmentTier: sm.environmentTier, environment: environmentBindings,
    environmentCatalog,
  });
  // Initial quality selection happens before Range construction. Apply the pending
  // mode once the grass workload hook exists, and repeat this after every rebuild.
  applyVisualQuality();
  ball = new Ball(range.terrain, env);
  wireBall(ball);
  // Free-fly cam persists across rebuilds (keeps its listeners); just re-point its
  // terrain reference at the new course. Created lazily on the first build.
  if (!freeCam) freeCam = new FreeCamera(sm.camera, sm.renderer.domElement, range.terrain, {
    onDragEnd: () => sm.invalidateTemporalHistory('free-camera drag settled'),
  });
  else freeCam.terrain = range.terrain;
  turfPanel.attach(range.terrain);   // live turf sliders (G) follow the rebuilt terrain
  minimap.attach(range.terrain);     // re-rasterise the hole for the new course
  range.terrain.uSunDir.value.copy(SUN); // compatibility baseline before shared daylight is installed
  updateTerrainSun();   // canopy self-shadow marches toward the shared daylight key
  // Dense supplemental blades improve long-grass macro views. Mown surfaces never
  // enable these helpers; their scale-correct PBR/parallax material remains continuous.
  for (const l of ballLie) {
    sm.scene.remove(l.mesh);
    l.dispose();
  }
  ballLie = [
    // Rough-only collar so long blades overlap the ball's contact silhouette.
    new BallLie({ terrain: range.terrain, camera: sm.camera, motionHistory: sm.motionHistory, environment: environmentBindings, count: 520, radius: 0.105, inner: 0.013, follow: 'ball' }),
    // Rough-only camera patch for dense ball-level macro views.
    new BallLie({ terrain: range.terrain, camera: sm.camera, motionHistory: sm.motionHistory, environment: environmentBindings, count: 7000, radius: 0.5, inner: 0.0, follow: 'camera' }),
  ];
  for (const l of ballLie) sm.scene.add(l.mesh);
  toAddress();
}

try {
  environmentCatalog = await environmentCatalogReady;
  // BACKDROP_PLAN Phase 1: the CC0 Alps HDR is no longer a render source. It is
  // composition inspiration for the procedural valley (Phase 2) and the A/B
  // skybox variant; the analytic clear-sky owns the visible background while
  // PMREM, water, and IBL follow the same shared node. The manifest asset stays
  // shipped as the rollback A/B baseline (docs/BACKDROP_PLAN.md).
  sm.configureSkyManifest(null);
  setBootstrapStage('course-loading', { detail: 'Loading and validating the authored course…' });
  const initialCourse = coursePath === '/course.json'
    ? await loadCourse('/course.json', { catalogAssetIds: environmentCatalog.byId })
    : await loadCourse(coursePath, { catalogAssetIds: environmentCatalog.byId });
  const initialAssetIds = collectEnvironmentAssetIds(initialCourse);
  setBootstrapStage('asset-integrity', {
    detail: `Verifying ${initialAssetIds.size} course-referenced asset${initialAssetIds.size === 1 ? '' : 's'}…`,
    completed: 0, total: initialAssetIds.size,
  });
  environmentAssetIntegrityReady = verifyEnvironmentCatalogAssets(environmentCatalog, {
    assetIds: initialAssetIds, memoize: true,
    onStage: ({ completed, total }) => setBootstrapStage('asset-integrity', {
      detail: `Verifying ${initialAssetIds.size} course-referenced asset${initialAssetIds.size === 1 ? '' : 's'}…`,
      completed, total,
    }),
  });
  await environmentAssetIntegrityReady;
  setBootstrapStage('course-building', { detail: 'Building the verified course environment…' });
  buildCourse(initialCourse);
  // The renderer is deliberately gated on the complete environment. The synchronous
  // material objects may exist while images decode, but no placeholder/partial course
  // is ever presented as a valid frame.
  setBootstrapStage('asset-decoding', { detail: 'Decoding verified geometry, foliage, terrain, and lighting…' });
  await range.assetsReady;
  setBootstrapStage('atmosphere-ready', { detail: 'Finalizing shared daylight and water reflections…' });
  await sm.weatherSky.ready;
  sm.rebuildDaylightPmrem();
  setBootstrapStage('ready', { detail: 'Range ready.' });
  // Richer authored variants are deliberately requested only after the first
  // complete production frame is eligible to present. Detaching the promise is
  // not enough if a large background transfer competes with course GLBs during
  // startup; this ordering keeps progressive residency truly post-critical.
  requestActiveVisualAssets();
} catch (error) {
  showFatalEnvironmentError(error);
  throw error;
}

async function rebuildCourseFromDisk() {
  const wasRunning = sm._ready && !sm._renderingPaused;
  const recoverFatalPause = sm._ready && sm._renderingPaused && !!document.getElementById('environment-fatal');
  if (wasRunning) sm.pauseRendering();
  try {
    setBootstrapStage('course-loading', { detail: 'Loading and validating the edited course…' });
    const nextCourse = await loadCourse(coursePath, { catalogAssetIds: environmentCatalog.byId });
    const nextAssetIds = collectEnvironmentAssetIds(nextCourse);
    setBootstrapStage('asset-integrity', {
      detail: `Re-verifying ${nextAssetIds.size} course-referenced asset${nextAssetIds.size === 1 ? '' : 's'}…`,
      completed: 0, total: nextAssetIds.size,
    });
    environmentAssetIntegrityReady = verifyEnvironmentCatalogAssets(environmentCatalog, {
      assetIds: nextAssetIds, memoize: true,
      onStage: ({ completed, total }) => setBootstrapStage('asset-integrity', {
        detail: `Re-verifying ${nextAssetIds.size} course-referenced asset${nextAssetIds.size === 1 ? '' : 's'}…`,
        completed, total,
      }),
    });
    await environmentAssetIntegrityReady;
    setBootstrapStage('course-building', { detail: 'Rebuilding from verified course assets…' });
    buildCourse(nextCourse);
    setBootstrapStage('asset-decoding', { detail: 'Decoding the rebuilt environment…' });
    await range.assetsReady;
    setBootstrapStage('atmosphere-ready', { detail: 'Finalizing rebuilt daylight and water reflections…' });
    await sm.weatherSky.ready;
    sm.rebuildDaylightPmrem();
    setBootstrapStage('ready', { detail: 'Range ready.' });
    requestActiveVisualAssets();
    document.getElementById('environment-fatal')?.remove();
    if (wasRunning || recoverFatalPause) sm.resumeRendering();
  } catch (error) {
    showFatalEnvironmentError(error);
    // Leave rendering paused: continuing with a partial rebuild would itself be a
    // fallback environment. A later successful rebuild may explicitly recover it.
    throw error;
  }
}

function applyEnvironmentConditions(conditions) {
  if (!range || !ball || !environmentBindings) return;
  const rho = airDensity({ altitude: conditions.altitude, temperatureC: conditions.temperatureC });
  environmentTickRemainder = 0;
  environmentTickCount = 0;
  const timelineSnapshot = environmentTimeline?.snapshot();
  environmentState = makeEnvironmentState(range.environmentSeed, {
    windSpeedMph: conditions.windSpeed,
    windDirectionDegrees: conditions.windDir,
    cloudCoverage: conditions.cloudCover / 100,
    timelineSnapshot,
    tickCount: 0,
  });
  environmentBindings.update(environmentState);
  updateTerrainSun();
  // The coverage uniform is already live for the next frame. This only rebuilds the
  // sky node on the clear/cloudy boundary, where the shader itself has to change.
  sm.refreshWeatherSkyClouds();
  environmentTimelineIso = timelineSnapshot?.iso ?? environmentTimelineIso;
  environmentTimelineRenderRemainder = 0;
  env = makeEnv({
    rho,
    viscosity: airViscosity(conditions.temperatureC),
    groundFirmness: conditions.groundFirmness,
    sampleWind: (position, time, out) => environmentState.sampleWind(position, time, out),
    waterEntryModel: GOLF_BALL_WATER_ENTRY_MODEL,
  });
  ball.setEnvironment(env);
}

// Let the conditions panel drive the same shared GPU/physics environment while the
// ball is at rest. This makes wind immediately visible in turf, trees, clouds, and
// water without permitting a slider edit to mutate an in-flight trajectory.
function previewEnvironment(conditions) {
  if (flying) return;
  applyEnvironmentConditions(conditions);
}

function hit(params = null) {
  if (flying || !ball) return;
  if (!params) {
    try {
      launchMonitor.emitShot(panel.getLaunchInput());
    } catch (error) {
      panel.setLive(`Launch input unavailable: ${error?.message || error}`);
    }
    return;
  }
  clearTimeout(_resetTimer);            // a new shot cancels any pending auto-reset
  // A launch-monitor shot arriving during the result hold is the user's request
  // for the next ball. Return its physical origin to the tee before launch; the
  // previous implementation could otherwise hit again from the landing position.
  if (director.phase === 'result' || director.phase === 'return') {
    toAddress();
  }
  // Freeze a fresh deterministic environment at the exact shot boundary. This is
  // intentionally the same path used by the at-rest visual preview.
  applyEnvironmentConditions(panel.getEnv());

  tracer.promoteActiveToWhite();
  tracer.reset();
  panel.beginShot(params);
  ball.launch(params);
  tracer.push(ball.start);
  director.onLaunch(ball);
  flying = true;

  // Take a divot on the GPU — but only for shots hit DOWN off the turf: irons and
  // wedges take a divot; a driver/wood (swept off a tee) or a putter never do. Stamp a
  // thin FRESH bacon-strip just target-side of the ball, aligned to the shot direction.
  const club = (params.club || '').toLowerCase();
  const takesDivot = club.includes('iron') || club.includes('wedge');
  if (takesDivot) {
    const a = Math.atan2(ball.velocity.x, -ball.velocity.z);
    // Small random offset around the strike so repeated shots from the same tee spot
    // leave DISTINCT scars (a scatter), instead of stacking on one divot.
    const divotEvent = environmentState.nextEvent('turf.divot');
    const random = createRng(divotEvent.id);
    const jx = (random() - 0.5) * 0.7;
    const jz = (random() - 0.5) * 0.7;
    range.terrain.stampDivot(sm.renderer, ball.start.x + jx, ball.start.z - 0.3 + jz,
      0.022, a, 0.08 + random() * 0.14, 4.0 + random() * 1.5, random() * 20);
  }
}

// The course builder: a prompt box that hands natural language to the local agent
// (via the /api/build sidecar), which authors course.json with the course-design
// skills. The ONLY authoring control is the prompt — no terrain editing.
const builder = new BuilderPanel({
  getCourse: () => (range ? range.course : null),
  // The sidecar pushes a live 'course:changed' event on success, which triggers the
  // rebuild below; this callback just surfaces the request result to the panel.
});

// App shell: the premium landing menu routes between Practice (range), Course
// Creator (builder), and Play (course select). On entering an in-scene view we drop
// the cinematic orbit and reframe to the tee.
const shell = new Menu({
  onView: (v) => {
    // An evaluator owns the live camera until it explicitly exits. Menu routing
    // must not reframe it through CameraDirector while a harness is capturing.
    if (evaluatorCamera?.active) return;
    if (v === 'practice' || v === 'creator') {
      if (freeCam.active) freeCam.exit();
      if (!flying) toAddress();
    }
    // Refresh the Play card with a live render of the current course each time it opens.
    if (v === 'play') requestThumb();
  },
  // Live figures for the Course Creator HUD (Objects / FPS / Status).
  getStats: () => {
    const c = range?.course;
    const objects = c ? c.greens.length + c.bunkers.length + c.ponds.length : 0;
    return { objects, fps: _fps || '—', status: builder?.busy ? 'Building' : 'Ready' };
  },
});

// The evaluator is installed after the initial course build so it can retain the
// live FreeCamera instance for ownership handoff/restore across course rebuilds.
evaluatorCamera = new EvaluatorCamera({
  camera: sm.camera,
  sceneManager: sm,
  director,
  freeCamera: freeCam,
});

// Slow cinematic orbit used as the menu's living backdrop (the real course renders
// behind the overlay). Reframed to the tee by toAddress() when a view is entered.
let _menuAngle = 0.4;
function menuCinematic(dt) {
  _menuAngle += dt * 0.04;
  const cx = 0, cz = -118, R = 138, H = 64;
  sm.camera.position.set(cx + Math.cos(_menuAngle) * R, H, cz + Math.sin(_menuAngle) * R);
  sm.camera.up.set(0, 1, 0);
  sm.camera.lookAt(cx, 6, cz);
}

// Live course thumbnail for the Play card — a real render of the actual geometry,
// captured from the existing menu camera. This used to teleport the LIVE camera to an
// elevated overview for four frames before returning it. The jump polluted the temporal
// AA/half-resolution AO history and produced horizontal bands across the grass just
// before the menu camera resumed its pan. Capturing the settled menu render keeps the
// thumbnail live without ever presenting a transient camera state to the player.
let _thumbCountdown = 0;
function requestThumb() { if (_thumbCountdown === 0) _thumbCountdown = 4; }
function thumbCapture() {
  // Direct toDataURL on the WebGPU canvas (drawImage from it returns blank). It holds
  // the overview frame after a few frames of posing above.
  try { shell.setCourseThumb(sm.renderer.domElement.toDataURL('image/jpeg', 0.75)); }
  catch (e) { /* canvas capture unavailable */ }
}

// Live rebuild: the Vite sidecar plugin fires this custom HMR event whenever
// course.json changes (an agent edit, or a manual edit). Re-fetch + rebuild.
if (import.meta.hot) {
  import.meta.hot.on('course:changed', async () => {
    try {
      await rebuildCourseFromDisk();
      builder.onCourseReloaded(range.course);
      setTimeout(requestThumb, 400);   // refresh the Play thumbnail to the new course
    } catch (error) {
      builder.onCourseReloadFailed(error);
    }
  });
}

// On-screen FPS / frame-time meter (toggle with `). Uses real wall-clock time —
// the physics dt is clamped to 0.1s, so it would floor the reading at 10fps and
// lie. On by default while we tune performance.
const fpsEl = document.createElement('div');
fpsEl.id = 'gs-fps';
// Flows inside the top-right stack (created by the Menu shell) so it never overlaps.
fpsEl.style.cssText = 'font:700 13px/1.3 ui-monospace,SFMono-Regular,monospace;color:#dff2e1;'
  + 'background:rgba(14,20,26,.72);padding:4px 8px;border-radius:6px;pointer-events:none;';
(document.getElementById('gs-topright') || document.body).appendChild(fpsEl);
fpsEl.style.display = 'none';
let _fpsLast = performance.now(), _fpsN = 0, _fpsAcc = 0, _fps = 0;
let _qualityLastFrameAt = null;
function updateFpsMeter() {
  const now = performance.now();
  _fpsAcc += (now - _fpsLast) / 1000; _fpsLast = now; _fpsN++;
  if (_fpsAcc >= 0.5) {
    _fps = Math.round(_fpsN / _fpsAcc);
    const off = [];
    if (range.grass && !range.grass.mesh.visible) off.push('grass');
    if (range.trees && !range.trees.visible) off.push('trees');
    const tag = off.length ? `  [${off.join(' ')} off]` : '';
    fpsEl.textContent = `${(_fpsN / _fpsAcc).toFixed(0)} fps · ${(1000 * _fpsAcc / _fpsN).toFixed(1)} ms${tag}`;
    _fpsAcc = 0; _fpsN = 0;
  }
}

function ingestQualityFrame() {
  const now = performance.now();
  if (!qualityController || !Number.isFinite(now) || sm.renderingPaused) {
    // Native timestamp capture steps production frames synchronously while the
    // animation loop is paused. Those diagnostic submissions are not presentation
    // cadence, so reset the wall clock instead of teaching Auto that they are very
    // fast live frames.
    _qualityLastFrameAt = Number.isFinite(now) ? now : null;
    return;
  }
  // Measure presentation cadence independently of simulation time. In particular,
  // evaluatorCamera.freeze() intentionally reports a zero simulation dt while the
  // live WebGPU animation loop continues; those presented frames must still drive
  // Auto quality and its 30/60 fps contracts.
  const frameMs = Number.isFinite(_qualityLastFrameAt)
    ? Math.max(0, now - _qualityLastFrameAt)
    : null;
  _qualityLastFrameAt = now;
  if (!(frameMs > 0)) return;
  const snapshot = qualityController.ingestSample({
    frameMs,
    atMs: Number.isFinite(now) ? now : undefined,
  });
  applyVisualQuality(snapshot);
}

function updateEnvironment(dt) {
  if (!environmentState || !environmentBindings) return;

  const timelineSnapshot = environmentTimeline?.advance(dt);
  const timelineChanged = Boolean(
    timelineSnapshot && timelineSnapshot.iso !== environmentTimelineIso,
  );
  environmentTimelineRenderRemainder += Math.max(0, dt);
  environmentTickRemainder += Math.max(0, dt);
  const environmentTicks = Math.floor(environmentTickRemainder / environmentState.config.tickSeconds);
  if (environmentTicks > 0) {
    environmentTickRemainder -= environmentTicks * environmentState.config.tickSeconds;
    environmentTickCount += environmentTicks;
  }

  if (flying) {
    // The active shot owns the exact EnvironmentFrameState it launched with.
    // Advancing its fixed phase is deterministic; timeline daylight changes are
    // intentionally held out of the physics/render bindings until the ball rests.
    if (environmentTicks > 0) {
      environmentState.advanceFixedTicks(environmentTicks);
      environmentBindings.update(environmentState);
    }
    return;
  }

  const shouldSyncTimeline = timelineChanged
    && environmentTimelineRenderRemainder >= TIMELINE_RENDER_UPDATE_SECONDS;
  if (shouldSyncTimeline) {
    syncTimelineEnvironment(timelineSnapshot);
    return;
  }

  // With a paused timeline this is the normal path: keep the fixed wind phase
  // moving without changing the daylight signature, so PMREM/shadow scheduling
  // stays quiet. A running timeline is likewise advanced between its bounded
  // daylight updates.
  if (environmentTicks > 0) {
    environmentState.advanceFixedTicks(environmentTicks);
    environmentBindings.update(environmentState);
  }
}

// Main update.
sm.onUpdate((dt, t) => {
  ingestQualityFrame();
  updateEnvironment(dt);
  // Thumbnail grab: let the current camera settle for a few frames, then capture its
  // real render. Never override the live camera for thumbnail generation.
  if (_thumbCountdown > 0) { _thumbCountdown--; if (_thumbCountdown === 0) thumbCapture(); }
  updateFpsMeter();
  if (flying) {
    try {
      ball.update(dt);
    } catch (error) {
      containShotFailure(error);
      return;
    }
    syncBallMesh();
    // Ball.update can synchronously emit rest and switch the UI to final results.
    // Never let the remainder of that same animation frame overwrite the terminal
    // state with stale flight telemetry.
    if (flying) {
      // One bounded point upload per presented frame. The GPU owns history,
      // smoothing, ribbon expansion, and indirect draw count.
      tracer.push(ball.position);
      const dist = Math.hypot(ball.position.x - ball.start.x, ball.position.z - ball.start.z) * M_TO_YARD;
      const height = (ball.position.y - ball.start.y) * 3.28084;
      const landed = ball.carryYards > 0;
      panel.showFlight({
        carryYards: landed ? ball.carryYards : dist,
        heightFeet: height,
        totalYards: dist,
        landed,
      });
    }

    lighting.follow(ball.position.x, ball.position.z);
  }

  // Menu view: slow cinematic orbit behind the overlay. The thumbnail countdown does
  // not interrupt it; its final frame is the one we capture. In-scene views use the
  // free-fly cam when active, else the cinematic shot director.
  if (evaluatorCamera.active) evaluatorCamera.update?.(dt);
  else if (shell.view === 'menu') menuCinematic(dt);
  else if (freeCam.active) freeCam.update(dt);
  else director.update(dt, ball);

  // Procedural blade positions are camera-dependent (LOD, lens fade, facing width).
  // Update them after the final camera pose for this frame, then retain those inputs
  // as the next frame's true previous geometry state.
  range.update(t);
  updateNearTurf(t);
  minimap.update(ball.position, sm.camera);
  // Startup turf remains pristine. Only the shot-completion path stamps divots.
  evaluatorCamera.notifyFrame(sm.renderer.info.frame);
});

sm.start();

// Prime the Play card with a real render once the scene (incl. trees) has settled.
setTimeout(requestThumb, 2600);

// Controls.
window.addEventListener('keydown', (e) => {
  // Don't steal keys while typing into the builder prompt.
  if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
  if (evaluatorCamera?.active) return;
  // Gameplay keys only apply inside the range/creator views (not on the menu).
  if (shell.view !== 'practice' && shell.view !== 'creator') return;
  // While free-roaming, Space is "rise" (handled by FreeCamera) — don't hit.
  if (e.code === 'Space') { e.preventDefault(); if (!freeCam.active) hit(); }
  if (e.code === 'KeyF') freeCam.toggle();
  if (e.code === 'KeyR') { if (freeCam.active) freeCam.exit(); if (!flying) toAddress(); }
  if (e.code === 'Backquote') fpsEl.style.display = fpsEl.style.display === 'none' ? '' : 'none';
});

// Dismiss the loading veil only after the verified production environment is
// ready. WebGPU alone is not enough: hiding here before GLB/atlas decode made a
// legitimate integrity wait look like a hung or partially rendered range.
function dismissLoadingAfterRendererReady() {
  if (!sm._ready || bootstrapDiagnostics.stage !== 'ready') {
    requestAnimationFrame(dismissLoadingAfterRendererReady);
    return;
  }
  requestAnimationFrame(() => document.getElementById('loading')?.classList.add('hidden'));
}
dismissLoadingAfterRendererReady();

// Expose a few handles for tinkering in the console (getters so they track rebuilds).
window.golf = {
  get ball() { return ball; },
  get range() { return range; },
  quality: qualityApi,
  visualAssets: visualAssetsApi,
  timeline: timelineApi,
  launchMonitor: launchMonitorApi,
  tracer,
  get freeCam() { return freeCam; },
  evaluatorCamera,
  director, panel, turfPanel, minimap, sm, lighting, builder, shell,
  // Narrow benchmark hook: this resolves only after the atmosphere, authoritative
  // terrain/turf material, and tree prototype are present. The harness then warms the actual camera/post
  // path before timing; it never measures loading placeholders as a scene baseline.
  // Resolves only after metadata, course-referenced binary hashes, runtime
  // decodes, and shared atmosphere readiness. Unused catalog derivatives are
  // deliberately outside this first-frame contract.
  get environmentReady() { return Promise.all([environmentCatalogReady, environmentAssetIntegrityReady, visualAssetManifestReady, visualCriticalAssetsReady, range?.assetsReady, sm.weatherSky?.ready]); },
  get environmentLoadError() { return environmentLoadError; },
  refreshThumb: requestThumb,
  rebuild: rebuildCourseFromDisk,
  // The robustness harness enables this before repeated real rebuilds. Creating the
  // WeakRef inside the application avoids DevTools retaining the Range merely because
  // an evaluation expression touched it.
  beginRangeRetentionProbe() { _rangeRetentionProbe = []; },
  sampleRangeRetentionProbe() {
    const refs = _rangeRetentionProbe || [];
    return { total: refs.length, alive: refs.filter((reference) => reference.deref() !== undefined).length };
  },
  endRangeRetentionProbe() { _rangeRetentionProbe = null; },
};
