# Performance and large-course shadow plan

Target: sustained 30 fps at crisp 1920×1080 on the A18 Pro Mac. Auto should spend
verified spare capacity on quality. Preserve playing surfaces, ball physics, the
111 procedural tall pines, and fitted headful WebGPU browser QA.

## Shadow revision

1. Keep three camera-centered cascades with a fixed distance and map budget,
   independent of total course dimensions. Use 1024² maps and feathered PCF edges
   for Battery (500 m reach), 1536² for Balanced (750 m), and the device's richer
   maps for Quality/Ultra (1000 m). Elevated cameras extend this reach in 50 m
   altitude bands so overview shadows still reach the ground, with no larger
   maps. Native cascade fading softens the far boundary.
2. Select procedural casters independently for each shadow camera, with bounds
   covering wind deformation. Retain off-screen casters that reach visible
   receivers; never reuse the beauty camera's compacted list.
3. Measure the complete scene and moving cameras. Lower map resolution alone has
   shown little speedup; fewer submitted casters must demonstrate its own gain.
   Battery also raises procedural tree detail thresholds by 1.5×, Balanced by
   1.15×; Quality retains the authored thresholds and Ultra retains full meshes.
   This uses the existing coverage-compensated mesh tiers without removing trees.
   Cloud shadows use the existing weather light-probe budgets: 4/6/8 samples for
   Battery/Balanced/Quality, instead of always paying for eight samples.
4. For large-course residency, reuse spatial course chunks to select the union of
   beauty, reflection, and shadow coverage. Stream that working set rather than
   enlarge shadow maps or upload the whole course. The present forest still owns
   all source records; per-cascade culling alone is not streaming.
5. Cache distant maps only when coverage, sun, and contributing casters are
   unchanged. Wind-animated casters invalidate the cache. Do not claim savings
   from freezing animation or dropping shadows.

## Remaining acceptance

- Auto: fixed 33.3 ms target, two-second observation windows, two overloaded
  windows to demote, ten seconds of CPU/GPU headroom before a promotion trial,
  and a cooldown after a failed trial. Preserve manual higher-quality modes.
- Complete scene: 60 seconds per representative pose, average ≥30 fps,
  presentation p95 ≤34 ms, GPU p95 ≤33.3 ms; then a ten-minute worst-view/motion soak.
- Practice / Play / Create, current and saved courses, single loading sequence,
  hidden Creator UI during loading, resized composer and visible ball.
- Cold load, warm reload, and course handoff: measure putting-scene cadence and
  long tasks, not just total load time.

Latest evidence: `/tmp/menu-flows.json` verifies all three menu paths, saved
Grasslands Play, one course-loading stage per navigation, and hidden Creator UI
during loading. `/tmp/play-auto-feathered-shadows.json` measures 30.66 fps with
34 ms presentation p95 at 1080p after a 20-second settling period in a 120-second
live Auto run. All 111 pine records remain resident and browser health is clean.
Four stable bilinear comparison taps preserve adjustable feathering and replace
the five rotated PCF taps. The preceding eight-to-four cloud-shadow sample change
alone measured 29.97 fps. These single-run results need broader verification;
the performance goal remains open pending the acceptance gates above.
Shadow-size and AA-bypass experiments alone did not materially improve GPU time.

`/tmp/live-shadow-sweep.json` subsequently measured five 60-second live Auto
views: tee 30.31 fps, approach 36.46, second tee 35.15, layup 40.40, overview
33.07. Frame p95 was 34–34.3 ms, narrowly missing the stability gate in four
views. The overview also exposed insufficient shadow reach at 540 m altitude;
its performance result is not visual acceptance. `/tmp/shadow-overview-fixed.png`
verifies restored ground shadows at 540 m altitude. Its short fixed-Battery,
frozen-animation capture measured 29.23 ms mean frame time and 29.13 ms GPU p95;
live endurance still needs repeating. `/tmp/shadow-motion-seq/report.json` has 24 moving-camera
frames and clean browser health, with simulation frozen for this visual capture.

