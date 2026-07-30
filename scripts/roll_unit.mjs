// Focused unit check of the spin-aware rolling solver: put a ball on a flat
// green moving down range with pure BACKSPIN and watch it check / zip back.
import { Vector3 } from 'three';
import { Ball } from '../src/physics/Ball.js';
import { makeEnv } from '../src/physics/ballistics.js';
import { RADS_TO_RPM, M_TO_YARD } from '../src/util/units.js';

const terrain = {
  heightAt: () => 0,
  normalAt: () => new Vector3(0, 1, 0),
  surfaceAt: () => 'green',
};
const ball = new Ball(terrain, makeEnv());
ball.placeAt(0, 0);
// Hand-set a rolling entry: 5 m/s down range (-Z), backspin axis +X.
ball.state = 'rolling';
ball._grounded = true;
ball.start.set(0, 0, 0);
ball.velocity.set(0, 0, -5);
ball.spin.axis.set(1, 0, 0);
ball.spin.omega = 3000 / RADS_TO_RPM; // 3000 rpm backspin

console.log('step  vz(m/s)   omega(rpm)  z(m)');
let t = 0;
let i = 0;
while (ball.state !== 'rest' && t < 20) {
  ball.update(1 / 240);
  t += 1 / 240;
  if (i++ % 60 === 0) {
    // sign of omega about +X axis (backspin positive)
    const sgn = ball.spin.axis.x >= 0 ? 1 : -1;
    console.log(
      String(i).padStart(5),
      ball.velocity.z.toFixed(2).padStart(7),
      (sgn * ball.spin.omega * RADS_TO_RPM).toFixed(0).padStart(9),
      ball.position.z.toFixed(2).padStart(7),
    );
  }
}
console.log('rest at z =', ball.position.z.toFixed(2), 'm  (', (ball.position.z * M_TO_YARD).toFixed(1), 'yd down range =', (-ball.position.z * M_TO_YARD).toFixed(1), 'yd)');
console.log('net travel down range:', (-ball.position.z).toFixed(2), 'm');
