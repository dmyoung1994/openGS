---
name: golf-environment-vibe
description: Dress playable golf holes with cohesive, strategic catalog-backed vegetation, rocks, groundcover, and deadwood, or explicit deterministic procedural tree definitions and placements. Use for hole vibe, foliage plans, landscaping, naturalization, biome dressing, and tournament polish.
---

# Golf Environment Vibe

> **Engine mapping:** claude-golfsim supports catalog-backed environment records in
> `course.project.json` under `site.environment`; routed projects compile every
> transformed hole into one shared `course.json` site. Read
> `golf-course-authoring/references/engine.md` first and map the
> design guidance below onto those records rather than the legacy command names.

Place authored catalog models or explicitly requested deterministic procedural
trees as a golf architect and landscape ecologist. A procedural definition is a
first-class source, never a fallback for a missing catalog GLB.

## Workflow

1. Read `references/vibe-recipes.md` to select a palette and composition.
   For grasslands, prairie, or naturalized fescue-style requests, use its
   photo-backed Grasslands recipe and inspect `references/grasslands-reference.jpeg`.
   This is a style-specific reference, not a default for every biome.
2. Read `references/placement-zones.md` before emitting placements.
3. Read `references/composite-assemblies.md` before building an outcrop, tree community, dense edge, or other multi-piece landmark.
4. Read the current engine mapping in
   `../golf-course-authoring/references/engine.md` before editing the course.
5. For catalog objects, inspect `public/assets/environment/catalog.json`. Use only cataloged IDs and
   respect each entry's biome, dimensions, slope, spacing, grounding, and provenance.
   When `biomeTransitions` exist, inspect `classify_biome`/compiled transition
   weights and habitat metadata; retire vegetation on sand/water weights and use
   ecotone weights to blend compatible communities without changing play physics.
   If no existing catalog entry can satisfy an explicit visual or ecological role
   and network use is authorized, read `references/asset-acquisition.md` before any
   web search or download. Do not acquire a new asset merely to create novelty.
6. Classify the prompt on four axes: biome, realistic/spectacle/hybrid,
   sparse/balanced/lush density, and manicured/naturalized finish. Infer only
   when the request is silent.
7. Reserve gameplay zones first: tees, green, fairway landing ellipses,
   recovery routes, hazard sightlines, galleries, and camera corridors.
8. Choose 5–9 compatible catalog IDs or explicitly requested procedural definitions with distinct jobs: canopy anchors, middle-story
   masses, low drifts, and optional rock/deadwood punctuation. Before mass
   scattering, audition each catalog asset at production scale in the live WebGPU
   scene. Check maturity, dimensions, canopy and trunk silhouette, grounding, PBR
   crispness, alpha behavior, and representative performance; reject an asset whose
   authored form does not serve its intended job.
   Assign age classes honestly: `forest-cluster` is mature overstory, while
   `forest-understory` is native-scale sapling/regeneration. Never inflate a
   sapling into a mature canopy substitute or a naturally open pine until its
   trunk reads as a giant pole. If the catalog lacks the requested mature crown
   form, record that gap and acquire a provenance-valid source when authorized.
9. Use `environment.assembly` for signature communities and rock outcrops.
   Use `environment.edgeDressing` for layered native-to-maintained transitions.
   Reserve `environment.placements` for deliberate accents and `scatter` for broad
   secondary masses, each limited to 2–4 related catalog IDs. Never scatter the
   whole biome catalog at once.
10. Treat canopy habitat and understory as one ecological composition. In a mature
    pine stand, keep crown cores nearly bare so authored needle litter and trunk
    contacts remain visible. Concentrate fern, grass, and sapling scatter on crown
    shoulders, forest openings, drainage lines, and maintained-to-native edges;
    never blanket every forest region with the same grass/fern pair.
    Give overstory and understory records the same `habitatMassId` when they form
    one stand. Tree crowns own exact grass exclusion only. Maintained pine straw is
    authored separately as stable site-level `forest-floor-area` polygons: broad,
    continuous woodland beds with sparse sweeping controls, never individual crown
    halos, all-deep-rough fill, or assembly rectangles. Match each bed to strategy
    and trunk composition, preview it from tee, landing, approach, and overview,
    then revise that stable entity. Keep the turf cut tight; soften the ecology with
    deliberate understory outside it, not a blurred or misregistered material edge.
11. Use a stable integer seed derived from course name, hole number, zone, and
    palette. Repeating the same request on unchanged terrain must reproduce the
    same layout.
12. Validate strategy, clearances, spacing, slope, density, asset count, and
    fidelity labels. Remove any placement that reads as a grid, blocks the
    intended shot, floats, intersects a bunker/water body, or misrepresents a
    form analogue as an exact species. Validate clearance against each resolved
    object footprint, not the full bounding rectangle of a forest assembly.
    Deliberate mature-tree strips in separator rough between fairways are valid
    strategic woodland, provided actual trunks/crowns stay off maintained play
    and the routing retains its intended recovery choices.
13. In Course Creator, ask existing-vs-custom only when source choice is material
    and ambiguous. Audition relevant candidates through the typed production-scene
    tree comparison, let the user select and then confirm, and keep previews outside
    project/history/object budgets. Prefer the catalog before spending ImageGen and
    fitting work. Promote an accepted custom definition into
    `public/assets/procedural-trees/catalog.json`; rejected temporary candidates are
    not reusable assets. Do not infer cross-course style preferences from a choice.

## Hard constraints

- Require `assetId` on every catalog placement. A procedural tree instead requires
  a validated reusable `proceduralTreeDefinition` plus placements with stable ID,
  `definitionId`, seed, age, health, wind exposure, transform, and scale; never mix
  the two source contracts. Use `npm run tree:build` or the tree-builder MCP to
  validate and fit definitions.
- Discover approved reusable procedural definitions through the procedural-tree
  catalog. Keep that registry distinct from the authored GLB catalog even when the
  agent presents both through one asset query.
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
- Do not judge density from retained source counts. Confirm perceived crown mass
  from golfer-height tee, landing, and green views; complete residency can still
  look empty when a sparse source or over-reduced LOD dominates the visible tier.
- Build important trees and outcrops as deterministic multi-piece assemblies with shared ecological or geologic logic.
- Treat catalog fidelity honestly. `form-analogue`, `material-analogue`, and
  `biome-analogue` describe visual use, not botanical identity.

## Output

In direct live-build mode, edit deterministic records with stable IDs and report a
short palette rationale plus the assets auditioned, rejected, and placed. In
proposal-review mode, return that rationale and no more than 80 proposal cards;
every semantic object keeps a stable ID even when the UI groups cards, and applying
selected cards creates per-object history events.