Cold/warm-page/warm-course loading measurements in
`/tmp/shadow-loading.log` show typical loading cadence near 60 fps but maximum
gaps of 550/484/484 ms, mainly during asset decoding. Loading remains unfinished.
The old harness then timed out checking a thumbnail element removed from the
course picker; that obsolete assertion has been removed. The corrected harness
completed all three phases with clean browser health. CPU profiling identified
synchronous minimap rasterization as a major hitch. Map preparation now yields
between six-millisecond row batches, cancels obsolete hole work, and is awaited
before course handoff. `/tmp/minimap-chunks-loading.log` verifies the correction:
cold/warm-page/warm-course maximum gaps fell to 166/217/200 ms, with loading
frame p95 17.6–17.7 ms and clean WebGPU/browser health across all three runs.
Remaining construction and atmosphere stalls still prevent smooth-loading
acceptance. The latest build and 16 focused minimap, shadow, and Creator UI tests
pass. Next: reduce those measured stalls, add worst-view frame-time margin,
repeat the live overview/motion coverage checks, then run the ten-minute soak.

Current complete-Play recheck: `/tmp/current-play-sweep.json` measures the latest
cup/audio build at crisp 1080p with live animation and all 111 pine records.
Sixty-second means are 31.12 fps at the tee and 32.12 fps in the overview, both
with 34 ms presentation p95 and clean browser health. Most sampled GPU p95
windows are below 31 ms, but one overview observation reaches 35.53 ms; the GPU
stability gate is still open. A reproducible ten-minute tee hold / smooth travel
test is now `node scripts/benchmark-play-endurance.mjs`. It writes incremental
30-second reports and fitted screenshots under `/tmp/play-endurance-*`; a started
run is not acceptance until its complete report and images have been inspected.

The first complete endurance run, `/tmp/play-endurance-donu7w/report.json`,
failed: 602.2 seconds, 29.16 fps overall, 30-second windows from 15.91 to 34.35 fps,
and presentation p95 up to 83.4 ms. The final screenshot retains the full scene;
all 111 records and 1080p remain, browser health is clean, and renderer memory is
roughly stable at 867–899 MB across quality changes. GPU and CPU costs rose
together in the slow middle section and later recovered. `pmset -g therm` reported
no recorded warning; this does not prove the absence of thermal or system-load
effects. The sustained 30 fps goal is not achieved. Next: bracket live diagnostic
perturbations with repeated baselines to isolate useful rendering headroom.

`/tmp/current-live-isolation.json` brackets temporary changes with live Battery
baselines. Removing tree draws reduced GPU throughput from about 32.9 to 25.0 ms;
halving shaft samples showed no clear benefit. Baselines themselves worsened
from 31.1 to 43.3 ms, so a precise gain cannot be claimed. All diagnostics were
restored, and browser health remained clean. A doubled existing tree-LOD threshold
probe (`/tmp/current-lod-isolation.json`) measured 31.7 ms between 39.3 and 32.8 ms
baselines: too much baseline variation to justify a visible quality reduction.
No rendering downgrade from these probes has been retained. The remaining loading
stalls are being re-profiled through the current complete Play route.

Current loading profiles (`current-play-loading-tpBJyM`, under the system temp
directory) identified synchronous canopy distance transforms. The shared bake
now returns after clearing distance bits when there are no habitat primitives,
preserving surface eligibility without allocating/rasterizing/transforming an
empty field. `/tmp/empty-canopy-comparison.json` brackets the same 1.92-million-
texel CPU calculation: 32.6–34.2 ms before, 0.61–0.74 ms after, identical SHA-256
output. This is an isolated preparation improvement, not a frame-rate claim.
Twenty canopy/material tests and the production build pass.

`empty-canopy-loading-hX5OFc/report.json` (system temp) verifies cold, warm-page and
warm-course production Play loading with clean browser health. Active p95 is
17.6 ms; maximum gaps remain 183/316/283 ms, so smooth loading is unfinished.
A concurrent loading-presentation edit added mural diagnostics between builds;
it was preserved and prevents attributing whole-workflow timing differences to
this one change. Remaining nonempty canopy transforms and atmosphere work still
need bounded preparation or worker execution.

The next loading pass retains three shared fixes:

- Production canopy preparation now runs the existing bake in a worker and
  transfers both fields back. Terrain keeps the same texture objects/storage;
  Grass remains a borrower. A real worker transfer test verifies byte-identical
  coarse/fine results, preserved eligibility and invalid-input error reporting.
