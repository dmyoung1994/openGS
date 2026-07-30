import { Vector3 } from 'three';
import { BALL } from './constants.js';

// Per-surface interaction properties. This is where "different grass and
// terrain interact with the ball differently" actually lives. Every value is
// dimensionless and tuned to feel right against real observation; they are the
// main knobs for shot-shaping realism.
//
//   restitution     normal-direction bounciness at a gentle impact
//                   (0 = dead, 1 = perfectly elastic). Reduced further for
//                   steep/fast landings by `plush` and `speedCOR` below.
//   friction        Coulomb tangential coefficient at the contact. Governs how
//                   fast the ball transitions from a skid to true rolling, and
//                   how strongly backspin is converted to a backward kick.
//   rollResistance  constant rolling deceleration as a fraction of g (higher =
//                   stops sooner). ~0.055 on a green matches a ~10 stimp putt;
//                   it dominates the slow, final trickle-out.
//   rollDrag        speed-squared "grass/skid drag" that only bites at pace, so
//                   a fast entry (driver release, hot approach) is scrubbed hard
//                   while a slow putt is untouched. Big on rough/sand.
//   spinCoupling    how much of the (rigid-body) tangential friction torque the
//                   turf actually transmits to the ball's spin, 0..1. A rigid
//                   contact (=1) would dump nearly all backspin in one hard
//                   bounce (unphysical for turf); real grass couples loosely, so
//                   greens (low) keep backspin alive to check and zip on the
//                   ground, while rough/sand (high) scrub it away.
//   spinRetain      extra multiplicative spin decay per bounce, after coupling.
//   plush           softness; steep, fast landings sink in and lose normal
//                   rebound (0 = firm, 1 = swallows the ball).
//   speedCOR        how much the normal restitution fades with impact speed
//                   (turf yields more when struck harder).
//   stopSpeed       m/s below which a rolling ball is considered stopped.
export const SURFACES = {
  tee:       { restitution: 0.42, friction: 0.52, rollResistance: 0.14, rollDrag: 0.040, spinCoupling: 0.55, spinRetain: 0.85, plush: 0.30, speedCOR: 0.32, stopSpeed: 0.20, color: 0x4f7a34 },
  fairway:   { restitution: 0.40, friction: 0.52, rollResistance: 0.130, rollDrag: 0.045, spinCoupling: 0.55, spinRetain: 0.80, plush: 0.36, speedCOR: 0.34, stopSpeed: 0.18, color: 0x5c8a3a },
  green:     { restitution: 0.33, friction: 0.46, rollResistance: 0.065, rollDrag: 0.024, spinCoupling: 0.24, spinRetain: 0.93, plush: 0.46, speedCOR: 0.30, stopSpeed: 0.11, color: 0x6ba24a },
  fringe:    { restitution: 0.34, friction: 0.52, rollResistance: 0.11, rollDrag: 0.060, spinCoupling: 0.42, spinRetain: 0.82, plush: 0.40, speedCOR: 0.32, stopSpeed: 0.15, color: 0x5f9540 },
  rough:     { restitution: 0.20, friction: 0.72, rollResistance: 0.44, rollDrag: 0.150, spinCoupling: 0.85, spinRetain: 0.30, plush: 0.68, speedCOR: 0.42, stopSpeed: 0.36, color: 0x3f6b2c },
  deepRough: { restitution: 0.13, friction: 0.85, rollResistance: 0.78, rollDrag: 0.280, spinCoupling: 0.95, spinRetain: 0.14, plush: 0.88, speedCOR: 0.52, stopSpeed: 0.52, color: 0x2f5824 },
  sand:      { restitution: 0.09, friction: 0.90, rollResistance: 1.05, rollDrag: 0.450, spinCoupling: 1.00, spinRetain: 0.05, plush: 0.97, speedCOR: 0.58, stopSpeed: 0.60, color: 0xcdb98b },
  hardpan:   { restitution: 0.60, friction: 0.32, rollResistance: 0.055, rollDrag: 0.010, spinCoupling: 0.70, spinRetain: 0.55, plush: 0.05, speedCOR: 0.18, stopSpeed: 0.12, color: 0x9a8a5f },
  cartpath:  { restitution: 0.72, friction: 0.20, rollResistance: 0.03, rollDrag: 0.004, spinCoupling: 0.80, spinRetain: 0.45, plush: 0.00, speedCOR: 0.10, stopSpeed: 0.10, color: 0x8f8f92 },
  water:     { restitution: 0.0,  friction: 1.0,  rollResistance: 1.0,  rollDrag: 1.0,   spinCoupling: 1.0,  spinRetain: 0.0,  plush: 1.0,  speedCOR: 1.0,  stopSpeed: 999,  color: 0x2f6f86, hazard: 'water' },
};

export function surface(name) {
  return SURFACES[name] || SURFACES.fairway;
}

// Solid-sphere constants. The impulse needed to bring a slipping contact to
// pure rolling is (2/7)|u| per unit mass; the angular response uses I = 2/5 m r^2.
const RADIUS = BALL.radius;
const GRIP = 2 / 7;

