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

Extended the existing `prepareSceneTextures` pass to discover texture values in
material node graphs using Three's child-node iterator, visiting shared nodes once.
Previously it only inspected direct material texture slots, so terrain height,
canopy and forest-floor uploads arrived together inside scene compilation. The
same texture objects now upload individually with the existing between-frame
yield; render-target inputs remain excluded and resource ownership is unchanged.
Three checks (including real TSL graph references, deduplication, target exclusion
and upload-error propagation) and the production build pass.

The real cold/warm-page/warm-course loading rerun completed with clean health at
`/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/node-texture-loading-vHUrPm/report.json`.
In the warm-course trace, height/canopy and the two forest-floor uploads now occur
in the staged asset-decoding phase (roughly 3–6 ms each), rather than the prior
21–32 ms uploads grouped during atmosphere/scene preparation. This establishes
that the missed maps are staged; it does not establish smooth total loading.
Active-loader p95 is 17.5 ms, but maxima remain 200/200/217 ms and the first-course
render still costs about 75–85 ms on cold/page reloads. Keep initialization,
shader preparation and handoff stalls open. The loading screenshot was inspected
and the benchmark closed its dedicated browser.

The loading profile also exposed redundant minimap redraws. Collapsed maps now
reuse their exact canvas pixels until ball/aim/pin state, lock state, shot plan,
course raster or expanded state changes. Latest state is always retained; the
expanded camera marker continues to redraw normally. Five minimap checks and the
production build pass. `/tmp/minimap-cache.json` compares cached/forced redraws
in the real 1080p Play scene: each cached 180-frame window makes zero canvas
redraws and preserves identical pixels, while forced windows redraw 180 times
and cost roughly 25–29 ms of JavaScript across the window. This is a small
steady-state saving, not a fix for the first-frame hitch or proof of sustained FPS.

Keyboard activation of the actual expand button passes open/close and captures
were inspected. The initial pointer probe missed its first activation and is
retained as `/tmp/minimap-cache-pointer-failure.json`; pointer targeting was not
certified by the successful keyboard test. The full metric-only hole replay
`/tmp/play-hole-QhXinu/report.json` passes three shots, unchanged resting positions,
one cup drop, and next-hole continuation with clean renderer/network health.
First-frame preparation, loading stalls, visual polish and sustained performance
remain open.

The pointer QA failure is resolved at the shared browser-fit helper. With a
1920×1080 render scaled to the physical display, Puppeteer's unscaled click
arrived at client x=2878 instead of the button's x=1887. `clickBrowserElement`
uses the fitted display scale for actual mouse input; app event handling is
unchanged. The plant-builder QA caller uses the same helper.
`node scripts/check-minimap-pointer.mjs` passes four actual expand/collapse clicks
on the real Pineglass Play route, with both viewport and renderer still
1920×1080, strict WebGPU, and no console/network errors. Report and inspected
capture: `/tmp/minimap-pointer.json` and `/tmp/minimap-pointer.png`.
This closes the minimap pointer-check gap, not the remaining loading, visual or
sustained-performance gates. Next: isolate first-frame work that scene-only
compilation misses before choosing another loading-path change.

Queued native compilation now retains each pass's material side. The live
baseline showed the yardage back/front passes both compiling as DoubleSide (2),
then rebuilding as BackSide (1) and FrontSide (0) on the visible frame. The
existing exact-version Three patch captures side with the queued work, applies
it during preparation, and restores it in `finally`, including node/pipeline
failures. Authored material settings, geometry, transparency and physics are
unchanged. Four native-cache/preparation checks pass; production build passes.
All five patch targets also validate against the published Three 0.185.1 tarball,
so this does not depend on an untracked dependency edit.

Fitted 1080p real Play loading evidence:
- Before: `/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/yardage-compile-before-7nQBOt/report.json`.
- After: `/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/yardage-compile-after-pT76cO/report.json`.
- Warm-course side trace now matches actual drawing (1/0). Duplicate yardage
  node builds disappear in cold, page reload and course rebuild. First render
  after course rebuild is 7.7 ms versus 34.6 ms in the baseline.
