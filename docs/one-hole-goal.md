# One exceptional hole

Deliver a complete Pineglass hole from measured launch input through the final
putt. No club selection: ball speed, launch angle/direction, spin rate and spin
axis drive the simulation. Keep optional device metadata separate from physics.

1. Fix the Play lifecycle: retain each resting lie, aim and launch from that lie,
   permit low-speed putts, and preserve Practice's return-to-tee behavior.
2. Implement and validate cup interaction, hole completion, stroke accounting
   and deliberate recovery from hazards. Reuse authored pin/cup positions and
   existing ball contact, camera and audio paths. Do not invent a full rules engine.
3. Replay the existing launch-data corpus; separate measured flight evidence
   from device-calculated distances and unknown atmospheric conditions. Validate
   roll, slope, surface transitions and cup behavior with reproducible checks;
   document calibration gaps rather than claim unmeasured accuracy.
4. Play the complete real WebGPU hole with varied launch metrics, lies, wind
   and pin positions. Verify ball visibility, aiming, result feedback, sound,
   resized UI and input arriving during result holds or an active shot.
5. Close the remaining performance gates in performance-plan.md: sustained
   30 fps at crisp 1080p, stable quality adaptation, responsive cold/warm loading,
   and a ten-minute worst-view/motion soak. Preserve the 111 procedural pines.

Initial audit: launch normalization and club-independent flight already exist.
Play currently inherits Practice's tee reset; the Lab minimum is 40 mph and the
input boundary rejects speeds below 1 mph. Ball has flight/bounce/roll/rest and
water entry, but no hole-capture lifecycle. These are the first implementation gaps.

## Execution evidence

- Goal created with no club-selection requirement; AGENTS.md now preserves this
  product contract. Low positive speeds and sub-metre aiming are accepted.
- `/tmp/one-hole-play-qa.json`: real headful WebGPU launches verify that Play's
  second shot starts exactly at the first resting lie while Practice resets to
  its tee. Both paths accept a 0.2 mph launch, with no browser health errors.
- `/tmp/one-hole-flight-baseline.json`: existing reference replay gives carry
  mean absolute errors of 1.01 yd for 15 FSX-calculated records, 5.09 yd for two
  owner device-calculated records, and 5.65 yd for five robot-average records.
  These groups have different evidence quality and incomplete atmospheric data;
  agreement with another simulator is not proof of measured outdoor accuracy.
