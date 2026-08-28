---
name: golf-environment-vibe
description: Dress playable golf holes with cohesive, strategic catalog-backed vegetation, rocks, groundcover, and deadwood, or explicit deterministic synthetic tree records. Use for hole vibe, foliage plans, landscaping, naturalization, biome dressing, and tournament polish.
---

# Golf Environment Vibe

> **Engine mapping:** claude-golfsim supports catalog-backed environment records in
> `course.project.json` under `site.environment`; the active hole compiles to
> `course.json`. Read `golf-course-authoring/references/engine.md` first and map the
> design guidance below onto those records rather than the legacy command names.

Place authored catalog models or explicitly requested deterministic synthetic
trees as a golf architect and landscape ecologist. A synthetic record is a
first-class source, never a fallback for a missing catalog GLB.

## Workflow

1. Read `references/vibe-recipes.md` to select a palette and composition.
2. Read `references/placement-zones.md` before emitting placements.
3. Read `references/composite-assemblies.md` before building an outcrop, tree community, dense edge, or other multi-piece landmark.
4. Read the current engine mapping in
   `../golf-course-authoring/references/engine.md` before editing the course.
5. For catalog objects, inspect `public/assets/environment/catalog.json`. Use only cataloged IDs and
   respect each entry's biome, dimensions, slope, spacing, grounding, and provenance.
   When `biomeTransitions` exist, inspect `classify_biome`/compiled transition
   weights and habitat metadata; retire vegetation on sand/water weights and use
   ecotone weights to blend compatible communities without changing play physics.
6. Classify the prompt on four axes: biome, realistic/spectacle/hybrid,
   sparse/balanced/lush density, and manicured/naturalized finish. Infer only
   when the request is silent.
7. Reserve gameplay zones first: tees, green, fairway landing ellipses,
   recovery routes, hazard sightlines, galleries, and camera corridors.
8. Choose 5–9 compatible catalog IDs or synthetic archetypes with distinct jobs: canopy anchors, middle-story
   masses, low drifts, and optional rock/deadwood punctuation. Use several age
   scales and rotations without exceeding catalog ranges.
9. Use `environment.assembly` for signature communities and rock outcrops.
   Use `environment.edgeDressing` for layered native-to-maintained transitions.
   Reserve `environment.placements` for deliberate accents and `scatter` for broad
   secondary masses, each limited to 2–4 related catalog IDs. Never scatter the
   whole biome catalog at once.
10. Use a stable integer seed derived from course name, hole number, zone, and
    palette. Repeating the same request on unchanged terrain must reproduce the
    same layout.
11. Validate strategy, clearances, spacing, slope, density, asset count, and
    fidelity labels. Remove any placement that reads as a grid, blocks the
    intended shot, floats, intersects a bunker/water body, or misrepresents a
    form analogue as an exact species.

## Hard constraints

- Require `assetId` on every catalog placement. A synthetic tree instead requires
  a stable ID, registered `archetype`, seed, age, health, wind exposure, transform,
  and scale; never mix the two source contracts.
- Never emit a raw primitive, billboard, atlas, placeholder, or procedural fallback
  for an authored catalog asset. Catalog load failures must remain terminal.
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

When operating through the course agent, return a short palette rationale and no
more than 80 proposal cards. Every tree has a stable object ID even when the UI
groups the cards. Applying selected cards creates per-object history events.
