import { Vector3 } from 'three';
import { loadCourseLibrary, savedCoursePath } from './course/CourseLibrary.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { SceneManager } from './scene/SceneManager.js';
import { LoadingGreen } from './scene/LoadingGreen.js';
import { prepareSceneTextures } from './scene/prepareSceneTextures.js';
import { TURF_PACK_SOURCE_URLS } from './terrain/TurfSources.js';
import './ui/loading.css';
import './ui/tree-builder.css';
import { Lighting } from './scene/Lighting.js';
import { Range } from './scene/Range.js';
import { CourseScene } from './scene/CourseScene.js';
import { CreatorScene } from './scene/CreatorScene.js';
import { PlayScene } from './scene/PlayScene.js';
import { createCreatorCup, GOLF_HOLE_RADIUS_M, CREATOR_CUP_DEPTH_M } from './scene/CreatorCup.js';
import { Tracer } from './scene/Tracer.js';
import { AimGuide } from './scene/AimGuide.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { FreeCamera } from './camera/FreeCamera.js';
import { EvaluatorCamera } from './camera/EvaluatorCamera.js';
import { MetricsPanel } from './ui/MetricsPanel.js';
import { BuilderPanel } from './ui/BuilderPanel.js';
import { Menu } from './ui/Menu.js';
import { TurfPanel } from './ui/TurfPanel.js';
import { createHoleShotPlan, Minimap, resolveAimTarget } from './ui/Minimap.js';
import { Ball } from './physics/Ball.js';
import { makeEnv } from './physics/ballistics.js';
import { GOLF_BALL_WATER_ENTRY_MODEL } from './physics/waterInteraction.js';
import { sitDepth } from './physics/groundInteraction.js';
import { BallLie } from './scene/BallLie.js';
import { renderedBallSitDepth } from './scene/NearTurfPolicy.js';
import { airDensity, airViscosity } from './physics/constants.js';
import {
  classifyCourseRuntimeChange, loadCourse, normalizeCourse, normalizeSurfaceMaterials,
} from './course/course.js';
import { createCreatorCanvasCourse, creatorCanvasCameraPose } from './course/CreatorCanvas.js';
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
import { GolfAudio, prepareGolfAudioContext } from './audio/GolfAudio.js';
import { AudioSettings } from './ui/AudioSettings.js';
import {
  dampNearBallTurfDetail, nearBallTurfDetailTarget, nearBallTurfFocusFollowAlpha,
} from './terrain/NearBallTurfDetail.js';

