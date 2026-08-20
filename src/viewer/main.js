import { Box3, Vector3 } from 'three';
import { SceneManager } from '../scene/SceneManager.js';
import { Lighting } from '../scene/Lighting.js';
import { FreeCamera } from '../camera/FreeCamera.js';
import { EvaluatorCamera } from '../camera/EvaluatorCamera.js';
import { TurfPanel } from '../ui/TurfPanel.js';
import { ASSETS } from './assets.js';
import {
  ENVIRONMENT_FRAME_STATE_VERSION, ENVIRONMENT_WIND_ALGORITHM_VERSION,
  EnvironmentFrameState,
} from '../environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../environment/EnvironmentGpuBindings.js';
import { disposeWebGPUGeometries, disposeMaterialTextures } from '../scene/WebGPUResourceDisposal.js';

// Viewer asset ownership is intentionally explicit here because viewer builders are
// production objects, not a second renderer path. Terrain owns its node textures;
// Grass, TreeBeautyLod, and WaterSurface own their own compute/material resources;
// the remaining roots in `objects` are ordinary viewer-owned Three objects. A
// builder may provide `asset.dispose()` as a complete replacement contract, but the
// existing registry uses the four named subsystems below.
const VIEWER_SUBSYSTEMS = ['grass', 'treeBeauty', 'water', 'terrain'];
const disposedViewerAssets = new WeakSet();

function viewerSubsystemRoot(subsystem) {
  return subsystem?.mesh || subsystem?.group || null;
}

function isDescendantOf(node, roots) {
  for (let cursor = node; cursor; cursor = cursor.parent) {
    if (roots.has(cursor)) return true;
  }
  return false;
}

function disposeViewerObjectResources(renderer, objects, subsystemRoots) {
  const geometries = [];
  const materials = [];
  const visit = (object) => {
    // These subsystem roots release their own geometry/material/compute resources.
    // Terrain is deliberately not in subsystemRoots: Terrain.dispose owns its
    // textures, while its clipmap group's geometry/materials are released here.
    if (isDescendantOf(object, subsystemRoots)) return;
    if (object.geometry) geometries.push(object.geometry);
    if (Array.isArray(object.material)) materials.push(...object.material);
    else if (object.material) materials.push(object.material);
    for (const child of object.children || []) visit(child);
  };
  for (const object of objects || []) visit(object);
  disposeWebGPUGeometries(renderer, geometries);
  disposeMaterialTextures(materials);
}

export function disposeViewerAsset(asset, {
  scene = null,
  renderer = null,
  disposeObjects = (objects, roots) => disposeViewerObjectResources(renderer, objects, roots),
} = {}) {
  if (!asset || disposedViewerAssets.has(asset)) return false;
  disposedViewerAssets.add(asset);

  for (const object of asset.objects || []) scene?.remove(object);

  // A custom disposer is a complete ownership contract. This lets a future viewer
  // builder clean up private resources without teaching this file its internals.
  if (typeof asset.dispose === 'function') {
    asset.dispose();
    return true;
  }

  const subsystems = [];
  const subsystemRoots = new Set();
  for (const name of VIEWER_SUBSYSTEMS) {
    const subsystem = asset[name];
    if (typeof subsystem?.dispose === 'function') subsystems.push(subsystem);
    const root = viewerSubsystemRoot(subsystem);
    if (root && name !== 'terrain') subsystemRoots.add(root);
  }

  // Release generic object resources once. The root check also handles an object
  // listed twice, or a group containing a subsystem-owned mesh.
  disposeObjects(asset.objects || [], subsystemRoots);
  for (const subsystem of new Set(subsystems)) subsystem.dispose();
  return true;
}

