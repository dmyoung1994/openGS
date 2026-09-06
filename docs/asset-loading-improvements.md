# Repeat material loading

## Preloaded putting presentation

The HTML head now preloads the real creator green's 12 dependencies (six turf
maps, three dirt maps, walnut flagstick, ball geometry, ball normal). WebGPU
preparation decodes/uploads/renders this scene before critical course residency
begins. The full creator scene is retained while hidden, not recreated during
rebuild/preview; animation stops when the playable course owns the renderer.
The temporary texture-free miniature was removed, not shipped as a fallback.

VisualAssetResidency now uses normal HTTP caching instead of unconditional reload.
Byte length and SHA-256 validation still execute; changed metadata rejects stale
bytes. In `/tmp/loading-green-qa.json`, preload requests began around208ms after
navigation; the full putting scene was ready at2001ms, ahead of course verification.
All 12 subsequent verifier requests transferred only300-byte revalidation overhead
in the development server, rather than downloading image bodies again. A real
course rebuild activated the retained scene immediately with unchanged prepared
timestamp; it rendered37 further frames and paused after the3.99s rebuild.
The delayed-real-tree-request run completed four putts, strict WebGPU, no errors.
This is not a claim of instant cold first visit: device/code/initial asset startup
remains measurable. Retained assets and GPU targets consume memory intentionally;
include them in the integrated device performance/memory budget.

## Implemented: turf CPU-pack reuse

`Terrain.loadTurfMaps()` previously loaded six 2048² images and copied their pixels
through Canvas into two three-layer RGBA arrays on every terrain construction.
Browser HTTP caching did not eliminate image decoding, canvas readback, or the
96 MiB allocation/copy. These operations ran again after course teardown.

The loader now retains one fixed 96 MiB packed CPU representation. Concurrent and
subsequent requests share its promise/pixels. Every Terrain receives independent
GPU Texture objects and image descriptors; terrain teardown still disposes those
GPU objects. No course, geometry, material, renderer, or GPU handle is cached.
Failed loading/packing clears the pending cache and can be retried. The existing
2048² validation, channel bytes, layer order, sRGB/data interpretation, mipmaps,
anisotropy, and source materials are unchanged.

This is deliberately one fixed pack, not an unbounded map. While terrain is live,
the retained CPU storage is the same bytes already used by its array textures.
After all terrain is disposed, the 96 MiB stays available for the next course.
Page reload clears it and is required after replacing source image files.

## Evidence (2026-09-04 local)

Canonical dedicated headful Chrome, strict hardware WebGPU, `/range.html`, Beach
Range, Ultra, render scale 1, 1280×720. Evaluator camera `[0, terrain+0.5, -20]`,
looking at `[0, terrain, -22]`, FOV 40. All 173 authored palm records retained.
Both captures passed bootstrap, scene identity, nonblank content, renderer, and
console/network health checks.

| Operation | Before | After |
| --- | --- | --- |
| First isolated turf decode/pack (HTTP cache already warm) | 877.9 ms | 750.8 ms; repeat run 1148.1 ms |
| Subsequent turf decode/pack calls | 163.1, 180.4 ms | 0.2, 0, 0 ms; repeat run 0.6, 0.1, 0.1 ms |

Zero means below the browser timer's resolution, not zero CPU cost. Cold variation
is substantial; only eliminating repeated pack work is the supported gain.
These timings exclude first GPU upload/mipmap generation and shader compilation.
They are not whole-application startup claims or frame-rate improvements.

`node scripts/benchmark-turf-loading.mjs` repeats concurrent loads and disposed
owner replacement, then invokes real `window.golf.rebuild()`. It asserts shared
CPU storage, distinct GPU objects, the fixed 96 MiB bound, and exactly one disposal
event per old array during actual course teardown. The measured whole-course
rebuild was 4651.4 ms (no before measurement for that metric). Post-rebuild strict
WebGPU screenshot and health passed; evaluator camera was restored and warmed.

