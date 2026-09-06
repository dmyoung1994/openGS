import { Color, PerspectiveCamera, Scene, Vector3 } from 'three';
import { RenderPipeline } from 'three/webgpu';
import { pass, mrt, output, velocity } from 'three/tsl';
import { resettableTraa } from './ResettableTRAANode.js';
import { Lighting } from './Lighting.js';
import { CreatorScene } from './CreatorScene.js';
import { Tracer } from './Tracer.js';
import { CREATOR_SHOWCASE_FOV_DEGREES, creatorCanvasCameraPose } from '../course/CreatorCanvas.js';
import { EnvironmentGpuBindings } from '../environment/EnvironmentGpuBindings.js';
import { createRng } from '../util/random.js';

// The maquette is framed to the margined viewport, leaving a wider strip at the
// bottom for the loading card the overlay docks there.
const FRAME_MARGIN = 0.05;
const FRAME_MARGIN_BOTTOM = 0.18;
// Beats around the roll itself. Both are short: the next putt is already solved and
// waiting, so the mural gains a line roughly every two and a half seconds.
const ADDRESS_SECONDS = 0.25;
const HOLED_HIDE_SECONDS = 0.35;
const HOLED_CLEAR_SECONDS = 0.55;
// The stroke runs through the centre of the ball that drew it, which is where a
// trace belongs: any lift reads as the line hovering over its own ball. It still
// does not trace the terrain - height comes from a bilinear 0.6 m collision grid,
// only C0, so re-seating a line on it reproduces a crease at every cell boundary,
// and sampling it once per frame makes spacing depend on how fast the ball happens
// to be moving. The curve is built once and evenly from the solved samples, which
// are ball centres, so zero lift puts it exactly on the ball's axis. The ball itself
// is untouched and still sits on exact production physics.
const TRACER_LIFT_M = 0;
// Control spacing of the drawn curve. Uniform by construction, because the ribbon's
// Catmull-Rom is uniformly parameterised and wobbles through unevenly spaced points.
const TRACER_PATH_SPACING_M = 0.05;
// Binomial passes over the control points. Two passes clear centimetre-scale grid
// detail while leaving the metre-scale break the putt actually has.
const TRACER_SMOOTHING_PASSES = 2;
// Golden-angle bearing stepping: successive putts approach from far apart around the
// cup, so a handful of lines reads as a spread mural. Uniform sampling clusters badly
// at these counts - the first six draws of the shipped seed put four approaches within
// thirty degrees of each other.
const GOLDEN_RATIO_STEP = 0.618034;
const PUTT_BEARING_STEP = GOLDEN_RATIO_STEP * Math.PI * 2;
const PUTT_BEARING_JITTER = 0.35;
// Starts that roll off the green have no solution. Retry a bounded few times rather
// than idling a whole cycle, without letting a pathological green spin the worker.
const PUTT_SOLVE_ATTEMPTS = 4;

// Broadcast telemetry, not a categorical palette: one warm champagne stroke, with the
// composition carried entirely by luminance and age. Values stay inside the tone
// mapper's range - pushing them past it only flattens every stroke to the same white.
const MURAL_LINE_RGB = 0xfff3dc;
const MURAL_LIVE_INTENSITY = 1.30;
const MURAL_FLARE_INTENSITY = 1.75;
const MURAL_FLARE_SECONDS = 0.8;
const MURAL_NEWEST_INTENSITY = 1.05;
const MURAL_OLDEST_INTENSITY = 0.72;
const MURAL_NEWEST_OPACITY = 1.0;
const MURAL_OLDEST_OPACITY = 0.40;
// Lines over which a stroke settles from hero to background.
const MURAL_SETTLE_LINES = 5;
// Opacity where a stroke began. The gradient toward the cup gives each line
// direction and stops it reading as a decal laid over the render.
const MURAL_START_FADE = 0.10;

