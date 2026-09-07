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
