# This engine (claude-golfsim) — READ FIRST

These skills were written for an earlier engine (an `apps/web` app with a
`.golfcourse` archive, an MCP command schema of `stage_commands` /
`environmentAssembly` / catalog IDs, and `scripts/analyze-*.mjs` analyzers). **That
tooling does not exist in this repository.** This file is the authoritative
description of the engine you are actually authoring for. When any other reference
describes prior-engine mechanics — `.golfcourse` archives, `stage_commands`,
`run_course_analyzers`, catalog IDs, `environmentAssembly` / `dressCourseEdge`,
polygon control points, transition-bank/lip construction values — **keep the design
intent and map it onto the features and tools below.** Ignore the mechanics.

## What this engine is

A Three.js / WebGPU golf simulator. The editable source of truth is
`course.project.json` schema v4: one site, 1–18 holes, stable object IDs, route
splines, semantic landforms, atmosphere, and environment records. The active hole
compiles deterministically to `course.json` schema v3, the strict physics/render
manifest. The engine BAKES the terrain heightfield and surface classes from those
features (`src/scene/Range.js` `_height` / `_surface`). **Never author raw heights,
meshes, materials, renderer algorithms, or shaders through a course prompt.**

The renderer also has one deterministic environment timeline shared by sky,
clouds, directional light and shadows, water, distant terrain, vegetation, and
physics-facing wind state. Solar and lunar direction, spectrum, illuminance,
phase, atmosphere, and exposure are transported through `EnvironmentFrameState`
and `EnvironmentGpuBindings`; visual systems should consume those shared values
instead of creating independent time-of-day colors or light directions.

The production post graph resolves opaque TRAA and depth-aware cloud transport,
then samples the existing TRAA texture for one thresholded eighth-resolution HDR
bloom pass, attenuated by cloud transmittance before neutral tone mapping.
Directional terrain/tree shadows are cached in a course-bounds-fitted
projection; ball flight must not recenter that projection or redraw it per step.
TRAA retains its bounded Halton projection sequence during cinematic camera motion;
the velocity/depth resolve owns history rejection instead of falling back to a
single hard sample for each moving frame.
After HDR bloom and the explicit Neutral/sRGB transform, one display-referred FXAA
pass cleans current-frame disocclusion edges that have no safe temporal history.

## Coordinate system

Metres throughout. `x` = lateral (right is `+x`). `z` = down-range: the tee sits
near `z ≈ 2` and the course runs toward **negative z**. A green D yards out sits at
`z ≈ -D * 0.9144` (e.g. 150 yд → `z ≈ -137`). `y` (elevation) is computed
automatically — you do not set it.

## Project and runtime schemas

Author mutations target the v4 project, never an arbitrary JSON path. Supported
semantic types are `project`, `site`, `atmosphere`, `hole`, `route`, `tee`,
`green`, `bunker`, `pond`, `landform`, `environment-object`, and
`synthetic-tree`. Every item uses a stable kebab-case ID and changes exactly one
object. `route.points` is the editable centerline spline; landforms use registered
forms (`ridge`, `bowl`, `shelf`, `saddle`, `shoulder`, `drainage-channel`,
`plateau`, `swale`). The compiler currently lowers the active hole into the
runtime corridor and feature representation below.

The project-level atmosphere preset is data, not a renderer override:
`climate`, `season`, `localTime`, `weather`, `cloudCoverage`, `windSpeedMph`, and
`windDirectionDegrees`. It configures the existing deterministic environment
timeline; sky scattering, sun/moon light, stars, clouds, bloom, and shadows remain
engine-owned algorithms.

The compiled `course.json` contract is:

