const NEAR_TURF_SURFACES = new Set(['rough', 'deepRough']);

// Dense near-field blade geometry only works for long grass. Short mown blades at
// the available instance density read as isolated slivers, so fairway, tee, fringe,
// and green stay on the scale-correct PBR/parallax ground material.
export function usesNearTurfGeometry(surfaceName) {
  return NEAR_TURF_SURFACES.has(surfaceName);
}

// Texture-only turf cannot occlude the ball, but placing the sphere exactly tangent
// to the mathematical plane reads as perched in a macro view. Retain a shallow,
// capped contact offset for mown turf; long grass keeps its full canopy-derived sink
// because real blades overlap the lower edge.
export function renderedBallSitDepth(surfaceName, modeledDepth) {
  if (!(modeledDepth > 0)) return 0;
  if (usesNearTurfGeometry(surfaceName)) return modeledDepth;
  return Math.min(modeledDepth * 0.75, 0.003);
}

// BallLie patches are discs classified from one centre point. Near a mowing line,
// that would let a rough-centred disc paint a circular fringe of blades over the
// fairway. Conservatively sample two rings and hide the whole helper unless its
// footprint remains on long grass. The continuous GPU rough field still covers the
// boundary, so hiding this close-up supplement does not create a bare strip.
export function footprintUsesNearTurfGeometry(terrain, x, z, radius) {
  if (!usesNearTurfGeometry(terrain.surfaceAt(x, z))) return false;
  if (!(radius > 0)) return true;

  const samples = 16;
  for (const fraction of [0.5, 1]) {
    const r = radius * fraction;
    for (let i = 0; i < samples; i++) {
      const angle = i * Math.PI * 2 / samples;
      if (!usesNearTurfGeometry(terrain.surfaceAt(
        x + Math.cos(angle) * r,
        z + Math.sin(angle) * r,
      ))) return false;
    }
  }
  return true;
}