Temporary evidence: `/tmp/turf-loading-before.{png,json}` and
`/tmp/turf-loading-after.{png,json}`. Rendered turf inspected without changes to
lighting/material appearance. 18 terrain/turf tests passed and `npm run build`
passed (existing large-chunk warning remains).

## Remaining asset-loading costs after the original CPU-cache step

- Tree catalog verification already memoizes URL/hash identities, but GLB parsing,
  geometry preprocessing, texture decoding/upload, and shaders still occur during
  rebuilds. Tree beauty owns and disposes those resources. Do not memoize the
  returned prototype objects without first changing that ownership contract.
- Forest-floor, coast, water, ball, and prop loaders have separate ownership rules;
  this change does not claim to accelerate every material.
- Full browser/page reload starts a fresh CPU cache. Network caching remains the
  browser/server's responsibility; no service worker, persistent cache, or stale
  integrity bypass was introduced.
- Repeat scene creation still creates/uploads new turf GPU textures. If transition
  profiling proves those uploads dominant, a bounded renderer-owned material
  residency pool is the next step, with explicit eviction and disposal tests.

## Putting-screen responsiveness (2026-09-04)

The loading presentation remains the real preloaded `CreatorScene`, with its full
turf, pin, ball, lighting and actual `Ball` physics. Twelve early HTML preload
hints cover its exact textures/model on app routes, not the asset viewer.
Visual integrity checks use normal HTTP freshness/revalidation instead of forced
reloads; expected byte length and SHA-256 are still checked, including changed
manifest hashes at the same URL.

Measured main-thread course construction originally blocked for 3209 ms. The
largest sampled portions were backdrop geometry (~1305 ms), zone rasterization
(~964 ms), repeated surface classification (~207 ms), and pot patches (~197 ms).
Implemented changes:

- Zone rasterization runs in a module worker and transfers typed arrays. The
  three packed half-float zone layers share one buffer with zero-copy views.
  Worker/direct output is byte-identical in tests. The shared GPU array also
  supports the production terrain's reduced sampler count.
- Terrain height/surface preparation and backdrop geometry advance in bounded
  batches, yielding through an actual animation frame and subsequent task.
  Merely using `scheduler.yield()` left repeated ~100 ms animation gaps despite
  short tasks; real after-paint checkpoints removed that scheduling starvation.
- Scene factories stage existing constructors without changing synchronous
  authoring callers. Cached growability bits remove duplicate classification.
  Pot outline ray intersections are reused across all 28 rings without changing
  vertices. Partial factory failures dispose their constructed resources.
- The putting solver runs the actual `Ball` solver in a worker using a transferred
  copy of the real terrain heights; shared sampling math preserves the exact
  trajectory. Requests are invalidated on pause and workers terminate on dispose.
- The installed Meshopt decoder's native two-worker pool handles transferable
  GLB geometry decoding instead of synchronous WASM behind an async API.

`node scripts/benchmark-loading-green.mjs LABEL` records cold page, warm page,
and real warm `golf.rebuild()` phases in a fresh headful hardware-WebGPU Chrome
profile. It saves CPU profiles, loading/ready screenshots, long tasks, animation
gaps, strict renderer/page/course identity and console/network errors.

| Active putting presentation | Original cold | After changes cold | Warm page | Warm course |
| --- | ---: | ---: | ---: | ---: |
| RAF p95 | 49.9 ms | 17.5 ms | 17.7 ms | 17.6 ms |
| Maximum RAF gap | 3233.4 ms | 100.3 ms | 116.7 ms | 66.6 ms |

After-change evidence is in the temporary `loading-after-paint-8P2PSt` capture
directory under the system temporary folder. All three runs reached the real
Beach Range with clean strict-WebGPU health, and recorded completed putts into
the hole during loading. Native CSM was added concurrently by the lighting work;
these are cumulative project-state measurements, not isolated worker effects.

