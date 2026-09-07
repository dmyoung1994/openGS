# Strategic bunker design

Build bunkers as terrain and strategy, not repeated sand stamps.

## Brief

Record the bunker role before drawing it:

```yaml
role: strategic | directional | recovery | penal | framing
shot_context: tee shot | layup | approach | recovery
target_players: casual | skilled | tour
stable_id: authored bunker ID
route_progress_band: intended shot interval along the routed centerline
risk_line: carry and benefit when successful
bailout: width, lie, and next-shot cost
visibility: edge and floor visible from relevant origins
miss_and_recovery: likely entry, stance, exit, and target
sand_character: color, grain scale, moisture, firmness, provenance
```

Remove a bunker that does not change aim, angle, club, trajectory, or recovery.
Avoid hazard rows at arbitrary yardages and avoid stacking sand beside water
unless the combination expresses one deliberate choice.

Before shaping, pass the hazard-intent gate in `hazard-design.md`. In particular,
do not use a bunker as decorative foreground beside a tee. Record its owning hole,
route progress, lateral offset, carry-to-front/clear from each tee, bailout, and the
advantage earned by challenging it. When a strategic drive bunker looks tee-side,
verify the active scene, site transform, and decision-camera origin before changing
the bunker.

## Placement and shape

- Fit each outline to contours, drainage, approach angle, and likely dispersion.
- Prefer diagonals, staggered noses, offset groups, and varied depths over
  symmetrical flanking hazards.
- Preserve a visible, credible bailout for the intended player class.
- Draw a distinct closed control polygon, then generate a rounded spline.
  Remove duplicate points, self-intersections, needles, repeated templates,
  and sharp re-entrant corners.
- Keep green bunkers part of the full miss-and-recovery network. Preserve at
  least one short-grass recovery and do not bunker every rejecting edge.

## Construction

> In **this** engine (see `references/engine.md`) a bunker is just
> `{x, z, r, depth, pot}` — the engine carves it INTO grade with a flush rim. The
> polygon/transition/lip parameters below are prior-engine detail; the design intent
> (cut in, drain-able floor, no raised rim, credible flashed face) is what carries.

- A real bunker is a depression **cut into grade** — the sand sits below the
  surrounding turf, and the surround stays at natural grade. **Never raise a rim/ring
  around it** (that reads as a meteor crater). Framing comes from the landform, not a
  ring. → set a sensible `depth`; leave the surround to the engine.
- **Regular bunker**: a flashed face — sand sweeps up a moderate wall to a
  grade-flush rim. `pot: false`, `depth ≈ 0.7–1.2`.
- **Pot bunker**: small, deep, steep, **revetted** (stacked-sod turf walls straight
  up to a flush rim; small sand floor). `pot: true`, `r ≲ 4`, `depth ≳ 1.5`.
- Real construction (for intent): shaped floor draining to a low point, drainage
  gravel + pipe, a permeable liner, then sand (~100 mm floor / ~50 mm faces). No
  closed bathtub, floating lip, or hidden sand plane.

## Sand material

- Use a natively tileable, redistribution-safe PBR set with albedo, OpenGL
  normal, and roughness maps. Record source, author/provider, license, native
  dimensions, resolution, conversion, and compression.
- Match the site: pale angular sand for a bright desert tournament bunker,
  warmer local sand for naturalized work, and darker damp sand only where the
  drainage story supports it.
- Tile at recorded physical scale. Do not mirror quadrants, clone-stamp seams,
  bake directional lighting into albedo, or enlarge grains to hide repetition.
- Keep normal strength and roughness subordinate to the carved geometry. Sand
  should read as granular without looking rocky, glossy, or embossed.

## Validation

- Run the MCP `validate_course` tool (not `scripts/analyze-bunkers.mjs`, which
  belongs to the prior engine). Confirm no bunker sits entirely inside a green or
  water and that any `pot` is genuinely small+deep.
- Use `classify_point {x,z}` to confirm the sand lands where intended relative to the
  fairway edge and the target line.
- Review the running sim from tee, landing areas, approach, bunker floor, and green.
  The player must read the carry, edge, floor, bailout, and recovery.
- Put landing/decision review cameras before the bunker interaction band. Fail the
  review if the camera stands on the bunker shoulder or makes a distant drive bunker
  read as sand beside a tee-like foreground pad.
