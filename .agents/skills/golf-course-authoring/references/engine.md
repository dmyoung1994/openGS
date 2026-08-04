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

A Three.js / WebGPU golf simulator. The entire course is one small JSON file,
`course.json` (repo root), describing **features only**. The engine BAKES the
terrain heightfield and surface classes from those features (`src/scene/Range.js`
`_height` / `_surface`). **There is no heightfield, mesh, spline, or material to
edit — you author by features, and never by terrain editing.** This is a hard
product rule: the only authoring surface exposed to the user is a prompt.

## Coordinate system

Metres throughout. `x` = lateral (right is `+x`). `z` = down-range: the tee sits
near `z ≈ 2` and the course runs toward **negative z**. A green D yards out sits at
`z ≈ -D * 0.9144` (e.g. 150 yд → `z ≈ -137`). `y` (elevation) is computed
automatically — you do not set it.

## course.json schema

```jsonc
{
  "meta":   { "name": "…", "mode": "realistic|spectacle|hybrid" },
  "bounds": { "minX": -110, "maxX": 110, "minZ": -340, "maxZ": 30 },
  "tee":    { "x": 0, "z": 2, "boxHalfX": 3.2, "z0": -2, "z1": 6 },
  "corridor": { "c0": 32, "k": 0.11, "rough": 26 },  // fairway half-width(m) = c0 + (-z)*k; then a rough band of width `rough`; beyond that, deep rough
  "fringeW": 2.2,                                     // green collar width (m)
  "greens":  [ { "yards": 150, "x": -14, "r": 9, "contour": "spine" } ],
  "bunkers": [ { "x": 20, "z": -86, "r": 5.0, "depth": 1.0, "pot": false } ],
  "ponds":   [ { "x": 55, "z": -122, "r": 15, "depth": 1.6 } ]
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

## Not authorable in this engine (yet)

Individual trees / rocks / props (the tree line is procedural and frames the
corridor automatically), raw terrain elevation, and materials. Requests for those
map to nothing here — say so rather than faking them. (A future feature may add
feature-level vegetation; today it is out of scope.)

## Two authoring paths (same course.json)

1. **In-app prompt** — the Course Creator's prompt box POSTs to `/api/build`; the
   dev-server sidecar runs the local agent, which edits `course.json`; the sim
   live-reloads. (You may BE this agent.)
2. **Terminal via MCP** — the course-engine MCP server (`scripts/course-mcp.mjs`)
   exposes the tools below. Register it: `claude mcp add course-engine -- node
   scripts/course-mcp.mjs` (or `codex mcp add …`). Writes land on `course.json`,
   which live-reloads the running sim.

### MCP tools (course-engine)

- `describe_schema` — the schema + contour vocabulary (this file, condensed).
- `get_course` — current `course.json` + a summary.
- `classify_point {x,z}` — the playing surface at a point (tee/green/fringe/fairway/
  rough/deepRough/sand/water), the fairway half-width at that z, and nearby
  features. **Use this to place features precisely** (it replaces the prior engine's
  `inspect_region`).
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
- Apply each request as ONE coherent edit; keep metre scale, tee reachability, and
  features within bounds.