// Turns a solved trajectory into the curve the ribbon actually draws: evenly spaced,
// smoothed clear of collision-grid detail, and lifted off the surface. Endpoints are
// pinned so the stroke still starts where the putt did and ends in the cup.
export function buildTracerPath(samples, {
  spacing = TRACER_PATH_SPACING_M, passes = TRACER_SMOOTHING_PASSES, lift = TRACER_LIFT_M,
} = {}) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new TypeError('A tracer path needs at least two solved samples.');
  }
  const sampleArc = new Float64Array(samples.length);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    sampleArc[i] = sampleArc[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const total = sampleArc[samples.length - 1];
  const count = Math.max(2, Math.round(total / spacing) + 1);
  const points = [], arc = new Float64Array(count);
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const target = total * index / (count - 1);
    while (cursor < samples.length - 2 && sampleArc[cursor + 1] < target) cursor++;
    const span = sampleArc[cursor + 1] - sampleArc[cursor];
    const amount = span > 0 ? (target - sampleArc[cursor]) / span : 0;
    const a = samples[cursor], b = samples[cursor + 1];
    points.push(new Vector3(a.x + (b.x - a.x) * amount,
      a.y + (b.y - a.y) * amount, a.z + (b.z - a.z) * amount));
    arc[index] = target;
  }
  const scratch = points.map(point => point.clone());
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < points.length; i++) scratch[i].copy(points[i]);
    for (let i = 1; i < points.length - 1; i++) {
      points[i].copy(scratch[i]).multiplyScalar(0.5)
        .addScaledVector(scratch[i - 1], 0.25)
        .addScaledVector(scratch[i + 1], 0.25);
    }
  }
  for (const point of points) point.y += lift;
  return {
    points,
    arc,
    total,
    // Playback runs on the solver's fixed sample step, so progress arrives as a
    // fractional sample index; convert it to the arc length the stroke has reached.
    arcAtSample(index) {
      const clamped = Math.max(0, Math.min(samples.length - 1, index));
      const low = Math.floor(clamped);
      const high = Math.min(samples.length - 1, low + 1);
      return sampleArc[low] + (sampleArc[high] - sampleArc[low]) * (clamped - low);
    },
  };
}

// Prewarmed real creator scene, retained between course loads. Assets are requested
// in the HTML head; prepare() decodes, uploads, and renders before course work starts.
export class LoadingGreen {
  constructor({ renderer, environmentTier, course, environmentState, onError }) {
    this.renderer = renderer;
    this.scene = new Scene();
    this.scene.background = new Color(0x0a0e12);
    this.camera = new PerspectiveCamera(CREATOR_SHOWCASE_FOV_DEGREES,
      window.innerWidth / window.innerHeight, 0.1, 400);
    this.environmentState = environmentState;
    this.environment = new EnvironmentGpuBindings(environmentState);
    this.lighting = new Lighting(this.scene, new Vector3(-0.72, 0.60, -0.32).normalize(), environmentTier,
      { mapSize: 1024 });
    this.lighting.configureEnvironment(this.environment);
    this.lighting.setCourseShadowCoverage(course.bounds);
    this.course = new CreatorScene(this.scene, this.camera, course, {
      renderer, environmentTier, environment: this.environment, lighting: this.lighting,
      environmentCatalog: { version: 2, byId: new Map(), assets: [] }, creatorCanvas: true,
    });
    if (this.course.creatorFringeGrass) this.course.creatorFringeGrass.visible = false;
    this._fitCourse = course;
    this._fitHeightAt = (x, z) => this.course.terrain.heightAt(x, z);
    this._fitAspect = 0;
    this._applyViewportFit(window.innerWidth / window.innerHeight);
    this.tracer = new Tracer(this.scene, {
      renderer, max: 1024, maxHistory: 32,
      liveWidthPixels: 3.6, historyWidthPixels: 2.6, historySamples: 96,
      liveColor: new Color(MURAL_LINE_RGB), alongFade: MURAL_START_FADE,
    });
    this._muralBase = new Color(MURAL_LINE_RGB);
    this._tracerColor = new Color(MURAL_LINE_RGB);
    this._puttPath = null;
    this._revealed = 0;
    this._muralScratch = new Color(MURAL_LINE_RGB);
    this._flareStartedAt = null;
    this.diagnostics = { ready: false, frames: 0, putts: 0, made: 0, muralLines: 0,
      firstSolveMs: null, active: false, disposed: false };
    this.scenePass = pass(this.scene, this.camera, { samples: 0 });
    this.scenePass.setMRT(mrt({ output, velocity }));
    this.aa = resettableTraa(this.scenePass.getTextureNode(), this.scenePass.getTextureNode('depth'),
      this.scenePass.getTextureNode('velocity'), this.camera);
    this.pipeline = new RenderPipeline(renderer, this.aa);
    this.rng = createRng(course.environmentSeed);
    this._puttBearing = this.rng() * Math.PI * 2;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._queuedPutt = null;
    this._puttRequestId = 0;
    this._puttsWanted = false;
    this._prefetchAttempts = PUTT_SOLVE_ATTEMPTS;
    this.onError = onError;
    this._startPuttSolver();
  }