// Build first, then commit. `commit` is synchronous so a second selection cannot
// interleave halfway through attachment; every async completion checks its token.
export function createViewerAssetSwitcher({
  scene = null,
  renderer = null,
  build,
  commit = () => {},
  disposeObjects,
} = {}) {
  if (typeof build !== 'function') throw new TypeError('Viewer asset switcher requires a build function.');
  let current = null;
  let generation = 0;
  const dispose = (asset) => disposeViewerAsset(asset, { scene, renderer, disposeObjects });

  async function load(name) {
    const token = ++generation;
    let next = null;
    try {
      next = await build(name, token);
      await next?.terrain?.assetsReady;
      if (token !== generation) {
        dispose(next);
        return null;
      }

      const previous = current;
      try {
        commit(next, previous, name);
      } catch (error) {
        dispose(next);
        throw error;
      }
      current = next;
      if (previous && previous !== next) dispose(previous);
      return next;
    } catch (error) {
      // A stale rejection must not replace the current error or leak a partially
      // built asset. The active selection still surfaces its original failure.
      if (next && next !== current) dispose(next);
      if (token !== generation) return null;
      throw error;
    }
  }

  function disposeCurrent() {
    generation++;
    if (!current) return;
    dispose(current);
    current = null;
  }

  return {
    load,
    disposeCurrent,
    dispose,
    get current() { return current; },
  };
}

// Isolated asset viewer (viewer.html) — open one asset at a time in its own window
// and iterate on it without the whole course in the way.
//
// It deliberately reuses the PRODUCTION SceneManager and Lighting rather than a
// simplified preview rig. Turf, sand and the ball are all judged almost entirely by
// how they respond to light, so a viewer with its own lighting would have you tuning
// against something you'll never ship. Same sun, atmosphere, tone-map, same post
// chain — the only difference is what's in the scene.
//
// Pick an asset from the dropdown or by URL: viewer.html?asset=ball

const SUN = new Vector3(-0.62, 0.74, -0.22).normalize();

const app = document.getElementById('app');
const errEl = document.getElementById('err');
const sm = new SceneManager(app);
await sm.initialize();
const lighting = new Lighting(sm.scene, SUN, sm.environmentTier);
const sunAzimuth = (Math.atan2(SUN.x, SUN.z) + Math.PI * 2) % (Math.PI * 2);
const environmentState = new EnvironmentFrameState({
  version: ENVIRONMENT_FRAME_STATE_VERSION,
  algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
  seed: 0x51a7e5d,
  tickSeconds: 1 / 120,
  sun: {
    azimuthRadians: sunAzimuth,
    elevationRadians: Math.asin(SUN.y),
    intensity: 85000,
      color: { r: 1.0, g: 0.965, b: 0.90 },
  },
  atmosphere: { turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005, mieDirectionalG: 0.76, exposure: 1.0 },
  clouds: { coverage: 0.40, density: 0.52, baseHeight: 900, thickness: 1500, advectionScale: 1.0 },
  wind: {
    speed: 2.2,
    directionRadians: 0.4,
    referenceHeight: 10,
    shearExponent: 0.18,
    gustStrength: 0.28,
    turbulenceStrength: 0.26,
    gustSpatialFrequency: 0.035,
    gustTemporalFrequency: 0.27,
  },
});
const environment = new EnvironmentGpuBindings(environmentState);
sm.configureWeather(environment);

const turfPanel = new TurfPanel();
let current = null;      // { terrain, objects[], grass, focus }
let freeCam = null;
const evaluatorCamera = new EvaluatorCamera({ camera: sm.camera, sceneManager: sm });

function showError(msg) {
  errEl.textContent = msg;
  errEl.style.display = msg ? 'block' : 'none';
}

// Point the camera at a given world position/target. Split out of frame() because an
// offline shot (scripts/shot.mjs) has to be able to reproduce an exact viewpoint —
// "the ground looked black" is only actionable if the next run stands in the same place.
// Coordinates are RELATIVE to the asset's focus point, so one camera spec means the
// same thing whatever patch an asset builds.
function setCamera(offset, lookAt = [0, 0.1, 0]) {
  if (!current) return;
  const { focus, terrain } = current;
  const gy = terrain.heightAt(focus.x, focus.z);
  if (!evaluatorCamera.owned) evaluatorCamera.enter();
  evaluatorCamera.setPose({
    position: [focus.x + offset[0], gy + offset[1], focus.z + offset[2]],
    lookAt: [focus.x + lookAt[0], gy + lookAt[1], focus.z + lookAt[2]],
  });
}

