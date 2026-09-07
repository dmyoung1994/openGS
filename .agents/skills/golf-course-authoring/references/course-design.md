# Course design rules

## Routing and playability

- Work in local metres. Keep tee, cup, feature points, and object locations inside the authored bounds.
- Preserve a playable route from tee to cup. Evaluate intended landing zones, alternate lines, recovery space, green access, and severe slopes.
- Use hazards to create strategic decisions rather than random punishment. Avoid invisible hazards and geometry that cannot be read from the playing camera.
- Keep green surrounds varied but recoverable. False fronts and falloffs need smooth terrain transitions and must not create mesh discontinuities.

## Multi-hole site flow

Before detailing any individual hole in a request for two or more holes, sketch the entire sequence as a site plan. A list of holes that all restart from the same local tee origin is not evidence of a connected routing.

- Give every hole a distinct conceptual tee, centerline, landing pattern, green, and direction of play in the site plan. Vary direction enough to create rhythm and changing wind without forcing unsafe crossing play.
- Evaluate each green-to-next-tee transition. Keep it direct and intentional, place the next tee outside the prior green's common miss and recovery areas, and keep walkers away from the next hole's primary shot cone.
- Check route envelopes, not centerlines alone. Include dispersion, alternate lines, bailout areas, hazard recoveries, maintenance access, and spectator space when deciding whether two holes conflict.
- Avoid repeated backtracking, blind crossings, and long connector walks with no landscape purpose. Relate the opening tee and final green sensibly to the clubhouse or entry point when one is part of the brief.
- Record an audit with one row per hole: transformed tee, green, next tee, transition distance and bearing, adjacent-hole conflicts, and the design response. Preserve a compact version in `project.meta.notes`. Flag rather than hide unresolved conflicts.

In claude-golfsim, each hole remains easy to author in its local negative-z coordinates. `site.routing.placements` rotates/translates those holes onto one site, while `site.routing.transitions` joins consecutive green-to-tee walks. The compiler rejects crossing centerlines and requires at least 12 m between non-adjacent rough envelopes. The schema-v4 runtime renders every transformed route, tee, feature, landform, and connector on one terrain; use `window.golf.selectHole(holeId)` to review active-hole address and launch direction without rebuilding it.

## Bunkers

- Accept any sensible control-polygon silhouette, including concave and asymmetric forms, then convert it to a closed rounded spline.
- Remove duplicate points, prevent self-intersections, and resample the spline at stable spacing. Enforce a minimum local turning radius so no boundary becomes a needle or point.
- Carve an editable terrain feature with:
  - a sand floor below adjacent grade;
  - a smooth transition bank outside the sand edge;
  - an optional rounded lip no higher than is visually and physically credible;
  - a subtle drainage direction or floor slope;
  - continuous height and normals at the tie-in.
- Rasterize sand only inside the final spline. Physics height and surface grids must match the rendered feature.
- Default to a natural tournament bunker: 0.65 m floor depth, 3.5 m transition, 0.12 m rounded lip, and 1% floor drainage. Clamp depth to 0.25–2.5 m, transition to 1.5–12 m, and lip to 0–0.6 m.

## Personalized rules

- “For all my courses” changes creator-profile preferences.
- “For this course” changes portable course-specific rules.
- Do not persist ordinary edit prompts as rules.
- Resolve shared mandatory rules first, creator preferences second, and course overrides last. Preferences cannot disable schema, licensing, bounds, deterministic physics, or playability validation.