- Courses without biome transitions use one exact constant texel per biome
  texture. Pineglass avoids classifying 385,000 identical samples, retaining
  48 CPU bytes and 16 packed texture bytes instead of 18.48 MB and 6.16 MB.
  Courses with transitions retain their existing resolution and sampling.
- Alpine massif construction yields between small column batches instead of
  blocking on each complete mountain segment. Heights, normals and topology
  use the same calculations and ordering.

`loading-batches-9h6ism/report.json` under the system temp directory verifies
cold/page/course handoff through real Play: presentation p95 is 17.6 ms in all
three phases, with 3/4/4 frames over 50 ms and maximum gaps of 184/166/183 ms.
Active-loading maxima are 150/151/183 ms. Browser/WebGPU health is clean.
The repeated 50–60 ms mountain tasks and roughly 200 ms constant-biome startup
task are gone from the profiles; remaining major tasks are atmosphere preparation
and the final visible handoff. These results do not certify smooth loading yet.
The extra yielding adds roughly 1–2 seconds to this loading run; responsiveness
improves at that cost. Existing concurrent loading-presentation work is preserved.

`/tmp/play-hole-o0VHr2/report.json` replays the complete metric-driven hole on this
build with identical resting positions, a single cup sound, three strokes,
next-hole continuation and clean health. Rendered course and cup screenshots were
inspected. The ten-minute FPS failure remains open; this pass targets startup
work and does not claim a steady-state rendering gain.

The next measured stall was native storage-buffer repacking: Grass allocated
2,097,152 three-word integer records, which Three repacked to the required
four-word WGSL storage stride on first upload. Grass now allocates/writes an
explicit `uvec4`; X/Y/Z retain the same identity, wind and LOD values, with W zero.
GPU storage size stays 32 MiB. This avoids the temporary 24 MiB source allocation
and the per-record conversion loop. Nine allocation/camera-motion checks pass.

`aligned-grass-loading-jTRABm/report.json` (system temp) records clean native
WebGPU cold/page/course loads. In the comparable cold atmosphere profile window,
attribute creation sampled 53 ms versus 144 ms before alignment. This is a
localized CPU improvement: whole-workflow maximum gaps were 234/133/233 ms,
active maxima 116/133/233 ms, and active p95 17.5 ms. The warm-course trace
still contains consecutive 2048-square image uploads of 61 and 73 ms and
four 32 MiB attribute uploads totaling about 71 ms. Loading remains unfinished.
The harness now records active-loading upload costs as well as handoff costs.

Repeated daylight PMREM captures took about 6 ms CPU in `/tmp/pmrem-before.json`;
recreating the capture scene was not the measured CPU stall, so its ownership
path is unchanged. Native compileAsync already yields between objects/stages;
adding another scene compilation batching layer would miss these upload stalls.

`/tmp/play-hole-nOjrsJ/report.json` verifies the aligned layout through a complete
three-shot hole, identical resting positions, one cup drop and next-hole reset.
Browser health is clean and final rendered evidence was inspected.

The two remaining slow 2048-square image uploads were identified as the authored
pine-straw color/roughness and normal/height/AO packs. Explicit HTML image
`decode()` did not help (`decoded-floor-loading-zZjEmv/report.json`, system temp)
and was removed. A paired native WebGPU probe (`/tmp/floor-upload-probe.json`)
measured HTML image uploads at 49–73 ms versus bitmap uploads at 0.8–4.8 ms.
Both paths produced identical GPU byte hashes for each complete RGBA pack.

Terrain now decodes these owned maps directly from the same asset URLs to
ImageBitmap with premultiplication and color conversion disabled. Existing
texture color spaces, orientation, mipmaps, filtering and ownership remain.
Normal disposal closes each bitmap once; disposal during loading closes late
results and rejects readiness. HTTP failures reject without a substitute map.
Thirteen material, loading-lifetime and grass-state checks pass; production
build succeeds. `/tmp/bitmap-floor-visual.json` verifies the production maps are
2048-square bitmaps with the same GPU hashes as the original path and clean
WebGPU/browser health. `/tmp/bitmap-floor-close.png` captures the actual tree base.
This verifies resource fidelity, not overall close-range visual excellence: the
existing large grass ribbons and flat distant forest-floor appearance still
need visual review.

