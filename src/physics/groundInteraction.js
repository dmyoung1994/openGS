import { Vector3 } from 'three';

// Per-surface interaction properties. This is where "different grass and
// terrain interact with the ball differently" actually lives. Every value is
// dimensionless and tuned to feel right against real observation; they are the
// main knobs for shot-shaping realism.
//
//   restitution     normal-direction bounciness (0 = dead, 1 = perfectly elastic)
//   friction        tangential grab on impact (skids vs. bites)
//   rollResistance  rolling deceleration as a fraction of g (higher = stops sooner)
//   spinGrab        how strongly backspin converts to backward velocity on the
//                   first bounces (greens "check" / spin back)
//   plush           softness; steep, fast landings sink in and lose energy
//   stopSpeed       m/s below which a rolling ball is considered stopped
export const SURFACES = {
  tee:       { restitution: 0.40, friction: 0.55, rollResistance: 0.12, spinGrab: 0.45, plush: 0.15, stopSpeed: 0.18, color: 0x4f7a34 },
  fairway:   { restitution: 0.45, friction: 0.50, rollResistance: 0.11, spinGrab: 0.50, plush: 0.20, stopSpeed: 0.16, color: 0x5c8a3a },
  green:     { restitution: 0.34, friction: 0.42, rollResistance: 0.055, spinGrab: 0.92, plush: 0.30, stopSpeed: 0.10, color: 0x6ba24a },
  fringe:    { restitution: 0.38, friction: 0.55, rollResistance: 0.14, spinGrab: 0.60, plush: 0.25, stopSpeed: 0.14, color: 0x5f9540 },
  rough:     { restitution: 0.26, friction: 0.78, rollResistance: 0.34, spinGrab: 0.20, plush: 0.55, stopSpeed: 0.30, color: 0x3f6b2c },
  deepRough: { restitution: 0.16, friction: 0.90, rollResistance: 0.60, spinGrab: 0.10, plush: 0.80, stopSpeed: 0.45, color: 0x2f5824 },
  sand:      { restitution: 0.12, friction: 0.85, rollResistance: 0.72, spinGrab: 0.05, plush: 0.95, stopSpeed: 0.40, color: 0xcdb98b },
  hardpan:   { restitution: 0.62, friction: 0.30, rollResistance: 0.05, spinGrab: 0.15, plush: 0.02, stopSpeed: 0.12, color: 0x9a8a5f },
  cartpath:  { restitution: 0.72, friction: 0.22, rollResistance: 0.03, spinGrab: 0.05, plush: 0.00, stopSpeed: 0.10, color: 0x8f8f92 },
  water:     { restitution: 0.0,  friction: 1.0,  rollResistance: 1.0,  spinGrab: 0.0,  plush: 1.0,  stopSpeed: 999,  color: 0x2f6f86, hazard: 'water' },
};

export function surface(name) {
  return SURFACES[name] || SURFACES.fairway;
}

// Resolve a single ground impact.
//
//   vel     incoming velocity (m/s), mutated in place to the outgoing velocity
//   normal  unit surface normal at the contact point
//   spin    { axis: Vector3(unit), omega: rad/s } - omega reduced on exit
//   surf    a SURFACES entry
//
// Returns { rolling } - true when the bounce is spent and the ball should
// switch to the rolling solver.
const _vn = new Vector3();
const _vt = new Vector3();
const _spinV = new Vector3();
export function resolveBounce(vel, normal, spin, surf) {
  const speed = vel.length();

  // Decompose into normal and tangential components.
  const vnMag = vel.dot(normal);
  _vn.copy(normal).multiplyScalar(vnMag);
  _vt.copy(vel).sub(_vn);

  // Steeper, faster landings dig in on soft turf and lose extra energy.
  const impactAngle = Math.abs(Math.asin(Math.min(1, -vnMag / Math.max(speed, 1e-4))));
  const dig = 1 - surf.plush * Math.min(1, impactAngle / (Math.PI / 3));

  // Normal rebound.
  const rebound = -vnMag * surf.restitution * dig;
  _vn.copy(normal).multiplyScalar(rebound);

  // Tangential: friction scrubs speed; backspin adds a backward impulse along
  // the ground track (this is what makes a wedge check up or spin back).
  const grab = Math.min(1, surf.friction * (0.6 + 0.4 * dig));
  _vt.multiplyScalar(1 - grab * 0.5);

  // Spin -> ground velocity. Backspin (axis pointing to the player's right for
  // a ball travelling down range) drives the contact point backward.
  const omega = spin.omega;
  if (omega > 1) {
    // Tangential surface velocity from spin at the contact: v = omega x r,
    // with r pointing from center to the ground (~ -normal * radius). We just
    // need its horizontal direction and a magnitude proxy.
    _spinV.copy(spin.axis).cross(normal); // direction spin pushes the contact
    const spinPush = surf.spinGrab * omega * 0.0016; // scaled to m/s of kick
    _vt.addScaledVector(_spinV.normalize(), -spinPush * (0.5 + 0.5 * dig));
  }

  vel.copy(_vn).add(_vt);

  // Each bounce sheds spin quickly through the turf.
  spin.omega *= 0.55 * (1 - surf.plush * 0.5);

  // If the rebound is small, we're done bouncing -> roll.
  const rolling = rebound < 0.7 || speed < 1.2;
  return { rolling, hazard: surf.hazard || null };
}
