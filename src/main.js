import { Vector3 } from 'three';
import { SceneManager } from './scene/SceneManager.js';
import { Lighting } from './scene/Lighting.js';
import { Range } from './scene/Range.js';
import { Tracer } from './scene/Tracer.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { FreeCamera } from './camera/FreeCamera.js';
import { MetricsPanel } from './ui/MetricsPanel.js';
import { BuilderPanel } from './ui/BuilderPanel.js';
import { Menu } from './ui/Menu.js';
import { Ball } from './physics/Ball.js';
import { makeEnv } from './physics/ballistics.js';
import { airDensity } from './physics/constants.js';
import { loadCourse } from './course/course.js';
import { MPH_TO_MS, DEG_TO_RAD, mph as toMph, M_TO_YARD } from './util/units.js';

// Low, warm late-afternoon sun from the SIDE (slightly in front) so its long
// shadows rake ACROSS the frame toward the camera — not hidden behind objects.
const SUN = new Vector3(-0.82, 0.4, -0.12).normalize();

const app = document.getElementById('app');
const sm = new SceneManager(app);
const lighting = new Lighting(sm.scene, SUN);

// Image-based lighting + sky from a real HDRI (async; scene renders meanwhile).
sm.loadEnvironment('/assets/hdri/sky.hdr').catch((e) => console.warn('HDRI load failed', e));

const tracer = new Tracer(sm.scene);
const director = new CameraDirector(sm.camera);

// Physics env is rebuilt on each shot from the current conditions.
let env = makeEnv();

// `range` and `ball` are (re)created every time the course spec changes — the
// prompt-driven builder edits course.json, and the whole course is rebuilt from it.
// Kept as `let` so every closure below sees the current instance after a rebuild.
let range = null;
let ball = null;
let freeCam = null;
let flying = false;
let _resetTimer = null;

const panel = new MetricsPanel({ onHit: hit });

// Attach the physics event handlers to a (freshly built) ball.
function wireBall(b) {
  b.on('rest', (r) => {
    flying = false;
    director.onRest(b);
    panel.showResult(r);
    panel.setLive('');
    // Driving range: after a beat on the result, glide the ball back to the tee for
    // the next shot (so you hit from the mat every time). Skipped if a new shot is
    // already in the air, the free-fly cam is active, or we've left the range view.
    clearTimeout(_resetTimer);
    _resetTimer = setTimeout(() => {
      if (!flying && !freeCam?.active && shell.view === 'practice') toAddress();
    }, 2500);
  });
  b.on('hazard', () => panel.setLive('— in the water —'));
}

// Address framing looking down the target line (-Z).
function toAddress() {
  ball.placeAt(0, 2);
  range.ballMesh.position.copy(ball.position);
  director.setAddress(ball.position, new Vector3(0, 0, -1));
  tracer.reset();
  panel.setLive('');
}

// Build (or rebuild) the entire course from a normalized spec. Disposes the old
// course first so repeated agent rebuilds don't leak GPU resources. The terrain is
// baked from the spec's FEATURES — this is the only path course data takes into the
// scene, so there is no terrain-editing surface to expose.
function buildCourse(course) {
  if (range) range.dispose();
  flying = false;
  range = new Range(sm.scene, sm.camera, course);
  ball = new Ball(range.terrain, env);
  wireBall(ball);
  // Free-fly cam persists across rebuilds (keeps its listeners); just re-point its
  // terrain reference at the new course. Created lazily on the first build.
  if (!freeCam) freeCam = new FreeCamera(sm.camera, sm.renderer.domElement, range.terrain);
  else freeCam.terrain = range.terrain;
  divotPrepopDone = false;   // new terrain → re-stamp the used-tee divots once the renderer is live
  toAddress();
}
let divotPrepopDone = false;

buildCourse(await loadCourse());

function hit() {
  if (flying || !ball) return;
  clearTimeout(_resetTimer);            // a new shot cancels any pending auto-reset
  const params = panel.getParams();
  const conditions = panel.getEnv();

  // Rebuild the environment from the conditions panel.
  const rho = airDensity({ altitude: conditions.altitude, temperatureC: conditions.temperatureC });
  const wind = windVector(conditions.windSpeed, conditions.windDir);
  env.rho = rho;
  env.wind.copy(wind);

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
    const jx = (Math.random() - 0.5) * 0.7;
    const jz = (Math.random() - 0.5) * 0.7;
    range.terrain.stampDivot(sm.renderer, ball.start.x + jx, ball.start.z - 0.3 + jz,
      0.022, a, 0.08 + Math.random() * 0.14, 4.0 + Math.random() * 1.5, Math.random() * 20);
  }
}

