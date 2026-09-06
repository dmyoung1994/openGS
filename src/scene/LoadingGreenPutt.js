import { Vector3 } from 'three';
import { Ball } from '../physics/Ball.js';
import { makeEnv } from '../physics/ballistics.js';
import { GOLF_HOLE_RADIUS_M } from './CreatorCup.js';

// Solve before showing a ball: playback contains only production-physics samples,
// never a curve that steers toward the cup. Unsolvable starts are not presented.
export function solveLoadingGreenPutt(terrain, start, cup) {
  if (![start?.x, start?.z, cup?.x, cup?.z].every(Number.isFinite)) {
    throw new TypeError('Loading putt positions must be finite.');
  }
  if (terrain.surfaceAt(start.x, start.z) !== 'green') return null;
  const dx = cup.x - start.x, dz = cup.z - start.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.5 || distance > 12) return null;
  // Ground rolling does not sample aerodynamic wind; no airborne phase is used.
  const ball = new Ball(terrain, makeEnv({ sampleWind: (_position, _time, out) => out.set(0, 0, 0) }));
  const normal = terrain.normalAt(start.x, start.z).clone();
  const nominalTime = (Math.sqrt(0.45 ** 2 + 1.28 * distance) - 0.45) / 0.64;
  const simulate = (vx, vz, frames, record = false) => {
    ball.placeAt(start.x, start.z);
    ball.start.copy(ball.position);
    ball.velocity.set(vx, -(normal.x * vx + normal.z * vz) / normal.y, vz);
    ball.angularVelocity.crossVectors(normal, ball.velocity).divideScalar(ball.radius);
    ball.state = 'rolling';
    ball.time = 0;
    ball._accum = 0;
    const samples = record ? [ball.position.clone()] : null;
    let onGreen = true;
    for (let frame = 0; frame < frames; frame++) {
      ball.update(0.01);
      if (record) {
        samples.push(ball.position.clone());
        onGreen &&= terrain.surfaceAt(ball.position.x, ball.position.z) === 'green';
      }
    }
    return { x: ball.position.x, z: ball.position.z, speed: ball.velocity.length(), samples, onGreen };
  };
  for (const timeScale of [1, 0.85, 1.15, 0.7]) {
    const frames = Math.max(30, Math.round(nominalTime * timeScale * 100));
    const duration = frames * 0.01;
    let vx = dx / duration + dx / distance * 0.32 * duration;
    let vz = dz / duration + dz / distance * 0.32 * duration;
    for (let iteration = 0; iteration < 10; iteration++) {
      const base = simulate(vx, vz, frames);
      const ex = cup.x - base.x, ez = cup.z - base.z;
      if (Math.hypot(ex, ez) < 0.004) {
        const result = simulate(vx, vz, frames, true);
        if (result.onGreen && result.speed > 0.12 && result.speed < 0.85
          && Math.hypot(result.x - cup.x, result.z - cup.z) < GOLF_HOLE_RADIUS_M - ball.radius) {
          return { samples: result.samples, sampleSeconds: 0.01, duration, arrivalSpeed: result.speed,
            velocity: new Vector3(vx, -(normal.x * vx + normal.z * vz) / normal.y, vz) };
        }
        break;
      }
      const epsilon = 0.015;
      const xProbe = simulate(vx + epsilon, vz, frames);
      const zProbe = simulate(vx, vz + epsilon, frames);
      const a = (xProbe.x - base.x) / epsilon, b = (zProbe.x - base.x) / epsilon;
      const c = (xProbe.z - base.z) / epsilon, d = (zProbe.z - base.z) / epsilon;
      const determinant = a * d - b * c;
      if (Math.abs(determinant) < 1e-5) break;
      vx += Math.max(-1, Math.min(1, (ex * d - b * ez) / determinant));
      vz += Math.max(-1, Math.min(1, (a * ez - ex * c) / determinant));
    }
  }
  return null;
}
