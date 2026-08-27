import {
  Scene, PerspectiveCamera, FogExp2, Color, Vector3,
  NeutralToneMapping, PCFSoftShadowMap,
  Matrix4, Quaternion, Vector2,
} from 'three';
import { PMREMGenerator, RenderPipeline, Renderer, StandardNodeLibrary } from 'three/webgpu';
import {
  pass, mrt, output, velocity, uniform, uv, Fn, If, float, vec2,
} from 'three/tsl';
import { GpuPassProfiler } from '../diagnostics/GpuPassProfiler.js';
import { CloudTemporalNode } from './CloudTemporalNode.js';
import { resettableTraa } from './ResettableTRAANode.js';
import { StrictWebGPUBackend } from './StrictWebGPUBackend.js';
import { WeatherSky, WEATHER_SKY_WORKLOADS, cloudsAreEnabled } from './WeatherSky.js';
import { disposeWebGPUSceneBackground } from './WebGPUResourceDisposal.js';

const WEATHER_SKY_WORKLOAD_FIELDS = Object.freeze([
  'id',
  'internalScale',
  'raySteps',
  'lightTransportSamples',
  'lightProbeSteps',
  'noiseOctaves',
  'jitterPeriod',
]);

function resolveWeatherSkyWorkload(workload) {
  const id = typeof workload === 'string' ? workload : workload?.id;
  const canonical = typeof id === 'string' ? WEATHER_SKY_WORKLOADS[id] : null;
  if (!canonical) {
    throw new RangeError('WeatherSky workload must be high, balanced, or conservative.');
  }

  // Accept a diagnostic/workload snapshot as a convenience, but only when every
  // fixed budget matches the authoritative entry. The returned object is always
  // the canonical frozen workload, so this API cannot introduce a new renderer
  // representation or an unbounded shader budget.
  if (typeof workload !== 'string') {
    for (const field of WEATHER_SKY_WORKLOAD_FIELDS) {
      if (workload[field] !== canonical[field]) {
        throw new RangeError(
          `WeatherSky workload ${id} must match the fixed ${id} workload budgets.`,
        );
      }
    }
  }
  return canonical;
}

export const DYNAMIC_RESOLUTION_MIN_SCALE = 0.5;
export const DYNAMIC_RESOLUTION_MAX_SCALE = 1;

// PMREM is an indirect-light cache. The visible sky and direct sun follow the
// environment uniforms every revision, but the 64px convolution does not need
// to be recaptured for every two-second timeline sample. These thresholds are
// intentionally measured from the last successful capture so small daylight
// changes accumulate instead of being discarded.
export const DAYLIGHT_PMREM_SUN_ANGLE_THRESHOLD_RADIANS = 0.5 * Math.PI / 180;
export const DAYLIGHT_PMREM_ATMOSPHERIC_THRESHOLD = 0.04;
export const DAYLIGHT_PMREM_RADIANCE_THRESHOLD = 0.04;
export const DAYLIGHT_PMREM_MAX_INTERVAL_MS = 15_000;

const DAYLIGHT_PMREM_ATMOSPHERE_SCALES = Object.freeze([4, 4, 0.01, 1]);

function daylightPmremVector(value) {
  return {
    x: Number(value?.x ?? 0),
    y: Number(value?.y ?? 0),
    z: Number(value?.z ?? 0),
  };
}

function daylightPmremVectorDelta(a, b) {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.z - b.z),
  );
}