// Park the camera so the subject fills the frame. Three modes:
//
// closeUp (the ball) — a macro distance in centimetres. An automatic fit would park
// the camera inside the near plane of a 4 cm object.
//
// standingView (turf) — a standing eye height, because play distance IS the distance
// you judge turf from. Fitting a 44 m ground plane to the frame would stand you 50 m
// away and turn the blades into sub-pixel noise.
//
// otherwise — a generic fit: bound the subject's world bbox (everything in `objects`
// except the context terrain/grass) and step back on the +Z axis until it fills the
// frame with headroom. The eye rises to the subject's mid-height for tall subjects
// (trees) and clamps above the ground under the camera, so any new asset gets a sane
// first view without a hand-tuned pose.
function autoFrame() {
  const { focus, terrain } = current;
  const gy = terrain.heightAt(focus.x, focus.z);
  let center, size;
  if (current.frameBounds) {
    // GPU-placed subjects (TreeBeauty) carry their placement in buffers, not node
    // transforms; the builder publishes the authoritative world bounds instead.
    center = new Vector3(...current.frameBounds.center);
    size = new Vector3(...current.frameBounds.size);
  } else {
    // Positions were set at build time; matrixWorld is not composed until a render,
    // and commit() frames the camera before the next one.
    sm.scene.updateMatrixWorld(true);
    const box = new Box3();
    const context = new Set([terrain.mesh, current.grass?.mesh]);
    for (const object of current.objects) {
      if (context.has(object)) continue;
      box.expandByObject(object);
    }
    if (box.isEmpty()) return null;
    center = box.getCenter(new Vector3());
    size = box.getSize(new Vector3());
  }
  const fovV = sm.camera.fov * Math.PI / 180;
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * sm.camera.aspect);
  const MARGIN = 1.25;    // headroom so the subject never touches the frame edges
  const halfH = (size.y * MARGIN) / 2;
  const halfW = (Math.max(size.x, size.z) * MARGIN) / 2;
  const targetY = current.focusY ?? center.y;
  // Stand at eye height, or rise to the subject's mid-height when it towers over it
  // — a 19 m fir seen from 1.6 m is a trunk; seen from 9.5 m it is a tree.
  const eyeY = Math.max(center.y, gy + 1.6);
  const distance = Math.max(
    halfH / Math.tan(fovV / 2),
    halfW / Math.tan(fovH / 2),
    (Math.max(0, eyeY - targetY) + halfH) / Math.tan(fovV / 2),
    4,  // never closer than this
  );
  const camZ = center.z + distance;
  const camY = Math.max(eyeY, terrain.heightAt(center.x, camZ) + 0.5);
  return { position: [center.x, camY, camZ], lookAt: [center.x, targetY, center.z] };
}

function frame() {
  if (!current || !freeCam) return;
  const { focus, terrain } = current;
  const gy = terrain.heightAt(focus.x, focus.z);
  let pose;
  if (current.closeUp) {
    pose = { position: [focus.x + 0.02, gy + 0.045, focus.z + 0.30], lookAt: [focus.x, gy + 0.02, focus.z] };
  } else if (current.standingView) {
    pose = { position: [focus.x + 1.5, gy + 1.6, focus.z + 9], lookAt: [focus.x, current.focusY ?? gy + 0.1, focus.z] };
  } else {
    // Fall back to the standing pose if the asset exposes no fit-able subject.
    pose = autoFrame() ?? { position: [focus.x + 1.5, gy + 1.6, focus.z + 9], lookAt: [focus.x, gy + 0.1, focus.z] };
  }
  if (!evaluatorCamera.owned) evaluatorCamera.enter();
  evaluatorCamera.setPose(pose);
}