- Overall cold/page first renders are 146.5/77.8 ms versus 75.6/92.2 ms; this is
  not an overall startup-speed win. Active-loader p95 remains 17.5–17.6 ms, but
  maxima of 133/283/317 ms still fail the responsive-loading requirement.
- All three runs retain strict WebGPU, clean health, turf ownership and audio
  unlock. Active putting and ready-scene captures were visually inspected.

`/tmp/play-hole-8Nfpkc/report.json` passes the complete 1080p metric-only three-shot
replay, unchanged resting positions, one cup drop and next-hole continuation.
No steady-state FPS gain is claimed for this preparation correction. Remaining
first-frame work includes shadow setup and post-processing material preparation;
loading stalls, visual polish, physical calibration gaps and sustained 30 fps
remain open.

The latest endurance trace's repeated failed Auto promotions do not explain its
Battery-mode sub-30 windows; no speculative quality-policy change was retained.
The backdrop shader did expose exact dead work: its 24 m course-normal blend
still fetched 16 height texels beyond the completed blend. Those fetches now
execute only inside `worldEdgeDistance < 24`; the existing blend formula, other
normal detail, assets, geometry and physics are unchanged.

Initial separate-process samples were noisy and did not establish a gain:
`/tmp/edge-normal-before.json` versus `/tmp/edge-normal-after.json`. The subsequent
same-build interleaved probe `/tmp/edge-normal-paired.json` toggled only whether
the dead height loads execute. Skipping measured 32.57/33.36/32.79 ms GPU per frame;
executing measured 33.36/33.89/33.25 ms. Adjacent pair savings are 0.78/0.52/0.46 ms.
All samples used real Pineglass, Battery, 1080p, active simulation and the same
tee pose. This modest saving does not establish sustained 30 fps.

The diagnostic toggle has been removed. `node scripts/check-backdrop-edge-normal.mjs`
passes against the final build and inspects actual production WGSL: both rendered
alpine bands have all 16 height loads inside the fixed 24 m branch, and retain the
same smoothstep blend. `/tmp/backdrop-edge-normal-check.json` records strict
WebGPU, 1920×1080 and clean health; generated shaders and a screenshot are stored
alongside it. The 38 existing backdrop tests and production build pass.

Final validation also passes the 16–32 m camera sweep across the new 24 m cutoff
on all four course sides; all four captures were inspected, with clean renderer
and network health. `/tmp/play-hole-2RkkeO/report.json` independently passes the
course-seam sweep plus three metric-only shots, unchanged resting positions, cup
audio and next-hole continuation. These checks preserve the edge behavior; the
broader terrain/material visual limitations remain open. No sustained-FPS or
loading-success claim follows from this small shader saving.

A further exact-zero grain-noise branch was tested and rejected. The existing
8.5 m grain field fades to zero with footprint, view angle and distance; the
candidate skipped its noise only after that existing fade completed. Actual WGSL
confirmed the Perlin call was inside the branch, and rendered health stayed clean.
However, same-build interleaved GPU samples did not reproduce a reliable saving:
`/tmp/grain-cull-paired.json` favored skipping by 0.59/0.17/0.55 ms, while reversed
ordering in `/tmp/grain-cull-reverse.json` gave -1.12/+0.81/-0.10 ms. The candidate
and temporary uniform were fully removed and the production build restored.
Do not retry this single-noise branch based on its algebra alone. The retained
24 m edge-normal optimization remains unchanged; further frame-budget work needs
a larger measured term. Shot/physics coverage remains as recorded above, with
independent green-speed calibration still a documented evidence gap.

The restored current build completed the full ten-minute Auto soak in
`/tmp/play-endurance-2ouNqw/report.json`: 601.22 s, 28.87 fps overall,
24.18–32.80 fps across 20 windows, with 14 windows below 30 and worst p95
66.8 ms. All windows remained visible, unfrozen, 1920×1080 at scale 1 with
111 tree records; renderer/network health was clean. GPU resource accounting
stayed effectively flat at 821.972 MiB. The final capture was inspected. During
the run the host reported AC power and Low Power Mode off; this does not identify
the cause of the timing variation. The performance gate remains failed.

