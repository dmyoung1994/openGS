# Composite Assemblies

Use small deterministic groups of licensed catalog pieces to create site-specific forms. An assembly is a placement recipe, not a new primitive or baked mesh.

## Shared structure

Every assembly has four possible roles:

- **anchor:** the dominant silhouette or oldest specimen;
- **support:** one to three related pieces that establish direction and mass;
- **fill:** smaller compatible forms that break repetition and occupy gaps;
- **contact:** low groundcover, fragments, or deadwood that hides the join with terrain.

Use 3–9 pieces for a landmark assembly. Give the group one stable seed, then derive independent yaw, scale, and offset jitter for each member. Do not apply the same transform sequence to every group.

## Tree communities

- Combine tall, medium, and small age classes rather than scaling copies uniformly.
- Use `forest-cluster` for catalog assets that are genuinely mature overstory and
  `forest-understory` for saplings/regeneration kept near native scale. Share one
  `habitatMassId` across layers that form the same stand.
- Place crowns with controlled overlap but keep trunks and primary stems legible.
- Use middle-story shrubs at the sheltered edge and sparse groundcover beneath open canopy.
- Form asymmetric masses with one view window. Avoid rows, rings, identical pairs, and evenly filled disks.
- Keep canopy anchors far enough apart to preserve mature crown form and golf sightlines.
- Rasterize pine-litter/grass exclusion from the resolved crown-disc union. Join
  each declared habitat mass with the minimum set of broad crown-to-crown corridors.
  Pine-litter sites join those stands course-wide but retain maintained-surface and
  hazard cutouts; region rectangles remain placement envelopes, not material masks.
  Give maintained litter beds a narrow organic turf cut; use plants, roots, and
  deadwood to naturalize selected forest shoulders rather than blurring every edge.
- A sparse mature source can be a deliberate emergent, not the sole wall-forming
  species. Use a denser compatible authored middle layer and deliberate tee/green
  anchors before increasing counts; verify the resulting layer from golfer height.

## Rock outcrops

- Choose one bedding direction and local slope relationship for the entire group.
- Use one dominant face or stack, supporting rocks at its toe and flank, then small fragments down-slope.
- Bury lower portions and overlap contact pieces so there is no visible flat-model base.
- Keep color/material families consistent. Variety comes from size, exposure, orientation, and partial burial—not unrelated rock types.
- Follow contour and drainage. Do not distribute isolated boulders like confetti.

## Layered course edges

- Foreground: sparse high-detail contact pieces that frame but do not block the shot.
- Middle ground: the main canopy, rock, or shrub mass with deliberate gaps and recognizable rhythm.
- Backdrop: broader, lower-detail silhouettes that cover the course boundary and connect to haze.
- Stagger zones in depth. Never solve the edge with one uniform perimeter band.

## Validation

Reject an assembly when it floats, visibly self-intersects, repeats another group exactly, reads as a pile of separate props, blocks protected play, creates an alpha-card wall, or exceeds the catalog's scale and slope limits. Inspect from golfer height and low oblique contact views as well as overhead.
