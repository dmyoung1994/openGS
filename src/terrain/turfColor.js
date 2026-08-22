import { Color, SRGBColorSpace } from 'three';
import { surface } from '../physics/groundInteraction.js';

// THE canonical gameplay-colour -> turf-albedo transform.
//
// Every surface that draws grass has to agree on this exactly, or blades stop
// matching the ground they stand in. Terrain.js (ground) and Grass.js (blades) both
// import from here; they used to carry duplicate copies under a "MUST stay identical"
// comment, which is exactly the arrangement that lets them drift.
//
// The numbers come from measuring a photographed sunlit fairway: turf sits at roughly
// H 80 deg (0.22 — a YELLOW-green, not a pure green), S 0.20, L 0.36. An earlier
// version pushed hue the WRONG way (toward 0.31, i.e. purer green) and cut lightness
// three separate times, which is what made the course read as dark video-game green.
//
// ---- Deep rough is not its own material. -------------------------------------
// It is ROUGH, mown longer — the same plant, the same pigment. Every real difference
// between them is geometric and is already modelled elsewhere: a deeper canopy for the
// parallax march (CANOPY_M in Terrain.js, 0.075 vs 0.055) and taller blades (bladeHeight
// in Grass.js, 0.32 vs 0.20), which together make deep rough read darker through
// SELF-SHADOW, the way it actually gets darker in the world.
//
// So deep rough takes rough's albedo, full stop. It previously had its own much darker
// gameplay colour baked into the albedo (linear green 0.064 vs rough's 0.096), and the
// turf shader then multiplied it by a further 0.85 — pigment darkening, hand-picked
// darkening AND canopy self-shadow, all stacked for the same physical effect. That
// triple-count was survivable only while a near-plastic roughness (0.34) threw a broad
// specular sheet over the top; the moment the surface was made properly matte it read
// as a different, near-black material rather than as long grass.
const ALBEDO_OF = { deepRough: 'rough' };

// ---- Photometric lightness correction. ---------------------------------------
// The gameplay colours encode surface IDENTITY — picked so a fairway reads as a
// different thing from rough on a minimap — so their LIGHTNESS spread is stylistic and
// far wider than the real one. Measured off the hue/saturation transform below, the
// linear green reflectances came out fairway 0.165 / rough 0.096, i.e. rough at 0.58x
// fairway. Real unmown turf sits around 0.83x (measured reflectances ~0.18 and ~0.15):
// it is darker than a fairway mostly through shadow, not pigment. 1.43 is exactly the
// ratio between those two rows, and it lands rough — and therefore deep rough — where a
// photograph puts it.
const LIFT = { rough: 1.43 };

// One shared pigment transform for the geometric rough blades and the terrain
// directly beneath them. Keeping this here prevents a dense green canopy from
// revealing a greyer substrate through normal inter-blade gaps.
export const TURF_BLADE_SATURATION = 1.28;

// Current fairway reels cut about 100 in / 2.54 m per pass. Alternating light/dark
// lays therefore repeat every two passes (5.08 m), not at the former stylized 14 m
// cycle. The range runs down -Z; this fixed linear axis makes every pass perfectly
// straight in world space while retaining the authored slight routing angle.
export const MOW_STRIPE_PASS_WIDTH_M = 2.54;
export const MOW_STRIPE_PERIOD_M = MOW_STRIPE_PASS_WIDTH_M * 2;
export const MOW_STRIPE_CROSS_SLOPE = 0.06;

// CPU-side counterpart used by focused contracts/tools. There is deliberately no
// noise, curvature, phase drift, or camera term on top of this linear coordinate.
export function mowingStripCoordinate(x, z) {
  return x + z * MOW_STRIPE_CROSS_SLOPE;
}

export function mowingStripPhase(x, z) {
  const period = MOW_STRIPE_PERIOD_M;
  const wrapped = mowingStripCoordinate(x, z) % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

const _hsl = { h: 0, s: 0, l: 0 };

export function turfBase(name, out = new Color()) {
  const key = ALBEDO_OF[name] || name;
  out.set(surface(key).color);
  out.getHSL(_hsl, SRGBColorSpace);
  // Keep one believable yellow-green plant family, but preserve enough pigment
  // chroma to survive the neutral daylight/PMREM path. The previous 0.40 saturation
  // and 1.02 lightness converged to pale sage in the fixed golfer views; this grade
  // keeps turf matte and muted while restoring chlorophyll colour without emissive
  // or post-lighting compensation.
  // Keep the base inside photographed fairway reflectance instead of letting the
  // daylight rig turn it into pale sage. Mower-pass contrast remains outside this
  // transform and comes primarily from registered leaf-lay normals/roughness.
  out.setHSL(_hsl.h + (0.225 - _hsl.h) * 0.55, _hsl.s * 0.66, _hsl.l * 0.89, SRGBColorSpace);
  if (LIFT[key]) out.multiplyScalar(LIFT[key]);
  return out;
}

export function turfBladeBase(name, out = new Color()) {
  turfBase(name, out);
  out.getHSL(_hsl, SRGBColorSpace);
  out.setHSL(_hsl.h, Math.min(_hsl.s * TURF_BLADE_SATURATION, 1), _hsl.l, SRGBColorSpace);
  return out;
}