const assetSwitcher = createViewerAssetSwitcher({
  scene: sm.scene,
  renderer: sm.renderer,
  build: (name) => ASSETS[name]({
      camera: sm.camera,
      renderer: sm.renderer,
      motionHistory: sm.motionHistory,
      environmentTier: sm.environmentTier,
      environment,
  }),
  commit: (built, previous, name) => {
    for (const o of built.objects || []) sm.scene.add(o);

    // Keep the old asset available until every step below succeeds. If a camera or
    // panel operation fails, the switcher's rollback disposes only `built`.
    const oldCurrent = current;
    try {
      current = built;

      // FreeCamera holds a terrain reference for its ground clamp; re-point it at the
      // patch we just built (each asset gets its own terrain).
      if (!freeCam) freeCam = new FreeCamera(sm.camera, sm.renderer.domElement, built.terrain);
      else freeCam.terrain = built.terrain;
      if (!freeCam.active) freeCam.toggle();

      turfPanel.attach(built.terrain);
      if (built.terrain) built.terrain.uSunDir.value.copy(SUN);
      // Re-centre the shadow frustum on the patch, exactly as main.js does on the ball.
      // Without this the frustum stays at the world origin while the patch sits 600 m away
      // in X (see PATCH_X in assets.js) — and because the sun points mostly down -X, that
      // offset lands almost entirely on the shadow camera's DEPTH axis, not its lateral
      // one. So the patch was not outside the frustum (which would have been harmless, and
      // reads as fully lit); it was inside it, at the far end of a 695 m deep range where
      // depth precision is worst. The result was shadow acne in huge blocks with a hard
      // straight edge where the patch finally crossed the far plane and popped back to lit
      // — which looked like the grass going dark in patches.
      lighting.follow(built.focus.x, built.focus.z);
      // ?cam=dx,dy,dz[&look=dx,dy,dz] overrides the automatic framing — see setCamera.
      const q = new URL(window.location).searchParams;
      const nums = (s) => s?.split(',').map(Number).filter((n) => Number.isFinite(n));
      const cam = nums(q.get('cam'));
      if (cam?.length === 3) setCamera(cam, nums(q.get('look'))?.length === 3 ? nums(q.get('look')) : undefined);
      else frame();
      if (built.note) showError(built.note);
      // Keep the dropdown, the URL and the scene in agreement — load() is callable from
      // the console too, and a stale dropdown makes you doubt what you're looking at.
      const url = new URL(window.location);
      url.searchParams.set('asset', name);
      history.replaceState(null, '', url);
      if (select.value !== name) select.value = name;
    } catch (error) {
      current = oldCurrent;
      throw error;
    }
  },
});

function disposeCurrent() {
  assetSwitcher.disposeCurrent();
  current = assetSwitcher.current;
}

async function load(name) {
  showError('');
  try {
    const built = await assetSwitcher.load(name);
    current = assetSwitcher.current;
    return built;
  } catch (e) {
    console.error(e);
    showError(`Could not build "${name}": ${e.message}`);
    throw e;
  }
}

const select = document.getElementById('asset');
for (const name of Object.keys(ASSETS)) {
  const o = document.createElement('option');
  o.value = o.textContent = name;
  select.appendChild(o);
}
select.addEventListener('change', () => load(select.value).catch(() => {}));

const wanted = new URL(window.location).searchParams.get('asset');
const initial = (wanted && ASSETS[wanted]) ? wanted : Object.keys(ASSETS)[0];
select.value = initial;

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) frame();
});

let frames = 0;
let environmentTickRemainder = 0;
sm.onUpdate((dt, t) => {
  environmentTickRemainder += Math.min(dt, 0.25);
  const tickSeconds = environmentState.config.tickSeconds;
  const ticks = Math.floor(environmentTickRemainder / tickSeconds);
  if (ticks > 0) {
    environmentState.advanceFixedTicks(ticks);
    environment.update(environmentState);
    environmentTickRemainder -= ticks * tickSeconds;
  }
  frames++;
  if (evaluatorCamera.owned) evaluatorCamera.update();
  else if (freeCam?.active) freeCam.update(dt);
  current?.terrain?.update(sm.camera);
  current?.grass?.update(t, sm.camera);
  current?.treeBeauty?.update(sm.camera);
  evaluatorCamera.notifyFrame(sm.renderer.info.frame);
});
try {
  await load(initial);
  sm.start();
} catch (error) {
  showError(`Required viewer environment failed: ${error.message}`);
}

// Console handles, same spirit as window.golf in the main app.
// `frames` is a monotonic render count — an offline shot has to be able to wait for
// "N frames have actually been drawn", which is the only reliable readiness signal when
// TRAA needs a few frames to converge before the image is worth capturing.
window.viewer = {
  sm, get current() { return current; }, get freeCam() { return freeCam; },
  evaluatorCamera, turfPanel, load, frame, setCamera,
  // Plain JSON-safe estimate for scripts that do not await GPU readback.
  treeDiagnostics: () => current?.treeBeauty?.residencyEstimate(sm.camera) ?? null,
  treeDiagnosticsGpu: () => current?.treeBeauty?.readDiagnostics() ?? null,
  get frames() { return frames; },
};