  // Solve the crop for the live viewport instead of a fixed span offset, so the green
  // fills the frame at any window shape rather than floating in backdrop.
  _applyViewportFit(aspect) {
    if (!(aspect > 0) || aspect === this._fitAspect) return;
    const pose = creatorCanvasCameraPose(this._fitCourse, this._fitHeightAt, {
      fit: { aspect, margin: FRAME_MARGIN, marginBottom: FRAME_MARGIN_BOTTOM },
    });
    this._fitAspect = aspect;
    this.camera.aspect = aspect;
    this.camera.position.fromArray(pose.position);
    this.camera.lookAt(...pose.lookAt);
    this.camera.updateProjectionMatrix();
    // A reframe invalidates every accumulated temporal sample; without this the
    // reprojection smears the whole maquette across the resize.
    this.aa?.reset('loading green reframed');
  }

  // Started from the constructor, not from prepare(): the solver's own module graph
  // is a network fetch, and behind `await assetsReady` it could not even begin until
  // every course asset had landed. On a slow connection that left the presented green
  // empty for seconds. Terrain is built synchronously with the scene, so the first
  // trajectory can be solved while those assets are still downloading.
  _startPuttSolver() {
    this._solverStartedAtMs = performance.now();
    this.puttWorker = new Worker(new URL('./LoadingGreenPutt.worker.js', import.meta.url), { type: 'module' });
    const terrain = this.course.terrain;
    const heights = terrain.heights.slice();
    this.puttWorker.postMessage({ terrain: { bounds: terrain.bounds, spacing: terrain.spacing,
      nx: terrain.nx, nz: terrain.nz, heights }, green: this.course.targets[0] }, [heights.buffer]);
    this.puttWorker.onerror = event => this._puttFailed(new Error(`Loading putt worker failed: ${event.message}`));
    this.puttWorker.onmessageerror = () => this._puttFailed(new Error('Loading putt worker returned an unreadable trajectory.'));
    this.puttWorker.onmessage = ({ data }) => {
      if (data.requestId !== undefined
        && (data.requestId !== this._puttRequestId || !this._puttsWanted)) return;
      if (data.error) { this._puttFailed(new Error(data.error)); return; }
      if (data.requestId !== this._puttRequestId || !this._puttsWanted) return;
      this._puttPending = false;
      // A start that rolls off the putting surface has no solution. Nothing else is
      // retrying while a putt is playing or before the first frame, so reach for
      // another one here rather than idling through the window we already have.
      if (!data.putt) {
        if (this._prefetchAttempts-- > 0) this._nextPutt();
        return;
      }
      // Solved trajectories always wait for the frame loop to start them. Playback is
      // clocked from the moment the ball is placed, so a putt begun off-frame would
      // have silently rolled away before the scene was ever presented.
      this._queuedPutt = data.putt;
      // Worker boot, module fetch, and solve, together. This is the number that
      // decides whether the green is putting when it appears or sitting empty.
      this.diagnostics.firstSolveMs ??= Math.round(performance.now() - this._solverStartedAtMs);
    };
    this._puttsWanted = true;
    this._nextPutt();
  }

  async prepare() {
    await this.course.assetsReady;
    this.course.update(0);
    this.pipeline.render();
    await this.renderer.backend.device.queue.onSubmittedWorkDone();
    this.diagnostics.ready = true;
    this.diagnostics.preparedAtMs = performance.now();
    this.show();
  }