`bitmap-floor-loading-UVQAbQ/report.json` (system temp) passed cold/page/course
loading and health checks, but did not pass responsiveness. Active p95 was
17.8/17.5/17.5 ms, maxima 1001/117/249 ms; whole-workflow maxima were
1001/434/299 ms. The large cold gaps occurred in catalog/manifest preparation
before these floor maps loaded. Actual warm-course bitmap uploads took 29 and
50 ms, and the atmosphere task still combined shadow work, field uploads and
material preparation. The isolated upload gain does not certify smooth loading
or sustained FPS. Remaining work must measure the full workflow and separate
owned resource uploads before compilation, while retaining the genuine putting
scene and exact material data.


Calm procedural trees now bypass wind deformation in their vertex shaders. The
existing sampled wind buffer supplies separate current/previous activity flags,
so flutter stops in calm conditions and its motion history follows each sample.
`/tmp/calm-tree.json` verifies actual Play/WebGPU startup, all 111 trees, zero →
15 mph → zero wind, and clean console/network health at 1920×1080. The final
`/tmp/calm-tree.png` was inspected. Three interleaved normal/forced-deformation
pairs gave normal tracked GPU means of 31.07/32.95/32.71 ms, versus
31.40/32.04/50.47 ms forced. That variability does not establish a reliable FPS
gain; retain the fix for correct calm motion, not as proof of the 30 fps goal.
An earlier build failed in LoadingGreen supersampling initialization; the current
shared source had already removed that path, and a rebuild passed. The failure
stack is retained in `/tmp/calm-tree-loading-failure.log`.


Stationary grass now omits its retained wind compute dispatch only when base wind
and turbulence are both exactly zero, after one final update settles previous
LOD/wind. Camera/projection, surface-texture, and workload changes still recompact;
wind or turbulence resumes per-frame updates. Fourteen vegetation checks pass.
`/tmp/calm-grass.json` verifies that the entire 32 MiB GPU state has the identical
SHA-256 (`86600737e3f85a9e8dbfe8e92b86ff69033d967798a092d6de3f1b1ebbfc46af`)
with the dispatch skipped or forced. Native timestamps confirm the retained wind
pass disappears. Interleaved whole-frame means remain variable (31–33 ms normally),
so this is reduced work with exact state preservation, not sustained-FPS acceptance.
The final 1080p screenshot was inspected; browser health is clean.

`/tmp/play-hole-mLmmA1/report.json` replays all three metric-only shots at 1920×1080
with these vegetation changes: identical resting positions, score three, one cup
drop, and next-hole continuation, with no browser errors. Final shot evidence was
inspected. Both calm timing probes also caught a roughly 0.48-second completion gap
coincident with a PMREM refresh; the next investigation targets its resource
replacement rather than changing lighting quality or lowering resolution.


PMREM refresh now uses Three r185's existing `fromScene(..., { renderTarget })`
option to update the owned target in place. The environment texture identity stays
stable; configureWeather still disposes it when replacing the weather system.
The capture cadence, resolution, sky shader and all material lighting are unchanged.
Four PMREM cadence/ownership tests pass. `/tmp/pmrem-reuse.json` confirms identical
720,768-byte GPU captures for reused versus newly allocated targets (SHA-256
`0de1f2de9a836cd6cc8d83312cf3b270dad5f242f82147d356e94835443ad23f`).

A same-build interleaved real WebGPU comparison in `/tmp/pmrem-paired.json`
reintroduced the old allocation behavior only during two controlled refreshes.
Those produced 416.8 and 433.4 ms maximum rAF gaps; the adjacent warm reused-target
refreshes peaked at 33.7 and 34.4 ms. The first reused refresh peaked at 83.3 ms.
This isolates target replacement as a major recurring hitch; the earlier 6 ms
synchronous PMREM measurement missed the subsequent renderer cost. Both probes
have clean browser health and preserve the final production behavior. The native
1080p screenshot was inspected. Ten-minute endurance is being rerun; this local
hitch fix alone does not certify the complete frame-rate or loading targets.


The ten-minute rerun `/tmp/play-endurance-9gYghg/report.json` **fails** the sustained
performance gate: 600.8 seconds, 28.86 fps overall, 30-second windows 24.84–32.94 fps,
and p95 up to 50.8 ms. GPU memory remains about 818–819 MiB, browser health is clean,
and every window retains native 1920×1080, live simulation, visible presentation
and all 111 procedural trees. Auto settles to Battery, with occasional promotion
trials. The final screenshot was inspected. Fixing the reproducible PMREM hitch
has not solved sustained throughput; the remaining work needs more headroom in
the complete scene, not another claim based on the short refresh probe.