```jsonc
{
  "meta":   { "name": "…", "mode": "realistic", "schema": 3 },
  "catalogVersion": 2,
  "placementAlgorithmVersion": 1,
  "biome": "temperate-maritime",
  "biomeTransitions": [],
  "environmentSeed": 1128746828,
  "bounds": { "minX": -110, "maxX": 110, "minZ": -340, "maxZ": 30 },
  "tee":    { "x": 0, "z": 2, "boxHalfX": 3.2, "z0": -2, "z1": 6 },
  "corridor": { "c0": 32, "k": 0.11, "rough": 26 },  // fairway half-width(m) = c0 + (-z)*k; then a rough band of width `rough`; beyond that, deep rough
  "fringeW": 2.2,                                     // green collar width (m)
  "greens":  [ { "yards": 150, "x": -14, "r": 9, "contour": "spine" } ],
  "bunkers": [ { "x": 20, "z": -86, "r": 5.0, "depth": 1.0, "pot": false } ],
  "ponds":   [ { "x": 55, "z": -122, "r": 15, "depth": 1.6 } ],
  "atmosphere": { "climate": "temperate-maritime", "season": "summer", "localTime": "15:30", "weather": "partly-cloudy", "cloudCoverage": 0.25, "windSpeedMph": 8, "windDirectionDegrees": 250 },
  "environment": {
    "foliageAliases": ["builtin.douglas-fir.pnw.v1", "builtin.monterey-cypress.coastal.v1"],
    "objectBudget": 700,
    "placements": [ { "id": "hero-tree", "assetId": "polyhaven-island-tree-01", "x": -72, "z": -70, "rotationY": 1.15, "scale": 1.55 } ],
    "scatter": [],
    "assembly": [],
    "edgeDressing": [],
    "exclusions": [],
    "syntheticTrees": [ { "id": "oak-left-1", "archetype": "live-oak", "x": -72, "z": -70, "rotationY": 1.15, "scale": 1.1, "seed": 42, "age": 0.85, "health": 0.95, "windExposure": 0.6 } ]
  }
}
```

- **greens** — `yards` (z auto-derived if `z` omitted), `x`, `r` (~6–12 m), and one
  named `contour`. Contour vocabulary (the ONLY internal shaping — never author raw
  height noise): `tilt` (back-high, feeds front), `punchbowl` (gathers to centre),
  `spine` (central ridge splits L/R pins), `tier` (two shelves), `crown` (pushed-up
  turtleback), `saddle` (twin shoulders, central pass). Give each green ONE legible
  contour and vary them across the set.
- **bunkers** — `x`, `z`, `r`, `depth` (m below grade), `pot` (bool). Bunkers are
  **cut INTO grade with no raised rim** (a raised ring reads as a meteor crater —
  see `bunker-design.md` intent, but note this engine has no `lip`/transition-bank
  parameter; depth + pot are the whole model). `pot: true` = a small (`r ≲ 4`), deep
  (`depth ≳ 1.5`) steep **revetted** links pit; the engine renders the near-vertical
  faces as stacked-sod turf and keeps sand on the small floor. Regular bunkers flash
  sand up a gentler wall to a grade-flush rim.
- **ponds** — `x`, `z`, `r`, `depth`. A dished water basin with a deterministic
  surface level.

## Environment dressing

Catalog-backed trees, shrubs/groundcover, rocks, and deadwood are authorable through
`environment.placements`, `scatter`, `assembly`, and `edgeDressing`. Asset IDs must
exist in `public/assets/environment/catalog.json`; placement is deterministic from
the course and record seeds, constrained by catalog spacing/slope data, protected
playing surfaces, exclusions, and the hard object budget. Raw terrain elevation and
materials remain intentionally non-authorable.

Generated foliage is selected by a versioned `environment.foliageAlias` string or
an ordered, unique `environment.foliageAliases` array; the forms are mutually
exclusive. Aliases resolve through the immutable built-in/local pack registry, never
through raw course paths. Practice-range planting derives its perimeter mix only from
the declared aliases and fails closed on an undeclared species.

`environment.syntheticTrees` is a separate explicit source for deterministic,
geometry-only trees. Registered archetypes are `broadleaf-oak`, `live-oak`,
`maple`, `monterey-cypress`, `douglas-fir`, and `loblolly-pine`. Bark relief,
crown form, age, health, and scale are procedural geometry/material parameters;
there are no scan or generated texture dependencies. These records never stand in
for catalog assets. A missing or invalid Poly Haven GLB still fails closed. Both
sources use stable grass-canopy suppression and camera-independent light-owned
shadow residency so beauty LOD changes cannot make flight shadows disappear.

## Authoring paths