// Clear alpine late-morning key from the left/downrange: a 37° elevation keeps
// the source plausible while its lateral component gives terrain relief and
// tree shadows a readable rake across the broadcast route. Every daylight
// consumer receives this same authored direction through EnvironmentGpuBindings.
const SUN = new Vector3(-0.72, 0.60, -0.32).normalize();
const QUALITY_OUTPUT_PIXEL_CAPS = Object.freeze({
  // Auto workload adaptation must never soften the whole scene. Battery and
  // Balanced reduce bounded scene workloads, while retaining Quality's output
  // cap so a mode change cannot silently lower high-DPI presentation resolution.
  battery: 5_760_000,
  balanced: 5_760_000,
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
  // The authored rough atlas owns distant coverage in live modes. Launching the
  // 192² candidate field through the former 4R continuation cost ~19 ms even when
  // almost every far candidate was rejected. Keep real crossed blades in the full
  // near field; reserve the long continuation for explicit Ultra presentation.
  battery: Object.freeze({ densityScale: 0.58, radiusScale: 0.68, farTierScale: 0.00 }),
  balanced: Object.freeze({ densityScale: 0.74, radiusScale: 0.82, farTierScale: 0.00 }),
  quality: Object.freeze({ densityScale: 0.90, radiusScale: 0.94, farTierScale: 0.00 }),
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
const startupView = startupQuery.get('view');
const directPage = window.location.pathname;
const hasDirectScenePage = ['/range.html', '/creator.html', '/play.html'].includes(directPage);
// An explicit page owns its scene even when a generic harness appends a stale
// `?view=` value. Query routing is used only by the shared landing entry.
const isRangePage = directPage === '/range.html'
  || (!hasDirectScenePage && startupView === 'practice');
const isCreatorPage = directPage === '/creator.html'
  || (!hasDirectScenePage && startupView === 'creator');
const isPlayPage = directPage === '/play.html'
  || (!hasDirectScenePage && startupView === 'play');
const referenceCourseSelected = startupQuery.get('course') === 'grasslands-reference';
let coursePath = referenceCourseSelected ? '/courses/grasslands-reference.json'
  : isRangePage ? '/beach-range.json' : '/course.json';
let creatorCanvasActive = isCreatorPage && !referenceCourseSelected && startupQuery.get('authored') !== '1';
let creatorCanvasVariant = 0;
let loadingGreen = null;
let bootstrapAudioContext = null;

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
  get loadingGreen() { return loadingGreen?.diagnostics ?? null; },
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
  const shadows = lighting?.cameraShadows;
  const shadowsChanged = shadows && (modeChanged || previous?.shadowTarget !== shadows);
  if (shadowsChanged) {
    shadows.setWorkloadPolicy(snapshot.activeMode);
    sm.invalidateTemporalHistory('shadow workload policy');
  }

  if (resolutionChanged || grassChanged || treeChanged || weatherChanged || shadowsChanged || !previous) {
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
      shadowTarget: shadows,
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
  bootstrapAudioContext?.dispose();
  loadingGreen?.stop();
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
  setBootstrapStage('audio-device-initializing', { detail: 'Preparing the audio device before the putting scene…' });
  const audioDeviceStarted = performance.now();
  bootstrapAudioContext = prepareGolfAudioContext();
  bootstrapDiagnostics.audioDevice = { supported: bootstrapAudioContext.supported,
    durationMs: performance.now() - audioDeviceStarted };
  // Installed decoder supports transferable worker jobs; an async GLTF API alone
  // otherwise executes its WASM buffer decoding on the animation thread.
  MeshoptDecoder.useWorkers(2);
  const navigatorHints = globalThis.navigator ?? {};
  qualityController = new VisualQualityController({
    environmentTier: sm.environmentTier,
    hardwareConcurrency: navigatorHints.hardwareConcurrency,
    deviceMemoryGiB: navigatorHints.deviceMemory,
  });
  applyVisualQuality();
  setBootstrapStage('webgpu-ready', { detail: 'WebGPU ready. Loading the visual asset manifest…' });
  lighting = new Lighting(sm.scene, SUN, sm.environmentTier);
  loadingGreen = new LoadingGreen({
    renderer: sm.renderer, environmentTier: sm.environmentTier,
    course: normalizeCourse(createCreatorCanvasCourse({ seed: crypto.getRandomValues(new Uint32Array(1))[0] })),
    environmentState: makeEnvironmentState(246813579, {
      timelineSnapshot: null, tickCount: 0, windSpeedMph: 3, cloudCoverage: 0,
    }),
    onError: error => showFatalEnvironmentError(error),
  });
  await loadingGreen.prepare();
  if (loadingGreen.error) throw loadingGreen.error;

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
const aimGuide = new AimGuide(sm.scene);
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
let environmentTimelineAtmosphereSignature = null;
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
    moon: {
      azimuthRadians: 0,
      elevationRadians: -Math.PI / 2,
      intensity: 0,
      color: { r: 0.78, g: 0.84, b: 1.0 },
      illuminatedFraction: 0,
      angularRadiusRadians: 0.0045,
      phaseAngleRadians: Math.PI,
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
let aimTarget = null;
let defaultAimTarget = null;
let _resetTimer = null;
let _rangeRetentionProbe = null;
let audio = null;
let holeStrokes = 0;
let pendingHazard = null;

// The Lab is a provider adapter, not a privileged simulation path. Future SDK
// integrations map their packets into LaunchMonitorAdapter and subscribe this same
// canonical handoff; Ball.launch never needs provider-specific branches.
const launchMonitor = new DevelopmentLaunchMonitorAdapter();
launchMonitor.subscribeShots((shot) => hit(launchShotToBallParams(shot)));
await launchMonitor.connect();
const panel = new MetricsPanel({ onHit: hit, onEnvironmentChange: previewEnvironment, onContinue: continuePlay });
let surfaceMaterialsPreviewBaseline = null;
const turfPanel = new TurfPanel({
  onApply: previewSurfaceMaterials,
  onRevert: revertSurfaceMaterialsPreview,
});
const minimap = new Minimap({
  enabled: isPlayPage || isCreatorPage,
  onAimTarget: setAimTarget,
});

const launchMonitorApi = Object.freeze({
  snapshot: () => launchMonitor.snapshot(),
  connect: () => launchMonitor.connect(),
  disconnect: () => launchMonitor.disconnect(),
  ingest: submitLaunchShot,
  submit: submitLaunchShot,
  get state() { return launchMonitor.state; },
  get capabilities() { return launchMonitor.capabilities; },
});

function submitLaunchShot(shot, options) {
  if (!sm._ready || loadingGreen.diagnostics.active || shell.view !== 'practice') return { accepted: false, reason: 'not-ready' };
  if (flying) return { accepted: false, reason: 'shot-in-progress' };
  if (ball?.holed) return { accepted: false, reason: 'hole-complete' };
  if (pendingHazard) return { accepted: false, reason: 'relief-required' };
  return launchMonitor.ingest(shot, options);
}

function configurePlayHole() {
  holeStrokes = 0;
  pendingHazard = null;
  if (range.sceneKind !== 'play') { ball.setCup(null); return; }
  const green = range.targets[range.activeHole().greenStart];
  const pin = green.pin ?? green;
  ball.setCup({ x: pin.x, z: pin.z, y: range.terrain.heightAt(pin.x, pin.z),
    radius: GOLF_HOLE_RADIUS_M, depth: CREATOR_CUP_DEPTH_M });
  range.terrain.activeCup.value.set(pin.x, GOLF_HOLE_RADIUS_M, pin.z);
  if (!range.playCup) {
    range.playCup = createCreatorCup();
    range.playCup.name = 'active-play-cup';
    range.group.add(range.playCup);
  }
  range.playCup.position.set(pin.x, ball.cup.y, pin.z);
}

function continuePlay() {
  if (flying || range.sceneKind !== 'play') return;
  if (ball.holed) {
    const holes = range.routingHoles;
    const index = holes.findIndex(hole => hole.holeId === range.activeHoleId);
    selectHole(holes[(index + 1) % holes.length].holeId);
  } else if (pendingHazard) {
    // Stroke-and-distance recovery: replay the previous lie with one penalty.
    holeStrokes++;
    pendingHazard = null;
    ball.placeAt(ball.start.x, ball.start.z);
    toAddress({ smooth: true });
    panel.setLive(`Shot ${holeStrokes + 1} · One penalty stroke added`);
  }
}

const SEASON_TIMELINE_DATES = Object.freeze({
  spring: '2026-04-15', summer: '2026-07-15', autumn: '2026-10-15', winter: '2026-01-15',
});

function authoredAtmosphereWeather(atmosphere) {
  if (!atmosphere) return null;
  const profile = {
    clear: { density: 0.28, turbidity: 2.0, mieCoefficient: 0.0035 },
    'partly-cloudy': { density: 0.44, turbidity: 2.3, mieCoefficient: 0.005 },
    overcast: { density: 0.67, turbidity: 3.2, mieCoefficient: 0.008 },
    mist: { density: 0.58, turbidity: 5.1, mieCoefficient: 0.014 },
    'light-rain': { density: 0.72, turbidity: 4.0, mieCoefficient: 0.011 },
  }[atmosphere.weather];
  return {
    date: SEASON_TIMELINE_DATES[atmosphere.season],
    time: `${atmosphere.localTime}:00.000Z`,
    profile,
  };
}

function createEnvironmentTimeline(seed, atmosphere = null) {
  const previous = environmentTimeline?.snapshot();
  const conditions = panel.getEnv();
  const authored = authoredAtmosphereWeather(atmosphere);
  return new EnvironmentTimeline({
    version: ENVIRONMENT_TIMELINE_VERSION,
    algorithmVersion: ENVIRONMENT_TIMELINE_ALGORITHM_VERSION,
    ...DEFAULT_TIMELINE_LOCATION,
    date: authored?.date ?? previous?.date ?? DEFAULT_TIMELINE_CLOCK.date,
    time: authored?.time ?? previous?.time ?? DEFAULT_TIMELINE_CLOCK.time,
    playback: previous?.playback ?? DEFAULT_TIMELINE_CLOCK.playback,
    seed: seed >>> 0,
    tickSeconds: 1 / 120,
    weather: {
      atmosphere: {
        turbidity: authored?.profile.turbidity ?? 2.3,
        rayleigh: 1.7,
        mieCoefficient: authored?.profile.mieCoefficient ?? 0.005,
        mieDirectionalG: 0.76,
        exposure: 1.0,
      },
      clouds: {
        coverage: conditions.cloudCover / 100,
        density: authored?.profile.density ?? 0.44,
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
  if (range?.terrain?.uSunDir && environmentBindings?.keyDirection?.value) {
    range.terrain.uSunDir.value.copy(environmentBindings.keyDirection.value);
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
  b.on('launch', (event) => {
    audio?.handleLaunch(event);
    if (range.sceneKind === 'play') {
      holeStrokes++;
      panel.setLive(`Hole ${range.activeHole().number} · Shot ${holeStrokes}`);
    }
  });
  b.on('bounce', (event) => audio?.handleBounce(event));
  b.on('groundContact', (event) => audio?.handleGroundContact(event));
  b.on('rest', (r) => {
    // Capture the terminal sample before the shot leaves the active stream. The
    // update loop checks `flying` again after Ball.update(), so this point is not
    // submitted twice when the rest event fires during the frame.
    if (tracer.count < tracer.max) tracer.push(b.position);
    flying = false;
    audio?.handleRest(r);
    setBallShadowCasting(true, 'ball-rest');
    director.onRest(b);
    panel.showResult(r);
    if (range.sceneKind === 'play') {
      aimTarget = null;
      const hole = range.activeHole();
      const green = range.targets[hole.greenStart];
      const pin = green?.pin ?? green;
      defaultAimTarget = pin ? { x: pin.x, z: pin.z, role: 'green' } : null;
    }
    // Hold the result, then address the resting lie in Play or the tee in Practice.
    clearTimeout(_resetTimer);
    if (range.sceneKind === 'play' && (r.holed || pendingHazard)) {
      panel.setLive(r.holed ? `Hole complete · ${holeStrokes} ${holeStrokes === 1 ? 'stroke' : 'strokes'}` : 'Ball in water · Relief required');
      panel.setContinuation(r.holed ? 'Next hole' : 'Replay shot · +1 penalty');
      return;
    }
    _resetTimer = setTimeout(() => {
      if (!flying && !freeCam?.active && shell.view === 'practice') toAddress({ smooth: true });
    }, RESULT_HOLD_MS);
  });
  b.on('hazard', (event) => {
    if (range.sceneKind === 'play') pendingHazard = event;
    panel.setLive('— in the water —');
  });
  b.on('waterImpact', (event) => {
    range.addWaterImpact(event.position, event.impactSpeed);
    audio?.handleWaterImpact(event);
  });
  b.on('holed', (event) => audio?.handleHoled(event));
}

// Put the ball mesh where the ball IS, then apply a render-only contact offset. Long
// grass receives its full canopy-derived sink because blades occlude the lower edge;
// texture-only mown turf receives only a shallow capped offset so the ball contacts the
// ground without looking buried in a surface that cannot geometrically overlap it.
function syncBallMesh() {
  range.ballMesh.position.copy(ball.position);
  const surf = range.terrain.surfaceAt(ball.position.x, ball.position.z);
  if (ball.state !== 'airborne' && ball.state !== 'holing' && !ball.holed) {
    range.ballMesh.position.y -= renderedBallSitDepth(surf, sitDepth(surf));
  }
  // The ball collar is additionally surface-gated by BallLie.update(); this flag only
  // suppresses the otherwise-valid rough collar while the ball is airborne.
  if (ballLie[0]) ballLie[0].visible = ball.state !== 'airborne' && ball.state !== 'holing' && !ball.holed;
  // The regulation ball rejoins the cached map at address/rest. During a shot it
  // is intentionally excluded: redrawing a course-scale map for a 42.7 mm moving
  // caster is wasteful, while retaining its old depth sample creates a stuck,
  // popping shadow as the camera follows it.
  if (range.ballMesh.castShadow) lighting.invalidateShadow();
}

function setBallShadowCasting(enabled, reason) {
  if (!range?.ballMesh || range.ballMesh.castShadow === enabled) return false;
  range.ballMesh.castShadow = enabled;
  lighting.invalidateShadow(true, { reason });
  return true;
}

// A bad shot state must never abort SceneManager's frame callback forever. The
// primary simulation paths are validated and deterministic, but an unexpected
// runtime error is contained to the current shot so the next animation frame can
// still submit a render and the player can recover without reloading the app.
function containShotFailure(error) {
  const x = Number.isFinite(ball?.position.x) ? ball.position.x : 0;
  const z = Number.isFinite(ball?.position.z) ? ball.position.z : 2;
  flying = false;
  setBallShadowCasting(true, 'shot-recovery');
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
const _nearTurfCameraXZ = { x: 0, y: 0 };
const _nearTurfForwardXZ = { x: 0, y: -1 };
let _nearTurfDetailActivation = 0;
let _nearTurfFocusReady = false;
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

function updateNearBallTurfDetail(dt) {
  if (!range?.terrain || !ball) return;
  const cam = sm.camera;
  const cameraHeightMeters = Math.max(
    0,
    cam.position.y - range.terrain.heightAt(cam.position.x, cam.position.z),
  );
  const cameraBallDistanceMeters = Math.hypot(
    cam.position.x - ball.position.x,
    cam.position.z - ball.position.z,
  );
  const target = nearBallTurfDetailTarget({
    enabled: (range.sceneKind === 'range' || range.sceneKind === 'play')
      && shell.view !== 'menu',
    ballState: ball.state,
    cameraHeightMeters,
    cameraBallDistanceMeters,
  });
  _nearTurfDetailActivation = dampNearBallTurfDetail(
    _nearTurfDetailActivation,
    target,
    dt,
  );
  cam.getWorldDirection(_fwd);
  const forwardLength = Math.hypot(_fwd.x, _fwd.z);
  const targetForwardX = forwardLength > 1e-6 ? _fwd.x / forwardLength : _nearTurfForwardXZ.x;
  const targetForwardY = forwardLength > 1e-6 ? _fwd.z / forwardLength : _nearTurfForwardXZ.y;
  if (!_nearTurfFocusReady || _nearTurfDetailActivation < 0.01) {
    _nearTurfCameraXZ.x = cam.position.x;
    _nearTurfCameraXZ.y = cam.position.z;
    _nearTurfForwardXZ.x = targetForwardX;
    _nearTurfForwardXZ.y = targetForwardY;
    _nearTurfFocusReady = true;
  } else {
    const follow = nearBallTurfFocusFollowAlpha(dt);
    _nearTurfCameraXZ.x += (cam.position.x - _nearTurfCameraXZ.x) * follow;
    _nearTurfCameraXZ.y += (cam.position.z - _nearTurfCameraXZ.y) * follow;
    _nearTurfForwardXZ.x += (targetForwardX - _nearTurfForwardXZ.x) * follow;
    _nearTurfForwardXZ.y += (targetForwardY - _nearTurfForwardXZ.y) * follow;
    const smoothedLength = Math.hypot(_nearTurfForwardXZ.x, _nearTurfForwardXZ.y);
    if (smoothedLength > 1e-6) {
      _nearTurfForwardXZ.x /= smoothedLength;
      _nearTurfForwardXZ.y /= smoothedLength;
    }
  }
  range.terrain.setNearBallTurfDetail({
    activation: _nearTurfDetailActivation,
    cameraXZ: _nearTurfCameraXZ,
    forwardXZ: _nearTurfForwardXZ,
  });
}

function currentShotOrigin() {
  return range?.sceneKind === 'play' ? ball.position : range?.tee ?? { x: 0, z: 2 };
}

function currentAim() {
  const target = aimTarget ?? defaultAimTarget;
  const origin = currentShotOrigin();
  if (!target || Math.hypot(target.x - origin.x, target.z - origin.z) < 0.01) return range?.activeAim?.() ?? { x: 0, z: -1 };
  return resolveAimTarget(origin, target, range.course.bounds).direction;
}

function syncDefaultAimTarget() {
  const hole = range?.activeHole?.();
  const green = range?.targets?.[hole?.greenStart];
  defaultAimTarget = createHoleShotPlan(hole, green)[1] ?? null;
  return defaultAimTarget;
}

function canAimNow() {
  return minimap.available && !flying && !ball?.holed && !pendingHazard && ['practice', 'creator'].includes(document.body.dataset.view);
}

function getAimState() {
  const source = currentShotOrigin();
  const origin = source ? { x: source.x, z: source.z } : null;
  const target = aimTarget ?? defaultAimTarget;
  const direction = range ? currentAim() : { x: 0, z: -1 };
  return Object.freeze({
    origin: origin ? Object.freeze(origin) : null,
    target: target ? Object.freeze({ ...target }) : null,
    direction: Object.freeze({ x: direction.x, z: direction.z }),
    source: aimTarget ? 'map' : 'shot-plan',
    canAim: canAimNow(),
  });
}

function setAimTarget(target) {
  if (flying) throw new Error('Aim is locked while the ball is in flight.');
  if (!canAimNow() || !range?.routing) throw new Error('Map aiming requires an active routed course.');
  const resolved = resolveAimTarget(currentShotOrigin(), target, range.course.bounds).target;
  aimTarget = Object.freeze({ ...resolved, ...(target.role ? { role: target.role } : {}), ...(target.label ? { label: target.label } : {}) });
  if (evaluatorCamera?.active) evaluatorCamera.exit();
  if (freeCam?.active) freeCam.exit();
  toAddress({ smooth: true });
  return getAimState();
}

function resetAim({ reframe = true } = {}) {
  if (flying) throw new Error('Aim is locked while the ball is in flight.');
  aimTarget = null;
  if (reframe && ball && !flying) {
    if (evaluatorCamera?.active) evaluatorCamera.exit();
    if (freeCam?.active) freeCam.exit();
    toAddress({ smooth: true });
  }
  return getAimState();
}

// Address framing follows the active routed hole or the player's transient map
// target. Legacy ranges retain the canonical origin and -Z target line.
function toAddress({ smooth = false, fromTee = false } = {}) {
  if (!fromTee && (ball.holed || pendingHazard)) return;
  const tee = range?.tee ?? { x: 0, z: 2 };
  if (fromTee || range?.sceneKind !== 'play') ball.placeAt(tee.x, tee.z);
  const aim = currentAim();
  syncBallMesh();
  // A completed shot leaves the shadow frustum centered down-range. Move the
  // unchanged-direction sun rig back with the teleported ball before caching the
  // next address map.
  const targetLine = new Vector3(aim.x, 0, aim.z).normalize();
  if (!evaluatorCamera?.active) {
    if (smooth) director.returnToAddress(ball.position, targetLine);
    else director.setAddress(ball.position, targetLine);
  }
  lighting.follow(ball.position.x, ball.position.z, { camera: sm.camera });
  panel.showAddress();
  if (range.sceneKind === 'play') {
    const distance = Math.hypot(ball.cup.x - ball.position.x, ball.cup.z - ball.position.z);
    const remaining = distance < 20 ? `${(distance * 3.28084).toFixed(1)} ft` : `${Math.round(distance * M_TO_YARD)} yd`;
    panel.setLive(`Hole ${range.activeHole().number} · Shot ${holeStrokes + 1} · ${remaining} to pin`);
  }
  // Only explicit/initial address changes are cuts. The automatic result return keeps
  // temporal history because CameraDirector continuously damps the whole move.
  if (!smooth) sm.invalidateTemporalHistory('address camera cut');
}

// Build (or rebuild) the entire course from a normalized spec. Disposes the old
// course first so repeated agent rebuilds don't leak GPU resources. The terrain is
// baked from the spec's FEATURES — this is the only path course data takes into the
// scene, so there is no terrain-editing surface to expose.
async function buildCourse(course, { creatorCanvas = false } = {}) {
  clearTimeout(_resetTimer);
  tracer.clearHistory();
  aimTarget = null;
  if (range) {
    if (_rangeRetentionProbe) {
      Object.defineProperty(range, '__rangeRetentionProbeMarker', { value: true });
      _rangeRetentionProbe.push(new WeakRef(range));
    }
    range.dispose();
  }
  flying = false;
  if (course.atmosphere) panel.setEnv({
    windSpeed: course.atmosphere.windSpeedMph,
    windDir: course.atmosphere.windDirectionDegrees,
    cloudCover: course.atmosphere.cloudCoverage * 100,
  });
  const atmosphereSignature = JSON.stringify(course.atmosphere ?? null);
  const timelineChanged = !environmentTimeline
    || environmentTimeline.config.seed !== course.environmentSeed
    || environmentTimelineAtmosphereSignature !== atmosphereSignature;
  if (timelineChanged) {
    environmentTimeline = createEnvironmentTimeline(course.environmentSeed, course.atmosphere);
    environmentTimelineAtmosphereSignature = atmosphereSignature;
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
  const SceneComposition = isCreatorPage
    ? CreatorScene
    : isPlayPage
      ? PlayScene
      : isRangePage
        ? Range
        : course.routing && !creatorCanvas
          ? CourseScene
          : Range;
  range = await SceneComposition.create(sm.scene, sm.camera, course, {
    renderer: sm.renderer, motionHistory: sm.motionHistory, lighting,
    environmentTier: sm.environmentTier, environment: environmentBindings,
    environmentCatalog, creatorCanvas,
  });
  _nearTurfDetailActivation = 0;
  _nearTurfFocusReady = false;
  range.terrain.setNearBallTurfDetail({ activation: 0 });
  // Initial quality selection happens before Range construction. Apply the pending
  // mode once the grass workload hook exists, and repeat this after every rebuild.
  applyVisualQuality();
  ball = new Ball(range.terrain, env);
  configurePlayHole();
  wireBall(ball);
  // Free-fly cam persists across rebuilds (keeps its listeners); just re-point its
  // terrain reference at the new course. Created lazily on the first build.
  if (!freeCam) freeCam = new FreeCamera(sm.camera, sm.renderer.domElement, range.terrain, {
    onDragEnd: () => sm.invalidateTemporalHistory('free-camera drag settled'),
  });
  else freeCam.terrain = range.terrain;
  turfPanel.attach(range.terrain);   // live turf sliders (G) follow the rebuilt terrain
  await minimap.attach(range);       // prepare the authoritative hole map without blocking loading animation
  syncDefaultAimTarget();
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
  audio?.setCourse({
    course: range.course,
    range,
    environment: environmentState,
    weather: range.course.atmosphere?.weather,
  });
  toAddress({ fromTee: true });
}

function courseForCurrentScene(authoredCourse) {
  if (!creatorCanvasActive) return authoredCourse;
  return normalizeCourse({
    ...createCreatorCanvasCourse({
      atmosphere: authoredCourse.atmosphere,
      seed: authoredCourse.environmentSeed,
      variant: creatorCanvasVariant,
    }),
    surfaceMaterials: authoredCourse.surfaceMaterials,
  }, { catalogAssetIds: environmentCatalog.byId });
}

const PINE_FLOOR_VISUAL_ASSET_IDS = Object.freeze([
  'forest-floor-03-color-roughness',
  'forest-floor-03-normal-height-ao',
]);

async function verifyCourseVisualAssets(course) {
  if (course?.groundCover !== 'pine-needle-litter') return Object.freeze([]);
  if (!visualAssetResidency) throw new Error('Visual asset residency is not initialized.');
  setBootstrapStage('visual-course-assets', {
    detail: 'Verifying the course-required fresh pine-straw material…',
    completed: 0,
    total: PINE_FLOOR_VISUAL_ASSET_IDS.length,
  });
  let completed = 0;
  const verified = await Promise.all(PINE_FLOOR_VISUAL_ASSET_IDS.map(async (assetId) => {
    const asset = visualAssetResidency.manifest.assetById.get(assetId);
    const variant = asset?.variants?.critical;
    if (!variant) throw new Error(`Required course visual asset is missing its critical binding: ${assetId}`);
    const result = await visualAssetResidency.verifyFile(variant.fileId);
    completed += 1;
    setBootstrapStage('visual-course-assets', {
      detail: 'Verifying the course-required Poly Haven pine-floor material…',
      completed,
      total: PINE_FLOOR_VISUAL_ASSET_IDS.length,
    });
    return result;
  }));
  return Object.freeze(verified);
}

function applyLiveSurfaceMaterials(surfaceMaterials, { resetPreview = false } = {}) {
  if (!range?.applySurfaceMaterials) throw new Error('The live course does not expose surface-material application.');
  const snapshot = range.applySurfaceMaterials(normalizeSurfaceMaterials(surfaceMaterials));
  if (resetPreview) surfaceMaterialsPreviewBaseline = null;
  turfPanel.sync(snapshot);
  sm.invalidateTemporalHistory('live surface material update');
  return snapshot;
}

function previewSurfaceMaterials(surfaceMaterials) {
  if (!surfaceMaterialsPreviewBaseline) surfaceMaterialsPreviewBaseline = range?.snapshotSurfaceMaterials?.() ?? null;
  return applyLiveSurfaceMaterials(surfaceMaterials);
}

function revertSurfaceMaterialsPreview() {
  if (!surfaceMaterialsPreviewBaseline) return range?.snapshotSurfaceMaterials?.() ?? null;
  const baseline = surfaceMaterialsPreviewBaseline;
  surfaceMaterialsPreviewBaseline = null;
  return applyLiveSurfaceMaterials(baseline);
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
  if (isPlayPage && startupQuery.has('course')) {
    coursePath = savedCoursePath(await loadCourseLibrary(), startupQuery.get('course'));
  }
  const authoredInitialCourse = await loadCourse(coursePath, { catalogAssetIds: environmentCatalog.byId });
  const initialCourse = courseForCurrentScene(authoredInitialCourse);
  await verifyCourseVisualAssets(initialCourse);
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
  await buildCourse(initialCourse, { creatorCanvas: creatorCanvasActive });
  // The renderer is deliberately gated on the complete environment. The synchronous
  // material objects may exist while images decode, but no placeholder/partial course
  // is ever presented as a valid frame.
  setBootstrapStage('asset-decoding', { detail: 'Decoding verified geometry, foliage, terrain, and lighting…' });
  await range.assetsReady;
  await prepareSceneTextures(sm.renderer, sm.scene);
  if (loadingGreen.error) throw loadingGreen.error;
  lighting.invalidateShadow({ force: true, reason: 'course-assets-ready' });
  setBootstrapStage('atmosphere-ready', { detail: 'Finalizing shared daylight and water reflections…' });
  await sm.weatherSky.ready;
  sm.rebuildDaylightPmrem();
  await range.waterReflection?.prepare();
  await sm.prepareScenePass();
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

async function rebuildCourseFromDisk({ authoredCourse: providedCourse = null } = {}) {
  const wasRunning = sm._ready && !sm._renderingPaused;
  const recoverFatalPause = sm._ready && sm._renderingPaused && !!document.getElementById('environment-fatal');
  if (wasRunning) sm.pauseRendering();
  try {
    loadingGreen.show();
    setBootstrapStage('course-loading', { detail: 'Loading and validating the edited course…' });
    const authoredCourse = providedCourse
      ?? await loadCourse(coursePath, { catalogAssetIds: environmentCatalog.byId });
    const nextCourse = courseForCurrentScene(authoredCourse);
    await verifyCourseVisualAssets(nextCourse);
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
    await buildCourse(nextCourse, { creatorCanvas: creatorCanvasActive });
    setBootstrapStage('asset-decoding', { detail: 'Decoding the rebuilt environment…' });
    await range.assetsReady;
    await prepareSceneTextures(sm.renderer, sm.scene);
    lighting.invalidateShadow({ force: true, reason: 'course-assets-ready' });
    setBootstrapStage('atmosphere-ready', { detail: 'Finalizing rebuilt daylight and water reflections…' });
    await sm.weatherSky.ready;
    sm.rebuildDaylightPmrem();
    await range.waterReflection?.prepare();
    await sm.prepareScenePass();
    setBootstrapStage('ready', { detail: 'Range ready.' });
    requestActiveVisualAssets();
    document.getElementById('environment-fatal')?.remove();
    loadingGreen.stop();
    document.getElementById('loading')?.classList.add('hidden');
    if (wasRunning || recoverFatalPause) sm.resumeRendering();
  } catch (error) {
    showFatalEnvironmentError(error);
    // Leave rendering paused: continuing with a partial rebuild would itself be a
    // fallback environment. A later successful rebuild may explicitly recover it.
    throw error;
  }
}

async function applyWatchedCourseChange({ isCurrent = () => true } = {}) {
  const authoredCourse = await loadCourse(coursePath, { catalogAssetIds: environmentCatalog.byId });
  if (!isCurrent()) return { mode: 'superseded' };
  const nextCourse = courseForCurrentScene(authoredCourse);
  const mode = classifyCourseRuntimeChange(range?.course, nextCourse);
  if (mode === 'unchanged') return { mode, course: range.course };
  if (mode === 'surface-materials-only') {
    const sceneIdentity = range;
    const terrainIdentity = range.terrain;
    const grassIdentity = range.grass;
    applyLiveSurfaceMaterials(nextCourse.surfaceMaterials, { resetPreview: true });
    turfPanel.attach(range.terrain, { resetBaseline: true });
    if (range !== sceneIdentity || range.terrain !== terrainIdentity || range.grass !== grassIdentity) {
      throw new Error('Surface-material hot apply replaced a live scene identity.');
    }
    return { mode, course: range.course };
  }
  await rebuildCourseFromDisk({ authoredCourse });
  return { mode: 'rebuild', course: range.course };
}

async function previewCourse(rawCourse) {
  const preview = normalizeCourse(rawCourse, { catalogAssetIds: environmentCatalog.byId });
  const wasRunning = sm._ready && !sm._renderingPaused;
  if (wasRunning) sm.pauseRendering();
  loadingGreen.show();
  try {
    await verifyCourseVisualAssets(preview);
    const assetIds = collectEnvironmentAssetIds(preview);
    await verifyEnvironmentCatalogAssets(environmentCatalog, { assetIds, memoize: true });
    creatorCanvasActive = false;
    await buildCourse(preview);
    await Promise.all([range.assetsReady, sm.weatherSky.ready]);
    await prepareSceneTextures(sm.renderer, sm.scene);
    sm.rebuildDaylightPmrem();
    await range.waterReflection?.prepare();
    await sm.prepareScenePass();
    setBootstrapStage('ready', { detail: 'Course preview ready.' });
    loadingGreen.stop();
    document.getElementById('loading')?.classList.add('hidden');
    if (wasRunning) sm.resumeRendering();
    return { name: preview.meta.name, assets: assetIds.size };
  } catch (error) {
    showFatalEnvironmentError(error);
    throw error;
  }
}

async function clearCoursePreview() {
  creatorCanvasActive = isCreatorPage;
  await rebuildCourseFromDisk();
  frameCreatorCanvas();
  return range.course.meta.name;
}

async function showAuthoredCreatorCourse() {
  creatorCanvasActive = false;
  await rebuildCourseFromDisk();
  builder?.onActiveHoleChanged?.(range.activeHole());
  return range.course.meta.name;
}

async function showCreatorCanvas({ reroll = false } = {}) {
  if (reroll) creatorCanvasVariant += 1;
  creatorCanvasActive = isCreatorPage;
  await rebuildCourseFromDisk();
  frameCreatorCanvas();
  return range.course.meta.name;
}

function frameCreatorCanvas() {
  if (!creatorCanvasActive || !evaluatorCamera) return;
  if (!evaluatorCamera.active) evaluatorCamera.enter();
  evaluatorCamera.setPose(currentCreatorCanvasPose());
  evaluatorCamera.unfreeze();
}

function currentCreatorCanvasPose() {
  if (!range?.course || !range?.terrain) return null;
  return creatorCanvasCameraPose(range.course, (x, z) => range.terrain.heightAt(x, z));
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
  if (flying || !ball || ball.holed || pendingHazard) return;
  if (!params) {
    try {
      launchMonitor.emitShot(panel.getLaunchInput());
    } catch (error) {
      panel.setLive(`Launch input unavailable: ${error?.message || error}`);
    }
    return;
  }
  clearTimeout(_resetTimer);            // a new shot cancels any pending auto-reset
  // A packet during the result hold starts the next shot: from the resting lie
  // in Play, or a fresh tee ball in Practice.
  if (director.phase === 'result' || director.phase === 'return') {
    toAddress();
  }
  // Freeze a fresh deterministic environment at the exact shot boundary. This is
  // intentionally the same path used by the at-rest visual preview.
  applyEnvironmentConditions(panel.getEnv());

  // Keep the course/tree shadow projection fixed for the whole cinematic. The
  // ball is sub-pixel through most of flight, so its moving course-scale shadow
  // contribution is disabled until the final lie is known.
  setBallShadowCasting(false, 'ball-flight');

  tracer.promoteActiveToWhite();
  tracer.reset();
  const aim = currentAim();
  const holeBearingDegrees = Math.atan2(aim.x, -aim.z) * 180 / Math.PI;
  const worldParams = { ...params, azimuth: (params.azimuth ?? 0) + holeBearingDegrees, aimAzimuth: holeBearingDegrees };
  panel.beginShot(params);
  ball.launch(worldParams);
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
    range.terrain.stampDivot(sm.renderer, ball.start.x + aim.x * 0.3 + jx, ball.start.z + aim.z * 0.3 + jz,
      0.022, a, 0.08 + random() * 0.14, 4.0 + random() * 1.5, random() * 20);
  }
}

function selectHole(holeId) {
  if (flying) throw new Error('Wait for the current shot to finish before changing holes.');
  if (!range?.course?.routing || typeof range.setActiveHole !== 'function') {
    throw new Error('Hole selection requires a routed course scene.');
  }
  range.setActiveHole(holeId);
  configurePlayHole();
  aimTarget = null;
  minimap.setActiveHole(range.activeHole());
  syncDefaultAimTarget();
  toAddress({ fromTee: true });
  builder?.onActiveHoleChanged?.(range.activeHole());
  return range.activeHole();
}

// The course builder: a prompt box that hands natural language to the local agent
// (via the /api/build sidecar), which authors course.json with the course-design
// skills. The ONLY authoring control is the prompt — no terrain editing.
const builder = new BuilderPanel({
  getCourse: () => (range ? range.course : null),
  readOnlyReason: referenceCourseSelected
    ? 'Photo study preview. Edit courses/grasslands-reference.project.json and recompile; workspace authoring is disabled here.'
    : null,
  // The sidecar pushes a live 'course:changed' event on success, which triggers the
  // rebuild below; this callback just surfaces the request result to the panel.
});

// Direct creator routes render stats during Menu construction, before the FPS
// meter itself is mounted. Seed the value before route resolution so /creator.html
// is a valid cold entry rather than depending on a prior range/menu transition.
let _fps = 0;
let _thumbCountdown = 0;
let thumbRequest = 0;
let thumbObjectUrl = null;

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
    const objects = c && !creatorCanvasActive ? c.greens.length + c.bunkers.length + c.ponds.length : 0;
    return { objects, fps: _fps || '—', status: builder?.busy ? 'Building' : 'Ready' };
  },
});
// An explicit catalog study URL has already selected and loaded its course.
if (referenceCourseSelected) {
  document.title = `${range.course.meta.name} — Rangeform`;
  if (isPlayPage) shell.setView('practice');
}

// Audio is progressive and deliberately outside the first-valid-frame barrier.
// Native device initialization already ran before putting began. Recordings still
// decode only now in the background, and the first
// trusted pointer/key interaction unlocks the graph under the browser autoplay policy.
audio = new GolfAudio({ camera: sm.camera, contextFactory: bootstrapAudioContext.contextFactory });
bootstrapAudioContext = null;
const audioSettings = new AudioSettings(audio);
audio.setCourse({
  course: range.course,
  range,
  environment: environmentState,
  weather: range.course.atmosphere?.weather,
});
const audioApi = Object.freeze({
  ready: audio.ready,
  unlock: () => audio.unlock(),
  setMuted: (muted) => audio.setMuted(muted),
  setVolume: (category, value) => audio.setVolume(category, value),
  snapshot: () => audio.snapshot(),
  diagnostics: () => audio.diagnostics(),
});

// The evaluator is installed after the initial course build so it can retain the
// live FreeCamera instance for ownership handoff/restore across course rebuilds.
evaluatorCamera = new EvaluatorCamera({
  camera: sm.camera,
  sceneManager: sm,
  director,
  freeCamera: freeCam,
});
if (creatorCanvasActive) {
  frameCreatorCanvas();
}

// Keep the address ball above the actual composer, including after window resize.
const composer = document.querySelector('.gb-compose-wrap');
function resizeAddressComposition() {
  if (shell.view !== 'creator' || !composer) return;
  director.addressViewport = { height: innerHeight, bottom: innerHeight - composer.getBoundingClientRect().top };
  if (director.phase === 'address' && !freeCam.active && !evaluatorCamera.active) {
    director.setAddress(ball.position, director.aim);
    sm.invalidateTemporalHistory('address viewport resized');
  }
}
if (composer) new ResizeObserver(resizeAddressComposition).observe(composer);
window.addEventListener('resize', resizeAddressComposition);
resizeAddressComposition();

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
function requestThumb() {
  thumbRequest++;
  if (_thumbCountdown === 0) _thumbCountdown = 4;
}
function thumbCapture() {
  const request = thumbRequest, course = range;
  // Encode the actual WebGPU canvas asynchronously; copying it to another canvas
  // is blank on this path, and synchronous JPEG encoding stalls the first frames.
  try {
    sm.renderer.domElement.toBlob(blob => {
      if (!blob || request !== thumbRequest || course !== range) return;
      const previous = thumbObjectUrl;
      thumbObjectUrl = URL.createObjectURL(blob);
      shell.setCourseThumb(thumbObjectUrl);
      if (previous) URL.revokeObjectURL(previous);
    }, 'image/jpeg', 0.75);
  }
  catch (e) { /* canvas capture unavailable */ }
}
window.addEventListener('pagehide', () => {
  thumbRequest++;
  if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
  thumbObjectUrl = null;
});

// Live rebuild: the Vite sidecar plugin fires this custom HMR event whenever
// course.json changes (an agent edit, or a manual edit). Re-fetch + rebuild.
const catalogCategorySignature = (catalog, category) => JSON.stringify(
  catalog.assets.filter((asset) => asset.category === category),
);
const catalogNonTreeSignature = (catalog) => JSON.stringify(
  catalog.assets.filter((asset) => asset.category !== 'tree'),
);
const normalizedPublicAssetPath = (path) => `/${String(path || '')
  .replace(/^public\//, '').replace(/^\/+/, '')}`;
const catalogTreeOwnsPath = (catalog, path) => {
  const normalized = normalizedPublicAssetPath(path);
  return catalog.assets.some((asset) => asset.category === 'tree' && [
    ...asset.lods.map((lod) => lod.url),
    ...(asset.alphaMaps || []).map((map) => map.url),
    ...(asset.impostor?.url ? [asset.impostor.url] : []),
  ].includes(normalized));
};
let liveAssetReloadTimer = null;
let liveAssetReloadSerial = 0;
let liveTurfPackReloadPending = false;
let liveCourseReloadSerial = 0;
let liveSceneMutationQueue = Promise.resolve();

function queueLiveSceneMutation(task) {
  const operation = liveSceneMutationQueue.catch(() => {}).then(task);
  liveSceneMutationQueue = operation.catch(() => {});
  return operation;
}

function queueLiveAssetReload(event = {}) {
  if (TURF_PACK_SOURCE_URLS.includes(normalizedPublicAssetPath(event.path))) {
    liveTurfPackReloadPending = true;
  }
  const serial = ++liveAssetReloadSerial;
  clearTimeout(liveAssetReloadTimer);
  builder.onAgentStatus({ message: `Preparing live asset update: ${event.path || 'environment catalog'}.` });
  liveAssetReloadTimer = setTimeout(() => queueLiveSceneMutation(async () => {
    if (serial !== liveAssetReloadSerial) return;
    try {
      // Developer edits to this immutable shared pack must refresh the retained
      // putting terrain as well as the course, CPU pixels and verified manifest.
      // Keep this flag across debounced catalog/other-asset events. Normal course
      // rebuilds and authored tree swaps continue to use their resident resources.
      if (liveTurfPackReloadPending) {
        liveTurfPackReloadPending = false;
        window.location.reload();
        return;
      }
      const nextCatalog = await loadEnvironmentCatalog(
        `/assets/environment/catalog.json?live=${Date.now()}`, { assetIds: [] },
      );
      if (serial !== liveAssetReloadSerial) return;
      const treeCatalogChanged = catalogCategorySignature(environmentCatalog, 'tree')
        !== catalogCategorySignature(nextCatalog, 'tree');
      const nonTreeCatalogChanged = catalogNonTreeSignature(environmentCatalog)
        !== catalogNonTreeSignature(nextCatalog);
      const treeAssetChanged = catalogTreeOwnsPath(nextCatalog, event.path);
      if ((treeAssetChanged || treeCatalogChanged) && !nonTreeCatalogChanged && range?.reloadTreeAssets) {
        const activeTreeIds = new Set([...collectEnvironmentAssetIds(range.course)].filter(
          (assetId) => nextCatalog.byId.get(assetId)?.category === 'tree',
        ));
        await verifyEnvironmentCatalogAssets(nextCatalog, { assetIds: activeTreeIds, memoize: false });
        if (serial !== liveAssetReloadSerial) return;
        const diagnostics = await range.reloadTreeAssets(nextCatalog, { cacheBust: Date.now() });
        if (serial !== liveAssetReloadSerial) return;
        environmentCatalog = nextCatalog;
        sm.invalidateTemporalHistory('atomic live tree asset swap');
        builder.onAgentStatus({
          message: `${diagnostics.sourceCount} authored trees swapped live; camera and course state preserved.`,
        });
        await builder.onSceneCheckpoint?.({
          kind: 'asset', path: event.path,
          summary: `${diagnostics.sourceCount} verified authored trees are live; camera and course state stayed in place.`,
        });
        return;
      }
      environmentCatalog = nextCatalog;
      await rebuildCourseFromDisk();
      if (serial !== liveAssetReloadSerial) return;
      builder.onAgentStatus({ message: 'Changed non-tree assets are live in the rebuilt WebGPU scene.' });
      await builder.onSceneCheckpoint?.({ kind: 'asset', path: event.path });
    } catch (error) {
      if (serial === liveAssetReloadSerial) builder.onCourseReloadFailed(error, { kind: 'asset', path: event.path });
    }
  }), 240);
}

if (import.meta.hot) {
  import.meta.hot.on('course:agent-status', (event) => builder.onAgentStatus(event));
  import.meta.hot.on('course:changed', (event = {}) => {
    const serial = ++liveCourseReloadSerial;
    queueLiveSceneMutation(async () => {
      if (serial !== liveCourseReloadSerial) return;
    try {
      const result = await applyWatchedCourseChange({ isCurrent: () => serial === liveCourseReloadSerial });
      if (serial !== liveCourseReloadSerial) return;
      builder.onCourseReloaded(range.course, event);
      if (result.mode === 'surface-materials-only') {
        builder.onAgentStatus({ message: 'Surface materials updated live; course, camera, and vegetation identities were preserved.' });
      }
      setTimeout(requestThumb, 400);   // refresh the Play thumbnail to the new course
    } catch (error) {
      if (serial === liveCourseReloadSerial) builder.onCourseReloadFailed(error, event);
    }
    });
  });
  import.meta.hot.on('course:assets-changed', (event) => queueLiveAssetReload(event));
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
let _fpsLast = performance.now(), _fpsN = 0, _fpsAcc = 0;
let _qualityLastFrameAt = null;
let _qualityGpuPending = false, _qualityNextGpuAt = 0;
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
  if (!qualityController || !Number.isFinite(now) || sm.renderingPaused
    || loadingGreen?.diagnostics.active || !window.golfBootstrap?.ready) {
    _qualityLastFrameAt = null;
    qualityController?.ingestSample({ eligible: false });
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
    frameMs, cpuMs: sm.cpuFrameMs,
    atMs: Number.isFinite(now) ? now : undefined,
  });
  applyVisualQuality(snapshot);
  if (snapshot.mode === 'auto' && !snapshot.presentationLock && !_qualityGpuPending
    && now >= _qualityNextGpuAt) {
    _qualityGpuPending = true; _qualityNextGpuAt = now + 2000;
    const mode = snapshot.activeMode;
    sm.gpuProfiler.capture(8).then(result => {
      const current = qualityController.snapshot();
      if (!result.available || !result.complete || current.mode !== 'auto'
        || current.activeMode !== mode || current.presentationLock || loadingGreen?.diagnostics.active) return;
      for (const frame of result.frames ?? []) {
        qualityController.ingestSample({ gpuMs: frame.gpuUnionMs, atMs: performance.now() });
      }
      applyVisualQuality();
    }).catch(error => console.error('Automatic quality GPU measurement failed', error))
      .finally(() => { _qualityGpuPending = false; });
  }
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

  }

  // Menu view: slow cinematic orbit behind the overlay. The thumbnail countdown does
  // not interrupt it; its final frame is the one we capture. In-scene views use the
  // free-fly cam when active, else the cinematic shot director.
  if (evaluatorCamera.active) evaluatorCamera.update?.(dt);
  else if (shell.view === 'menu') menuCinematic(dt);
  else if (freeCam.active) freeCam.update(dt);
  else director.update(dt, ball);

  if (lighting.cameraShadows) {
    const camera = sm.camera.position;
    lighting.cameraShadows.cameraClearance = Math.max(0, camera.y - range.terrain.heightAt(camera.x, camera.z));
  }
  // Keep the compatibility light aligned with the active camera too.
  lighting.follow(ball.position.x, ball.position.z, { camera: sm.camera });

  // Listener pose must follow the final owner of the camera for this frame.
  audio.update(dt, { camera: sm.camera, ball, range, environment: environmentState });

  // Procedural blade positions are camera-dependent (LOD, lens fade, facing width).
  // Update them after the final camera pose for this frame, then retain those inputs
  // as the next frame's true previous geometry state.
  range.update(t);
  updateNearBallTurfDetail(dt);
  updateNearTurf(t);
  minimap.update({
    ball: ball.position,
    camera: sm.camera,
    aimOrigin: currentShotOrigin(),
    aimTarget: aimTarget ?? defaultAimTarget,
    canAim: canAimNow(),
  });
  const guideOrigin = currentShotOrigin();
  aimGuide.update({
    terrain: range.terrain,
    origin: guideOrigin,
    target: aimTarget ?? defaultAimTarget,
    visible: canAimNow() && (director.phase === 'address' || director.phase === 'return'),
  });
  // Startup turf remains pristine. Only the shot-completion path stamps divots.
  evaluatorCamera.notifyFrame(sm.renderer.info.frame);
});

loadingGreen?.stop();
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
  play: Object.freeze({
    snapshot: () => ({ active: range.sceneKind === 'play', holeId: range.activeHoleId,
      strokes: holeStrokes, complete: ball.holed, reliefRequired: Boolean(pendingHazard) }),
    continue: continuePlay,
  }),
  audio: audioApi,
  surfaceMaterials: Object.freeze({
    get: () => range?.snapshotSurfaceMaterials?.() ?? null,
    preview: (surfaceMaterials) => previewSurfaceMaterials(surfaceMaterials),
    revert: () => revertSurfaceMaterialsPreview(),
    commit: async () => {
      throw new Error('Surface-material persistence requires the course-agent commit adapter; write project.site.surfaceMaterials and compile the course.');
    },
  }),
  tracer, aimGuide,
  get freeCam() { return freeCam; },
  evaluatorCamera,
  director, panel, turfPanel, minimap, sm, lighting, builder, shell, audioSettings,
  aim: Object.freeze({
    getState: getAimState,
    setTarget: setAimTarget,
    reset: resetAim,
  }),
  // Narrow benchmark hook: this resolves only after the atmosphere, authoritative
  // terrain/turf material, and tree prototype are present. The harness then warms the actual camera/post
  // path before timing; it never measures loading placeholders as a scene baseline.
  // Resolves only after metadata, course-referenced binary hashes, runtime
  // decodes, and shared atmosphere readiness. Unused catalog derivatives are
  // deliberately outside this first-frame contract.
  get environmentReady() { return Promise.all([environmentCatalogReady, environmentAssetIntegrityReady, visualAssetManifestReady, visualCriticalAssetsReady, range?.assetsReady, sm.weatherSky?.ready]); },
  get environmentLoadError() { return environmentLoadError; },
  refreshThumb: requestThumb,
  toAddress,
  // Public requests share the watcher queue. Internal rebuild calls remain raw
  // so a queued preview/reset cannot await another operation behind itself.
  rebuild: (options) => queueLiveSceneMutation(() => rebuildCourseFromDisk(options)),
  previewCourse: (course) => queueLiveSceneMutation(() => previewCourse(course)),
  clearCoursePreview: () => queueLiveSceneMutation(() => clearCoursePreview()),
  showAuthoredCreatorCourse: () => queueLiveSceneMutation(() => showAuthoredCreatorCourse()),
  showCreatorCanvas: (options) => queueLiveSceneMutation(() => showCreatorCanvas(options)),
  creatorCanvasPose: currentCreatorCanvasPose,
  beginCreatorApply() { creatorCanvasActive = false; },
  get creatorCanvasActive() { return creatorCanvasActive; },
  get creatorCanvasVariant() { return creatorCanvasVariant; },
  selectHole,
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
