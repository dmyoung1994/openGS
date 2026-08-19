import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import {
  AERO_SOURCE,
  MODERN_TOUR_AERO_PROFILE,
  aerodynamicCoefficients,
  flightAerodynamicCoefficients,
  reynolds,
  spinRatio,
} from '../src/physics/aerodynamics.js';
import { BALL, airViscosity } from '../src/physics/constants.js';
import { MODERN_TOUR_CALIBRATION } from '../src/physics/calibration.js';
import { Ball } from '../src/physics/Ball.js';
import { deriveLaunchState, makeEnv, simulateFlight, stepRK4 } from '../src/physics/ballistics.js';
import { resolveBounce, surface } from '../src/physics/groundInteraction.js';
import {
  GOLF_BALL_WATER_ENTRY_MODEL,
  intersectSegmentWaterPlane,
  resolveWaterEntry,
} from '../src/physics/waterInteraction.js';

const stillAir = makeEnv({ sampleWind: (_position, _time, out) => out.set(0, 0, 0) });
const almost = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} ±${epsilon}`);

test('source coefficient fixtures are exact table samples and interpolation is continuous', () => {
  assert.deepEqual(AERO_SOURCE.reynolds, [20_000, 40_000, 70_000, 100_000, 150_000, 200_000]);
  const direct = aerodynamicCoefficients({ cl: 0, cd: 0 }, 100_000, 0.2);
  // Direct samples of USGA/R&A 2006 Appendix C equation (7)/(8), six-decimal table precision.
  almost(direct.cl, 0.240167, 1e-12);
  almost(direct.cd, 0.285417, 1e-12);
  const halfway = aerodynamicCoefficients({ cl: 0, cd: 0 }, 85_000, 0.15);
  const a = aerodynamicCoefficients({ cl: 0, cd: 0 }, 85_000, 0.1);
  const b = aerodynamicCoefficients({ cl: 0, cd: 0 }, 85_000, 0.2);
  almost(halfway.cl, (a.cl + b.cl) * 0.5);
  almost(halfway.cd, (a.cd + b.cd) * 0.5);
  assert.throws(() => aerodynamicCoefficients({}, 19_999, 0.2), /source-backed domain/);
  assert.throws(() => aerodynamicCoefficients({}, 100_000, 1.81), /source-backed domain/);
  almost(reynolds(1.225, 42.7, BALL.diameter), 124_732.36978875604, 1e-6);
  assert.ok(airViscosity(35) > airViscosity(15));
  assert.ok(airViscosity(-5) < airViscosity(15));
  almost(spinRatio(BALL.radius, 500, 50), 0.21335, 1e-12);
});

test('live-flight coefficients stay bounded across terminal source-domain crossings', () => {
  const low = flightAerodynamicCoefficients({ cl: 0, cd: 0 }, 19_994.6287759743, 0.2);
  const lowBoundary = aerodynamicCoefficients({ cl: 0, cd: 0 }, AERO_SOURCE.reynolds[0], 0.2);
  assert.deepEqual(low, lowBoundary);

  const high = flightAerodynamicCoefficients({ cl: 0, cd: 0 }, 250_000, 2.4);
  const highBoundary = aerodynamicCoefficients(
    { cl: 0, cd: 0 },
    AERO_SOURCE.reynolds.at(-1),
    AERO_SOURCE.spinRatio.at(-1),
  );
  assert.deepEqual(high, highBoundary);
  assert.ok(Number.isFinite(low.cl) && Number.isFinite(low.cd));
  assert.ok(Number.isFinite(high.cl) && Number.isFinite(high.cd));
});

test('modern tour profile corrects the high-speed low-spin corner without altering iron spin parameters', () => {
  const sourceDriver = aerodynamicCoefficients({ cl: 0, cd: 0 }, 200_000, 0.065);
  const modernDriver = flightAerodynamicCoefficients({ cl: 0, cd: 0 }, 200_000, 0.065, MODERN_TOUR_AERO_PROFILE);
  assert.ok(modernDriver.cl > sourceDriver.cl * 2, 'modern driver lift must not reuse the iron fit unchanged');
  const sourceIron = aerodynamicCoefficients({ cl: 0, cd: 0 }, 130_000, 0.32);
  const modernIron = flightAerodynamicCoefficients({ cl: 0, cd: 0 }, 130_000, 0.32, MODERN_TOUR_AERO_PROFILE);
  almost(modernIron.cl, sourceIron.cl);
  almost(modernIron.cd, sourceIron.cd);
});

test('modern-tour profile stays inside committed launch-monitor flight envelopes', () => {
  for (const fixture of MODERN_TOUR_CALIBRATION.fixtures) {
    const result = simulateFlight(fixture.launch, stillAir, { diagnostics: true });
    const carry = result.carry / 0.9144;
    const apex = result.apexHeight * 3.28084;
    const descent = result.descentAngle * 180 / Math.PI;
    assert.ok(carry >= fixture.expected.carryYards[0] && carry <= fixture.expected.carryYards[1], `${fixture.id} carry ${carry}`);
    assert.ok(apex >= fixture.expected.apexFeet[0] && apex <= fixture.expected.apexFeet[1], `${fixture.id} apex ${apex}`);
    assert.ok(descent >= fixture.expected.descentDegrees[0] && descent <= fixture.expected.descentDegrees[1], `${fixture.id} descent ${descent}`);
    if (fixture.expected.earlyFlightAngleGainDegrees) {
      const launchAngle = Math.atan2(
        result.samples[0].vel.y,
        Math.hypot(result.samples[0].vel.x, result.samples[0].vel.z),
      ) * 180 / Math.PI;
      const earlyMaximum = Math.max(...result.samples
        .filter((sample) => sample.t <= 1.25)
        .map((sample) => Math.atan2(sample.vel.y, Math.hypot(sample.vel.x, sample.vel.z)) * 180 / Math.PI));
      const gain = earlyMaximum - launchAngle;
      assert.ok(
        gain >= fixture.expected.earlyFlightAngleGainDegrees[0]
          && gain <= fixture.expected.earlyFlightAngleGainDegrees[1],
        `${fixture.id} early flight-angle gain ${gain}`,
      );
    }
    assert.equal(result.diagnostics.aerodynamicProfile, MODERN_TOUR_AERO_PROFILE.id);
    assert.ok(result.diagnostics.coefficientSamples.length > 100);
    assert.ok(result.diagnostics.landingSpeed > 0 && result.diagnostics.landingSpin > 0);
  }
});

test('environment requires a wind sampler and RK4 samples every substage position/time', () => {
  assert.throws(() => makeEnv(), /sampleWind/);
  const calls = [];
  const env = makeEnv({
    sampleWind(position, time, out) {
      calls.push({ position: position.clone(), time });
      return out.set(time, 0, 0);
    },
  });
  const state = {
    position: new Vector3(0, 10, 0),
    velocity: new Vector3(10, 0, -20),
    angularVelocity: new Vector3(4, 200, 3),
  };
  stepRK4(state, 0.1, 2, env);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ time }) => time), [2, 2.05, 2.05, 2.1]);
  almost(calls[0].position.x, 0);
  // Stages advance with their own drag-affected velocity, so the positions
  // must be genuinely evaluated rather than reusing the step boundary.
  almost(calls[1].position.x, 0.5);
  assert.ok(calls[2].position.x > 0 && calls[2].position.x < 0.5);
  assert.ok(calls[1].position.distanceTo(calls[2].position) > 1e-6);
  assert.ok(calls[3].position.x > 0.9 && calls[3].position.x < 1);
  assert.throws(() => stepRK4({ position: new Vector3(), velocity: new Vector3(), angularVelocity: new Vector3() }, 0.01, 0, { rho: 1.225 }), /sampleWind/);
});

function advance(state, dt, seconds, env = stillAir) {
  let time = 0;
  while (time < seconds - 1e-12) {
    stepRK4(state, dt, time, env);
    time += dt;
  }
  return state;
}

test('RK4 converges and vector angular velocity is integrated as a torque state', () => {
  const launch = deriveLaunchState({ ballSpeed: 130, launchAngle: 14, spinRate: 2200 });
  const coarse = { position: launch.position.clone(), velocity: launch.velocity.clone(), angularVelocity: launch.angularVelocity.clone() };
  const fine = { position: launch.position.clone(), velocity: launch.velocity.clone(), angularVelocity: launch.angularVelocity.clone() };
  advance(coarse, 0.01, 1);
  advance(fine, 0.002, 1);
  assert.ok(coarse.position.distanceTo(fine.position) < 2e-4);
  assert.ok(coarse.velocity.distanceTo(fine.velocity) < 2e-4);
  assert.ok(coarse.angularVelocity.distanceTo(fine.angularVelocity) < 2e-4);

  const state = { position: new Vector3(0, 15, 0), velocity: new Vector3(0, 4, -50), angularVelocity: new Vector3(11, 700, -29) };
  const before = state.angularVelocity.clone();
  stepRK4(state, 0.02, 0, stillAir);
  assert.ok(state.angularVelocity.length() < before.length());
  // Damping torque preserves direction in still air; all vector components are integrated.
  almost(state.angularVelocity.x / state.angularVelocity.y, before.x / before.y, 1e-10);
  almost(state.angularVelocity.z / state.angularVelocity.y, before.z / before.y, 1e-10);
  resolveBounce(new Vector3(2, -8, -20), new Vector3(0, 1, 0), { angularVelocity: state.angularVelocity }, surface('green'));
  assert.ok(Math.abs(state.angularVelocity.x / state.angularVelocity.z - before.x / before.z) > 1e-4, 'contact torque must be able to change vector-spin orientation');
});

test('launch matrix is deterministic and remains finite', () => {
  const matrix = [
    { ballSpeed: 150, launchAngle: 12, spinRate: 2700, spinAxis: 0 },
    { ballSpeed: 125, launchAngle: 18, spinRate: 5900, spinAxis: 4 },
    { ballSpeed: 95, launchAngle: 29, spinRate: 8000, spinAxis: -7 },
  ];
  for (const params of matrix) {
    const first = simulateFlight(params, stillAir, { dt: 0.002, maxTime: 4, groundHeight: () => -1000 });
    const second = simulateFlight(params, stillAir, { dt: 0.002, maxTime: 4, groundHeight: () => -1000 });
    assert.deepEqual(first.samples.map((sample) => [sample.pos.x, sample.pos.y, sample.pos.z, sample.angularVelocity.x, sample.angularVelocity.y, sample.angularVelocity.z]), second.samples.map((sample) => [sample.pos.x, sample.pos.y, sample.pos.z, sample.angularVelocity.x, sample.angularVelocity.y, sample.angularVelocity.z]));
    for (const sample of first.samples) {
      for (const v of [sample.pos.x, sample.pos.y, sample.pos.z, sample.vel.x, sample.vel.y, sample.vel.z, sample.angularVelocity.x, sample.angularVelocity.y, sample.angularVelocity.z]) assert.ok(Number.isFinite(v));
    }
  }
});

test('representative shots complete their full bounce-and-roll lifecycle', () => {
  const shots = [
    { ballSpeed: 167, launchAngle: 10.9, spinRate: 2686, spinAxis: -2, carry: [284, 292], apex: [27, 33] },
    { ballSpeed: 120, launchAngle: 16.3, spinRate: 7097, spinAxis: 0, carry: [155, 175], apex: [20, 32] },
    { ballSpeed: 102, launchAngle: 24.2, spinRate: 9304, spinAxis: 0, carry: [120, 140], apex: [22, 35] },
  ];
  const terrain = {
    heightAt: () => 0,
    normalAt: () => new Vector3(0, 1, 0),
    surfaceAt: () => 'fairway',
    waterHeightAt: () => null,
  };
  for (const params of shots) {
    const ball = new Ball(terrain, stillAir);
    ball.placeAt(0, 0);
    ball.launch(params);
    let frames = 0;
    while (ball.state !== 'rest' && frames < 1_800) {
      ball.update(1 / 60);
      frames += 1;
    }
    assert.equal(ball.state, 'rest', `${params.ballSpeed} mph shot did not reach rest`);
    assert.ok(frames < 1_800);
    assert.ok(ball.carryYards >= params.carry[0] && ball.carryYards <= params.carry[1],
      `${params.ballSpeed} mph carry ${ball.carryYards} outside ${params.carry.join('..')}`);
    assert.ok(ball.apexHeight >= params.apex[0] && ball.apexHeight <= params.apex[1],
      `${params.ballSpeed} mph apex ${ball.apexHeight} outside ${params.apex.join('..')}`);
    assert.ok(ball.time >= 5 && ball.time <= 9, `${params.ballSpeed} mph lifecycle time ${ball.time} outside 5..9`);
    for (const value of [
      ...ball.position.toArray(), ...ball.velocity.toArray(),
      ball.carryYards, ball.totalYards, ball.time,
    ]) assert.ok(Number.isFinite(value));
  }
});

test('water crossing is exact and entry response distinguishes calibrated skip from penetration', () => {
  const crossing = intersectSegmentWaterPlane(new Vector3(2, 3, -4), new Vector3(8, -9, 5), 0);
  assert.ok(crossing);
  almost(crossing.t, 0.25);
  assert.deepEqual(crossing.position.toArray(), [3.5, 0, -1.75]);
  assert.equal(intersectSegmentWaterPlane(new Vector3(0, 1, 0), new Vector3(2, 2, 0), 0), null);
  const skip = resolveWaterEntry({
    velocity: new Vector3(25, -1.5, 0),
    angularVelocity: new Vector3(0, 0, 300),
    ball: BALL,
    model: GOLF_BALL_WATER_ENTRY_MODEL,
  });
  assert.equal(skip.kind, 'skip');
  assert.ok(skip.velocity.y > 0);
  assert.ok(skip.retention > 0 && skip.retention < 1);
  assert.ok(skip.angularVelocity.length() < 300);
  assert.ok(skip.criticalSpeed < skip.velocity.length() / skip.retention);
  const penetration = resolveWaterEntry({
    velocity: new Vector3(5, -7, 0),
    angularVelocity: new Vector3(0, 0, 300),
    ball: BALL,
    model: GOLF_BALL_WATER_ENTRY_MODEL,
  });
  assert.equal(penetration.kind, 'penetration');
  assert.ok(penetration.dragCoefficient > 0);
  assert.ok(penetration.buoyancy > 0);
  assert.equal(penetration.sinks, true);
  assert.throws(() => resolveWaterEntry({ velocity: new Vector3(), ball: BALL, model: { ...GOLF_BALL_WATER_ENTRY_MODEL, source: '' } }), /source identifier/);
});

const flatPondTerrain = Object.freeze({
  heightAt: () => -10,
  normalAt: () => new Vector3(0, 1, 0),
  surfaceAt: () => 'rough',
  waterHeightAt: () => 0,
});

function waterEntryBall({ velocity, angularVelocity = new Vector3(0, 0, 300), calibrated = true }) {
  const env = makeEnv({
    sampleWind: (_position, _time, out) => out.set(0, 0, 0),
    waterEntryModel: calibrated ? GOLF_BALL_WATER_ENTRY_MODEL : null,
  });
  const ball = new Ball(flatPondTerrain, env);
  ball.position.set(0, 0.023, 0);
  ball.start.copy(ball.position);
  ball.velocity.copy(velocity);
  ball.angularVelocity.copy(angularVelocity);
  ball.state = 'airborne';
  return ball;
}

test('Ball applies the calibrated water response at exact RK4 contact and emits one deterministic impact', () => {
  const run = () => {
    const ball = waterEntryBall({ velocity: new Vector3(25, -1.5, 0) });
    const impacts = [];
    const hazards = [];
    ball.on('waterImpact', (event) => impacts.push(event));
    ball.on('hazard', (event) => hazards.push(event));
    ball.update(0.002);
    return {
      ball,
      impacts,
      hazards,
      state: [
        ...ball.position.toArray(), ...ball.velocity.toArray(),
        ...ball.angularVelocity.toArray(), ball.time, ball.state,
      ],
      event: impacts.map((event) => [
        event.kind, ...event.position.toArray(), event.impactSpeed,
        event.incidentAngleDegrees, event.criticalSpeed, event.spinRatio,
      ]),
    };
  };
  const first = run();
  const second = run();
  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.event, second.event);
  assert.equal(first.impacts.length, 1);
  assert.equal(first.impacts[0].kind, 'skip');
  assert.equal(first.hazards.length, 0);
  assert.equal(first.ball.state, 'airborne');
  assert.ok(first.ball.velocity.y > 0);
  almost(first.ball.time, 0.002, 1e-15);
});

test('Ball penetration terminates at the water plane while missing calibration fails closed', () => {
  const ball = waterEntryBall({ velocity: new Vector3(5, -7, 0) });
  const impacts = [];
  const hazards = [];
  ball.on('waterImpact', (event) => impacts.push(event));
  ball.on('hazard', (event) => hazards.push(event));
  ball.update(0.002);
  assert.equal(ball.state, 'rest');
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'penetration');
  assert.equal(hazards.length, 1);
  assert.strictEqual(hazards[0], impacts[0]);
  almost(ball.position.y, BALL.radius, 1e-12);
  assert.deepEqual(ball.velocity.toArray(), [0, 0, 0]);
  assert.throws(
    () => waterEntryBall({ velocity: new Vector3(5, -7, 0), calibrated: false }).update(0.002),
    /no fallback response exists/,
  );
});