  show() {
    if (!this.diagnostics.ready || this.diagnostics.active) return;
    this.diagnostics.active = true;
    this.presentationToneMapping = this.renderer.toneMapping;
    this.presentationColorSpace = this.renderer.outputColorSpace;
    // Each load draws its own mural. Retaining lines across loads would show the
    // previous course's putts under the new one's progress.
    this.tracer.clearHistory();
    this.diagnostics.muralLines = 0;
    this._flareStartedAt = null;
    this._puttsWanted = true;
    this._prefetchAttempts = PUTT_SOLVE_ATTEMPTS;
    this.aa.reset('show preloaded putting scene');
    this.lastFrameAt = performance.now();
    const overlay = document.getElementById('loading');
    overlay?.classList.remove('hidden');
    overlay?.classList.add('has-green');
    this._frame(this.lastFrameAt);
  }

  // The single place a solved trajectory becomes the playing one, always inside the
  // frame loop so playback starts on a frame that is actually presented.
  _pumpPutts() {
    if (this.putt) return;
    const queued = this._queuedPutt;
    if (!queued) { this._nextPutt(); return; }
    this._queuedPutt = null;
    this._startPutt(queued);
  }

  _startPutt(putt) {
    this.putt = putt;
    this.puttStarted = performance.now();
    this.diagnostics.putts++;
    this.course.ballMesh.visible = true;
    this.course.ballMesh.position.copy(putt.samples[0]);
    this._tracerColor.copy(this._muralBase).multiplyScalar(MURAL_LIVE_INTENSITY);
    this.tracer.setLiveColor(this._tracerColor);
    this.tracer.reset();
    this._puttPath = buildTracerPath(putt.samples);
    this._revealed = 0;
    // Solve the next line while this one rolls.
    this._prefetchAttempts = PUTT_SOLVE_ATTEMPTS;
    this._nextPutt();
  }

  // The holed line joins the mural at the cup, not after the post-hole beat, so it
  // appears exactly as the ball drops.
  _retirePutt() {
    // Complete the stroke into the cup regardless of which frame the ball landed on.
    this._revealPath(Infinity);
    if (this.tracer.count >= 2) {
      this.tracer.promoteActiveToHistory({ color: this._tracerColor });
      this.diagnostics.muralLines = this.tracer.historyCount;
      this._flareStartedAt = performance.now();
    }
    this.tracer.reset();
    this.diagnostics.made++;
    this.putt = null;
    this._pumpPutts();
  }

  // Newest stroke brightest, older ones receding, with a brief flare as a putt drops.
  // Re-applied only while that flare is easing out, then once more to settle it.
  _restyleMural(now) {
    const elapsed = (now - this._flareStartedAt) / 1000;
    const easing = Math.max(0, 1 - elapsed / MURAL_FLARE_SECONDS);
    const flare = easing * easing;
    this.tracer.restyleHistory((age) => {
      const settled = Math.min(1, age / MURAL_SETTLE_LINES);
      const intensity = MURAL_NEWEST_INTENSITY
        + (MURAL_OLDEST_INTENSITY - MURAL_NEWEST_INTENSITY) * settled
        + (age === 0 ? (MURAL_FLARE_INTENSITY - MURAL_NEWEST_INTENSITY) * flare : 0);
      return {
        opacity: MURAL_NEWEST_OPACITY + (MURAL_OLDEST_OPACITY - MURAL_NEWEST_OPACITY) * settled,
        color: this._muralScratch.copy(this._muralBase).multiplyScalar(intensity),
      };
    });
    if (elapsed >= MURAL_FLARE_SECONDS) this._flareStartedAt = null;
  }

  // Draw the precomputed curve on as far as the ball has travelled. Control points
  // never move once revealed, so the stroke grows instead of being re-derived each
  // frame from wherever the ball happened to land.
  _revealPath(throughArcMetres) {
    const path = this._puttPath;
    if (!path) return;
    while (this._revealed < path.points.length
      && path.arc[this._revealed] <= throughArcMetres
      && this.tracer.count < this.tracer.max) {
      this.tracer.push(path.points[this._revealed]);
      this._revealed++;
    }
  }

  _nextPutt() {
    if (this._puttPending || this._queuedPutt) return;
    const cup = this.course.targets[0];
    // Long putts from right across the green. Starts that leave the putting surface
    // are rejected by the solver, so the reach is bounded by the green's real shape
    // rather than by a radius that would keep every line in one small patch.
    this._puttBearing += PUTT_BEARING_STEP + (this.rng() - 0.5) * PUTT_BEARING_JITTER;
    const angle = this._puttBearing, distance = 3 + this.rng() * 6;
    const start = { x: cup.x + Math.cos(angle) * distance, z: cup.z + Math.sin(angle) * distance };
    this._puttPending = true;
    this.puttWorker.postMessage({ requestId: ++this._puttRequestId, start, cup });
  }