This is **not yet a zero-stall whole-load result**. Native first-course rendering
still caused approximately 0.9–1.3 seconds of main-thread work after the loader
stopped. The benchmark now records three trailing animation frames to include
handoff delays separately from active animation. An exact-MRT native
`compileAsync` prewarm experiment reduced a warm handoff but increased cold delay
and active spikes; that experiment and its context wrappers were removed. No
unverified prewarm path remains. Remaining work is to attribute first-frame
uploads, shadows and post-processing individually before choosing the next fix.

## Verified GPU turf residency and staged map uploads

The original per-Terrain GPU ownership described above has now been replaced for
the fixed turf pack by explicit renderer-scoped leases. `TurfMapResidency` retains
exactly two immutable array textures while actual Terrain owners exist. The real
preloaded putting terrain keeps those arrays alive when the main course is
disposed/rebuilt. The last owner releases both GPU textures and removes the entry;
double release is harmless, renderer devices cannot share GPU handles, and failed
loads evict their entry without poisoning a later retry. The standalone
`loadTurfMaps()` factory still returns independently owned textures for isolated
tests/tools. No generic cache, LRU, alternate materials or asset changes were added.

This also removes the duplicate GPU copy formerly owned by the main course and
the retained putting scene (96 MiB of level-zero turf pixels, plus mipmaps).
CPU packing remains one fixed 96 MiB pack per page. GPU residency is bounded by
actual owners, not an indefinite course-resource cache.

`prepareSceneTextures` uploads each exact existing direct/owned material texture
one per paint after assets are ready. It does not clone, retain or dispose maps,
and excludes render-target textures whose passes generate their contents. This
reduced measured image-upload work in the handoff from roughly 218–265 ms to
72–93 ms. The remainder lives in generated node graphs rather than direct maps.

Latest canonical three-phase evidence:
`loading-resident-turf-Od3DRH/report.json` in the system temporary directory.
The benchmark includes three handoff frames and read-only timing wrappers around
the actual rendering passes/native texture queue. No pass is disabled or replaced.

| Latest capture | Cold page | Warm page | Warm course rebuild |
| --- | ---: | ---: | ---: |
| Active putting RAF p95 | 17.5 ms | 17.5 ms | 17.4 ms |
| Active putting maximum gap | 99.5 ms | 100.8 ms | 66.6 ms |
| Maximum including handoff | 2083.9 ms | 950.2 ms | 616.9 ms |
| Native handoff data uploads | 10.8 ms | 6.9 ms | 12.7 ms |

The previous real-grass capture had 538 ms of data uploads in the warm rebuild,
including individual 2048px array-layer writes of 218 and 154 ms. The latest
capture contains **no repeated 2048px turf-layer writes**, and asserts both actual
array identities and versions remain unchanged with zero disposal events across
the real course teardown. Warm handoff decreased from 1283.7 ms to 616.9 ms.
Cold totals remain variable and are not claimed improved: a separate 781 ms
ready-stage CPU task preceded first rendering in the latest cold capture.

All three runs reached the real Beach Range, passed strict hardware-WebGPU and
console/network health, and completed physical putts during loading. The warm
rebuild HUD parent had computed `visibility: hidden`, but screenshot inspection
still showed an overlapping card; inherited visibility alone has not proven the
visual fix. Grass dispatch and cloud-cast corrections are active in this latest
capture; earlier zero-blade course captures are not representative of final course
graphics performance. Native first-render node construction/reflection work still
prevents a zero-stall handoff, so the responsiveness objective is not declared done.

Follow-up `loading-hud-resident-final-zIBdGb` verifies the HUD fix in actual pixels:
the warm-course screenshot has no overlapping address card, `.gs-shot-ui` is
`display: none`, and every shot-view descendant has zero client rectangles.
Residency identity/version/zero-disposal assertions pass again. Active RAF p95 is
17.6/17.5/17.5 ms (cold/page/rebuild), maximum active gaps 82.4/83.8/66.7 ms, and
handoff-inclusive maxima 1834/934.1/600.1 ms. The cold profile identifies native
AudioContext construction as a separate ~760 ms task; moving that cost to the
first shot would not solve responsiveness and has not been done.

