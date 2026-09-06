# Agent-Native Course Authoring Architecture

## System model

Course Creator is one closed evidence loop, not a collection of editor features:

```text
intent -> AuthoringContext -> semantic project edit -> compiled revision
       -> requested production-scene evidence -> user decision -> reusable asset
```

Every boundary carries stable IDs and revisions. The agent never has to infer which
file is authoritative, whether a screenshot is stale, or which browser operations
are safe.

The system has four small planes:

- **Data:** `course.project.json` schema v5 is the sole editable course source.
  `course.json` is deterministic schema-v3/v4 runtime output.
- **Control:** the Codex thread can request bounded semantic scene actions; it cannot
  execute arbitrary browser JavaScript.
- **Evidence:** the production WebGPU browser publishes revision-matched diagnostics
  and explicitly requested captures outside the repository.
- **Knowledge:** course decisions remain in existing history; approved procedural
  trees enter the shared asset-kit catalog. User taste is not inferred globally.

## Shared authoring kernel

`scripts/lib/course-authoring-kernel.mjs` is the single adapter over existing project
normalization, semantic mutations, compilation, history, and tree catalogs. The live
sidecar and `scripts/course-mcp.mjs` use that same contract.

`AuthoringContext` is regenerated at the beginning of a live turn and contains:

- project/runtime revisions, source/runtime schema identity, bounds, biome, routing,
  active hole, route and feature summaries;
- environment counts and budgets, authored tree summaries, approved procedural-tree
  summaries, recent course-local decisions, and selected scene context;
- a capability manifest naming supported scene controls, views, and hard budgets.

The context is intentionally compact. Durable design doctrine stays in `AGENTS.md`
and the golf authoring skills; the prompt need not restate or rediscover it.

MCP exposes `get_context`, `get_course`, `classify_point`, `classify_biome`,
`validate_course`, `query_tree_assets`, and `apply_mutations`. `apply_mutations`
requires the exact base revision, records an undoable checkpoint, writes project v5,
and compiles runtime. No tool writes `course.json` as authoring source.

## Scene interaction protocol

A live Codex turn ends with exactly one disposition:

- `complete`: work is finished;
- `question`: a consequential user choice is required;
- `control`: production-scene evidence is required before the agent can continue.

A control request has a stable `control-*` ID and one to four actions from:

- `select-hole`
- `set-view` (`current`, `tee`, `landing`, `approach`, `overview`, or `point`)
- `present-trees`
- `clear-preview`
- `observe`

The existing NDJSON stream sends the request to the open creator page. The browser
executes it using `window.golf.selectHole`, `evaluatorCamera`, and the production tree
renderers, posts a `SceneControlResult` through the existing observation endpoint,
then restores the user's hole/camera and disposes previews. The same Codex thread is
resumed with the immutable observation manifest and image paths.

Results identify the control request, build, project revision, render revision,
render generation, active hole, camera, WebGPU/console/network health, diagnostics,
and zero or more captures. Stale, cross-build, or wrong-revision results are rejected.
The limits are six control rounds, eight captures, three tree candidates, and fifteen
seconds per browser response. Diagnostics are preferred; images are requested only
when the uncertainty is visual.

## Visual decisions and trees

A terminal question may attach a `tree-comparison` presentation. Each rendered
candidate maps to a question option ID and references either a real environment
catalog asset or a same-origin approved/generated procedural definition. The browser
finds a safe rough-area lineup, renders the real production geometry and materials at
authored scale, and adds clickable A/B/C scene labels. There are no billboards,
placeholders, asset substitutions, or generic fallbacks.

Selecting a scene label or question card highlights the same option. Selection does
not submit: the user confirms with Continue or supplies a custom answer. Preview
objects never enter project data, history, clearance checks, or object budgets, and
are disposed on answer, cancellation, refresh, error, or course rebuild.

Ask existing-vs-custom only when tree source materially affects the design and cannot
be inferred. Prefer relevant existing assets before spending an ImageGen/build pass.
For a custom tree, use ImageGen for transparent orthographic and leaf references,
fit and validate deterministic geometry, visually compare candidates, then run
`tree:build promote` only after acceptance.

`public/assets/procedural-trees/catalog.json` is the shared procedural asset-kit
registry. It stores discovery metadata and strict same-origin definition/reference
URLs while keeping procedural definitions separate from the authored GLB catalog.
Approved assets may be reused by other courses and users. Ordinary design choices
remain course-local and never become inferred cross-course taste.

## Trust and verification

The Codex SDK uses the existing login, one persistent workspace-write thread, live
web search, and governed network access. Same-origin loopback checks protect every
state-changing sidecar request. Captures stay in OS temporary storage.

Catalog-first and licensing rules remain mandatory. Poly Haven catalog assets retain
their authored geometry, normals, UVs, vertex colours, alpha, and PBR maps and fail
closed when verification or rendering fails.

Rendered acceptance uses the real `/creator.html` route, a fresh headful Chrome
profile, strict WebGPU readiness, `window.golfBootstrap.ready`, `window.golf`, and
`window.golf.evaluatorCamera`. A passing flow proves page identity, non-blank render,
clean console/network health, control round-trip, tree selection/confirmation, no
preview project mutation, and exact camera/hole restoration.