function daylightPmremVectorAngle(a, b) {
  const aLength = Math.hypot(a.x, a.y, a.z);
  const bLength = Math.hypot(b.x, b.y, b.z);
  if (aLength <= 1e-8 || bLength <= 1e-8) return Infinity;
  const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (aLength * bLength);
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

function daylightPmremScaledDelta(current, previous, scale) {
  return Math.abs(current - previous) / Math.max(Math.abs(scale), 1e-8);
}

// Keep this snapshot renderer-independent so tests and diagnostics can reason
// about the PMREM schedule without constructing a GPU node graph.
export function readDaylightPmremState(environment) {
  if (!environment) return null;
  const atmosphere = environment.atmosphere?.value;
  return {
    direction: daylightPmremVector(environment.sunDirection?.value),
    sunIlluminanceScale: Number(environment.sunIlluminanceScale?.value ?? 0),
    sunColor: daylightPmremVector(environment.sunColor?.value),
    atmosphere: [
      Number(atmosphere?.x ?? 0),
      Number(atmosphere?.y ?? 0),
      Number(atmosphere?.z ?? 0),
      Number(atmosphere?.w ?? 0),
    ],
    horizonColor: daylightPmremVector(environment.horizonColor?.value),
    zenithColor: daylightPmremVector(environment.zenithColor?.value),
  };
}

export function measureDaylightPmremChange(previous, current, {
  lastCaptureAt = null,
  now = null,
} = {}) {
  if (!previous || !current) {
    return {
      sunAngleRadians: Infinity,
      atmosphericDelta: Infinity,
      radianceDelta: Infinity,
      elapsedMs: Infinity,
    };
  }

  const atmosphericDelta = Math.max(
    ...current.atmosphere.map((value, index) => daylightPmremScaledDelta(
      value, previous.atmosphere[index], DAYLIGHT_PMREM_ATMOSPHERE_SCALES[index],
    )),
    daylightPmremVectorDelta(current.horizonColor, previous.horizonColor),
    daylightPmremVectorDelta(current.zenithColor, previous.zenithColor),
  );
  const radianceDelta = Math.max(
    daylightPmremScaledDelta(
      current.sunIlluminanceScale,
      previous.sunIlluminanceScale,
      Math.max(1, Math.abs(previous.sunIlluminanceScale)),
    ),
    daylightPmremVectorDelta(current.sunColor, previous.sunColor),
  );
  const elapsedMs = Number.isFinite(lastCaptureAt) && Number.isFinite(now)
    ? Math.max(0, now - lastCaptureAt)
    : Infinity;

  return {
    sunAngleRadians: daylightPmremVectorAngle(current.direction, previous.direction),
    atmosphericDelta,
    radianceDelta,
    elapsedMs,
  };
}

export function resolveDaylightPmremUpdate({
  previous = null,
  current,
  lastCaptureAt = null,
  now = null,
  force = false,
} = {}) {
  const change = measureDaylightPmremChange(previous, current, { lastCaptureAt, now });
  if (force) {
    return { ...change, shouldRebuild: true, reason: 'explicit' };
  }
  if (!previous || !Number.isFinite(lastCaptureAt)) {
    return { ...change, shouldRebuild: true, reason: 'initial' };
  }

  const reasons = [];
  if (change.sunAngleRadians >= DAYLIGHT_PMREM_SUN_ANGLE_THRESHOLD_RADIANS) {
    reasons.push('sun-angle');
  }
  if (change.atmosphericDelta >= DAYLIGHT_PMREM_ATMOSPHERIC_THRESHOLD) {
    reasons.push('atmosphere');
  }
  if (change.radianceDelta >= DAYLIGHT_PMREM_RADIANCE_THRESHOLD) {
    reasons.push('radiance');
  }
  if (change.elapsedMs >= DAYLIGHT_PMREM_MAX_INTERVAL_MS) {
    reasons.push('max-interval');
  }

  return {
    ...change,
    shouldRebuild: reasons.length > 0,
    reason: reasons[0] ?? 'below-threshold',
  };
}

// Three r185 has a public render-pipeline output, but its TRAANode history is
// tied to the source pass dimensions. Keep the controller-facing policy pure so
// a future output-resolution temporal reconstruction can consume the same state
// without changing how caps are selected.
export function normalizeRenderResolution({ outputPixelCap = null, internalRenderScale = 1 } = {}) {
  const scale = Number(internalRenderScale);
  if (!Number.isFinite(scale)
    || scale < DYNAMIC_RESOLUTION_MIN_SCALE
    || scale > DYNAMIC_RESOLUTION_MAX_SCALE) {
    throw new RangeError(
      `internalRenderScale must be between ${DYNAMIC_RESOLUTION_MIN_SCALE} and ${DYNAMIC_RESOLUTION_MAX_SCALE}.`,
    );
  }

  if (outputPixelCap === null || outputPixelCap === undefined) {
    return Object.freeze({ outputPixelCap: null, internalRenderScale: scale });
  }

  const cap = Number(outputPixelCap);
  if (!Number.isFinite(cap) || cap < 1) {
    throw new RangeError('outputPixelCap must be null or a finite positive pixel count.');
  }
  return Object.freeze({ outputPixelCap: Math.floor(cap), internalRenderScale: scale });
}

export function calculateOutputPixelRatio({
  width,
  height,
  devicePixelRatio = 1,
  tierPixelRatioCap = 2,
  outputPixelCap = null,
} = {}) {
  const cssWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const cssHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const dpr = Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
  const tierCap = Math.max(1, Number.isFinite(tierPixelRatioCap) ? tierPixelRatioCap : 2);
  const maximumRatio = Math.min(dpr, tierCap);
  if (outputPixelCap === null || outputPixelCap === undefined) return maximumRatio;

  const cap = Math.max(1, Number(outputPixelCap));
  const capRatio = Math.sqrt(cap / (cssWidth * cssHeight));
  // A 0.5 floor avoids unusable 1px-wide output on small windows while making
  // the diagnostic explicit when a very small cap cannot be met exactly.
  return Math.min(maximumRatio, Math.max(0.5, capRatio));
}

// Owns the WebGPU renderer, scene, camera, HDRI environment, and the frame loop.
// Migrated from WebGLRenderer + EffectComposer to WebGPURenderer so the grass can
// be generated/animated in real compute shaders (TSL). Post-processing (bloom +
// cinematic grade) is being reintroduced through the node RenderPipeline system;
// until then we render directly, which still applies tone-mapping and sRGB.
export class SceneManager {
  constructor(container) {
    this.container = container;
    this._renderResolution = {
      outputPixelCap: null,
      internalRenderScale: 1,
      revision: 0,
    };
    this._drawingBufferSize = new Vector2();
    // The browser viewport is the sole CSS-size authority. Renderer.setSize's
    // default style mutation can make canvas.clientWidth briefly disagree with
    // window.innerWidth, feeding a resize event back into this handler and
    // repeatedly tearing down temporal targets. Cache the last applied tuple and
    // leave CSS sizing to index.html's fixed #app/canvas rules.
    this._viewportState = {
      width: Math.max(1, Math.round(window.innerWidth)),
      height: Math.max(1, Math.round(window.innerHeight)),
      pixelRatio: this._outputPixelRatio(window.innerWidth, window.innerHeight),
    };
    this._viewportRevision = 1;
    // WebGPURenderer silently installs a WebGL2 fallback. That is useful for a general
    // Three.js demo but actively wrong for this renderer: its environment path uses
    // WebGPU/TSL features and must fail loudly instead of quietly changing renderer.
    // Renderer + WebGPUBackend has no getFallback callback, so init() rejects when
    // WebGPU cannot be acquired. TRAA owns anti-aliasing in the scene pass; enabling
    // canvas MSAA here would only spend bandwidth on an image TRAA immediately replaces.
    const rendererParams = { antialias: false, powerPreference: 'high-performance' };
    this.renderer = new Renderer(new StrictWebGPUBackend(rendererParams), rendererParams);
    this.renderer.library = new StandardNodeLibrary();
    this.renderer.isWebGPURenderer = true;
    this.gpuProfiler = new GpuPassProfiler();
    this.renderer.inspector = this.gpuProfiler;
    // The real cap arrives with the hardware adapter during initialize(). This
    // provisional cap is never rendered: initialize resolves before start resumes.
    this.renderer.setPixelRatio(this._viewportState.pixelRatio);
    this.renderer.setSize(this._viewportState.width, this._viewportState.height, false);
    // Khronos/PBR Neutral preserves the shared daylight chromaticity into the
    // highlight shoulder. The analytic sky and sun are already authored in
    // linear HDR; ACES was converging their warm/blue channels toward white
    // after the TRAA/history graph had resolved them.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.20;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = null;
    // Gentle exponential aerial perspective. The live daylight binding refines
    // this baseline by turbidity, keeping the distant alpine wall seated in the
    // same chromatic horizon without spatially blurring near-course detail.
    this.scene.fog = new FogExp2(0xb8c9d8, 0.00016);

    // The outer alpine massif reaches roughly 4 km from the tee. Keep it inside
    // the view volume so the world closes against terrain instead of the far plane.
    this.camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 6000);
    this.camera.position.set(0, 2, 8);
    // Unjittered camera matrices for material-owned procedural velocity. TRAA mutates
    // the camera projection inside its render pass, so reading camera matrices from a
    // material would mix jittered current data with non-jittered history. Capturing both
    // here, immediately before the pipeline, gives every procedural material one shared
    // and explicitly versioned frame contract.
    this.motionHistory = {
      currentProjection: uniform(new Matrix4()),
      currentView: uniform(new Matrix4()),
      previousProjection: uniform(new Matrix4()),
      previousView: uniform(new Matrix4()),
      valid: false,
    };
    this._cameraCutState = {
      position: new Vector3(),
      quaternion: new Quaternion(),
      projection: new Matrix4(),
      valid: false,
    };
    // A result orbit is effectively stationary from the reprojection point of
    // view. If the delayed return-to-address begins after that still period,
    // velocity buffers alone cannot explain the newly exposed course; restart
    // TRAA on that first transition frame.
    this._cameraStillFrames = 0;
    this._cameraMoving = false;

    this.weatherSky = null;
    this._weatherSkyGraphRevision = 0;
    this._weatherSkyWorkloadSwitchCount = 0;
    this._lastWeatherSkyWorkloadSwitch = null;
    this._environmentBindings = null;
    this.skyManifest = null;
    this._environmentUnsubscribe = null;
    this._daylightPmremTarget = null;
    this._daylightPmremRevision = -1;
    this._daylightPmremLastCaptureAt = null;
    this._daylightPmremLastCaptureState = null;
    this._daylightPmremLastDecision = null;
    this._daylightPmremSuppressedUpdates = 0;
    this._sceneDaylightRevision = -1;

    this.environmentTier = null;
    this._initializePromise = null;

    this._updates = [];
    this._elapsed = 0;
    // Diagnostic control used by the benchmark's temporal-AA stability capture.
    // It freezes simulation state while the renderer and TRAA continue advancing,
    // separating genuine reconstruction shimmer from authored wind animation.
    this.freezeSimulation = false;
    this._ready = false;
    this._lastFrameTime = 0;
    this._animationFrame = () => this._renderFrame(performance.now());
    this._renderingPaused = false;
    window.addEventListener('resize', () => this._onResize());
  }

  // Public read-only pacing state for systems that consume presentation timing.
  // A paused diagnostic frame is still rendered through the production graph,
  // but it is not part of the live animation cadence and must not train adaptive
  // quality. Simulation freezing is deliberately separate: a stationary camera
  // or paused shot still presents real frames whose GPU pressure matters.
  get renderingPaused() { return this._renderingPaused; }

  // Node post-processing: subtle bloom on genuine highlights, a saturation lift
  // and a soft vignette. The renderer's Neutral tone-map + sRGB output are applied
  // to the final node automatically (outputColorTransform), so the grade lives in
  // linear light before the tone-mapping curve — a graded-broadcast finish, not a filter.
  _setupPost() {
    if (!this.environmentTier) throw new Error('SceneManager post pipeline requires a resolved environment device tier.');
    // Weather configuration can arrive immediately after WebGPU initialization,
    // and a later authored weather change may rebuild the atmosphere graph. Release
    // the old graph before replacing its handles so its full-resolution MRT and
    // temporal targets do not remain resident or overlap the next frame.
    this._cloudTemporal?.dispose();
    this._scenePass?.dispose();
    this._traa?.dispose();
    this.postProcessing?.dispose();

    // TRAA (temporal AA) resolves the sub-pixel shimmer of thin grass blades that
    // MSAA can't. It needs MSAA OFF and an MRT scene pass exposing color +
    // velocity (motion vectors) plus depth so it can reproject the history.
    const scenePass = pass(this.scene, this.camera, { samples: 0 });
    scenePass.name = 'Scene MRT';
    scenePass.setMRT(mrt({ output, velocity }));
    // PassNode exposes resolutionScale internally in r185. Keep this assignment
    // local to the Scene MRT: the final RenderPipeline remains the output-size
    // presentation surface, while color/velocity/depth share one source size.
    scenePass._resolutionScale = this._renderResolution?.internalRenderScale ?? 1;
    this._scenePass = scenePass;
    this._syncScenePassResolution();
    const color = scenePass.getTextureNode();
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');

    let cloudLayer = null;
    let cloudSourceLayer = null;
    if (this.weatherSky?.usesVolumetricClouds) {
      // One bounded quarter-resolution fullscreen material now evaluates the
      // current cloud ray and resolves/reprojects history into the same target.
      // There is no intermediate current-sky render target or readback path.
      this._cloudTemporal = new CloudTemporalNode(
        this.weatherSky,
        this.camera,
        this.weatherSky.workload.internalScale * (this._renderResolution?.internalRenderScale ?? 1),
        depth,
      );
      cloudLayer = this._cloudTemporal.getTextureNode();
      cloudSourceLayer = this._cloudTemporal.getSourceMetadataNode();
      // Scene beauty owns the analytic daylight sky. The quarter-resolution cloud
      // pass remains depth-clamped world transport and is composed once after TRAA,
      // outside TRAA's expensive neighborhood reconstruction.
      this.scene.backgroundNode = this.weatherSky.clearBackgroundNode;
    } else {
      // Clear weather allocates and submits no cloud pass or cloud history target.
      this._cloudTemporal = null;
      this.scene.backgroundNode = this.weatherSky?.backgroundNode ?? null;
    }

    // Resolve opaque scene beauty independently. The existing final pass applies
    // the cloud transport once, avoiding cloud work in TRAA's neighborhood taps.
    const aa = resettableTraa(color, depth, vel, this.camera, null);
    // Thin, high-contrast blades are precisely the case where TRAA's optional
    // subpixel correction turns a stable history into a changing per-pixel weight.
    // Keep normal motion/disocclusion handling, but avoid that documented square/
    // shimmer trade-off in the production golf-environment path.
    aa.useSubpixelCorrection = false;
    // Stationary opaque geometry always needs projection sample diversity. Cloud
    // transport records the actual current/previous camera matrices, including
    // this bounded Halton offset, so it reprojects the same jittered scene/depth
    // sample rather than forcing trunks and alpha-cut foliage onto one pixel grid.
    aa.cameraJitterEnabled = true;
    this._traa = aa;
    // Grounding is authored by real directional shadows, sky irradiance, material
    // normals, terrain alignment, and physical burial. The former screen-space AO
    // required a second scene render for an 8% dark decal and cost almost as much as
    // the beauty pass on this hardware; it also contradicted the no-fake-AO bar.
    const resolvedScene = aa.rgb;
    // Neutral retains real sun/water/ball highlights without a second glare copy.
    // The former 6.5% bloom was visually negligible in the fixed suite but forced
    // another offscreen render and full-screen composition on this hardware.
    this._bloomPass = null;
    const cloudTransport = cloudLayer ? Fn(() => {
      const sampleUv = uv();
      const lowSize = cloudLayer.size();
      const coordinate = sampleUv.mul(lowSize).sub(0.5)
        .clamp(vec2(0), lowSize.sub(1));
      const base = coordinate.floor();
      const fraction = coordinate.fract();
      const depthValue = depth.sample(sampleUv).r;
      const finiteGeometry = this.renderer.reversedDepthBuffer
        ? depthValue.greaterThan(0.000001)
        : depthValue.lessThan(0.999999);
      // One native gather classifies the same 2x2 bilinear footprint that the
      // former four metadata loads tested individually. Almost every output pixel
      // is wholly sky or wholly geometry, so keep the normal path to one gather +
      // one filtered transport sample. Only actual depth silhouettes enter the
      // exact nearest-compatible search and issue point loads.
      const gatheredFinite = cloudSourceLayer.sample(sampleUv).gather(0).greaterThan(0.5);
      const gatheredCompatible = gatheredFinite.notEqual(finiteGeometry).not();
      const allCompatible = gatheredCompatible.x.and(gatheredCompatible.y)
        .and(gatheredCompatible.z).and(gatheredCompatible.w);
      const transport = cloudLayer.sample(sampleUv).toVar();
      If(allCompatible.not(), () => {
        const selectedTexel = sampleUv.mul(lowSize).floor().toVar();
        const selectedMetric = float(1e9).toVar();
        const selectedFound = float(0).toVar();
        for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const texel = base.add(vec2(x, y)).clamp(vec2(0), lowSize.sub(1));
          const sourceFinite = cloudSourceLayer.load(texel).r.greaterThan(0.5);
          const compatible = sourceFinite.notEqual(finiteGeometry).not();
          const metric = vec2(x, y).sub(fraction).length();
          If(compatible.and(metric.lessThan(selectedMetric)), () => {
            selectedTexel.assign(texel);
            selectedMetric.assign(metric);
            selectedFound.assign(1);
          });
        }
        const pointTransport = cloudLayer.load(sampleUv.mul(lowSize).floor());
        transport.assign(selectedFound.greaterThan(0.5)
          .select(cloudLayer.load(selectedTexel), pointTransport));
      });
      return transport;
    })() : null;
    const rgb = cloudTransport
      ? resolvedScene.mul(cloudTransport.a).add(cloudTransport.rgb)
      : resolvedScene;

    // RenderPipeline is the current Three.js API. The former PostProcessing alias
    // emits a warning on every startup despite using the same implementation.
    this.postProcessing = new RenderPipeline(this.renderer);
    this.postProcessing.outputNode = rgb;
    this._weatherSkyGraphRevision = (this._weatherSkyGraphRevision ?? 0) + 1;
  }

  configureWeather(environment, skyManifest = this.skyManifest) {
    if (!this.environmentTier) throw new Error('Weather configuration requires initialized WebGPU device tier.');
    const workload = WEATHER_SKY_WORKLOADS[this.environmentTier.id];
    if (!workload) throw new Error(`No WeatherSky workload for tier ${this.environmentTier.id}.`);
    this._daylightPmremTarget?.dispose();
    this._daylightPmremTarget = null;
    this.scene.environment = null;
    this._daylightPmremRevision = -1;
    this._daylightPmremLastCaptureAt = null;
    this._daylightPmremLastCaptureState = null;
    this._daylightPmremLastDecision = null;
    this._daylightPmremSuppressedUpdates = 0;
    this.weatherSky?.dispose();
    this.weatherSky = new WeatherSky(this.renderer, environment, workload, skyManifest);
    this.scene.background = null;
    this.scene.backgroundNode = this.weatherSky.usesVolumetricClouds ? null : this.weatherSky.backgroundNode;
    this._environmentUnsubscribe?.();
    this._environmentBindings = environment;
    this.scene.userData.environmentLighting?.configureEnvironment(environment);
    const applyDaylight = () => this._applyEnvironmentDaylight();
    applyDaylight();
    this._environmentUnsubscribe = environment.onChange(applyDaylight);
    this._setupPost();
    this.invalidateTemporalHistory('weather-sky graph');
  }

  // Rebuild the weather graph only at an explicit workload boundary. Every
  // workload uses the same strict WebGPU volumetric representation; the fixed
  // entry only changes ray/probe/noise budgets. There is intentionally no call
  // path from _renderFrame, so presentation never churns graph ownership.
  setWeatherSkyWorkload(workload) {
    const nextWorkload = resolveWeatherSkyWorkload(workload);
    if (!this.weatherSky || !this._environmentBindings) {
      throw new Error('WeatherSky workload requires configured weather.');
    }

    const previous = this.weatherSky;
    const previousWorkloadId = previous.workload.id;
    if (previousWorkloadId === nextWorkload.id) {
      return {
        changed: false,
        reason: 'unchanged',
        previousWorkloadId,
        workloadId: previousWorkloadId,
        diagnostics: this.readWeatherSkyDiagnostics(),
      };
    }

    // Construct the replacement before changing ownership. A constructor or
    // workload validation failure therefore leaves the current graph intact.
    const next = new WeatherSky(
      this.renderer,
      this._environmentBindings,
      nextWorkload,
      this.skyManifest,
    );
    next.setTemporalFrame(0);

    this.weatherSky = next;
    this.scene.backgroundNode = next.usesVolumetricClouds ? null : next.backgroundNode;
    previous.dispose();
    this._setupPost();
    this.invalidateTemporalHistory(`weather-sky workload: ${previousWorkloadId} -> ${nextWorkload.id}`);

    this._weatherSkyWorkloadSwitchCount = (this._weatherSkyWorkloadSwitchCount ?? 0) + 1;
    this._lastWeatherSkyWorkloadSwitch = {
      from: previousWorkloadId,
      to: nextWorkload.id,
      graphRevision: this._weatherSkyGraphRevision ?? null,
    };

    return {
      changed: true,
      reason: 'workload-changed',
      previousWorkloadId,
      workloadId: nextWorkload.id,
      diagnostics: this.readWeatherSkyDiagnostics(),
    };
  }

  readWeatherSkyDiagnostics() {
    const sky = this.weatherSky;
    const workload = sky?.workload ?? null;
    return {
      workloadId: workload?.id ?? null,
      workload: workload ? { ...workload } : null,
      representation: sky
        ? (sky.usesVolumetricClouds ? 'gpu-volume-raymarch' : 'analytic-background')
        : null,
      usesVolumetricClouds: sky?.usesVolumetricClouds === true,
      cloudsEnabled: sky?.cloudsEnabled === true,
      temporalFrame: Number.isInteger(sky?.temporalFrame) ? sky.temporalFrame : null,
      graphRevision: this._weatherSkyGraphRevision ?? 0,
      workloadSwitchCount: this._weatherSkyWorkloadSwitchCount ?? 0,
      lastWorkloadSwitch: this._lastWeatherSkyWorkloadSwitch
        ? { ...this._lastWeatherSkyWorkloadSwitch }
        : null,
    };
  }

  // Authored cloud coverage is a live Conditions control. Edits inside the enabled
  // range update uniforms in the existing volume graph; crossing clear/cloudy changes
  // the graph and rebuilds the existing Scene MRT background variant.
  refreshWeatherSkyClouds() {
    if (!this.weatherSky || !this._environmentBindings) return this;
    const wanted = cloudsAreEnabled(this._environmentBindings.clouds.value);
    if (wanted === this.weatherSky.cloudsEnabled) return this;
    const previous = this.weatherSky;
    this.weatherSky = new WeatherSky(
      this.renderer, this._environmentBindings, previous.workload, this.skyManifest,
    );
    // A cloud graph switch has no meaningful reprojection predecessor. Start a new
    // jitter sequence and reject TRAA history after installing the matching pass.
    this.weatherSky.setTemporalFrame(0);
    this.scene.backgroundNode = this.weatherSky.usesVolumetricClouds
      ? null : this.weatherSky.backgroundNode;
    previous.dispose();
    this._setupPost();
    // Compiling in or out the volume changes every sky pixel at once. There is no
    // meaningful prior image to reproject across that edit.
    this.invalidateTemporalHistory('cloud-coverage');
    return this;
  }

  configureSkyManifest(manifest) {
    this.skyManifest = manifest;
    return this;
  }

  _applyEnvironmentDaylight() {
    const environment = this._environmentBindings;
    if (!environment || this._sceneDaylightRevision === environment.daylightRevision) return;
    this._sceneDaylightRevision = environment.daylightRevision;
    // Keep authored exposure responsive, but bound pathological presets before
    // Neutral: a 10–20x input otherwise drives the shoulder over the whole frame and
    // turns the sky and turf into the same low-contrast grey. Normal daylight
    // values (0.75–1.35) pass through unchanged.
    // Keep the authored atmosphere exposure authoritative while applying the
    // renderer's fixed daylight calibration. Neutral needs a slightly higher
    // reference exposure than ACES to hold the same midtone value while
    // retaining the source sky/rock chromaticity in its highlight shoulder.
    this.renderer.toneMappingExposure = Math.min(1.65, Math.max(0.70, environment.atmosphereExposure.value * 1.20));
    const horizon = environment.horizonColor.value;
    this.scene.fog.color.setRGB(horizon.x, horizon.y, horizon.z);
    // Turbidity owns both aerial perspective and sky extinction. Keeping these
    // coupled prevents a crystal-clear horizon under a hazy atmosphere preset.
    const cameraHeight = Math.max(0, this.camera.position.y);
    const horizonWeight = Math.min(1, Math.max(0, 1 - cameraHeight / 220));
    // FogExp2 squares density with view distance. This is deliberately restrained
    // enough for ridges to retain their authored value hierarchy while making the
    // 3–4 km wall converge toward the same daylight horizon as the sky.
    // The 0.00010 + 9e-6*turbidity baseline made the 3–4 km wall contribute
    // almost half of every far pixel. Use a shallower, still turbidity-coupled
    // path so the mountain/turf value hierarchy survives while the horizon
    // remains seated in the same shared chromatic sky.
    this.scene.fog.density = (0.000075 + environment.atmosphere.value.x * 0.000005)
      * (0.82 + horizonWeight * 0.34);
    // PMREM is the sky bounce, not a second sun. Keep its diffuse/specular return
    // below the authored key so the lower, lateral sun can model terrain while
    // the shared sky still supplies coloured open-sky detail in forest shadows.
    // This is the same shared HDR/analytic source captured below; only its renderer-relative
    // return is calibrated here, and it follows the authored illuminance scale.
    this.scene.environmentIntensity = 0.34 * Math.sqrt(Math.max(0, environment.sunIlluminanceScale.value));
    const now = this._daylightPmremNow();
    const current = readDaylightPmremState(environment);
    const decision = resolveDaylightPmremUpdate({
      previous: this._daylightPmremLastCaptureState,
      current,
      lastCaptureAt: this._daylightPmremLastCaptureAt,
      now,
    });
    this._daylightPmremLastDecision = decision;
    if (decision.shouldRebuild) {
      const rebuilt = this._rebuildDaylightPmrem({ now, reason: decision.reason });
      if (!rebuilt) this._daylightPmremLastDecision = { ...decision, deferred: true };
    } else {
      this._daylightPmremSuppressedUpdates += 1;
    }
  }

  _daylightPmremNow() {
    return globalThis.performance?.now?.() ?? Date.now();
  }

  _recordDaylightPmremCapture(environment, now, reason) {
    this._daylightPmremLastCaptureAt = now;
    this._daylightPmremLastCaptureState = readDaylightPmremState(environment);
    this._daylightPmremLastDecision = {
      ...this._daylightPmremLastDecision,
      shouldRebuild: true,
      reason,
      deferred: false,
    };
    this._daylightPmremSuppressedUpdates = 0;
  }

  _rebuildDaylightPmrem({ force = false, now = this._daylightPmremNow(), reason = 'unspecified' } = {}) {
    const environment = this._environmentBindings;
    if (!environment || !this.weatherSky || (!force && this._daylightPmremRevision === environment.daylightRevision)) {
      return false;
    }
    // HDRLoader returns its texture handle synchronously, but the Radiance pixels
    // arrive later. Never ask PMREMGenerator to convolve that placeholder image;
    // startup explicitly calls rebuildDaylightPmrem() after weatherSky.ready.
    if (this.skyManifest && !this.weatherSky.skyTextureLoaded) return false;
    // Three r185's WebGPU PMREMGenerator can capture a Scene.backgroundNode after
    // renderer.init(). A compact 64px cube is sufficient for matte turf, bark, rock,
    // and water while keeping this weather-change-only operation inexpensive.
    this._pmremGenerator ??= new PMREMGenerator(this.renderer);
    const captureScene = new Scene();
    // Capture the same HDR node used by water/reflections, with its solar disc
    // replaced by the analytic sky. fromEquirectangular(raw HDR) would preserve
    // that six-pixel ~60k-linear disc and create an unshadowed duplicate sun.
    // WeatherSky applies the manifest yaw in its equirectangular lookup, so the
    // PMREM and visible background have identical world orientation.
    captureScene.backgroundNode = this.weatherSky.iblBackgroundNode;
    const next = this._pmremGenerator.fromScene(captureScene, 0.035, 0.1, 10, { size: 64 });
    // PMREM's capture Scene is intentionally ephemeral, but WebGPURenderer stores
    // its generated sky sphere outside the scene graph. End that hidden geometry's
    // GPU lifetime immediately after the synchronous cube capture.
    disposeWebGPUSceneBackground(this.renderer, captureScene);
    this.scene.environmentRotation.set(0, 0, 0);
    next.texture.name = this.skyManifest ? 'polyhaven-kloofendal-daylight-pmrem' : 'analytic-daylight-pmrem';
    const previous = this._daylightPmremTarget;
    this._daylightPmremTarget = next;
    this._daylightPmremRevision = environment.daylightRevision;
    this.scene.environment = next.texture;
    previous?.dispose();
    this._recordDaylightPmremCapture(environment, now, reason);
    return true;
  }

  rebuildDaylightPmrem() {
    this._daylightPmremRevision = -1;
    this._rebuildDaylightPmrem({ force: true, reason: 'explicit', now: this._daylightPmremNow() });
  }

  // Call this at discontinuities in camera/scene state. Do not substitute zero
  // velocity for a bad history: invalidating the actual TRAA history is the only
  // correct response when there is no meaningful prior image to reproject.
  invalidateTemporalHistory(reason = 'unspecified') {
    this.motionHistory.valid = false;
    this._cameraCutState.valid = false;
    this._cameraStillFrames = 0;
    // Volumetric clouds own a separate quarter-resolution reprojection history.
    // Leaving it valid across the same cut/drag boundary preserves old opaque
    // depth silhouettes and paints canopy-shaped streaks over sky and trunks even
    // after the full-resolution TRAA target has been cleared.
    this._cloudTemporal?.reset();
    this._traa?.reset(reason);
    this._lastTemporalInvalidation = { reason, frame: this.renderer.info?.frame ?? null };
  }

  // Update the source render resolution without rebuilding the post graph. The
  // public contract is deliberately independent of device tier selection so a
  // future controller can make this decision from measured GPU timings.
  setRenderResolution(options = {}) {
    const current = this._renderResolution ?? {
      outputPixelCap: null,
      internalRenderScale: 1,
      revision: 0,
    };
    const next = normalizeRenderResolution({
      outputPixelCap: options.outputPixelCap === undefined
        ? current.outputPixelCap : options.outputPixelCap,
      internalRenderScale: options.internalRenderScale === undefined
        ? current.internalRenderScale : options.internalRenderScale,
    });
    const outputChanged = next.outputPixelCap !== current.outputPixelCap;
    const scaleChanged = next.internalRenderScale !== current.internalRenderScale;
    if (!outputChanged && !scaleChanged) return this.readRenderResolutionDiagnostics();

    this._renderResolution = {
      ...next,
      revision: (current.revision ?? 0) + 1,
    };
    if (this._scenePass) this._scenePass._resolutionScale = next.internalRenderScale;
    const cloudScaleChanged = this._cloudTemporal?.setResolutionScale?.(
      (this.weatherSky?.workload?.internalScale ?? 0.25) * next.internalRenderScale,
    ) === true;

    // A cap can change the output drawing buffer without changing CSS layout.
    // Apply it through the same viewport authority used by resize, then resize
    // only the existing MRT source target. TRAA/cloud history are invalidated,
    // not replaced by a second post graph.
    const viewportChanged = this._applyViewport(this._readViewport(), { invalidate: false });
    const sourceChanged = this._syncScenePassResolution();
    if (viewportChanged || sourceChanged || scaleChanged || cloudScaleChanged) {
      const changes = [
        outputChanged ? 'output-pixel-cap' : null,
        scaleChanged ? 'internal-render-scale' : null,
      ].filter(Boolean).join(', ');
      this.invalidateTemporalHistory(`dynamic resolution: ${changes}`);
    }
    return this.readRenderResolutionDiagnostics();
  }

  setOutputPixelCap(outputPixelCap) {
    return this.setRenderResolution({ outputPixelCap });
  }

  setInternalRenderScale(internalRenderScale) {
    return this.setRenderResolution({ internalRenderScale });
  }

  onUpdate(fn) { this._updates.push(fn); return this; }

  _pixelRatio() {
    if (!this.environmentTier) throw new Error('SceneManager pixel ratio requires a resolved environment device tier.');
    return this._outputPixelRatio(window.innerWidth, window.innerHeight);
  }

  _clampPixelRatio(value, cap) {
    return Math.min(Math.max(Number.isFinite(value) && value > 0 ? value : 1, 1), cap);
  }

  _readViewport() {
    return {
      width: Math.max(1, Math.round(window.innerWidth)),
      height: Math.max(1, Math.round(window.innerHeight)),
      pixelRatio: this._outputPixelRatio(window.innerWidth, window.innerHeight),
    };
  }

  _outputPixelRatio(width, height) {
    const state = this._renderResolution ?? { outputPixelCap: null };
    return calculateOutputPixelRatio({
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
      tierPixelRatioCap: this.environmentTier?.pixelRatioCap ?? 2,
      outputPixelCap: state.outputPixelCap,
    });
  }

  _readDrawingBufferSize() {
    if (typeof this.renderer?.getDrawingBufferSize === 'function') {
      const size = this.renderer.getDrawingBufferSize(this._drawingBufferSize ??= new Vector2());
      return {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
      };
    }
    const canvas = this.renderer?.domElement;
    if (canvas) {
      return {
        width: Math.max(1, Math.round(canvas.width || 1)),
        height: Math.max(1, Math.round(canvas.height || 1)),
      };
    }
    const viewport = this._viewportState ?? { width: 1, height: 1, pixelRatio: 1 };
    return {
      width: Math.max(1, Math.round(viewport.width * viewport.pixelRatio)),
      height: Math.max(1, Math.round(viewport.height * viewport.pixelRatio)),
    };
  }

  _syncScenePassResolution() {
    const scenePass = this._scenePass;
    if (!scenePass || typeof scenePass.setSize !== 'function') return false;
    const target = scenePass.renderTarget;
    const before = target ? [target.width, target.height] : null;
    scenePass._resolutionScale = this._renderResolution?.internalRenderScale ?? 1;
    const size = this._readDrawingBufferSize();
    scenePass.setSize(size.width, size.height);
    const after = scenePass.renderTarget ? [scenePass.renderTarget.width, scenePass.renderTarget.height] : null;
    return before?.[0] !== after?.[0] || before?.[1] !== after?.[1];
  }

  _applyViewport(viewport, { invalidate = true } = {}) {
    const previous = this._viewportState;
    if (previous && previous.width === viewport.width && previous.height === viewport.height
      && previous.pixelRatio === viewport.pixelRatio) return false;
    this._viewportState = { ...viewport };
    this._viewportRevision++;
    this.camera.aspect = viewport.width / viewport.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(viewport.pixelRatio);
    // Keep CSS owned by the fixed app layout; a renderer backing-store update
    // cannot create a clientWidth resize loop.
    this.renderer.setSize(viewport.width, viewport.height, false);
    this._syncScenePassResolution();
    if (invalidate) this.invalidateTemporalHistory('render-size change');
    return true;
  }

  readRenderResolutionDiagnostics() {
    const state = this._renderResolution ?? {
      outputPixelCap: null,
      internalRenderScale: 1,
      revision: 0,
    };
    const canvas = this.renderer?.domElement;
    const outputWidth = Math.max(1, Math.round(canvas?.width || 1));
    const outputHeight = Math.max(1, Math.round(canvas?.height || 1));
    const outputPixels = outputWidth * outputHeight;
    const sceneTarget = this._scenePass?.renderTarget ?? null;
    const sceneWidth = sceneTarget?.width ?? null;
    const sceneHeight = sceneTarget?.height ?? null;
    const expectedWidth = Math.max(1, Math.floor(outputWidth * state.internalRenderScale));
    const expectedHeight = Math.max(1, Math.floor(outputHeight * state.internalRenderScale));
    return {
      revision: state.revision,
      outputPixelCap: state.outputPixelCap,
      internalRenderScale: state.internalRenderScale,
      output: {
        width: outputWidth,
        height: outputHeight,
        pixels: outputPixels,
        pixelRatio: this._viewportState?.pixelRatio ?? null,
        capSatisfied: state.outputPixelCap === null || outputPixels <= state.outputPixelCap,
      },
      internal: {
        width: sceneWidth,
        height: sceneHeight,
        expectedWidth,
        expectedHeight,
        sourceScaleActive: sceneWidth === expectedWidth && sceneHeight === expectedHeight,
      },
      temporal: this._traa?.readDiagnostics?.() ?? null,
      cloud: this._cloudTemporal?.readDiagnostics?.() ?? null,
      temporalUpscale: {
        enabled: false,
        mode: 'dynamic-resolution-spatial-upsample',
        reason: 'Three r185 TRAA history remains source-resolution; output-resolution temporal reconstruction is not enabled.',
        presentation: 'RenderPipeline samples the resolved internal texture at output resolution.',
      },
    };
  }

  readDaylightPmremDiagnostics() {
    const current = readDaylightPmremState(this._environmentBindings);
    const change = measureDaylightPmremChange(
      this._daylightPmremLastCaptureState,
      current,
      {
        lastCaptureAt: this._daylightPmremLastCaptureAt,
        now: this._daylightPmremNow(),
      },
    );
    const finiteOrNull = (value) => Number.isFinite(value) ? value : null;
    return {
      capturedRevision: this._daylightPmremRevision,
      pendingRevision: this._environmentBindings?.daylightRevision ?? null,
      lastCaptureAt: finiteOrNull(this._daylightPmremLastCaptureAt),
      maxIntervalMs: DAYLIGHT_PMREM_MAX_INTERVAL_MS,
      sunAngleThresholdRadians: DAYLIGHT_PMREM_SUN_ANGLE_THRESHOLD_RADIANS,
      atmosphericThreshold: DAYLIGHT_PMREM_ATMOSPHERIC_THRESHOLD,
      radianceThreshold: DAYLIGHT_PMREM_RADIANCE_THRESHOLD,
      suppressedUpdates: this._daylightPmremSuppressedUpdates ?? 0,
      pending: Boolean(
        this._environmentBindings
        && this._daylightPmremRevision !== this._environmentBindings.daylightRevision,
      ),
      deltas: {
        sunAngleRadians: finiteOrNull(change.sunAngleRadians),
        atmospheric: finiteOrNull(change.atmosphericDelta),
        radiance: finiteOrNull(change.radianceDelta),
        elapsedMs: finiteOrNull(change.elapsedMs),
      },
      lastDecision: this._daylightPmremLastDecision
        ? { ...this._daylightPmremLastDecision }
        : null,
    };
  }

  readViewportDiagnostics() {
    const canvas = this.renderer.domElement;
    const targetSize = (target) => target ? [target.width, target.height] : null;
    const textureSize = (texture) => texture ? [texture.width, texture.height] : null;
    const sceneTarget = this._scenePass?.renderTarget ?? null;
    const cameraView = this.camera.view;
    return {
      revision: this._viewportRevision,
      authoritative: { ...this._viewportState },
      windowCssPx: [window.innerWidth, window.innerHeight],
      canvasClientPx: [canvas.clientWidth, canvas.clientHeight],
      canvasBackingPx: [canvas.width, canvas.height],
      inlineCssSize: [canvas.style.width, canvas.style.height],
      internalTargets: {
        scene: targetSize(sceneTarget),
        sceneColor: textureSize(sceneTarget?.texture),
        temporalHistory: targetSize(this._traa?._historyRenderTarget),
        temporalResolve: targetSize(this._traa?._resolveRenderTarget),
        bloom: targetSize(this._bloomPass?._target),
      },
      renderResolution: this.readRenderResolutionDiagnostics(),
      daylightPmrem: this.readDaylightPmremDiagnostics(),
      // TRAA deliberately changes the sub-pixel offset every frame while the
      // pipeline renders. It must be cleared before control returns here. Ignore
      // the remembered (but disabled) jitter tuple so stable-frame comparisons do
      // not mistake normal sample progression for a live camera crop/resize.
      cameraView: cameraView?.enabled ? {
        enabled: true,
        fullWidth: cameraView.fullWidth,
        fullHeight: cameraView.fullHeight,
        offsetX: cameraView.offsetX,
        offsetY: cameraView.offsetY,
        width: cameraView.width,
        height: cameraView.height,
      } : null,
    };
  }

  _showWebGpuInitError(error) {
    this._initError = error;
    console.error('WebGPU initialization failed; this build does not fall back to WebGL.', error);
    if (this.container.querySelector('.webgpu-required')) return;
    const notice = document.createElement('div');
    notice.className = 'webgpu-required';
    notice.textContent = 'WebGPU is required to run this simulator. Enable WebGPU or use a supported browser/device.';
    notice.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:24px;'
      + 'background:#111b;color:#fff;font:600 18px/1.45 system-ui;text-align:center;z-index:99999;';
    this.container.appendChild(notice);
  }

  // Acquire the sole strict WebGPU device before environment construction. The
  // backend classifies the actual hardware limits and navigator hints here; every
  // later scene system consumes that immutable workload policy before its first draw.
  initialize() {
    if (this._initializePromise) return this._initializePromise;
    this._initializePromise = this.renderer.init().then(() => {
      const tier = this.renderer.backend?.environmentTier;
      if (!tier) throw new Error('StrictWebGPUBackend did not resolve an environment device tier.');
      this.environmentTier = tier;
      this._applyViewport(this._readViewport(), { invalidate: false });
      // Range GPU classifiers run in onUpdate before the renderer's first
      // `_updateCamera()`. Initialise the camera to this backend's clip-space now
      // so frame zero uses the same near/far convention as every later frame.
      this.camera.coordinateSystem = this.renderer.coordinateSystem;
      this.camera.updateProjectionMatrix();
      this._ready = true;
      return tier;
    }).catch((error) => {
      this._showWebGpuInitError(error);
      throw error;
    });
    return this._initializePromise;
  }

  // WebGPU needs async device init before the first render. We kick it off, then
  // drive the frame loop via setAnimationLoop (which the renderer prefers).
  start() {
    this.initialize().then(() => this.resumeRendering()).catch(() => {});
    return this;
  }

  _renderFrame(now) {
    const dt = this._lastFrameTime === 0 ? 0 : Math.min((now - this._lastFrameTime) / 1000, 0.1);
    this._lastFrameTime = now;
    const simulationDt = this.freezeSimulation ? 0 : dt;
    if (!this.freezeSimulation) this._elapsed += dt;
    for (const fn of this._updates) fn(simulationDt, this._elapsed);
    // Advance one shared temporal phase per presented frame. Cloud ray jitter is
    // reprojected by the existing TRAA background input; freezing it at zero would
    // turn the volume into a static undersampled slice and defeat reconstruction.
    if (this.weatherSky) this.weatherSky.setTemporalFrame(this.weatherSky.temporalFrame + 1);
    this._beginMotionFrame();
    // A moving broadcast camera already supplies real sub-pixel sample diversity.
    // At rest, retain the bounded Halton sequence in clear and cloudy weather;
    // CloudTemporalNode captures those actual matrices for its own reprojection.
    if (this._traa) {
      this._traa.cameraJitterEnabled = !this._cameraMoving;
    }
    this.postProcessing.render();
  }

  // These controls let the benchmark capture exact, adjacent completed frames.
  // They do not select another renderer or rendering path: renderSingleFrame invokes
  // the same update/compute/post stack used by the live WebGPU animation loop.
  pauseRendering() {
    if (this._renderingPaused) return;
    // Renderer.setAnimationLoop(null) only clears the user callback; Three's private
    // rAF scheduler (and NodeFrame counter) keeps running. Stop that scheduler too so
    // a benchmark frame means exactly one NodeFrame and one GPU submission.
    this.renderer._animation.setAnimationLoop(null);
    this.renderer._animation.stop();
    this._renderingPaused = true;
  }

  renderSingleFrame(deltaSeconds = null) {
    if (!this._ready) throw new Error('Cannot render a diagnostic frame before WebGPU initialization');
    if (!this._renderingPaused) throw new Error('renderSingleFrame requires pauseRendering()');
    const now = performance.now();
    if (deltaSeconds !== null) {
      const fixedDelta = Number(deltaSeconds);
      if (!Number.isFinite(fixedDelta) || fixedDelta < 0 || fixedDelta > 0.1) {
        throw new RangeError('renderSingleFrame deltaSeconds must be between 0 and 0.1 seconds.');
      }
      // Offline capture advances the same production update/render graph on an
      // exact editorial timebase. Wall-clock screenshot and encode latency must
      // never leak into physics, wind, camera damping, or temporal sampling.
      this._lastFrameTime = now - fixedDelta * 1000;
    }
    if (this.renderer.info.autoReset === true) this.renderer.info.reset();
    this.renderer._nodes.nodeFrame.update();
    this.renderer.info.frame = this.renderer._nodes.nodeFrame.frameId;
    this.renderer._inspector.begin();
    try {
      this._renderFrame(now);
    } finally {
      this.renderer._inspector.finish();
    }
  }

  resumeRendering() {
    this._lastFrameTime = performance.now();
    if (this._renderingPaused) {
      this.renderer._animation.setAnimationLoop(this._animationFrame);
      this.renderer._animation.start();
      this._renderingPaused = false;
    } else {
      this.renderer.setAnimationLoop(this._animationFrame);
    }
  }

  _onResize() {
    if (!this.environmentTier) return;
    this._applyViewport(this._readViewport());
  }

  _beginMotionFrame() {
    const h = this.motionHistory;
    this.camera.updateMatrixWorld();
    const cut = this._cameraCutState;
    this._cameraMoving = false;
    if (cut.valid) {
      const positionDelta = cut.position.distanceTo(this.camera.position);
      const rotationDelta = cut.quaternion.angleTo(this.camera.quaternion);
      const positionJump = positionDelta > 8;
      const rotationJump = rotationDelta > Math.PI * 25 / 180;
      const delayedTransition = this._cameraStillFrames >= 3
        && (positionDelta > 1.25 || rotationDelta > Math.PI * 8 / 180);
      let projectionJump = false;
      const previousProjection = cut.projection.elements;
      const currentProjection = this.camera.projectionMatrix.elements;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(previousProjection[i] - currentProjection[i]) > 1e-3) {
          projectionJump = true;
          break;
        }
      }
      // Use a much tighter threshold than camera-cut detection. This flag controls
      // only projection jitter, so even a slow result orbit should retain an exact
      // lens while it moves. The epsilon rejects matrix noise on a static camera.
      this._cameraMoving = positionDelta > 1e-5 || rotationDelta > 1e-6 || projectionJump;
      if (positionJump || rotationJump || projectionJump || delayedTransition) {
        this.invalidateTemporalHistory('automatic camera discontinuity');
      }
      if (positionDelta < 0.02 && rotationDelta < Math.PI / 720) this._cameraStillFrames++;
      else this._cameraStillFrames = 0;
    }
    cut.position.copy(this.camera.position);
    cut.quaternion.copy(this.camera.quaternion);
    cut.projection.copy(this.camera.projectionMatrix);
    cut.valid = true;

    if (h.valid) {
      h.previousProjection.value.copy(h.currentProjection.value);
      h.previousView.value.copy(h.currentView.value);
    }
    h.currentProjection.value.copy(this.camera.projectionMatrix);
    h.currentView.value.copy(this.camera.matrixWorldInverse);
    if (!h.valid) {
      h.previousProjection.value.copy(h.currentProjection.value);
      h.previousView.value.copy(h.currentView.value);
      h.valid = true;
    }
  }
}
