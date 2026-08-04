# Course design rules

## Routing and playability

- Work in local metres. Keep tee, cup, feature points, and object locations inside the authored bounds.
- Preserve a playable route from tee to cup. Evaluate intended landing zones, alternate lines, recovery space, green access, and severe slopes.
- Use hazards to create strategic decisions rather than random punishment. Avoid invisible hazards and geometry that cannot be read from the playing camera.
- Keep green surrounds varied but recoverable. False fronts and falloffs need smooth terrain transitions and must not create mesh discontinuities.

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