Next measured candidate: root terrain seating currently performs four height
loads for foliage and rootless shadow geometry, even though their root-blend
weights are zero. Existing root-geometry tests establish that roots only occur in
near-tier branches. Preserve the recent root-shape work and shared beauty bark
material across LODs; do not remove seating from that shared material based on
the last processed LOD. Foliage and independent rootless shadow materials can be
examined without changing root geometry or the collision surface.

The repository full-hole harness now runs fitted 1080p and records per-shot rAF
cadence, first callback latency after input, quality state and per-frame fidelity.
Inactive screenshot intervals are excluded; initial callback latency is reported
and gated separately rather than silently discarded. It retains all functional,
audio and next-hole checks before reporting performance failure.

This exposed a shared QA defect: a native screenshot resets Chrome's fitted
display transform while CSS and renderer dimensions stay 1920×1080. Scaled clicks
then landed at client x=1237 instead of the minimap button's x=1887.
`/tmp/minimap-capture.json` reproduces four misses; sending identical metrics
again also failed (`/tmp/minimap-capture-reapply-failure.json`). The browser-fit
helper now restores its scoped display transform after captures with a subpixel
scale refresh followed by the exact requested scale, without changing CSS or
renderer dimensions. The runnable minimap check now captures before each click;
all four actual toggles pass with clean health and unchanged 1080p dimensions.
The prior endurance still establishes a performance failure, but predates this
post-capture presentation-fit correction.

`/tmp/play-hole-ykpbhy/report.json` passes the full metric-only gameplay replay,
one cup drop and actual next-hole click with the corrected fit helper. Shot mean
FPS is 34.01/39.94/35.77; p95 is 34.2/33.5/33.5 ms. The first shot has a 450 ms
maximum frame and 39.8 ms initial callback latency (later shots: 11.4/8.6 ms),
so the performance gate correctly fails. Every sampled frame retained 1080p,
scale 1, visible active simulation; health is clean. The result capture was
inspected. Profile the first-shot stall before attributing it to shader building,
quality changes or another cause; this is a new high-impact timing lead alongside
the root-seating steady-state investigation. Goal remains active.

### Remove unused live course-thumbnail readbacks

The first-shot CPU profile `/tmp/play-hole-M1GNhB/first-shot.cpuprofile`
recorded 105.7 ms in native `toBlob`, called by the delayed menu thumbnail
capture during flight, with a 110 ms long task. No node rebuild over 10 ms was
recorded in that shot. This identifies one pause, not every large frame.
Tracing the consumer found `Menu.thumbEl` is never assigned: saved-course cards
already contain names and hole counts only. Removed the obsolete capture timer,
countdown, blob ownership, refresh API and unused menu setter/CSS. The retired
thumbnail implementation test is preserved at `/tmp/course-thumbnail-retired.test.mjs`;
the real full-hole harness now asserts zero gameplay canvas `toBlob` calls.
Production build passes. The intermediate menu-only guard run
`/tmp/play-hole-l2x8fr/report.json` had zero captures and passed gameplay but still
failed performance (22.12/28.16/26.38 fps, first-shot maximum 950.3 ms), so removing
this dead work does not establish a general stall or sustained-FPS fix.

Final removal replay `/tmp/play-hole-3DEFPx/report.json`: zero application canvas
captures, clean health, all three exact rests, one cup drop and next hole score
reset. Every sample remained fitted 1920×1080 with active simulation. Per-shot
means 32.65/37.77/31.41 fps, p95 34.4/33.7/33.8 ms; maxima 500.2/50/482.7 ms
and first callback 56.9/17.4/16.2 ms. Performance gate correctly fails. These
runs are not isolated FPS comparisons (shared workspace and device workload);
the demonstrated improvement is removal of the proven unused readback only.
Next: trace remaining long frames with timestamps, GPU timing and native CPU
profiles; do not attribute them to the removed capture. Goal remains active.

Settled course-picker capture `/tmp/play-hole-chdLw3/course-picker.png` and
`menu-report.json` confirm both existing saved-course cards remain visible on the
real Play route, strict WebGPU, fitted 1080p and clean health. Screenshot inspected
after the opacity transition completed.

### Flag cloth clock reset and completed-render validation

