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
`course.project.json` schema v5: one site, 1–18 holes, stable object IDs, route
splines, semantic landforms, atmosphere, and environment records. A routed project
compiles deterministically to a shared-site `course.json` schema v4; an unrouted
practice project retains the legacy schema-v3 contract. The engine BAKES the terrain
heightfield and surface classes from those features (`src/scene/PlayableCourseScene.js`
`_height` / `_surface`). **Never author raw heights,
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
The graph proceeds directly from TRAA and bloom through the explicit Neutral/sRGB
transform. Do not add a second display-space antialiasing pass: it softens authored
asset detail instead of reducing geometry cost.

## Coordinate system

Metres throughout. `x` = lateral (right is `+x`). `z` = down-range: the tee sits
near `z ≈ 2` and the course runs toward **negative z**. A green D yards out sits at
`z ≈ -D * 0.9144` (e.g. 150 yд → `z ≈ -137`). `y` (elevation) is computed
automatically — you do not set it.

That coordinate contract is local to each authored hole. For a multi-hole project,
`site.routing.placements` gives every hole a site origin and bearing, and
`site.routing.transitions` authors each consecutive green-to-tee connector. The
compiler transforms all routes and features into one bounded site, validates route
crossings and non-adjacent rough-envelope separation, and emits one shared terrain.
Page identity owns composition selection: `/range.html` uses the thin
single-corridor `Range`, `/creator.html` uses `CreatorScene` for both its disposable
canvas and routed authoring world, and `/play.html` uses `PlayScene`. Explicit page
paths take precedence over stale `?view=` values. `CreatorScene` and `PlayScene`
share routed active-hole lifecycle through `CourseScene`; all page compositions
consume `PlayableCourseScene`'s shared terrain, hazard, water, vegetation, target,
and presentation primitives. Never choose a page scene merely from whether loaded
course data happens to contain routing.

## Project and runtime schemas

Author mutations target the v5 project, never an arbitrary JSON path. Supported
semantic types are `project`, `site`, `atmosphere`, `hole`, `route`, `tee`,
`green`, `bunker`, `pond`, `landform`, `forest-floor-area`, `surface-materials`, `environment-object`, and
`procedural-tree-definition`, and `procedural-tree`. Every item uses a stable kebab-case ID and changes exactly one
object. `route.points` is the editable centerline spline; landforms use registered
forms (`ridge`, `bowl`, `shelf`, `saddle`, `shoulder`, `drainage-channel`,
`plateau`, `swale`). The compiler lowers an unrouted project to the legacy
representation below, or adds a `routing` object and every transformed feature
array for a schema-v4 shared site.

Maintained pine straw is a first-class site entity. Author each
`forest-floor-area` as `{id, shape:[{x,z},...]}` with 4–32 sparse world-space
control points. The compiler expands those controls into a smooth filtered SDF in
the existing zone texture. Design broad woodland beds from route strategy, terrain,
and forest composition; never trace crown circles, fill all deep rough, or reuse
rectangular scatter bounds. Preview tee, landing, approach, and overview, then
revise the stable area entity rather than painting compiled runtime data.

The project-level atmosphere preset is data, not a renderer override:
`climate`, `season`, `localTime`, `weather`, `cloudCoverage`, `windSpeedMph`, and
`windDirectionDegrees`. It configures the existing deterministic environment
timeline; sky scattering, sun/moon light, stars, clouds, bloom, and shadows remain
engine-owned algorithms.

