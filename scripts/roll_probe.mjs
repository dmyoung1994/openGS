// Headless ground-interaction probe. Builds a minimal terrain stub, launches
// representative shots over each surface (plus sloped fairway), runs each to
// rest, and prints carry vs total roll-out, bounce count, and final state.
//
// Run:  node scripts/link-three.js && node scripts/roll_probe.mjs
import { Vector3 } from 'three';
import { Ball } from '../src/physics/Ball.js';
import { makeEnv } from '../src/physics/ballistics.js';
import { airDensity } from '../src/physics/constants.js';
import { M_TO_YARD, RADS_TO_RPM } from '../src/util/units.js';

// ---- terrain stub -----------------------------------------------------------
// Height field y = gradX*x + gradZ*z. Ball travels down range in -Z, so a
// positive gradZ means the ground DROPS as the ball moves down range = downhill.
function makeTerrain(surfaceName, { gradX = 0, gradZ = 0 } = {}) {
  const n = new Vector3(-gradX, 1, -gradZ).normalize();
  return {
    heightAt: (x, z) => gradX * x + gradZ * z,
    normalAt: () => n.clone(),
    surfaceAt: () => surfaceName,
  };
}

// ---- shot library (representative tour launch conditions) -------------------
const SHOTS = {
  driver:  { ballSpeed: 167, launchAngle: 11.5, spinRate: 2600, spinAxis: 0 },
  sevenIron: { ballSpeed: 120, launchAngle: 17.5, spinRate: 7000, spinAxis: 0 },
  wedge:   { ballSpeed: 92,  launchAngle: 29,   spinRate: 9600, spinAxis: 0 },
};

const stillWind = (_position, _time, out) => out.set(0, 0, 0);

function environment(groundFirmness = 'medium') {
  return makeEnv({
    rho: airDensity({ altitude: 0, temperatureC: 15 }),
    sampleWind: stillWind,
    groundFirmness,
  });
}

function runShot(shotName, surfaceName, slope = {}, groundFirmness = 'medium') {
  const terrain = makeTerrain(surfaceName, slope);
  const ball = new Ball(terrain, environment(groundFirmness));
  let bounces = 0;
  let carryYards = 0;
  let descentDeg = 0;
  let landSurface = surfaceName;
  const bounceSpeeds = [];
  ball.on('carry', (p) => { carryYards = p.yards; descentDeg = p.descentDeg; });
  ball.on('bounce', (p) => { bounces++; bounceSpeeds.push(p.speed); });

  ball.placeAt(0, 0);
  ball.launch(SHOTS[shotName]);

  let t = 0;
  const maxT = 45;
  let rollEntry = 0;
  let rollEntryRpm = 0;
  let prevState = ball.state;
  let maxBack = 0; // most negative down-range progress after landing (spin-back)
  let landedZ = null;
  while (ball.state !== 'rest' && t < maxT) {
    ball.update(1 / 240);
    if (prevState !== 'rolling' && ball.state === 'rolling') {
      rollEntry = ball.velocity.length();
      rollEntryRpm = ball.spin.omega * RADS_TO_RPM;
    }
    if (ball._grounded) {
      if (landedZ === null) landedZ = ball.position.z;
      // progress down range is -Z; spin-back means z increases past landing z
      const back = (ball.position.z - landedZ);
      if (back > maxBack) maxBack = back;
    }
    prevState = ball.state;
    t += 1 / 240;
  }
  const totalYards = ball.totalYards || (ball._groundDist() * M_TO_YARD);
  const rollout = totalYards - carryYards;
  return {
    shotName, surfaceName,
    carry: carryYards,
    total: totalYards,
    rollout,
    bounces,
    descentDeg,
    finalState: ball.state,
    firstBounceSpeed: bounceSpeeds[0] || 0,
    rollEntry,
    rollEntryRpm,
    spinBackYd: maxBack * M_TO_YARD,
    offline: (ball.position.x - ball.start.x) * M_TO_YARD,
  };
}

function fmt(v, d = 1) { return v.toFixed(d).padStart(7); }

function line(r) {
  return [
    r.shotName.padEnd(10),
    r.surfaceName.padEnd(12),
    'carry', fmt(r.carry), 'yd',
    'roll', fmt(r.rollout), 'yd',
    'total', fmt(r.total), 'yd',
    'bounces', String(r.bounces).padStart(2),
    'desc', fmt(r.descentDeg, 0) + 'd',
    'entry', fmt(r.rollEntry) + 'm/s',
    'spin', fmt(r.rollEntryRpm,0) + 'rpm',
    'zip', fmt(r.spinBackYd) + 'yd',
  ].join(' ');
}

const cases = [
  ['driver', 'fairway'],
  ['driver', 'rough'],
  ['driver', 'green'],
  ['sevenIron', 'green'],
  ['sevenIron', 'fairway'],
  ['sevenIron', 'rough'],
  ['wedge', 'green'],
  ['wedge', 'fairway'],
  ['wedge', 'rough'],
  ['sevenIron', 'sand'],
  ['wedge', 'sand'],
  ['driver', 'sand'],
];

console.log('=== FLAT ===');
for (const [shot, surf] of cases) console.log(line(runShot(shot, surf)));

console.log('\n=== SLOPED FAIRWAY (driver & 7i) ===');
const downhill = { gradZ: 0.08 };  // ~4.6 deg drop down range
const uphill = { gradZ: -0.08 };
for (const shot of ['driver', 'sevenIron']) {
  console.log('DOWNHILL ' + line(runShot(shot, 'fairway', downhill)));
  console.log('UPHILL   ' + line(runShot(shot, 'fairway', uphill)));
}

console.log('\n=== FAIRWAY FIRMNESS (driver) ===');
for (const firmness of ['soft', 'medium', 'firm']) {
  console.log(firmness.toUpperCase().padEnd(8) + line(runShot('driver', 'fairway', {}, firmness)));
}

console.log('\n=== carry sanity (should be unchanged by ground model) ===');
for (const shot of ['driver', 'sevenIron', 'wedge']) {
  const r = runShot(shot, 'fairway');
  console.log(`${shot.padEnd(10)} carry ${fmt(r.carry)} yd  descent ${fmt(r.descentDeg,0)}d`);
}