Developer edits to one of the six exact packed turf PNGs now intentionally request
a full page reload through the existing asset-event debounce. This refreshes the
CPU pack, the retained loading terrain, the renderer-owned arrays and manifest
verification together. A sticky pending flag survives later catalog/manifest
events in the same batch. Ordinary course edits keep fast resident rebuilding;
authored tree swaps retain their existing atomic path. Source URL/preload parity,
exact path matching and mixed-event debounce behavior are tested. Invalid bytes or
a mismatched manifest still fail closed; no stale hash/size validation is bypassed.

## Native audio device initialization before putting

`prepareGolfAudioContext` now allocates the single native audio context immediately
after renderer initialization and hands it to the existing late `GolfAudio`
constructor. Audio recordings still download/decode at the original late point;
trusted input still unlocks sound. An unclaimed context closes on bootstrap error
or page exit; handoff removes temporary cleanup listeners. Unsupported audio stays
optional, and a failed audio graph also closes its acquired context.

Canonical three-phase evidence: `/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/loading-early-audio-JRoopi/report.json`.
Cold/page/rebuild active RAF p95 is 17.5/17.5/17.4 ms, maximum active gaps
99.9/99.8/49.6 ms, and handoff-inclusive maxima 1250.7/933.3/615.8 ms. Cold
handoff completes at 9709.4 ms versus the preceding 10755.7 ms capture, but this
is cumulative state with intervening grass changes, not an isolated total-time
gain claim. Native context allocation measured 119.3 ms cold and 39.4 ms on page
reload, both before putting readiness (1631.7/993.7 ms). The large 666 ms early
task is not audio. Audio's unavoidable OS initialization was relocated, not removed.

All healthy phases use strict WebGPU, actual Beach Range assets, physical loading
putts, and clean console/network health. GPU turf identity and zero-disposal
assertions pass. Thirty-five audio assets decode; trusted-click unlock passes.
An additional real catalog-request abort fails closed before course installation
and closes the one pending native context exactly once. Thirteen audio unit tests
and production build pass. Native first-course rendering remains a substantial
handoff stall, so loading responsiveness is not yet fully solved.

## Exact reflection preparation (provisionally retained)

The real `PlanarWaterReflection` now precompiles its existing cached MRT-free
material variants against the actual mirror camera and reflection target before
handoff. It does not render history or replace any material/geometry. Target,
material and visibility restoration is nested and tested on native compile
rejection. Loading frames temporarily select the screen and restore the pending
target so compilation can yield without redirecting the putting presentation.

`loading-reflection-preparation-eNIRcH/report.json` (same temporary parent directory
as the audio report) passes all three strict WebGPU phases and health checks.
Cold/page/rebuild handoff maxima are 733.5/499.6/650.4 ms, versus
1250.7/933.3/615.8 ms before. Active p95 is 17.6/17.6/17.5 ms, maxima
100.2/133.8/83.4 ms. Crucially, total cold handoff time regresses from 9709.4 to
11810.3 ms; page reload 8631.8 to 8964.4 ms; rebuild 7158.7 to 7181.6 ms.
This is an explicit responsiveness/latency tradeoff, not a total-loading-speed
improvement. It is provisionally retained because the user prioritizes animated
putting responsiveness. Twelve focused tests and production build pass.
The remaining first Scene MRT render costs about 445–497 ms; further work is
required before claiming a smooth handoff.

### Rejected: additional exact Scene MRT compilation

