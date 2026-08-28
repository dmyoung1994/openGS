# Placement zones

Establish protected play before environmental dressing.

## Protected clearances

- Tee complexes: no trunks or rocks within 12 m; no tall shrubs within 8 m.
- Primary tee sightline: keep a widening corridor clear from 12 m beyond the
  tee through the first landing area.
- Driver landing area: preserve an ellipse roughly 55 m long by 38 m wide,
  adjusted for the intended player class and slope.
- Layup/second landing area: preserve an ellipse roughly 40 m by 30 m.
- Green: no scenery on the putting surface or collar; keep trunks and large
  rocks at least 14 m from the green edge unless an explicit strategic tree is
  recoverable and visible.
- Bunkers/water: no placement inside the feature. Keep enough shoreline and
  bunker edge visible to read the hazard from golfer height.
- Recovery: preserve at least one ground or aerial recovery lane from every
  intended miss zone.

## Community layering

1. Place 1–5 anchor trees or major rocks at turns, ridgelines, hazard ends, and
   green-backdrop positions.
2. Add middle-story clusters primarily outside play, with gaps between masses.
3. Add groundcover in drifts that follow contours, moisture, and disturbance.
4. Add deadwood or accent rocks only where they reinforce ecology or geology.
5. Review from tee, each landing area, green approach, and broadcast camera.

Use several small scatter regions instead of one huge circular scatter. Offset
their centers, vary radii/counts, and overlap edges lightly to avoid visible
circles. Keep each region's palette narrow.

## Density guide per hectare of naturalized ground

- Sparse desert: 4–10 trees, 35–80 shrubs, 40–120 accents.
- Balanced parkland: 12–24 trees, 25–70 shrubs, 60–180 groundcover pieces.
- Mountain woodland: 18–38 trees, 20–60 shrubs, 40–130 groundcover/deadwood.
- Coastal: 6–18 trees, 30–90 shrubs, 80–220 low groundcover pieces.

These are starting points, not quotas. Reduce counts near playable turf and
increase them only beyond shot corridors. The runtime course budget is 3,000
objects; premium single-hole dressing should normally stay below 700.

## Runtime-aware density

- Prefer repeated licensed `catalogId` placements and deterministic composite
  assemblies. They retain authored transforms but share GPU geometry,
  materials, and category-aware LOD batches.
- Reserve embedded custom models for true hero assets. Repeating a custom model
  forfeits catalog instancing and can turn hundreds of placements into hundreds
  of draw calls.
- Spend high-detail placements inside roughly one golfer-view foreground;
  distant trees carry skyline and depth, while distant shrubs and groundcover
  should merge into texture and mass rather than remain individual geometry.
- Validate the densest golfer view and a moving shot camera at 30 FPS with
  shadows, water, turf detail, and GTAO active. Reduce invisible/sub-pixel
  accents before reducing strategic anchors or backdrop trees.

## Final audit

- Every object has exactly one declared source: a valid catalog `assetId`, or a
  registered synthetic-tree archetype plus stable ID and deterministic parameters.
- Seeds are stable and regions are reproducible.
- Same-ID spacing and slope ranges pass catalog rules.
- No grid, repeated yaw sequence, uniform scale, floating base, or intersection.
- The route remains visually obvious at golfer height.
- Hero views have foreground, midground, backdrop, and intentional negative
  space without hiding the ball, target, or hazard boundaries.