A subsequent interleaved 1024/768-square camera-shadow diagnostic
(`/tmp/shadow-size.json`) did not establish a throughput gain from smaller maps.
The warm 1024 result was 33.35 ms tracked GPU/frame versus 34.65 ms at 768;
earlier pairs also varied. All runtime overrides were restored and browser health
was clean. No production shadow-size reduction was retained. The next useful
investigation is the dominant beauty/material workload; avoid further quality
cuts without a repeatable complete-scene gain.


Unused maintained-turf ray experiment (rejected): gated each bake's parallax and
self-shadow ray work by its exact blend support, retaining unconditional filtered
texture reads and the existing single-conditional rough override. Fifteen material
checks passed; `scripts/shot.mjs --asset "turf: rough" --probe --size 1920x1080
--out /tmp/unused-rays-rough.png --url http://127.0.0.1:4173` reported no near-black
pixels or renderer errors. Full Play `/tmp/play-hole-0sOwbJ/report.json` passed the
three metric-only shots, identical rests, cup audio and next-hole continuation;
close rough and green captures were inspected. Those close captures still expose
the previously recorded coarse grass ribbons; this was not a visual-quality fix.

Separate original/optimized builds at the same three poses suggested 30.54→29.29 ms
at the tee, 24.15→23.60 ms in close rough, and 23.36→23.24 ms near the green
(`/tmp/play-hole-IgR81l/terrain-probes.json`,
`/tmp/play-hole-sAY4uQ/terrain-probes.json`). A subsequent temporary uniform allowed
same-build interleaving in `/tmp/turf-rays-paired.json`: optimized/original pairs
30.16/30.51, 31.25/32.02, 32.78/32.56 ms. Timing drift and the reversing final pair
do not establish a reliable gain. Both the proposed mask and temporary uniform
were removed; the original material path is retained. Browser health was clean.


Turf filtering diagnostic `/tmp/turf-af.json` compared 8×/4× anisotropy on the same
2048×2048×3 albedo and normal/relief arrays, with all source data retained. The
interleaved tracked GPU times were 28.75/30.19/30.76/33.04/33.22/32.05 ms in
8/4/4/8/8/4 order. Close green captures were inspected and health was clean,
but timing drift prevents a reliable gain claim. Original 8× filtering was restored.

Class isolation `/tmp/terrain-class-isolation.json` measured roughly 30–32 ms with
the full scene, 25.47 ms with only the backdrop hidden, and 23.64 ms with only the
playable terrain hidden. Visibility changes were diagnostic only and were restored.
Further backdrop material isolation `/tmp/backdrop-material-isolation.json` left
geometry/vertex relief intact: disabling all color/normal/roughness detail reduced
31.90–32.41 ms surrounding baselines to 27.09 ms. Removing individual output nodes
was inconclusive because the remaining outputs share those calculations. Every
material node was restored; no simplified mountain material is retained.

The solid backdrop was explicitly sorted before all foreground geometry. A native
depth-order comparison `/tmp/backdrop-order.json` preserved every material, vertex,
source tree and 1080p target. Later/original/original/later/later/original tracked
GPU times were 27.92/30.41/30.91/30.49/30.68/32.08 ms. The first balanced quartet
suggests about 1.46 ms saved; the final adjacent pair suggests 1.41 ms. Gameplay
captures were inspected and health remained clean. The solid shell now follows
foreground opaque depth (order 2), with its far ribbon still after its foothill
band (order 3). Existing polygon offset retains course-edge depth ownership.
Forty-one backdrop/atmosphere checks pass. Production validation in
`/tmp/play-hole-gQ9sWG/report.json` passes all four moving boundary traversals and
the complete three-shot metric-only hole at 1920×1080, with unchanged resting
positions, one cup drop, next-hole continuation, all 111 source trees and clean
WebGPU/console/network health. Boundary screenshots expose a visible material
band; matched old/new draw-order captures in `/tmp/edge-order.json` confirm it
predates this change. This remains a visual-quality failure. The modest isolated
timing improvement does not prove sustained 30 fps; the ten-minute gate remains
open.