The site also owns a versioned `surfaceMaterials` object. Its `turf` controls
parallax, detail normal, AO, self-shadow, matte roughness/specular response,
saturation, and value. Its `forestFloor` controls physical relief depth, tangent
normal strength, source-colour contribution, macro variation, canopy affinity,
mature-crown grass density, and crown feathering. These fields are render-only:
they never alter collision height or surface IDs. A material-only project revision
must call the live scene's semantic material API and update existing uniforms; it
must not rebuild Terrain, Grass, trees, renderer, or camera.
Author it through the singleton `surface-materials` semantic entity rather than
replacing the whole site or editing compiled runtime data.

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
  "greens": [{
    "yards": 150, "x": -14, "z": -137, "r": 10, "contour": "spine",
    "shape": [{"x":-27,"z":-131},{"x":-29,"z":-142},{"x":-23,"z":-151},
      {"x":-16,"z":-150},{"x":-11,"z":-141},{"x":-4,"z":-145},
      {"x":2,"z":-140},{"x":0,"z":-131},{"x":-8,"z":-129},
      {"x":-12,"z":-122},{"x":-20,"z":-123},{"x":-22,"z":-131}],
    "grade": {"slopeX":0.003,"slopeZ":0.007,"blend":14},
    "contours": [{"kind":"ridge","points":[{"x":-20,"z":-145},{"x":-17,"z":-131}],
      "width":14,"height":0.2,"falloff":8}]
  }],
  "bunkers": [ { "x": 20, "z": -86, "r": 5.0, "depth": 1.0, "pot": false } ],
  "ponds":   [ { "x": 55, "z": -122, "r": 15, "depth": 1.6 } ],
  "atmosphere": { "climate": "temperate-maritime", "season": "summer", "localTime": "15:30", "weather": "partly-cloudy", "cloudCoverage": 0.25, "windSpeedMph": 8, "windDirectionDegrees": 250 },
  "environment": {
    "objectBudget": 700,
    "placements": [ { "id": "hero-tree", "assetId": "polyhaven-island-tree-01", "x": -72, "z": -70, "rotationY": 1.15, "scale": 1.55 } ],
    "scatter": [],
    "assembly": [],
    "edgeDressing": [],
    "exclusions": [],
    "proceduralTreeDefinitions": [ { "id": "coastal-oak", "generator": "parametric", "seed": 42, "variantCount": 3, "parameters": { "...": "complete validated tree-builder parameter record" }, "materials": { "...": "bark, leaves, blossoms" } } ],
    "proceduralTrees": [ { "id": "oak-left-1", "definitionId": "coastal-oak", "x": -72, "z": -70, "rotationY": 1.15, "scale": 1.1, "seed": 42, "age": 0.85, "health": 0.95, "windExposure": 0.6 } ]
  }
}
```

- **greens** — `yards`, `x`, optional `z`, nominal `r` (3–40 m), legacy
  `contour` intent label, optional `pin:{x,z}`, `shape`, `grade`, and `contours`.
  Author `shape` as 6–48 sparse hole-local control points: concave bays, narrow
  waists, angled entries and unequal lobes are supported. Controls may extend up
  to 2.5 × r from the centre; there is no inner radial exclusion. The polygon and
  its smooth quadratic spline must remain simple, enclose the centre and have
  area at least 0.8 × r². The compiler samples the same smooth boundary for
  surface classification, rendering, clearances, minimap and the reading grid.
  Never pre-sample the spline in the project or paint a circular mask over it.
  `contour` labels (`tilt`, `punchbowl`, `spine`, `tier`, `crown`, `saddle`) retain
  old files' design intent; they do **not** generate relief by themselves.
  Optional `grade:{slopeX,slopeZ,blend}` sets an underlying plane at the site's
  natural centre elevation before contour features are added. Slopes are signed
  height/metre in hole-local axes (0.01 = 1%), total magnitude at most 6%; `blend`
  is 2–40 m outside the actual outline. The compiler rotates this slope with the
  hole. This replaces incidental background bumps inside a deliberately graded
  green and ties continuously into the surrounds, without adding a radial pad.
  Omitted grade preserves legacy terrain. Check the combined slope after contours.
  Actual green-owned relief is `contours`, up to 12 records using the existing
  semantic landform grammar: `{kind,points:[{x,z}],width,height,falloff}` (no IDs).
  Points are hole-local and transform with the green; width is 1–80 m, signed
  height −3..3 m, falloff 1–60 m. Use broad `ridge`/`swale` lines and quiet
  `shelf`/`plateau` regions. Rounded ridge/swale/channel/saddle profiles decay
  across half the width; shelf/plateau/shoulder/bowl profiles keep a flat core
  of half the width and use falloff for their outer shoulder. These add to the shared course landform and continue
  smoothly beyond the mowing boundary; they change both rendering and physics.
  Keep features within the intended green complex and away from unrelated play.
  Own the silhouette, pin and contour edits in one undoable `green` mutation.
  Start with a strategic contour concept and varied pin regions, not random noise
  or concentric height pads. Verify local slope and low-speed putts in production.
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

Photo-backed grassland studies may opt into `site.groundCover: "native-grasslands"`.
This changes native deep-rough blade morphology/pigment and its distant material,
not terrain height, surface IDs, ball lies, or other courses. Maintain short rough
beside protected cuts and validate foreground stems, continuous distant mass, live
shared wind, and active-camera LOD together. Original architecture can use strict
catalog `building` records with a local editable `.blend` provenance source;
authored glass, metal and emissive fixtures retain their PBR values and real shadows.
New studies belong in separate projects; do not overwrite the active course merely
to audition a reference.

For separated tee terraces/native carries, a shared-site hole's full strategic
`route.points` still starts at its primary tee and preserves measured yardage.
Optional `route.fairwayStartMeters` (finite, 0..route length; omitted means 0)
delays only the maintained fairway/rough corridor along that route. Tees and greens
retain their own surface ownership. This avoids painting a continuous fairway
between isolated tee boxes; never shorten the strategic route or relax tee/yardage
validation to achieve that visual result. Validate the baked surface field at tee,
native gap, fairway start and maintained shoulder.

Catalog-backed trees, shrubs/groundcover, rocks, and deadwood are authorable through
`environment.placements`, `scatter`, `assembly`, and `edgeDressing`. Asset IDs must
exist in `public/assets/environment/catalog.json`; placement is deterministic from
the course and record seeds, constrained by catalog spacing/slope data, protected
playing surfaces, exclusions, and the hard object budget. Raw terrain elevation and
materials remain intentionally non-authorable.

Forest assemblies expose two age-class semantics. `forest-cluster` is mature
overstory and resolves a plausible 15–25 m anchor/support/fill hierarchy from the
catalog asset's native dimensions. `forest-understory` retains a tree's authored
sapling/regeneration age class near native scale; it must not manufacture mature
trees from small source models. Layers may share `habitatMassId` to form one
ecological stand. Crown habitat owns exact grass exclusion, not a maintained ground
bed's silhouette. A `pine-needle-litter` site uses explicit `forest-floor-area`
features for Augusta-style continuous woodland beds. Keep 4–32 broad control points,
smooth turf-facing sweeps, irregular depth into the trees, and hard exclusions for
maintained surfaces and hazards. `crownFeatherMeters` supplies the tight inward SDF
cut without adding geometry or rebaking the feature.

Tree LODs remain catalog-authored geometry with their source materials and alpha.
When a middle tier looks sparse, first validate whole-crown occupancy, source
alpha, lighting, and golfer-view composition. Do not hide the defect with blur,
temporal smearing, billboards, or missing-instance budgets. A source can be fully
resident and still be the wrong dominant canopy form.

`environment.proceduralTreeDefinitions` contains reusable deterministic parametric
or safe data-only L-system definitions. `environment.proceduralTrees` contains
placements that reference those definitions. Agents may use ImageGen to create one
transparent front/right/top sheet, fit it with `npm run tree:build`, and generate a
leaf texture for explicit leaf meshes. Whole-tree billboards and catalog fallbacks
remain forbidden. A missing or invalid Poly Haven GLB still fails closed. Both
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
   Previewing a proposal or compiling a direct live checkpoint replaces the
   showcase with the authored course; starting a new
   conversation advances its deterministic variant and reframes a fresh green, while
   preview recovery and hot rebuilds retain the current variant. A picked terrain point
   resolves to the closest stable v4
   object (or terrain surface/biome context), and that selection plus the current
   camera view are attached to the prompt. The creator also captures automatic,
   route-aware tee/decision/approach/overview review views without rebuilding the
   scene. For the revision and observation protocol, read
   `live-editor-loop.md`. The local Codex SDK runs as a live
   workspace agent with repository write access, inherited `AGENTS.md` and skill
   instructions, live web search and sandbox network access, and no interactive approvals.
   Network use is limited by the environment skill's asset-acquisition contract:
   inspect the local catalog first, accept only verified compatible licenses, record
   provenance and hashes, and fail closed when source or derivative validation fails.
   In direct live-build mode it authors in small valid checkpoints: update
   `course.project.json`, compile the shared site to `course.json`, wait for the
   matching post-edit observation, then continue with later holes or environment work.
   Reasoning summaries, command state, and file-change summaries stream into the
   creator status bar, including the latest checkpoint revision and observation
   state. The Vite sidecar watches the editable project, compiled
   runtime, catalog metadata, geometry/build code, GLBs, and textures; each valid
   runtime checkpoint updates the production scene in the same page. Catalog changes
   reload and reverify referenced model derivatives before presentation. An existing
   Codex login is required; there is no API-key fallback in the local creator.
2. **Terminal via MCP** — the course-engine MCP server (`scripts/course-mcp.mjs`)
   exposes the tools below. Register it: `claude mcp add course-engine -- node
   scripts/course-mcp.mjs` (or `codex mcp add …`). It uses the same project-v5
   authoring kernel, history, and compiler as the in-app agent. No tool authors
   `course.json` directly.

Legacy runtime schema v3 requires `meta.schema: 3` and `biomeTransitions` (use `[]` when no
transition is intended). For transition records and registered profiles, read
`../../golf-biome-transitions/references/engine-contract.md`.

### MCP tools (course-engine)

- `describe_schema` — the schema + contour vocabulary (this file, condensed).
- `get_context` — compact revision-tagged project, active-hole, asset, decision,
  and scene-capability context used by the in-app agent.
- `get_course` — authoritative `course.project.json` v5, revision, and compiled runtime.
- `classify_point {x,z}` — the playing surface at a point (tee/green/fringe/fairway/
  rough/deepRough/sand/water), the fairway half-width at that z, and nearby
  features. **Use this to place features precisely** (it replaces the prior engine's
  `inspect_region`).
- `classify_biome {x,z}` — semantic transition owner, habitat, profile weights,
  and primary/target biome at a point; it does not replace gameplay classification.
- `validate_course {project?}` — normalize/compile + design sanity checks (bounds, feature
  overlaps, undersized "pots"); returns warnings. Does not write.
- `query_tree_assets {biome?,source?}` — discover authored and approved procedural
  trees without loading either full catalog.
- `apply_mutations {baseRevision,mutations,intent?}` — apply typed semantic project
  mutations, record an undoable checkpoint, then compile runtime.

## Workflow mapping (from the SKILL steps)

- "Operate through the engine tool server / inspect before editing" → call
  `get_context` and `classify_point` before authoring; make edits with
  revision-guarded `apply_mutations`.
- "Run the green/approach/hazard/bunker analyzers" → run `validate_course` and read
  its warnings; there are no `.mjs` analyzers here. Prove geometry with validation;
  prove look by inspecting the running sim (golfer height, low oblique, overhead).
- "Prefer editable vector features; derive render/physics grids from them" → already
  true by construction: you edit features, the engine derives everything.
- In proposal-review mode, keep one proposal item per semantic object. Applying
  multiple selected cards is coherent at the project level but records independent
  object history. In direct live mode, preserve those same stable object boundaries
  in the v5 project and checkpoint only valid compilable states.

## Creative intent and detached topology

The live agent, staged proposals, and final review share a creative-intent brief.
Persist the requested mode, signature shots, topology, and miss/recovery behavior
in project.meta.notes. Treat explicit TGL-style or fantasy requests as spectacle
architecture with authentic measured-ball physics. Report unfulfilled requirements
in the final review instead of silently substituting a conventional hole.

Detached playable platforms are not supported by the current authored schema.
The opening creator green's finite outline is a presentation cutout; it does not
provide arbitrary platform collision occupancy or void relief. Do not use it to
claim a detached course is playable. That extension must share polygon boundaries
between rendering and collision, define edge departures and misses/relief, and
validate low-speed roll-offs before the agent can author dependent geometry.
