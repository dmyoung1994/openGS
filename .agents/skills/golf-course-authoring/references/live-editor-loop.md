# Direct live editor loop

Read this reference when Codex is authoring files from the Course Creator. It does
not apply to proposal-review threads, which remain typed, read-only previews until
the user selects cards.

## Session contract

- Keep one production WebGPU page and renderer alive for the whole turn. File,
  model, texture, and catalog watchers update that scene; do not relaunch or reload
  merely to change camera pose, active hole, or review angle.
- Treat `course.project.json` schema v5 as the editable source. Compile every valid
  checkpoint to `course.json`: the entire routed site is schema v4, while an
  unrouted practice project may compile to legacy schema v3.
- Use `window.golf.selectHole(holeId)` and `window.golf.evaluatorCamera` for live
  hole selection and deterministic camera movement. Preserve the user's camera
  unless a review capture requires a temporary pose, then restore it.
- The production renderer is authoritative. Do not substitute DOM, mocked scene
  state, software rendering, billboards, or placeholder geometry for review.

## Checkpoint cycle

1. Announce the immediate design action in a short status summary.
2. Make one coherent project change and preserve stable semantic IDs.
3. Compile and validate before continuing. Never leave a half-authored project as
   the latest render checkpoint.
4. Wait for an observation whose build ID and project/runtime revision match that
   checkpoint. Ignore older observations even if their capture completed later.
5. The builder records that stable observed project as an undoable history boundary
   before publishing the observation. Keep each checkpoint limited to one independent
   semantic object or the smallest dependency-closed routed-site transaction.
6. Inspect the reported health data and production captures, revise if needed, and
   only then start the next coherent change.

## Agent control and evidence

The turn begins with a compact `AuthoringContext`: current project/runtime revision,
active route/features, environment counts, relevant authored and procedural trees,
recent course-local decisions, selected scene context, and the supported control
manifest. Use it before reading broad source files or catalogs.

When the next decision depends on the rendered scene, return `kind: "control"`
instead of guessing or attempting browser JavaScript. A request contains a stable
`control-*` ID and one to four actions: `select-hole`, `set-view`, `present-trees`,
`clear-preview`, or `observe`. Prefer diagnostics and one current capture; request a
route review only when the broader relationship is actually uncertain.

The browser executes the request in the existing production scene, posts a result
tagged with request/build/project/render IDs, and restores user state. The service
resumes the same thread with the immutable observation manifest. Reject a result
whose IDs or revisions do not match. Hard limits are six control rounds, eight
captures, three tree candidates, and fifteen seconds per response.

The status bar should always show the newest useful summary: current action,
compile/validation result, watched file or asset change, observation revision, or
specific blocker. Do not emit an empty heartbeat or hide a long download/compile
behind a generic "working" state.

## High-impact questions

Codex decides whether a question is worth interrupting the build. First inspect the
project, current observation, catalog, and applicable authoring rules; do not ask for
facts discoverable locally or for low-impact tuning that can be safely revised in
the next checkpoint. Pause only when mutually exclusive answers would materially
change routing, strategy, identity, budget, licensing, or destructive scope.

Emit one structured question with two or three mutually exclusive options. Put the
recommended option first, explain each option's design impact in one sentence, and
always allow a short custom answer. The expanded Updates drawer owns this
interaction: preserve the timeline above it, display the options in place, and show
that the build is waiting. An answer resumes the same Codex thread and build ID;
reject duplicate or stale answers.

When trees materially affect the course identity and existing-vs-custom cannot be
inferred, attach a `tree-comparison` presentation. Candidate `optionId` values must
match offered question options. Use real catalog IDs or same-origin procedural
definition URLs; the production renderer finds safe rough-area positions. The user
selects a scene label or option card and confirms separately. Preview geometry is
temporary and must never enter project data, history, clearances, or object budgets.

Use ImageGen and the procedural fitter only after the user chooses custom or no
existing tree serves the requested role. After visual acceptance, promote the
validated definition with `npm run tree:build -- promote ...` so it enters the
shared procedural asset kit. Do not persist inferred cross-course aesthetic taste.

## Route-aware review

Generate review poses from each hole's route polyline, not a direct tee-to-green
chord. At minimum inspect:

- tee, looking along the opening route tangent;
- each meaningful landing or decision zone, looking along the next route segment;
- approach, looking from the final route segment into the green and its misses;
- low oblique and overview views for landform, routing, and hole-to-hole flow.

Activate the reviewed hole before every pose so its flag, furniture, hazards, and
diagnostics agree with the capture. For routed projects, also inspect every
green-to-next-tee transition and any close or crossing corridors. Blind shots are
acceptable when intentional; judge their aiming cue, landing width, and recovery
logic from the preceding decision-zone view.

Place every landing/decision camera before the interaction band it reviews. Include
enough foreground and target context to prove carry, bailout, and reward; do not
stand on a hazard edge or inside the landing zone. If a valid long-carry hazard reads
as tee-side clutter, verify page-scene ownership, active hole, transforms, and camera
origin before revising course geometry.

Use a compact route-aware capture set after intermediate edits and a complete tour
for final validation. Camera moves must not trigger a cold scene rebuild.

## Observation acceptance

A usable post-edit observation identifies the live build, project/runtime revision,
render generation, active hole, camera pose, WebGPU readiness, and console/network
health. Prefer captures from the settled frames after the matching watcher update.
If readiness fails, the render is blank, assets fail validation, or the observation
cannot be matched to the current revision, fail closed and report the exact blocker.

Catalog-backed Poly Haven GLBs remain authoritative. Preserve their geometry,
normals, UVs, vertex colours, alpha, and PBR maps; never replace a failed authored
asset with a primitive, billboard, atlas, placeholder, or generic prop.
