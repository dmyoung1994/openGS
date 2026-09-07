# Strategic hazard design

Design hazards as decisions, not decoration or indiscriminate punishment.

## Hazard brief

Define before generating geometry:

```yaml
role: strategic | heroic | directional | recovery | penal | framing
target_players: casual, skilled, tour
shot_context: tee shot, layup, approach, recovery
stable_id: authored hazard ID
route_progress_band: intended shot interval along the routed centerline
preferred_line: rewarded origin and target
risk_line: carry, dispersion, benefit when successful
bailout: minimum width, resulting lie, next-shot cost
miss_outcomes: short, long, left, right
visibility: what each tee and likely lie can see
penalty_rule: red-area, yellow-area, stroke-and-distance, replay
```

If the hazard has no answer to “what better decision does this create?”, move, reshape, or remove it.

## Hazard-intent gate

Before accepting geometry, project every hazard onto the owning hole's routed
centerline and verify its stable ID, owning hole, shot context, route-progress band,
lateral offset, carry-to-front, carry-to-clear, bailout, and earned benefit. A
hazard is not justified merely because it is near a conventional yardage or makes a
camera composition look busier.

- Reject a tee-foreground or tee-adjacent hazard unless it affects a declared shot
  from that tee or is an explicit recovery/construction feature with appropriate
  play behavior. Decorative sand beside a tee is not a golf hazard.
- If a hazard with a valid long carry appears beside the tee or under a review
  camera, first check scene ownership, local-to-site transforms, active-hole state,
  and camera placement. Do not move sound strategy to conceal a review bug.
- Place decision cameras before the relevant dispersion band and aim through the
  hazard toward its reward. Never stand the review camera on the bunker shoulder or
  inside the landing zone and call that proof of placement.
- Require a golfer-height tee view and a preceding-decision view that make the same
  strategic story legible. An overview alone cannot pass the gate.

## Placement

- Map realistic carry and dispersion bands from every tee before placing the hazard.
- Keep the immediate teeing-ground, stance, follow-through, access, and camera
  foreground free of unrelated play hazards.
- Scale the same strategic question across casual, skilled, and tour tees instead of merely shortening the hole.
- Prefer diagonal hazards, staggered edges, offset targets, corner carries, and hazards that change the next-shot angle.
- Reward accepted risk with a shorter shot, better view, better angle, flatter lie, or easier pin access.
- Make conservative play genuinely viable but meaningfully less advantageous.
- Avoid hazards covering the whole route when the player has no prior positional choice. Use a forced carry only when its length is fair, visible, and central to the hole's identity.
- Do not stack unrelated penalties. Water plus bunker plus severe rough at one miss requires an explicit strategic reason.

## Water geometry

- Author one closed rounded shoreline spline. Derive basin terrain, water plane, render mask, physics volume, and penalty boundary from it.
- Set a constant water elevation. Lower the basin floor beneath it and shape banks continuously into surrounding grade.
- Declare a bank profile for every water feature from the hole's role and site: `naturalGraded` for broad lakeshores, `hybridSteepBank` for a playable outer grade with a crisp visible inner face, or `engineeredWall` for deliberately constructed retaining edges. This is a per-hole earthwork decision, never a global renderer toggle.
- Use broad natural banks for lakes and coves; use narrower incised banks for creeks. Avoid rectangular cuts and constant-width ribbons unless the setting is intentionally constructed.
- Connect water to the site's drainage story: feeder, outlet, lowland, canyon, coast, quarry, or engineered reservoir.
- Keep the near bank readable from play. Avoid a water plane floating above terrain or hidden below a hard terrain lip.
- Preserve dry relief and drop space along penalty boundaries.

## Other hazards

- Use bunkers to signal strategy, defend a line, collect misses, or complicate recovery; follow the carved-bunker rules in `course-design.md`.
- Use cliffs, canyons, waste areas, native vegetation, and rock as site-scale hazards only when their collision, lie, penalty, and recovery behavior are explicit.
- Use wind as a spatial hazard in spectacle or exposed realistic settings. Show it through water, vegetation, particles, flags, sound, or environmental motion.

## Validation

- Report carry-to-front, carry-to-clear, lateral bailout width, and target benefit from every tee.
- Report stable hazard ID, owning hole, route progress, lateral offset, and intended
  shot origin so local/site transform mistakes cannot masquerade as design.
- Trace conservative, neutral, and hero lines with the authoritative physics solver.
- Confirm the entire conservative corridor remains dry and collision-valid.
- Confirm hazard outlines, visual surfaces, height field, physics mask, and penalty boundary agree.
- Flag invisible water, accidental full-width carries, unreachable carries, zero-width bailouts, disconnected water masks, shoreline slopes above the design intent, and drop areas nearer the hole.

## Failure patterns

- Water painted across the fairway without a strategic line or geological reason.
- A hazard located at an arbitrary round distance rather than a player decision band.
- Decorative or transformed sand beside a tee that does not change the opening shot.
- A valid landing hazard photographed from on top of its edge, making it read as
  tee-side clutter and obscuring its actual carry.
- A heroic carry whose reward is no different from the safe route.
- A safe route that is technically dry but too narrow for its target player.
- Water rendered at one elevation while physics collides with the basin floor.
- Spectacle that hides the landing area or makes success depend on animation frame timing.

## Sources

- [USGA: Building Blocks of Great Course Architecture](https://www.usga.org/content/usga/home-page/articles/2025/10/building-blocks-great-course-architecture.html) — hazards and surrounds should create decisions and varied recovery questions.
- [USGA: The Evolution of Shinnecock Hills](https://www.usga.org/content/usga/home-page/history/the-evolution-of-the-shinnecock-hills-golf-course.html) — strategic hazards, natural landforms, acute doglegs, and preferred angles.
- [Calusa Pines: Architects' Vision](https://calusapinesgolfclub.com/architect-vision) — water, preserve areas, height, privacy, and memorable strategic sequences.
