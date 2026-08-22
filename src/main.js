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
import { MPH_TO_MS, DEG_TO_RAD, mph as toMph, M_TO_YARD } from './util/units.js';
import {
  ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from './environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from './environment/EnvironmentGpuBindings.js';
import { createRng } from './util/random.js';
import {
  loadEnvironmentCatalog, verifyEnvironmentCatalogAssets, collectEnvironmentAssetIds,
} from './environment/EnvironmentCatalog.js';
import { createLocalFoliagePackRegistry } from './foliage/FoliagePackResolver.js';

// Clear alpine late-morning key from the left/downrange: a 37° elevation keeps
// the source plausible while its lateral component gives terrain relief and
// tree shadows a readable rake across the broadcast route. Every daylight
// consumer receives this same authored direction through EnvironmentGpuBindings.
const SUN = new Vector3(-0.72, 0.60, -0.32).normalize();

const app = document.getElementById('app');
const sm = new SceneManager(app);
// Available even when strict WebGPU initialization rejects before the production
// `window.golf` API is installed. Browser integration tests use this narrow handle to
// prove that failure is terminal: no frame loop, retry, or alternate renderer starts.
const bootstrapStartedAt = performance.now();
const bootstrapDiagnostics = {
  stage: 'webgpu-initializing', completed: 0, total: 0, error: null,
  stages: [],
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
let localFoliagePackRegistry;

function showFatalEnvironmentError(error) {
  console.error('Required environment initialization failed.', error);
  bootstrapDiagnostics.error = String(error?.message || error);
  setBootstrapStage('failed', { detail: 'Required course assets could not be verified. Reload after fixing the asset or course.' });
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
  setBootstrapStage('webgpu-ready', { detail: 'WebGPU ready. Reading the environment manifest…' });
  lighting = new Lighting(sm.scene, SUN, sm.environmentTier);
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
let env = null;

// Broken alpine cumulus is the authored default: a low, sparse layer above the
// valley that reads as separate billows from golfer height instead of clipped
// crowns at the top of frame or a uniform overcast.
// The Conditions panel drives `cloudCoverage`; 0 is a real setting and costs nothing,
// because WeatherSky then compiles the clear analytic sky with no cloud grade at all.
const DEFAULT_CLOUD_COVERAGE = 0.26;

function makeEnvironmentState(seed, {
  windSpeedMph = 0, windDirectionDegrees = 0, cloudCoverage = DEFAULT_CLOUD_COVERAGE,
} = {}) {
  const azimuth = Math.atan2(SUN.x, SUN.z);
  return new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: seed >>> 0,
    tickSeconds: 1 / 120,
    sun: {
      azimuthRadians: (azimuth + Math.PI * 2) % (Math.PI * 2),
      elevationRadians: Math.asin(SUN.y),
      intensity: 85000,
      // At this ~37 degree solar elevation, a mildly warm 5200–5600 K source
      // gives sunlit rock/turf separation without turning the shared atmosphere
      // into a golden-hour preset.
      color: { r: 1.0, g: 0.955, b: 0.87 },
    },
    atmosphere: { turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005, mieDirectionalG: 0.76, exposure: 1.0 },
    // Higher, lighter broken alpine cumulus. Smaller parcels leave blue channels
    // between crowns and keep the mountain silhouette readable from address.
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
  });
}

// `range` and `ball` are (re)created every time the course spec changes — the
// prompt-driven builder edits course.json, and the whole course is rebuilt from it.
// Kept as `let` so every closure below sees the current instance after a rebuild.
let range = null;
let ball = null;
let freeCam = null;
let evaluatorCamera = null;
let ballLie = [];
let flying = false;
let _resetTimer = null;
let _rangeRetentionProbe = null;

const panel = new MetricsPanel({ onHit: hit, onEnvironmentChange: previewEnvironment });
const turfPanel = new TurfPanel();
const minimap = new Minimap();   // M to toggle; drawn from the same baked zone field as the turf

// Attach the physics event handlers to a (freshly built) ball.
function wireBall(b) {
  b.on('rest', (r) => {
    flying = false;
    director.onRest(b);
    panel.showResult(r);
    panel.setLive('');
    // Driving range: hold the rotating result view, then glide back to the tee for
    // the next shot (so you hit from the mat every time). Skipped if a new shot is
    // already in the air, the free-fly cam is active, or we've left the range view.
    clearTimeout(_resetTimer);
    _resetTimer = setTimeout(() => {
      if (!flying && !freeCam?.active && shell.view === 'practice') toAddress({ smooth: true });
    }, 4000);
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
  panel.setLive('');
  // Only explicit/initial address changes are cuts. The automatic result return keeps
  // temporal history because CameraDirector continuously damps the whole move.
  if (!smooth) sm.invalidateTemporalHistory('address camera cut');
}

// Build (or rebuild) the entire course from a normalized spec. Disposes the old
// course first so repeated agent rebuilds don't leak GPU resources. The terrain is
// baked from the spec's FEATURES — this is the only path course data takes into the
// scene, so there is no terrain-editing surface to expose.
function buildCourse(course) {
  if (range) {
    if (_rangeRetentionProbe) {
      Object.defineProperty(range, '__rangeRetentionProbeMarker', { value: true });
      _rangeRetentionProbe.push(new WeakRef(range));
    }
    range.dispose();
  }
  flying = false;
  if (!environmentState || environmentState.config.seed !== course.environmentSeed) {
    // Carry the panel's current cloud setting across a course rebuild so a slider
    // change is not silently reverted by loading an edited course.json.
    environmentState = makeEnvironmentState(course.environmentSeed, {
      cloudCoverage: panel.getEnv().cloudCover / 100,
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
  }
  range = new Range(sm.scene, sm.camera, course, {
    renderer: sm.renderer, motionHistory: sm.motionHistory, lighting,
    environmentTier: sm.environmentTier, environment: environmentBindings,
    environmentCatalog, localFoliagePackRegistry,
    foliageCandidateAlias: new URL(window.location.href).searchParams.get('foliageCandidate') === 'generated'
      ? [
        'builtin.valley-oak.california.v1',
        'builtin.sugar-maple.northeastern.v1',
        'builtin.monterey-cypress.coastal.v1',
      ] : null,
  });
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
  range.terrain.uSunDir.value.copy(SUN);   // canopy self-shadow marches toward the real key light
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
  divotPrepopDone = false;   // new terrain → re-stamp the used-tee divots once the renderer is live
  toAddress();
}
let divotPrepopDone = false;

try {
  environmentCatalog = await environmentCatalogReady;
  // A local authoring host may inject an alias-keyed descriptor object before this
  // module loads. The registry accepts same-origin pack roots only and is immutable
  // after bootstrap; the course itself still contains aliases, never local paths.
  localFoliagePackRegistry = createLocalFoliagePackRegistry(
    globalThis.__GOLF_LOCAL_FOLIAGE_PACKS__ ?? [],
  );
  // BACKDROP_PLAN Phase 1: the CC0 Alps HDR is no longer a render source. It is
  // composition inspiration for the procedural valley (Phase 2) and the A/B
  // skybox variant; the analytic clear-sky owns the visible background while
  // PMREM, water, and IBL follow the same shared node. The manifest asset stays
  // shipped as the rollback A/B baseline (docs/BACKDROP_PLAN.md).
  sm.configureSkyManifest(null);
  setBootstrapStage('course-loading', { detail: 'Loading and validating the authored course…' });
  const initialCourse = await loadCourse('/course.json', { catalogAssetIds: environmentCatalog.byId });
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
    const nextCourse = await loadCourse('/course.json', { catalogAssetIds: environmentCatalog.byId });
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
  environmentState = makeEnvironmentState(range.environmentSeed, {
    windSpeedMph: conditions.windSpeed,
    windDirectionDegrees: conditions.windDir,
    cloudCoverage: conditions.cloudCover / 100,
  });
  environmentBindings.update(environmentState);
  // The coverage uniform is already live for the next frame. This only rebuilds the
  // sky node on the clear/cloudy boundary, where the shader itself has to change.
  sm.refreshWeatherSkyClouds();
  environmentTickRemainder = 0;
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

function hit() {
  if (flying || !ball) return;
  clearTimeout(_resetTimer);            // a new shot cancels any pending auto-reset
  const params = panel.getParams();

  // Freeze a fresh deterministic environment at the exact shot boundary. This is
  // intentionally the same path used by the at-rest visual preview.
  applyEnvironmentConditions(panel.getEnv());

  tracer.reset();
  panel.hud.classList.remove('show');
  ball.launch(params);
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
let _fpsLast = performance.now(), _fpsN = 0, _fpsAcc = 0, _fps = 0;
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

// Main update.
sm.onUpdate((dt, t) => {
  environmentTickRemainder += dt;
  const environmentTicks = Math.floor(environmentTickRemainder / environmentState.config.tickSeconds);
  if (environmentTicks > 0) {
    environmentTickRemainder -= environmentTicks * environmentState.config.tickSeconds;
    environmentState.advanceFixedTicks(environmentTicks);
    environmentBindings.update(environmentState);
  }
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
    // One bounded point upload per presented frame. The GPU owns history,
    // smoothing, ribbon expansion, and indirect draw count.
    tracer.push(ball.position);

    const speed = ball.velocity.length();
    const dist = Math.hypot(ball.position.x - ball.start.x, ball.position.z - ball.start.z) * M_TO_YARD;
    const height = (ball.position.y - ball.start.y) * 3.28084;
    panel.setLive(`${dist.toFixed(0)} yds   ·   ${height.toFixed(0)} ft   ·   ${toMph(speed).toFixed(0)} mph`);

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
  // Stamp the "used tee" divots on the GPU once the WebGPU backend is live (the
  // update loop only runs after renderer.init, so it's safe here).
  if (!divotPrepopDone && range) { range.terrain.prepopulateDivots(sm.renderer); divotPrepopDone = true; }
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
  get freeCam() { return freeCam; },
  evaluatorCamera,
  director, panel, turfPanel, minimap, sm, lighting, builder, shell,
  // Narrow benchmark hook: this resolves only after the atmosphere, authoritative
  // terrain/turf material, and tree prototype are present. The harness then warms the actual camera/post
  // path before timing; it never measures loading placeholders as a scene baseline.
  // Resolves only after metadata, course-referenced binary hashes, runtime
  // decodes, and shared atmosphere readiness. Unused catalog derivatives are
  // deliberately outside this first-frame contract.
  get environmentReady() { return Promise.all([environmentCatalogReady, environmentAssetIntegrityReady, range?.assetsReady, sm.weatherSky?.ready]); },
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
