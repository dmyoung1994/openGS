import { Vector3 } from 'three';
import { SceneManager } from './scene/SceneManager.js';
import { Lighting } from './scene/Lighting.js';
import { Range } from './scene/Range.js';
import { Tracer } from './scene/Tracer.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { MetricsPanel } from './ui/MetricsPanel.js';
import { Ball } from './physics/Ball.js';
import { makeEnv } from './physics/ballistics.js';
import { airDensity } from './physics/constants.js';
import { MPH_TO_MS, DEG_TO_RAD, mph as toMph, M_TO_YARD } from './util/units.js';

// Low, warm late-afternoon sun -> long raking shadows and terrain modeling.
const SUN = new Vector3(-0.62, 0.4, 0.3).normalize();

const app = document.getElementById('app');
const sm = new SceneManager(app);
const lighting = new Lighting(sm.scene, SUN);

// Image-based lighting + sky from a real HDRI (async; scene renders meanwhile).
sm.loadEnvironment('/assets/hdri/sky.hdr').catch((e) => console.warn('HDRI load failed', e));

const range = new Range(sm.scene, sm.camera);
const tracer = new Tracer(sm.scene);
const director = new CameraDirector(sm.camera);

// Physics env is rebuilt on each shot from the current conditions.
let env = makeEnv();

const ball = new Ball(range.terrain, env);
ball.placeAt(0, 2);
range.ballMesh.position.copy(ball.position);

const panel = new MetricsPanel({ onHit: hit });

// Address framing looking down the target line (-Z).
function toAddress() {
  ball.placeAt(0, 2);
  range.ballMesh.position.copy(ball.position);
  director.setAddress(ball.position, new Vector3(0, 0, -1));
  tracer.reset();
  panel.setLive('');
}
toAddress();

let flying = false;

function hit() {
  if (flying) return;
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
}

// Wind: windDir in degrees, 0 = helping (blows down range toward -Z),
// increasing clockwise (90 = left-to-right across the shot).
function windVector(speedMph, dirDeg) {
  const v = speedMph * MPH_TO_MS;
  const a = dirDeg * DEG_TO_RAD;
  // Rotate the down-range helping vector (-Z) clockwise about Y.
  return new Vector3(Math.sin(a) * v, 0, -Math.cos(a) * v);
}

ball.on('rest', (r) => {
  flying = false;
  director.onRest(ball);
  panel.showResult(r);
  panel.setLive('');
});

ball.on('hazard', () => panel.setLive('— in the water —'));

// Main update.
sm.onUpdate((dt, t) => {
  range.update(t);

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

  director.update(dt, ball);
});

sm.start();

// Controls.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); hit(); }
  if (e.code === 'KeyR' && !flying) toAddress();
});

// Dismiss the loading veil once the first frame is up.
requestAnimationFrame(() => {
  const l = document.getElementById('loading');
  if (l) l.classList.add('hidden');
});

// Expose a few handles for tinkering in the console.
window.golf = { ball, range, director, panel, sm };