// Resolve a single ground impact with a proper impulse model.
//
//   vel     incoming velocity (m/s), mutated in place to the outgoing velocity
//   normal  unit surface normal at the contact point
//   spin    { axis: Vector3(unit), omega: rad/s } - mutated on exit
//   surf    a SURFACES entry
//
// The tangential behaviour models the ball SKIDDING and, if the contact grabs,
// transitioning to true ROLL (v_contact -> 0). Backspin drives the contact
// point forward, so friction pushes it backward: that is what makes a wedge
// check up or spin back on a green, while a low-spin driver just releases.
//
// Returns { rolling } - true when the vertical rebound is spent and the ball
// should hand off to the rolling solver.
const _n = new Vector3();
const _vn = new Vector3();
const _vt = new Vector3();
const _omega = new Vector3();
const _r = new Vector3();
const _vspin = new Vector3();
const _slip = new Vector3();
const _slipHat = new Vector3();
const _dOmega = new Vector3();

export function resolveBounce(vel, normal, spin, surf) {
  _n.copy(normal).normalize();
  const speed = vel.length();

  // Split incoming velocity into normal and tangential parts.
  const vnMag = vel.dot(_n);           // < 0 while descending into the surface
  const vnIn = Math.max(0, -vnMag);    // inbound normal speed (>= 0)
  _vn.copy(_n).multiplyScalar(vnMag);
  _vt.copy(vel).sub(_vn);              // tangential velocity vector

  // Impact steepness: 0 = grazing skim, 1 = dropped straight down.
  const steep = speed > 1e-4 ? vnIn / speed : 0;

  // --- Normal restitution -------------------------------------------------
  // Steep, fast landings into soft turf dig in and shed rebound; the COR also
  // sags with impact speed (the surface yields more when hit harder).
  const dig = 1 - surf.plush * (0.30 + 0.70 * steep);
  const speedFade = 1 - surf.speedCOR * Math.min(1, vnIn / 32);
  const eN = surf.restitution * Math.max(0.04, dig) * Math.max(0.30, speedFade);
  const reboundVn = eN * vnIn;

  // --- Tangential + spin: skid vs. grip -----------------------------------
  // Contact-point velocity contributed by spin: u_spin = omega x r, with the
  // contact arm r = -n * radius. For backspin this points DOWN range, so the
  // contact slips forward and friction acts backward.
  _omega.copy(spin.axis).multiplyScalar(spin.omega);
  _r.copy(_n).multiplyScalar(-RADIUS);
  _vspin.copy(_omega).cross(_r);
  _vspin.addScaledVector(_n, -_vspin.dot(_n)); // keep purely tangential

  _slip.copy(_vt).add(_vspin);        // slip velocity of the contact point
  const slipMag = _slip.length();
  if (slipMag > 1e-6) _slipHat.copy(_slip).multiplyScalar(1 / slipMag);
  else _slipHat.set(0, 0, 0);

  // Impulses per unit mass (units of m/s).
  const jn = (1 + eN) * vnIn;         // normal impulse
  const jtMax = surf.friction * jn;   // Coulomb cap
  const jtGrip = GRIP * slipMag;      // impulse to reach pure rolling
  // If the cap covers the grip impulse the contact bites and rolls; otherwise
  // it skids through contact at the friction limit.
  const jt = jtGrip <= jtMax ? jtGrip : jtMax;

  // Linear response: tangential impulse opposes the slip direction.
  _vt.addScaledVector(_slipHat, -jt);

  // Embedding scrub: on soft turf a steep landing buries the ball slightly and
  // the crater walls resist forward skid, bleeding tangential speed on top of
  // Coulomb friction. This is a big part of why receptive greens and rough
  // HOLD while firm fairways RELEASE - and, because spin is largely kept
  // (spinRetain), it lets a checked ball whose forward speed is gone flip to a
  // net backward velocity on a later hop (the wedge "zip back").
  const embed = surf.plush * (0.25 + 0.75 * steep);
  _vt.multiplyScalar(Math.max(0, 1 - 0.72 * embed));

  // Angular response: the ideal rigid torque is dOmega = (r x J_t)/I =
  // (5 jt / 2r)(n x slipHat). A rigid contact would dump almost all of a
  // wedge's backspin in a single hard bounce - which is not what soft, grassy
  // turf does. `spinCoupling` throttles how much of that torque the surface
  // actually transmits, so greens keep enough backspin to check and zip on the
  // ground while rough and sand scrub it away.
  const coupling = surf.spinCoupling == null ? 1 : surf.spinCoupling;
  _dOmega.copy(_n).cross(_slipHat).multiplyScalar((5 * jt * coupling) / (2 * RADIUS));
  _omega.add(_dOmega);

  // Extra multiplicative spin decay per bounce (grass shear, ball deformation).
  _omega.multiplyScalar(surf.spinRetain);
  spin.omega = _omega.length();
  if (spin.omega > 1e-4) spin.axis.copy(_omega).multiplyScalar(1 / spin.omega);

  // Reassemble outgoing velocity (rebound along +normal, plus tangential).
  _vn.copy(_n).multiplyScalar(reboundVn);
  vel.copy(_vn).add(_vt);

  // Once the vertical hop is spent (or the whole thing is crawling), hand off
  // to the rolling solver instead of spawning endless micro-bounces.
  const rolling = reboundVn < 0.55 || vel.length() < 0.6;
  return { rolling, hazard: surf.hazard || null };
}