Three-shot profiling reproduced a 471–558 ms render pause near Auto's Quality to
Balanced transition (`/tmp/play-hole-wv12BK`, `/tmp/play-hole-LGymJd`). Instrumented
native WebGPU device, queue, encoder, texture and context methods did not show an
individual call above 5 ms; do not claim pipeline creation is the cause yet.

`/tmp/play-hole-mBIMTy` also exposed a separate production failure: resetting the
shot environment clock retained flag cloth's fractional previous-shot accumulator,
causing `sampleWind requires a non-negative finite time` on every subsequent
render update. Its later apparent 60 fps is invalid: rAF continued while render
updates threw. Captured live stack points to `FlagClothSystem._step`. Closed that
owned browser after retaining evidence; no performance success from that run.

The shared cloth updater now drops only the old accumulator when the clock goes
backward, retaining cloth positions and solver history. A regression reproduced
-0.003333333333333334 s before the fix and passes afterward; all five cloth tests
and production build pass. The canonical full-hole benchmark additionally checks
that the post-processing render completed between measured animation callbacks.
This protects its FPS gate from a live rAF loop with failed rendering.

Post-fix full replay `/tmp/play-hole-LGymJd/report.json` has clean health, exact
rests, one cup drop and next-hole reset. It still fails performance: 33.58/38.68/
31.08 fps, p95 34.2/34.0/33.9 ms, maximum 483.5/50.2/501 ms. Goal remains active.

The manager-level trace `/tmp/play-hole-IEowwL/render-trace.json` finally located
many 10–29 ms `NodeManager.getForRender` calls for pine, terrain and prop materials
inside the long transition frame. Earlier wrappers missed this work; the evidence
does not support ruling out shader building. `setWeatherSkyWorkload` rebuilt the
entire sky/post graph even for a clear analytic sky, although every tier's changed
budget controls cloud work only. It now records the next cloud budget on the
existing clear sky, retaining node identities, post targets and history. Cloudy
workloads still use the existing replacement path. The regression verifies clear
identity/history retention and a subsequent clear-to-cloudy transition using the
new budget; ten weather/cloth tests and the production build pass.

The first completed-render counter wrapped the replaceable post pipeline and was
invalidated by quality rebuilding it. `/tmp/play-hole-IEowwL` therefore has false
invalid-frame counts despite clean health. The canonical counter now wraps the
stable SceneManager frame method, incrementing only after the complete production
update/render returns successfully. Do not treat those preliminary counts as
rendering failures. The final replay uses this corrected counter.

**Clear-sky shortcut rejected and fully removed.** Actual production diagnostics
in `/tmp/play-hole-F0wS3C/report.json` show `gpu-volume-raymarch`, starting `high`
at graph revision 1 and reaching `conservative` at revision 3. The assumption
that current Pineglass had clear skies was wrong. `_setupPost` also derives
sun-shaft ray steps and resolution from the weather workload, so retaining the
entire graph for clear skies without updating those controls would be incomplete.
No SceneManager optimization or associated test change from that experiment is
retained. Next root investigation: preserve the shared scene MRT/compatible scene
shader state across weather graph replacement while correctly updating cloud and
sun-shaft workloads. Do not replace this with a clear-sky-only success criterion.

`/tmp/play-hole-F0wS3C/report.json` verifies the corrected stable completed-frame
counter: zero invalid frames over 288/223/75 intervals, zero thumbnail readbacks,
clean health, full three-shot completion and next-hole reset. Performance remains
failed: 21.38/26.54/25.85 fps, maxima 1217/267.1/67.6 ms. These are not isolated
before/after timings; another root-asset QA process was observed overlapping the
preceding `/tmp/play-hole-Pk8XwX` run. No sustained performance gain is claimed.
Retained this turn: flag-clock correctness fix, regression, stronger live-render
measurement, and evidence locating expensive weather-transition scene rebuilds.

### Retain shared scene MRT across weather changes