  _puttFailed(error) {
    this.error = error;
    this.stop();
    this.onError(error);
  }

  _frame(now) {
    if (!this.diagnostics.active || this.diagnostics.disposed) return;
    try {
      const dt = Math.max(0, Math.min(0.05, (now - this.lastFrameAt) / 1000));
      this.lastFrameAt = now;
      this.environmentState.advanceFixedTicks(Math.round(dt * 120));
      this.environment.update(this.environmentState);
      this._applyViewportFit(window.innerWidth / window.innerHeight);
      if (this._flareStartedAt !== null) this._restyleMural(now);
      if (!this.reducedMotion) {
        this._pumpPutts();
        if (this.putt) {
          const t = Math.max(0, (now - this.puttStarted) / 1000 - ADDRESS_SECONDS);
          const frame = Math.min(this.putt.samples.length - 1, t / this.putt.sampleSeconds);
          const index = Math.floor(frame);
          const ball = this.course.ballMesh;
          ball.position.lerpVectors(this.putt.samples[index],
            this.putt.samples[Math.min(index + 1, this.putt.samples.length - 1)], frame - index);
          if (t > this.putt.duration) {
            const drop = t - this.putt.duration;
            ball.position.y -= Math.min(0.12, 4.905 * drop * drop);
            if (drop > HOLED_HIDE_SECONDS) ball.visible = false;
            if (drop > HOLED_CLEAR_SECONDS) this._retirePutt();
          } else if (t > 0) {
            this._revealPath(this._puttPath.arcAtSample(frame));
          }
        }
      }
      this.course.update(now / 1000);
      this.lighting.sun.shadow.needsUpdate = true;
      // Course rebuilds stop Three's scheduler. Advance its node frame exactly
      // as SceneManager.renderSingleFrame does, or passes reuse the old texture.
      if (this.renderer.info.autoReset) this.renderer.info.reset();
      this.renderer._nodes.nodeFrame.update();
      this.renderer.info.frame = this.renderer._nodes.nodeFrame.frameId;
      this.renderer._inspector.begin();
      const pendingTarget = this.renderer.getRenderTarget();
      const pendingMrt = this.renderer.getMRT();
      const pendingToneMapping = this.renderer.toneMapping;
      const pendingColorSpace = this.renderer.outputColorSpace;
      try {
        this.renderer.setRenderTarget(null);
        this.renderer.setMRT(null);
        this.renderer.toneMapping = this.presentationToneMapping;
        this.renderer.outputColorSpace = this.presentationColorSpace;
        this.pipeline.render();
      } finally {
        this.renderer.toneMapping = pendingToneMapping;
        this.renderer.outputColorSpace = pendingColorSpace;
        try { this.renderer.setRenderTarget(pendingTarget); } finally {
          try { this.renderer.setMRT(pendingMrt); } finally { this.renderer._inspector.finish(); }
        }
      }
      this.diagnostics.frames++;
      this.raf = requestAnimationFrame(time => this._frame(time));
    } catch (error) {
      this.error = error;
      this.stop();
      this.onError(error);
    }
  }

  // Pause, don't dispose: subsequent loads reuse the already-ready scene.
  stop() {
    this.diagnostics.active = false;
    cancelAnimationFrame(this.raf);
    this.putt = null;
    this._queuedPutt = null;
    this._puttPending = false;
    this._puttsWanted = false;
    this._puttRequestId++;
    // A stop can be the tail of a failed frame. Touching the renderer again there
    // would mask the original error with a cleanup one.
    if (!this.error) this.tracer.reset();
    this.course.ballMesh.visible = false;
  }

  dispose() {
    if (this.diagnostics.disposed) return;
    this.stop();
    this.diagnostics.disposed = true;
    this.puttWorker?.terminate();
    this.tracer.dispose();
    this.pipeline.dispose();
    this.aa.dispose();
    this.scenePass.dispose();
    this.course.dispose();
    this.lighting.sun.shadow.map?.dispose();
    this.lighting.dispose();
    this.scene.clear();
  }
}
