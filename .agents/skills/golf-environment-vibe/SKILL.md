---
name: golf-environment-vibe
description: Dress playable golf holes with cohesive, strategic vegetation, rocks, groundcover, and deadwood selected from the licensed external-model catalog. Use when a user asks for a hole vibe, environmental character, foliage plan, landscaping, naturalization, biome dressing, tournament polish, or placement of environment-kit assets around a golf course.
---

# Golf Environment Vibe

> **Not usable in the current claude-golfsim engine.** This skill places props from a
> licensed external-model catalog via `environmentAssembly` / `scatter` /
> `dressCourseEdge` commands — none of which exist here. This engine renders a
> procedural tree line that frames the fairway corridor automatically; there is no
> per-prop placement API yet. Kept for when feature-level vegetation is added. For
> course authoring today, use `golf-course-authoring` (see its `references/engine.md`).

Place real catalog models as a golf architect and landscape ecologist. Never
create geometric substitutes.

## Workflow

1. Read `references/vibe-recipes.md` to select a palette and composition.
2. Read `references/placement-zones.md` before emitting placements.
3. Read `references/composite-assemblies.md` before building an outcrop, tree community, dense edge, or other multi-piece landmark.
4. Read `references/agent-engine-tools.md` and `references/agent-environment-commands.md` before emitting course-agent commands.
5. Inspect `apps/web/src/environment-kit.ts` and
   `apps/web/public/environment-kit/provenance.json`. Use only IDs present in
   both. Respect each entry's biome, dimensions, slope, spacing, and cluster
   metadata.
6. Classify the prompt on four axes: biome, realistic/spectacle/hybrid,
   sparse/balanced/lush density, and manicured/naturalized finish. Infer only
   when the request is silent.
7. Reserve gameplay zones first: tees, green, fairway landing ellipses,
   recovery routes, hazard sightlines, galleries, and camera corridors.
8. Choose 5–9 compatible IDs with distinct jobs: canopy anchors, middle-story
   masses, low drifts, and optional rock/deadwood punctuation. Use several age
   scales and rotations without exceeding catalog ranges.
9. Use `environmentAssembly` for signature tree communities and rock outcrops.
   Use `dressCourseEdge` for layered native-to-maintained transitions. Reserve
   `place` for a deliberate solitary accent and `scatter` for broad secondary
   masses, each limited to 2–4 related catalog IDs. Never scatter the whole
   biome catalog at once.
10. Use a stable integer seed derived from course name, hole number, zone, and
    palette. Repeating the same request on unchanged terrain must reproduce the
    same layout.
11. Validate strategy, clearances, spacing, slope, density, asset count, and
    fidelity labels. Remove any placement that reads as a grid, blocks the
    intended shot, floats, intersects a bunker/water body, or misrepresents a
    form analogue as an exact species.

## Hard constraints

- Require `catalogId` on every environment `place` command.
- Never emit a raw primitive `kind`, image card, generated mesh, or procedural
  fallback.
- Keep large trees off greens, tees, bunker floors, water, primary landing
  areas, and the first 12 m of the tee sightline.
- Use rocks as geologic systems following contours; do not salt-and-pepper
  isolated boulders uniformly across turf.
- Concentrate moisture-loving forms near drainage and water. Put drought forms
  on exposed shoulders and rocky transitions.
- Preserve a clean pin backdrop and readable hazard edges from golfer height.
- Prefer negative space. A premium environment has intentional views, not the
  maximum possible object count.
- Compose depth in foreground, middle ground, and backdrop. A single sparse perimeter scatter is not a finished environment.
- Build important trees and outcrops as deterministic multi-piece assemblies with shared ecological or geologic logic.
- Treat catalog fidelity honestly. `form-analogue`, `material-analogue`, and
  `biome-analogue` describe visual use, not botanical identity.

## Output

When operating through the course agent, return one undoable response with a
short palette rationale and no more than 80 commands. When editing course data
directly, use the same catalog, seeding, zoning, and validation rules.