`loading-mrt-preparation-0U6CBW/report.json` tested the production Scene MRT
target/camera/MRT and native linear-output context after reflection preparation,
with loading presentation restored independently during every yield. Health and
restoration tests passed, but cold handoff worsened to 817.8 ms; page/rebuild
improved to 399.1/383.6 ms while each warm load gained about one second of total
latency. Totals were 11863.2/9961.2/8163.3 ms, active p95
17.6/17.7/17.7 ms, with more active gaps over 50 ms. Native beauty rendering
still rebuilt substantial nodes. The additional MRT method, hooks, renderer-state
wrapper and experiment-only test were removed; reflection-only preparation and
its narrow screen-target isolation remain. Restoration tests pass (12).

Read-only cache trace identifies a structural mismatch in the installed renderer:
`Renderer.compileAsync` obtains a render context without a call-depth argument
(default zero), while real nested rendering obtains it using `_callDepth`.
`RenderContexts.get` includes that depth in its key, and
`RenderObject.getMaterialCacheKey` includes the resulting context ID. Scene MRT
is nested beneath the output pipeline and TRAA, so matching target/MRT/camera
alone cannot reuse that compiled material state. The direct reflection pass runs
at depth zero, consistent with its successful preparation. No call-depth override
or native dependency modification was introduced by this investigation.

Runtime-only `/tmp/cache-identity.json` confirms this with the installed production
bundle: the same four terrain objects/materials, lights node and renderer context
node compile into context ID 13, but render through context ID 9 at nested depth
2. For clipmap L0 the material keys differ (15054784483205456 compiled versus
11522246996509984 rendered), despite using the observed actual target, MRT and
linear-output settings. All instrumentation is restored, rendering resumes, and
strict WebGPU/console/network/nonblank checks pass. This is a cache-identity
diagnostic, not a performance acceptance run.

The smallest maintainable native correction appears to be separating shader
compatibility identity (existing attachment configuration plus MRT identity) from
the reentrant render-context instance identity (which also includes call depth).
Keep separate contexts for nested passes, but reuse compiled shader state when
their actual shader-relevant configuration matches. The public native compile
APIs expose no nested-context argument. Implementing this requires a reproducible,
version-pinned dependency correction and targeted nested-pass tests; no global
monkeypatch, hardcoded depth, or ephemeral dependency edit has been applied.

### Accepted native compatibility correction

The subsequent guarded native correction is now retained. Three is pinned to
0.185.1; `scripts/patch-three-render-cache.mjs` runs on postinstall and checks exact
source contexts before touching any file. It updates the native source and both
actual WebGPU bundles, preserves unrelated edits, is idempotent, and supports
`--reverse`. Reversal requires refreshing Vite's dependency optimizer (`--force`)
before any browser comparison; two initial probes correctly rejected stale,
unpatched optimized code rather than counting those as patch evidence.

Shader compatibility now includes every attachment's format/type/color space,
sample/depth/stencil configuration and MRT identity, plus renderer output settings
in the material key. Reentrant contexts remain separate. Existing material/light/
environment keys are preserved. `/tmp/cache-compatible.json` proves all four
actual terrain clipmaps share the exact native node-builder state between
compilation and nested rendering, while context IDs remain distinct (10/14).

With exact MRT preparation restored over the corrected cache,
`loading-compatible-mrt-UDuavI/report.json` passes three-phase strict WebGPU,
physical putting, audio unlock and retained texture ownership checks. Cold/page/
rebuild handoff maxima are 184.3/166.7/250.3 ms versus reflection-only
733.5/499.6/650.4 ms. Active p95 is 17.5/17.5/17.6 ms, maxima
116.7/150/149.2 ms. Total times are 9890.8/10331.5/8303.5 ms: cold improves
1.92 seconds; warm totals regress 1.1–1.37 seconds. This is explicitly accepted
for reduced handoff freezes, not as an across-the-board load-time gain. Later
evaluator camera changes still trigger 410–542 ms first-view shader tasks.
Pineglass's real creator-to-authored transition also passes strict rendering with
all authored trees and blades; that is health evidence, not a matched speed test.