- Cup capture uses [Penner (2002)](https://doi.org/10.1139/p01-137), equations
  23 and 30: the allowed entry speed decreases with lateral offset and is
  adjusted for the approach slope. Swept entry prevents tunnelling and captures
  only a crossing of the actual opening. The short descent is approximate;
  detailed lip, flagstick and airborne cup contacts remain pending.
- Play tracks strokes, rejects input during a shot or after completion, and
  offers explicit water recovery by replaying the previous lie with one penalty
  under [Rule 18.1](https://www.randa.org/en/rog/the-rules-of-golf/rule-18).
  Other relief choices and a complete competition rules engine are not implemented.
- `/tmp/play-hole-MMUGh0/report.json`: the repeatable production replay completed
  the first hole in three strokes (167 mph tee shot, 94.6875 mph approach,
  6.275 mph putt from 3.01 m), rejected concurrent packets, displayed the score,
  and advanced to the next hole with zero strokes. Browser health was clean.
  These are synthetic QA inputs; a temporary predictor selected them using the
  same Ball model. They validate lifecycle consistency, not physical calibration.
- Reproduce with `VIEWER_URL=http://127.0.0.1:4173 node scripts/benchmark-play-hole.mjs`.
  It uses the production scene and real launch boundary with no ball teleportation
  or substituted geometry. Screenshots/reports are saved under `/tmp/play-hole-*`.
- Offline results now use the aim line rather than world X; the finishing putt
  correctly reports 0.0 yd offline. Hazard notification precedes terminal rest so
  the result UI can require relief before accepting another shot.
- 38 focused tests pass. Remaining: close cup/motion
  inspection, varied wind/lie/pin checks,
  physics calibration gaps and the open performance/loading/endurance gates.
- `/tmp/play-hole-K8bpTy/report.json`: the full three-shot production replay also
  verifies trusted-input audio unlock, native decoding with no failed assets,
  exactly one `cup.drop` playback and one holed event, and next-hole continuation.
  The CC0 inbeeld recording uses the existing spatial effect pool; retained source,
  license and reproducible mastering are in `audio/sources/README.md`. Its decoded
  peak is -6.5 dBFS; this is not a subjective listening-quality certification.
- `/tmp/play-hole-MIDtvd/report.json`: a real 70 mph / 35° / 6000 rpm shot into
  the saved Grasslands pond requires relief, rejects another input packet, and
  restores the exact previous lie with one penalty (two strokes total). The
  actual button and fitted production WebGPU scene were exercised; health was clean.
- Rolling shots now check the contacted surface for water and reuse the landing
  hazard path. A regression checks green-to-water travel, hazard-before-rest order,
  boundary stopping and zero residual linear/angular velocity. Water entry also
  reports first-contact carry, descent, speed and spin through the same method as
  turf contact, fixing zero landing metrics in the recovery result. Thirty focused
  audio, cup and flight tests pass, and the production build succeeds.
- `/tmp/play-hole-SL6986/report.json` repeats the rendered water recovery after
  contact-metric correction. Its result screenshot shows 49 mph landing speed and
  51° descent, with clean health and unchanged entry/recovery positions.
- `/tmp/play-hole-f639Qe/report.json` repeats the full-hole/audio/continuation
  checks on the latest build. `cup-close.png` verifies the actual turf opening and
  recessed liner from a production evaluator camera. Cup-entry motion, flagstick
  interaction and detailed rim behavior still need work; a static aperture check
  does not certify them.
- `test/physics-flight.test.mjs` now exercises positive low-speed putts at
  30/120 Hz and checks ordering across green/fairway/rough/sand, three firmness
  settings, and ±2% slopes. All 14 flight/ground tests pass. These are consistency
  checks, not independently measured roll-distance fixtures.
- `/tmp/putting-reference-audit.json`: an ideal fully rolling 1.95072 m/s release
  on a level green travels 7.02/9.11/12.68 feet at soft/medium/firm settings.
  The release speed is the 6.4 ft/s value in the
  [USGA putting guide](https://www.usga.org/content/dam/usga/pdf/science-of-golf/middle-school/Putting/putting_facilitator_guide_MS.pdf).
  This omits actual ramp/green transition effects and does not calibrate Pineglass
  to an outdoor green. Firmness currently couples rebound and green speed; a
  separately measured green-speed parameter remains a future calibration need.
- The loading pass now prepares nonempty canopy fields in a worker, represents
  transition-free biomes with exact constant texels, and yields within mountain
  segments. `docs/performance-plan.md` records timings and the remaining
  atmosphere/handoff stalls. `/tmp/play-hole-o0VHr2/report.json` verifies unchanged
  complete-hole behavior and clean production rendering after these changes.

- Grass state now starts in the native four-word storage layout, avoiding the
  two-million-record upload repack. Nine allocation/camera-motion checks pass.
  `/tmp/play-hole-nOjrsJ/report.json` confirms unchanged three-shot resting
  positions, one cup-drop event, hole-2 continuation, and clean real WebGPU
  rendering; the final screenshot was inspected. Loading profiles and remaining
  upload/handoff stalls are recorded in `docs/performance-plan.md`. The goal
  remains active: this startup fix does not establish sustained 30 fps.

- Pine-straw PBR maps now use the native bitmap upload path. GPU readback hashes
  prove exact RGBA preservation against the prior path; normal/late disposal and
  failure propagation are tested. Actual cold/page/course loading remains
  variable and fails the smooth-loading gate. Full evidence and close-range
  visual limitations are recorded in `docs/performance-plan.md`; the goal stays
  active and sustained 30 fps is still unproven.

- `scripts/benchmark-play-conditions.mjs` now exercises eight synthetic launch
  packets through the real 1080p Play route with native WebGPU: calm, 15 mph
  tail/head/right/left winds, ±17° spin axes, and an 80 mph / 35° / 8000 rpm shot.
  `/tmp/play-conditions-G1RW9T/report.json` passes all directional, stroke-count,
  finite-position and result-HUD checks with clean browser/network health.
  Carry is 244.08 yd calm, 254.40 tailwind, 224.95 headwind; crosswind results
  finish 18.09 yd right and 22.56 yd left. Spin-axis results finish 28.60 yd right
  and 28.13 yd left. The high-loft shot carries 96.12 yd. Actual landing outcomes
  include fairway, rough and deep rough. These are shared-workflow invariants,
  not physical launch-monitor measurements or sustained-FPS certification.
- The conditions UI said “Wind from” while EnvironmentFrameState specifies the
  direction wind blows toward (0° = -Z, 90° = +X). The UI now says “Wind toward”;
  physics, renderer wind and authored course values retain their existing meaning.
- Independent pin authoring and runtime alignment are implemented as described
  below; the rough/deep-rough continuation checks are also complete.

- `/tmp/play-conditions-lmTQNQ/report.json` reruns all eight wind/launch scenarios
  and adds actual second shots from rough and deep rough. Both 65 mph / 30° /
  6000 rpm packets launch from exactly the prior resting XYZ coordinates and
  increment the score to two. Carries are 72.405 and 72.344 yd; the result HUD
  agrees with authoritative telemetry. No ball teleport, club selection, or
  synthetic scene/lie substitution is used. Native WebGPU remains 1920×1080,
  browser/network health is clean, and the settled recovery screenshot was
  inspected. The harness now waits for result-panel opacity before capturing.
  This closes the rough/deep-rough continuation coverage gap. Performance and
  visual-quality requirements remain open.

Independent pin authoring is now supported with optional `green.pin: { x, z }`.
In project files those coordinates are local to the hole and follow its routing
placement transform; compiled/runtime coordinates are world-space. Omission keeps
the existing center pin. Runtime validation requires finite coordinates and the
complete 108 mm opening inside the smoothed green. The green center, outline,
contour and surface classification do not move when the pin moves. Cup physics,
cutout, liner, flag/pole, final aim target and minimap pin all use this position;
minimap front/center/back green yardages continue to describe the green itself.

The focused pin/project/minimap run passes 16 checks, including local-to-world
rotation and unchanged green geometry. Two migration fixtures were corrected to
clear course-wide procedural trees when they discard/shrink routing. The subsequent schema-fixture refresh passes all 29 schema/pin/project/minimap
checks (`/tmp/schema-refresh-tests.log`). Shipped-course assertions now cover the
111 procedural pines and 88 catalog ground objects. Habitat/clearance/budget
fixtures are explicit and independent of the current course composition; the
water-clearance test now includes a real nearby authored pond.

`/tmp/play-pins-Ku5m1d/report.json` passes two offset-pin previews on the actual
1080p WebGPU Play route. Pins at (-269, -76.9) and (-275, -71.9) retain identical
complete terrain-height and surface-mask hashes. Cup physics, rendered liner,
cutout uniform, pole matrix, cloth anchor and minimap aim agree with each pin.
A real 80 mph / 35° / 8000 rpm packet is accepted after each preview; its result
increments the score and aims the next shot at that pin. Both close-up captures
were inspected. Browser/network health is clean. The cup interior remains too
bright/blue in these views and needs rendering diagnosis before claiming final
visual quality.

This verification also fixed two shared lifecycle defects: preview completion
now restores the bootstrap ready flag, and every course build cancels the old
shot-result auto-reset before disposing terrain. The harness explicitly exercises
a shot followed by another preview/rebuild and would catch both regressions.
The earlier failed runs (`/tmp/play-pins-tl7rfx` readiness and
`/tmp/play-pins-o0o1qI` stale reset) remain recorded as diagnostic evidence.
Sustained 30 fps, smooth loading and visual polish remain open; the active goal is not complete.

Cup rendering diagnosis: `/tmp/cup-path-probe.json` records the rootzone wall,
white liner and bottom at the correct world positions, each drawn repeatedly by
the real renderer. At the close camera angle the visible bright area is the
liner; the deep bottom projects behind the front wall. The controlled native
lighting comparison (`/tmp/cup-no-indirect-diagnostic.png` versus
`/tmp/cup-lighting-restored.png`) shows most of that brightness comes from shared
indirect sky light. The original callback and environment intensity were restored,
and browser health remained clean. The renderer currently has no cavity-aware
indirect-light visibility. No cup-specific color darkening or fake AO was retained;
proper cavity occlusion remains a rendering-quality task.


Calm vegetation and recurring lighting refresh work is recorded in
`performance-plan.md`. The full metric-only hole still passes at 1920×1080 in
`/tmp/play-hole-mLmmA1/report.json`: three shots, unchanged resting positions,
one cup-drop sound and next-hole continuation. Grass retained state is byte-exact
when its redundant calm dispatch is skipped; procedural tree flutter now follows
actual wind. Reusing the native PMREM target preserves lighting pixels and removes
a reproducible 417–433 ms texture-replacement hitch (warm refresh peaks 34 ms).
The ten-minute performance rerun fails at 28.86 fps overall (24.84–32.94 fps
windows), recorded in `/tmp/play-endurance-9gYghg/report.json`. Sustained throughput,
loading responsiveness, visual polish and the previously recorded real-world
calibration gaps remain open.

The solid backdrop now draws after foreground opaque depth, preserving its
materials and relative shell order. Controlled comparisons suggest about 1.4 ms
less GPU work. `/tmp/play-hole-gQ9sWG/report.json` verifies the complete metric-only
hole and four moving course-boundary traversals at 1080p with clean renderer
health. A visible edge material band predates this ordering change, confirmed by
matched captures in `/tmp/edge-order.json`; seamless edge appearance and sustained
30 fps still require work. No club-selection step was introduced.

Fixed the alpine ring's course-wide side triangles by retaining its existing
24 m spacing across both site dimensions. The central playable area remains
unmeshed. The full hole and all four boundary traversals pass at 1080p in
`/tmp/play-hole-8nJway/report.json`; the foothills now retain sampled valleys that
the stretched triangles erased. The material band still needs work, and loading
and sustained-performance acceptance remain outstanding.

The post-grid ten-minute production run completed in
`/tmp/play-endurance-juMeGb/report.json` (600.74 s, 20 windows). Overall throughput
is 31.11 fps, with 28.98–33.35 fps windows; six windows fall below 30 fps and the
worst window p95 is 50 ms. This improves on the previous run's 28.86 fps average,
but still fails sustained-performance acceptance. Separate-run averages do not
isolate the contribution of individual edits. All windows retain 1920×1080,
renderScale 1, a visible page, live simulation and 111 source trees; health is
clean. Reported GPU memory spans 820–851 MiB and ends at 824 MiB. Start/final
screenshots were inspected. The benchmark process finished and closed Chrome.
The next performance pass needs margin below the 33.3 ms frame budget, followed
by another complete-scene endurance check; loading and visual-quality gaps remain.

Near-edge geometry diagnosis found a contributing artificial depression:
`/tmp/edge-grass-air.json` records the min-Z profile falling from -1.26 m at the
course boundary to -8.81 m at 100 m out and -10.25 m at 200 m, before rising into
the foothills. Shared grass color plus disabled atmosphere still retained the
rim. The fixed 15 m downward world offset is now introduced smoothly from 180 to
500 m outside the course, preserving the distant valley while avoiding that
fixed-depth depression immediately around the site. Playable terrain, source
materials, geometry density and shaders are unchanged.

All 41 backdrop/atmosphere checks and the production build pass. The real 1080p
full-hole replay `/tmp/play-hole-cTFugr/report.json` passes all four moving boundary
traversals, three metric-only shots with unchanged resting positions, one holed
and cup-drop event, and next-hole continuation, with clean renderer/network health.
All four boundary screenshots were inspected: the straight near rim becomes a
softer, terrain-following connection, particularly at min-Z/max-X/max-Z. Retain
this geometry correction; broader naturalization/material quality and the
sustained-performance/loading gates remain open. No new frame-rate claim is made.

Moved the fixed six-map turf image decode/canvas readback/96 MiB array packing
into `TurfTextures.worker.js`. It transfers the two finished pixel buffers,
closes each decoded bitmap promptly, terminates on success/error, and preserves
the existing shared CPU cache and renderer-scoped GPU residency. Failures remain
retryable; no texture fallback or quality reduction was added. The original
main-thread canvas loop accounted for roughly 766 ms of sampled CPU inside an
894 ms cold startup task in `near-valley-loading-QTo1Kx`.

`node scripts/check-turf-worker.mjs` passes: all six 2048×2048 layers have identical
SHA-256 hashes against the original HTML-image/canvas packing on the actual
WebGPU Play route. Evidence: `/tmp/turf-worker-check.json` and screenshot. Sixteen
material/residency checks and the production build pass. The 1080p cold/warm-page/
warm-course rerun is at
`/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/turf-worker-loading-2nCxuQ/report.json`.
Runtime health is clean and the loader was visually inspected. The 894 ms packing
task is absent; the largest recorded pre-loader task is now 234 ms. Active-loader
p95 is 17.6 ms across all phases, but active maxima are 216/149/166 ms, so loading
responsiveness is still not accepted. Isolating this CPU task does not establish
an overall loading-speed or sustained-FPS improvement; remaining upload,
initialization and handoff stalls require work.