SceneManager owns one scene and one camera for its lifetime. Weather graph changes
now retain that scene's existing PassNode, MRT declaration, color/velocity/depth
attachments and node identities; only weather-dependent effects are disposed and
rebuilt. Cloud raymarch budgets, sun-shaft resolution/steps, clear/cloudy switching
and temporal invalidation continue through their original paths. This replaces
last turn's rejected clear-sky shortcut and applies to Pineglass's actual
volumetric-cloud configuration. Nineteen temporal/weather tests and production
build pass. The full-hole harness asserts stable scene-pass and color attachment
UUIDs through live Auto adaptation and refuses absent identities.

First replay `/tmp/play-hole-RwD3Fm/report.json`: same scene pass through Balanced,
Quality and Balanced shot endpoints, exact three rests, one cup drop, actual next
hole, zero thumbnail captures, zero invalid completed-render frames, clean health.
Per-shot mean 34.99/35.28/34.70 fps; maxima 67.1/50.4/34.3 ms, versus repeated
roughly 500 ms transition frames in the prior traces. Inspected final screenshot.
P95 34.3/34.4/34.2 ms and first callback 332.2/15.7/12.7 ms still fail the gate:
this removes the observed large in-flight transition pauses in this run, not every
startup/launch delay or the sustained-performance requirement. The first replay
recorded PassNode UUID correctly but RenderTarget has no UUID; the final harness
records its color texture UUID instead and validates both are present.

Final replay `/tmp/play-hole-JSqXSF/report.json` validates nonempty, unchanged
PassNode and color-attachment UUIDs for every shot. Full gameplay, next hole,
health and completed-render fidelity pass. Means 34.48/38.51/34.32 fps; p95
34.3/34.3/34.3 ms; maxima 50.9/50/34.4 ms; first callbacks 23.6/7.5/7.8 ms.
The unchanged strict p95 gate correctly fails. No 400–500 ms transition pause
recurred in either post-change replay. Next: repeat ten-minute endurance with
completed-render validation and inspect remaining steady-state frame cost;
retain the unresolved launch-delay observation from the first run. No new
endurance result is claimed yet. Goal remains active.

### Ten-minute endurance after scene-pass reuse

The canonical endurance harness now starts fitted 1920×1080 before navigation
and counts only frames whose complete SceneManager update/render returns. Every
sample also checks visibility, active simulation, drawing-buffer size and internal
scale. It retains the existing 20×30-second tee/travel cycle and strict gates.

`/tmp/play-endurance-UIcvNe/report.json` and `summary.json`: 601.17 seconds,
29.389 fps overall (weighted by measured frame intervals), 23.491–33.190 fps per
window, 13/20 windows below 30, worst p95 66.7 ms and maximum 200.1 ms. All sampled
frames were valid, visible, unfrozen, scale 1 at 1080p; 111 trees remained present,
health errors were empty. GPU resource accounting stayed 777.81864–777.81974 MiB.
Final screenshot inspected. The process exited with the expected performance-gate
failure and closed its owned browser. No application rebuild or competing asset-QA
process was observed during this run. This is not a sustained-performance success;
scene-pass reuse addressed transition churn but has not made the full scene fit
the target's steady-state budget.

Next measured candidate: root seating currently samples four terrain texels on
all procedural tree vertices, including foliage and independent shadow geometry
whose rootBlend is identically zero. Keep seating on the shared beauty bark
material (near roots use it; bark materials span all LODs). First verify the
rootless draw invariant, then compare the complete scene with only those unused
samples omitted. Do not infer a frame-time gain from shader counts alone. Remaining
loading cadence, visual-quality and physical-reference gaps stay in the goal.

### Omit root seating on rootless procedural draws

The shared tree shader now bypasses terrain seating for foliage/blossoms and
independent shadow draws, whose generated `rootBlend` is identically zero.
Beauty bark retains seating across every LOD because those draws share the near
root material. Root generation, transforms, wind/history and shadow visibility
are unchanged. Extended the root-geometry invariant check to cover foliage and
blossoms; nine root tests and production build pass.

`/tmp/tree-seating-current-before-shaders.json`, `tree-seating-after-shaders.json`
and `tree-seating-shader-check.json` verify all 24 rendered pine vertex shaders:
15 foliage/shadow shaders went from four height loads to zero; all nine beauty
bark shaders retain four. The after screenshot was inspected in the real scene.
An initial probe used an older build and is not the comparison baseline. Refreshed
the production build first and verified root-generator/preset/control source
hashes stayed unchanged between matched before/after builds.