1. **Dedicated Course Creator** — `/creator.html` opens on a disposable, seeded
   regulation green with a true green/fringe surface boundary, restrained playable
   contour, no hazards, trees, backdrop terrain, or visible ball. The finite rendered
   terrain and its open earthen skirt follow the same organic outer-fringe outline, so
   no square authoring tile is exposed. One slender clear-coated hardwood production
   pin and recessed cup occupy the green's quiet core; its fixed-step cloth consumes the shared
   environment wind and is not part of editable course data. It is real
   collision/render terrain, not a placeholder. Its top mesh terminates at the
   regulation 108 mm cup opening instead of sealing the recessed liner beneath turf;
   the opening is presentation geometry and does not alter the height-field physics
   until an authored course replaces the disposable showcase. The live
   WebGPU world stays full-screen beneath translucent chrome: a top-right icon-only menu button
   opens the full-screen Range / Course Creator / Play destination menu, and the
   chat/action history is hidden by default behind a small history tab. The bottom
   prompt, fly/preset camera controls, and semantic object picker provide authoring
   context without moving the creator into the practice-range UI. The opening green
   starts in a close, long-lens three-quarter terrain-maquette composition that makes
   its contour, collar, earth edge, regulation pin, and wind response immediately
   legible without wide-angle perspective keystoning.
   Previewing or
   applying a proposal replaces the showcase with the authored course; starting a new
   conversation advances its deterministic variant and reframes a fresh green, while
   preview recovery and hot rebuilds retain the current variant. A picked terrain point
   resolves to the closest stable v4
   object (or terrain surface/biome context), and that selection plus the current
   camera view are attached to the prompt. The creator also captures automatic
   tee/landing/approach/overview review views. The local Codex SDK runs
   read-only in an isolated temporary workspace and returns typed proposal cards;
   it never edits the repository. The designer previews, revises, rejects, or
   applies cards individually. Dependencies are included and explained. Accepted
   objects are saved to `course.project.json`, compiled to `course.json`, and kept
   as separate semantic undo events. An existing Codex login is required; there is
   no API-key fallback in the local creator.
2. **Terminal via MCP** — the course-engine MCP server (`scripts/course-mcp.mjs`)
   exposes the tools below. Register it: `claude mcp add course-engine -- node
   scripts/course-mcp.mjs` (or `codex mcp add …`). Writes land on `course.json`,
   which live-reloads the running sim.

Runtime schema v3 requires `meta.schema: 3` and `biomeTransitions` (use `[]` when no
transition is intended). For transition records and registered profiles, read
`../../golf-biome-transitions/references/engine-contract.md`.

### MCP tools (course-engine)

- `describe_schema` — the schema + contour vocabulary (this file, condensed).
- `get_course` — current `course.json` + a summary.
- `classify_point {x,z}` — the playing surface at a point (tee/green/fringe/fairway/
  rough/deepRough/sand/water), the fairway half-width at that z, and nearby
  features. **Use this to place features precisely** (it replaces the prior engine's
  `inspect_region`).
- `classify_biome {x,z}` — semantic transition owner, habitat, profile weights,
  and primary/target biome at a point; it does not replace gameplay classification.
- `validate_course {course?}` — normalize + design sanity checks (bounds, feature
  overlaps, undersized "pots"); returns warnings. Does not write.
- `set_course {course}` — validate then write the full course. This is the
  mutation (it replaces `stage_commands`); read `get_course`, edit, `set_course`.

## Workflow mapping (from the SKILL steps)

- "Operate through the engine tool server / inspect before editing" → call
  `get_course` and `classify_point` before authoring; make edits with `set_course`.
- "Run the green/approach/hazard/bunker analyzers" → run `validate_course` and read
  its warnings; there are no `.mjs` analyzers here. Prove geometry with validation;
  prove look by inspecting the running sim (golfer height, low oblique, overhead).
- "Prefer editable vector features; derive render/physics grids from them" → already
  true by construction: you edit features, the engine derives everything.
- Keep one proposal item per semantic object. Applying multiple selected cards is
  coherent at the project level but records independent object history; keep metre
  scale, tee reachability, dependencies, and features within bounds.