A follow-up runtime-only atmosphere isolation (`/tmp/edge-atmosphere.json`)
disabled backdrop aerial perspective at the same min-Z camera pose. The near
material band persists while distant peaks lose atmospheric haze; removing
atmosphere does not solve the defect. No atmospheric source change was retained.
The next diagnosis should isolate the ground/material and geometric transition
at grazing angles. The probe used strict WebGPU at 1080p with clean health and
closed its dedicated browser after capture.

The next isolation (`/tmp/edge-material.json`) held the same camera and replaced
backdrop color with the shared grass substrate, then removed its normal node.
Both diagnostic changes left a straight edge feature; neither was retained.
Source inspection found the ring grid skipped subdivision across the entire
course width/length, producing side-strip triangles hundreds of metres wide.
The ring now subdivides those spans at its existing 24 m spacing and omits the
central rectangle by cell range. The 12 m overlap, sampler, shaders and physical
course are unchanged. A geometry assertion bounds triangle X/Z spans to 36 m
(including overlap) and verifies the central playable rectangle stays unmeshed.
All 41 backdrop/atmosphere checks and the production build pass.

`/tmp/play-hole-8nJway/report.json` passes four moving boundary traversals and the
three-shot metric-only hole at 1920×1080, with one holed/cup-drop event and next-hole
continuation; console/network/WebGPU health is clean. All four boundary captures
were inspected against the previous grid: the artificial straight foothill crest
now follows the sampled hills/valleys, notably on min-X and min-Z. A near green-to-
gray material band remains conspicuous, so this is a geometry correction, not
acceptance of seamless blending. Added geometry has not yet been profiled in the
full endurance/loading workflows; those gates remain open.

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

A subsequent clipmap isolation (`/tmp/edge-clipmap.json`) captured the same min-Z
edge with the playable terrain visible, hidden, and restored. The green-to-gray
band remains unchanged with the entire playable terrain hidden. The feature is
inside the backdrop; the terrain's out-of-bounds sentinel/clipping is not its
cause. No clipping change was made. This production-path probe used headful Chrome,
strict WebGPU, 1920×1080 and a fitted physical window, with clean console/network
health. The dedicated browser completed and closed. Combined with the earlier
color/normal and atmosphere isolations, the next visual work should address the
backdrop's grass-to-foothill transition at grazing views, rather than altering
playable boundary ownership or physics.

A shared-grass-only vegetation material trial passed 41 checks and the full
metric-only hole (`/tmp/play-hole-uLSlCu/report.json`), but failed visual review:
it removed the gray-green palette transition while making the foothills broad,
featureless green slopes, with the straight band still visible. The material edit
was fully reverted; the restored production build passed. Do not retain that
palette deletion as a visual fix.

A stronger runtime normal isolation (`/tmp/edge-flat-normal.json`) replaced the
entire backdrop normal with one constant view-space normal, then additionally
used the shared grass color everywhere. The same mid-image band persists even
with both changes, so normal variation alone does not explain it. These overrides
were diagnostic only, in a dedicated headful 1080p WebGPU browser that finished
and closed. Further isolation should include post-processing contributions and
remaining material outputs (roughness/AO), rather than repeating color-only or
normal-only changes. Source and preview are restored to the last retained build.

Post-processing isolation `/tmp/edge-post.json` bypassed the final composite in
favor of the actual Scene MRT with the renderer's normal display transform.
The band persists, ruling out creation by TRAA, shafts, bloom or cloud compositing;
the original output graph was restored and the probe completed cleanly.

`/tmp/edge-constant.json` then held backdrop color, normal, roughness, specular and
AO constant and disabled its material aerial perspective. The mid-image band
disappears in this combined isolation. Earlier individual-input experiments must
not be read as ruling out interacting causes: shared color alone and atmosphere
disabled alone both retained the band. Next compare shared grass color combined
with no aerial perspective, and sample the actual near-to-far height/distance
profile to distinguish a compressed valley/horizon transition from material
parameter discontinuity. All captures used real headful WebGPU at 1080p and saved
clean runtime health. The constant-material probe saved its report/screenshots
but its Node process remained alive after Chrome had no child process; that
owned process (43839) was terminated during cleanup. No diagnostic material or
post-processing changes were written to production source.

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