// Wind: windDir in degrees, 0 = helping (blows down range toward -Z),
// increasing clockwise (90 = left-to-right across the shot).
function windVector(speedMph, dirDeg) {
  const v = speedMph * MPH_TO_MS;
  const a = dirDeg * DEG_TO_RAD;
  // Rotate the down-range helping vector (-Z) clockwise about Y.
  return new Vector3(Math.sin(a) * v, 0, -Math.cos(a) * v);
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

// Live course thumbnail for the Play card — a real render of the actual geometry
// (not a fake image). A tiny state machine drives the render loop: one frame poses
// an elevated overview camera, the next frame grabs the (now overview) canvas into a
// downscaled JPEG. The swap is a single frame, hidden behind the blurred menu/play
// overlay, so it's imperceptible.
let _thumbCountdown = 0;
function requestThumb() { if (_thumbCountdown === 0) _thumbCountdown = 4; }
function thumbFraming() {
  sm.camera.position.set(34, 84, 40);
  sm.camera.up.set(0, 1, 0);
  sm.camera.lookAt(0, 2, -150);
}
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
    buildCourse(await loadCourse());
    builder.onCourseReloaded(range.course);
    setTimeout(requestThumb, 400);   // refresh the Play thumbnail to the new course
  });
}

// On-screen FPS / frame-time meter (toggle with `). Uses real wall-clock time —
// the physics dt is clamped to 0.1s, so it would floor the reading at 10fps and
// lie. On by default while we tune performance.
const fpsEl = document.createElement('div');
fpsEl.id = 'gs-fps';
// Flows inside the top-right stack (created by the Menu shell) so it never overlaps.
fpsEl.style.cssText = 'font:600 12px/1.3 ui-monospace,SFMono-Regular,monospace;color:#cfe9d0;'
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
    if (sm.bypassPost) off.push('post');
    const tag = off.length ? `  [${off.join(' ')} off]` : '';
    fpsEl.textContent = `${(_fpsN / _fpsAcc).toFixed(0)} fps · ${(1000 * _fpsAcc / _fpsN).toFixed(1)} ms${tag}`;
    _fpsAcc = 0; _fpsN = 0;
  }
}

// Main update.
sm.onUpdate((dt, t) => {
  // Thumbnail grab: pose an overview camera for a few frames (below), then capture
  // the (now settled) canvas at the end of the countdown.
  if (_thumbCountdown > 0) { _thumbCountdown--; if (_thumbCountdown === 0) thumbCapture(); }
  updateFpsMeter();
  range.update(t);
  // Stamp the "used tee" divots on the GPU once the WebGPU backend is live (the
  // update loop only runs after renderer.init, so it's safe here).
  if (!divotPrepopDone && range) { range.terrain.prepopulateDivots(sm.renderer); divotPrepopDone = true; }

  if (flying) {
    ball.update(dt);
    range.ballMesh.position.copy(ball.position);
    // Feed the tracer from the ball's own sampled trail.
    while (tracer.count < ball.trail.length) tracer.push(ball.trail[tracer.count]);

    const speed = ball.velocity.length();
    const dist = Math.hypot(ball.position.x - ball.start.x, ball.position.z - ball.start.z) * M_TO_YARD;
    const height = (ball.position.y - ball.start.y) * 3.28084;
    panel.setLive(`${dist.toFixed(0)} yds   ·   ${height.toFixed(0)} ft   ·   ${toMph(speed).toFixed(0)} mph`);

    lighting.follow(ball.position.x, ball.position.z);
  } else {
    tracer.fade(dt);
  }

  // Hold the overview pose through the whole thumbnail countdown (takes priority).
  if (_thumbCountdown > 0) thumbFraming();
  // Menu view: slow cinematic orbit behind the overlay. In-scene views use the
  // free-fly cam when active, else the cinematic shot director.
  else if (shell.view === 'menu') menuCinematic(dt);
  else if (freeCam.active) freeCam.update(dt);
  else director.update(dt, ball);
});

sm.start();

// Prime the Play card with a real render once the scene (incl. trees) has settled.
setTimeout(requestThumb, 2600);

// Controls.
window.addEventListener('keydown', (e) => {
  // Don't steal keys while typing into the builder prompt.
  if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
  // Gameplay keys only apply inside the range/creator views (not on the menu).
  if (shell.view !== 'practice' && shell.view !== 'creator') return;
  // While free-roaming, Space is "rise" (handled by FreeCamera) — don't hit.
  if (e.code === 'Space') { e.preventDefault(); if (!freeCam.active) hit(); }
  if (e.code === 'KeyF') freeCam.toggle();
  if (e.code === 'KeyR') { if (freeCam.active) freeCam.exit(); if (!flying) toAddress(); }
  if (e.code === 'Backquote') fpsEl.style.display = fpsEl.style.display === 'none' ? '' : 'none';
  // Perf diagnostics — toggle a subsystem and watch the meter to find the cost.
  if (e.code === 'Digit1' && range.grass) range.grass.mesh.visible = !range.grass.mesh.visible;
  if (e.code === 'Digit2' && range.trees) range.trees.visible = !range.trees.visible;
  if (e.code === 'Digit3') sm.bypassPost = !sm.bypassPost;
});

// Dismiss the loading veil once the first frame is up.
requestAnimationFrame(() => {
  const l = document.getElementById('loading');
  if (l) l.classList.add('hidden');
});

// Expose a few handles for tinkering in the console (getters so they track rebuilds).
window.golf = {
  get ball() { return ball; },
  get range() { return range; },
  get freeCam() { return freeCam; },
  director, panel, sm, builder, shell,
  refreshThumb: requestThumb,
  rebuild: async () => { buildCourse(await loadCourse()); },
};
