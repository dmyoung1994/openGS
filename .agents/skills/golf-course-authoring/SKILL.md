---
name: golf-course-authoring
description: Direct realistic, spectacle, or hybrid golf-course design and revise playable simulator environments. Use for terrain routing, strategic greens, bunker shaping and sand materials, hazard placement, water, multi-tee scaling, TGL- or video-game-inspired holes, environmental dynamics, vegetation, course personalization, and physics-ready validation.
---

# Golf Course Authoring

Build the course as playable terrain, not a painted illustration.

## Workflow

0. **Read `references/engine.md` FIRST.** It describes the engine you are actually authoring for: `course.project.json` v5 is the editable source. Routed projects compile the complete shared site to `course.json` v4; only unrouted practice projects retain the legacy v3 runtime. Where another reference mentions a `.golfcourse` archive, `stage_commands`, or `run_course_analyzers`, keep the design intent and ignore those prior-engine mechanics.
1. Read `references/course-design.md` before changing routing, landing areas, or personalized design rules. For two or more holes, complete its whole-site flow audit before detailing individual holes and do not confuse a collection of independently playable local holes with a connected course routing.
2. Read `references/approach-design.md` before changing a green approach, surrounds, maintained-ground tie-ins, or an intentionally isolated target.
3. Classify the request as `realistic`, `spectacle`, or `hybrid`. Honor explicit mode words; use hybrid when realistic and fantasy intent coexist; otherwise default to realistic.
4. Read `references/realistic-design.md` for realistic work, `references/spectacle-design.md` for spectacle work, and both for hybrid work.
5. Read `references/hazard-design.md` in full before creating, moving, resizing, or removing any hazard. Also read `references/bunker-design.md` before bunker geometry, placement, or sand-material work.
6. Read `references/green-design.md` in full before creating, resizing, contouring, or revising a green or its surrounds.
7. Choose the actual authoring mode. In a **direct live build**, edit the v5 workspace project in small compiled checkpoints while the same WebGPU page renders and reports revision-tagged observations. In **proposal review**, return typed semantic-object mutations for preview and apply only selected cards. Read `references/live-editor-loop.md` for direct live work. Use `golf-environment-vibe` for dressing and `golf-biome-transitions` for coastline/ecotone work.
8. Read `references/visual-fidelity.md` before changing terrain rendering, surface materials, lighting, atmosphere, sky, or visual-detail systems.
9. Preserve metre scale, height-field continuity, physics surface IDs, tee/cup reachability, and deterministic results.
10. Prefer editable vector features for shaped hazards and maintained ground regions. Author pine-straw beds as stable `forest-floor-area` entities with sparse site-space controls; never derive their silhouette from tree scatter. Derive render and physics grids from those features.
11. Validate bounds, approach connectivity, carries, bailouts, clearances, playability, and golfer-height visual quality before accepting an edit. For multi-hole work, also report green-to-next-tee transitions, crossing-play conflicts, backtracking, and start/finish coherence. In direct live mode, use the repository compiler/tests and revision-matched WebGPU observations; in proposal-review or MCP mode, use `validate_course` and inspect its warnings. The `scripts/analyze-*.mjs` analyzers belong to the prior engine and do not run here.
12. When implementation work adds or materially changes an authorable system, update the relevant engine or fidelity reference in the same task. Document durable capabilities, physical invariants, and validation criteria; keep one-off tuning constants and implementation experiments in code and tests.

## Non-negotiable rules

- Make bunker outlines closed, smooth, rounded, and free of self-intersections or pointed corners.
- Give every hazard a stable owning-hole identity and a declared shot context,
  route-progress band, carry, lateral offset, bailout, and earned benefit. Reject
  decorative tee-side hazards and camera views that stand inside the interaction band.
- Carve bunkers into terrain with a floor, transition bank, and optional lip; never represent a new bunker as sand paint at the unchanged ground elevation.
- Give every water hazard a declared strategic role, a visible continuous shoreline, a real basin, a deterministic water level, a viable bailout unless explicitly designed as a fair forced carry, and appropriate carries from casual, skilled, and tour tees.
- Keep spectacle mechanics deterministic and legible. Preserve authentic ball flight and contact; use wind volumes, timed physical gates, waterfalls, and moving scenery rather than portals or boosters.
- Design a green as one system comprising approach angle, putting surface, collar, surrounds, hazards, misses, recovery shots, target speed, drainage, and pin rotation. Never generate random height noise and call it contouring.
- Connect ordinary greens to the hole through playable ground, landform, and sightline. Allow an island only as a declared target premise with fair scaled carries and explicit recovery or drop logic.
- Give every green a legible primary contour idea, multiple quiet pin regions, continuous drainage exits, and at least one recoverable miss. Couple usable slope to intended green speed.
- Keep built-in assets permissively licensed and record source, author, license, dimensions, and optimization provenance.
- Place plants according to biome, slope, moisture, spacing, and clustering metadata. Keep tees, greens, intended landing areas, and shot corridors clear unless the prompt explicitly requests obstruction.
- Resolve visual quality at four scales: surface microstructure, playable landform, course-edge composition, and distant atmosphere. A high-resolution texture alone does not satisfy this rule.
- Keep turf matte and scale-correct. Greens, fairways, rough, sand, native ground, and rock need distinct material response; never recolor one glossy turf material and call the surfaces finished.
- Use separate licensed rock or cliff models for silhouettes, overhangs, ledges, and vertical relief that a height field cannot represent.
- Treat creator-wide rules as preferences, course rules as overrides, and engine/physics/licensing constraints as mandatory.
- Make each independently valid changed semantic object its own undoable history event. When a routed-site placement and new holes cannot satisfy schema validation separately, group only that smallest dependency-closed set into one clearly labeled reversible checkpoint. Keep dependency links explicit so the builder can explain blocked or cascading reversions.