Complete-scene fixed Battery/1080p tee samples in
`/tmp/tree-seating-current-before.json`: 30.129/31.044/30.994 ms tracked GPU time
per frame; `/tmp/tree-seating-after.json`: 29.597/29.831/30.220 ms. Clean health
and original fidelity in both. This suggests a small improvement (median about
1.16 ms), but separate-run timing is not an isolated causal or sustained-FPS
proof. No textures, geometry quality, shadow casters or render resolution were
reduced. Full-hole validation follows; the overall goal remains active.

Final full-hole `/tmp/play-hole-QjDcIl/report.json`: exact three rests, one cup
drop, next-hole score reset, stable scene-pass/attachment identities, zero
thumbnail readbacks, zero invalid completed renders and clean health. Means
34.41/35.08/34.22 fps, p95 34.1/49.6/33.7 ms, maxima 66/50.9/34.3 ms;
first callbacks 25.3/12.6/7.3 ms. The unchanged performance gate correctly fails.
Final result screenshot inspected. Retain the verified removal of dead height
sampling, without claiming sustained 30 fps. A possible next vertex-work test is
skipping seating on zero-weight trunk/branch vertices within the shared bark
shader, preserving positive-weight near roots; measure branch cost before
retaining it. Loading and overall visual quality remain unfinished too.

### Reject conditional seating within shared bark

Current-state inspection found last turn's verified foliage/shadow bypass absent
from ProceduralTrees.js after shared-worktree history changes. Restored only that
narrow bypass; existing root geometry/invariant tests were still present.

Tested an additional bark vertex branch: sample terrain only for rootBlend.x > 0.
A temporary uniform forced the original sampling on zero-weight vertices without
changing any output, enabling same-build interleaved complete-scene measurements.
WGSL showed the four loads inside the intended branch and rootless draws remained
free of terrain loads. `/tmp/bark-seating-paired.json` adjacent savings were
+1.378/-0.536/-0.539 ms; reverse ordering `/tmp/bark-seating-reverse.json` gave
-1.269/+0.091/+0.193 ms. No consistent benefit. Removed the entire extra bark
branch and temporary uniform, retaining unconditional seating on beauty bark.
Nine root tests, production rebuild and diff checks pass.

Restored full replay `/tmp/play-hole-TfDQlZ/report.json`: exact rests, one cup drop,
next-hole reset, stable scene targets, clean health and zero invalid completed
frames. Means 33.90/32.74/33.80 fps, p95 49.9/49.9/33.6 ms; maxima 83.9/50.7/
34.2 ms; first callbacks 70/13.6/6.7 ms. Screenshot inspected; performance gate
correctly fails. Do not repeat the zero-weight bark branch without new evidence.
Next candidate to inspect: fixed-parameter work in sun shafts (distance attenuation
is assigned uniform zero yet native Godrays evaluates a per-sample power). Verify
actual shader/callers and measure before replacing uniforms with constants;
keep the current appearance and weather response. Goal remains active.


### Pass closed at user request — 2026-09-06

Retained the sun-shaft distance attenuation as `float(0)` instead of a uniform
fixed at zero. Actual GPU readback compared 552,832 bytes of the 480×270 shaft
target with zero differences (`/tmp/sun-attenuation-pixels.json`); paired timings
were mixed, so no FPS improvement is claimed. Temporary comparison controls were
removed. Final production build passed in 8.55 seconds.

The final full-hole attempt ended during readiness with Puppeteer's
`TargetCloseError: Protocol error (Runtime.callFunctionOn): Target closed`
(`/tmp/sun-attenuation-final-hole.log`), so it provides no final replay validation.
The previous successful functional replay is `/tmp/play-hole-TfDQlZ/report.json`
above. Latest ten-minute endurance evidence remains
`/tmp/play-endurance-UIcvNe/report.json`: 29.39 fps overall, 13 of 20 windows below
30 fps. Sustained 30 fps, loading cadence, visual polish and physical calibration
remain unfinished. Close this pass without further experiments or claiming the
broader goal complete; preserve the current improvements and recorded evidence.
