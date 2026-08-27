---
name: golf-course-authoring
description: Direct realistic, spectacle, or hybrid golf-course design and revise playable simulator environments. Use for terrain routing, strategic greens, bunker shaping and sand materials, hazard placement, water, multi-tee scaling, TGL- or video-game-inspired holes, environmental dynamics, vegetation, course personalization, and physics-ready validation.
---

# Golf Course Authoring

Build the course as playable terrain, not a painted illustration.

## Workflow

0. **Read `references/engine.md` FIRST.** It describes the engine you are actually authoring for (a Three.js sim whose whole course is `course.json` — features only, terrain baked from them). Where any reference below mentions a `.golfcourse` archive, `stage_commands`, `run_course_analyzers`, catalog IDs, `environmentAssembly`, polygon control points, or an `apps/web` engine, that is a PRIOR engine — keep the design intent and map it onto `engine.md`'s features and MCP tools.
1. Read `references/course-design.md` before changing routing, landing areas, or personalized design rules.
2. Read `references/approach-design.md` before changing a green approach, surrounds, maintained-ground tie-ins, or an intentionally isolated target.
3. Classify the request as `realistic`, `spectacle`, or `hybrid`. Honor explicit mode words; use hybrid when realistic and fantasy intent coexist; otherwise default to realistic.
4. Read `references/realistic-design.md` for realistic work, `references/spectacle-design.md` for spectacle work, and both for hybrid work.
5. Read `references/hazard-design.md` in full before creating, moving, resizing, or removing any hazard. Also read `references/bunker-design.md` before bunker geometry, placement, or sand-material work.
6. Read `references/green-design.md` in full before creating, resizing, contouring, or revising a green or its surrounds.
7. When operating through an agent, use the course-engine MCP tools or the in-app builder described in `references/engine.md` (`get_course`, `classify_point`, `classify_biome`, `validate_course`, `set_course`). The engine exposes catalog-backed environment records; use `golf-environment-vibe` for dressing. Route biome, coastline, ecological-region, beach, and course-edge transition requests through `golf-biome-transitions`.
8. Read `references/visual-fidelity.md` before changing terrain rendering, surface materials, lighting, atmosphere, sky, or visual-detail systems.
9. Preserve metre scale, height-field continuity, physics surface IDs, tee/cup reachability, and deterministic results.
10. Prefer editable vector features for shaped hazards. Derive render and physics grids from those features.
11. Validate bounds, approach connectivity, carries, bailouts, clearances, playability, and golfer-height visual quality before accepting an edit. Validate via the MCP `validate_course` tool (read its warnings) and by inspecting the running sim from golfer height, low oblique, and overhead. The `scripts/analyze-*.mjs` analyzers belong to the prior engine (`.golfcourse` archives) and do not run here — do not invoke them.

## Non-negotiable rules

- Make bunker outlines closed, smooth, rounded, and free of self-intersections or pointed corners.
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
- Apply each natural-language request as one undoable transaction.
