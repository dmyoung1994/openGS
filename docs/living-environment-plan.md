# Living environment graphics plan

## Goal and priorities

Deliver a visibly richer, calm, premium golf environment through coherent wind,
living skies, cinematic atmospheric lighting, and restrained bird life. Establish
the strongest visual result first, then tune it for sustained 30 fps on this
device while retaining an explicit Ultra ceiling for stronger hardware.
Market leadership is the direction, not a claim this work can independently prove.

Preserve ball physics, gameplay readability, and authored catalog geometry and
PBR assets. Preserve existing workspace changes. Extend the existing renderer
and environment state rather than creating parallel weather or quality systems.

## Initial code findings

- `EnvironmentFrameState` and `EnvironmentGpuBindings` already provide shared
  CPU/GPU wind and current/previous animation time; physics consumes this state.
- `Grass` already bends blades with sampled wind. `Trees` precomputes per-source
  wind and applies height/stiffness deformation with previous-frame motion.
  These are foundations to refine, not missing features to duplicate.
- `WeatherSky` already generates a GPU cloud volume, raymarches light transport,
  and advects it with shared wind. `CloudTemporalNode` resolves cloud history.
- `SceneManager` owns scene MRT, temporal reconstruction, cloud composition,
  bloom, and presentation. Lighting and water already share environment inputs.
- Quality modes already include battery, balanced, quality, and ultra; existing
  source-resolution policy deliberately avoids stretching a low-resolution image.
- Ambient wind audio exists. Initial source search found no dedicated bird or
  god-ray implementation. Verify full integration paths before adding them.
- `scripts/shot.mjs` and the course pose sweep provide production WebGPU evidence.
  No fresh rendered baseline or device performance has been measured for this goal.

## Execution sequence

User steering: use both the beach range and Pineglass course as visual references.
Premium PBR turf is a priority; source research and audition criteria are tracked
in `docs/premium-turf-research.md`. Continue the full environment goal alongside it.

1. **Understand and capture.** Trace scene creation/disposal, environment clocks,
   tree material paths, lighting/shadows, temporal history, quality changes, and
   course transitions. Identify this device and current production routes. Capture
   fixed tee, landing, green, woodland, and water views plus a moving camera.
   Record page identity, backend, resolution, mode, health, and frame/GPU timings.
   This is a reference capture, not an early optimization phase.
2. **Make wind convincing.** Refine structural sway, branch response, and local
   foliage flutter while preserving authored assets and stable roots. Give grass
   readable traveling gusts with cut-height-dependent response. Keep trees, turf,
   flags, water, and clouds directionally coherent with the existing wind source.
   Preserve correct motion history and true calm conditions; do not alter physics
   coefficients merely to make visual movement stronger.
3. **Give the sky and light depth.** Improve cloud shape, drift, soft self-shadow,
   and silver linings where current rendered evidence shows weaknesses. Add moving
   cloud shade and occlusion-aware atmospheric sun shafts integrated with the
   existing sun, cloud field, scene depth, and shadows. Tune aerial perspective,
   exposure, and restrained bloom together. Shafts should emerge in suitable
   lighting and disappear naturally when conditions do not support them.
4. **Add restrained wildlife.** Add sparse, deterministic bird flight with gliding,
   banking, and intermittent wingbeats, appropriate scale and habitat placement.
   Keep the ball, pin, and shot corridor easy to read. Integrate lifecycle, time,
   pause/resume, and course changes. Reuse suitable existing assets if available;
   document provenance for any new assets.
5. **Art-direct the whole scene.** Review golfer-height and moving-camera footage
   in clear midday, partly cloudy, and low-sun conditions, with calm and stronger
   wind. Refine turf/foliage light response, shadow contact, water, and background
   depth where needed to make the additions feel like one place. Avoid blanket
   haze, exaggerated sway, distracting wildlife density, and clipped highlights.
6. **Scale and optimize after visual acceptance.** Profile the completed result,
   isolate dominant costs, and extend existing quality controls. Preserve the
   visual reference in Ultra. Tune sample counts, temporal reuse, submission,
   culling, and authored-geometry LOD before considering visible compromises.
   Explicitly record any fidelity tradeoffs; do not claim hidden content or
   resolution blur as equivalent quality.
7. **Verify and hand off.** Run relevant tests and production build; verify live
   conditions changes, camera motion, shot flight, and scene transitions. Deliver
   before/after captures, measured timings, working quality settings, and remaining
   limitations. Do not claim stronger-device performance without measuring it.

## Iteration and completion contract

Repeat: inspect the relevant full path, implement one coherent improvement,
run the smallest meaningful checks, capture through dedicated headful Chrome
using Puppeteer, inspect the result, and revise. Use `window.golfBootstrap.ready`,
`window.golf`, and the evaluator camera; keep temporary captures outside the repo.
A launch, readiness, network, console, or WebGPU blocker remains a QA failure.

## Working evidence — September 4

- Native shader-cache correction regression: `/tmp/pineglass-native-cache.png`
  and `.json` pass real Creator→authored Pineglass selection, strict WebGPU,
  console/network health,111 source trees and567,273 grass blades with no overflow.
  This is **not** performance acceptance: Ultra1280×720 live240-frame p95 is
  217.7ms, max1034.5ms;24/24 GPU frames report212.14ms mean active work. Three
  shadow maps each cost38.7–42.4ms; SceneMRT89.2ms. These nested timestamps must
  not be blindly summed. Complete-caster cascade submission is a major next
  source-preserving optimization target. No matched pre-patch Pineglass capture
  exists, so do not attribute this workload to the shader-cache correction.
- Full acceptance harness audit remains open: `scripts/benchmark-environment.mjs`
  still freezes simulation for its GPU window, rejects the now-active bloom
  pass, and expects cached single-map shadows rather than live cascades. Its old
  eight-pass ceiling is not the current graph. Do not use that legacy contract
  to certify the living environment or weaken the requested33.3ms presented-p95
  target to make it pass. Current iteration proofs use `scripts/shot.mjs` with
  `--gpu-live` and explicitly unfrozen evaluator simulation; migrate the full
  scenario matrix to that live measurement contract before final acceptance.
- `/tmp/grass-retained-motion-corrected.png`/`.json` verifies stationary-camera
  grass reuses its exact GPU draw list while updating current/previous wind:
  547,292 blades, zero stable-ID changes, 460,378 changed wind packets over1.5s,
  zero previous-LOD mismatches, and clean production WebGPU health. Native Three
  pads this uvec3 storage attribute to four words; the initial three-word probe
  was invalid and is not evidence of changing identities. At the same live
  Ultra1280×720 Beach pose, grass compute fell from16.5 ms to0.99 ms and total
  activeGPU mean from52.4 ms to40.05 ms. Presented240-frame p95 improved from66.8
  to50.1 ms, with a666.9 ms outlier: still not sustained30fps. Camera, projection,
  density-policy, and terrain-map changes retain full recompaction; moving-view
  rendered validation remains required. No blades, topology, or authored assets
  were removed for this optimization.
- `node scripts/qa-grass-motion.mjs` now checks the real moving-to-stationary
  transition through the canonical capture harness. `/tmp/grass-motion-before-diffuse-ibl.json`
  passes13 terrain-following camera positions over38m, with live camera uniforms,
  changing populations (547,292 to456,903), no empty draws or overflow. After
  stopping: zero ID changes, 344,580 wind-packet changes and zero previous-LOD
  errors. Final-pose live240-frame p95 is50.9 ms (max51.1 ms); this is stationary
  timing after travel, not a continuous-motion performance benchmark. Final PNG
  and strict renderer/console/network checks pass. Camera-policy unit tests pass.
- The subsequent diffuse-IBL grass material correction also passes this full
  moving-to-stationary probe: `/tmp/grass-motion-qa.json` retains identical counts
  at all13 poses, zero ID/previous-LOD errors, and339,591 changing wind packets.
  Daylight screenshot remains nonblank/healthy; final-pose p95 is50.2 ms and
  activeGPU mean39.61 ms. This validates material integration and motion, not a
  performance gain or final premium turf appearance. Dusk photo calibration
  remains visibly too dark despite fixing the Phong environment multiply path.
- `/tmp/owned-camera-rebuild-fixed.json` now proves exact evaluator position and
  quaternion preservation through a real course rebuild (both deltas0), retained
  loader recovery and clean WebGPU health. Its live Ultra1280×720 GPU profile
  captures24/24 frames with no unavailable passes: activeGPU mean52.4 ms,
  SceneMRT23.2 ms, grass compaction16.5 ms. Shadow/reflection timings are nested
  and must not be blindly added. Presented240-frame p95 is66.8 ms, with a566.8 ms
  outlier; this is not the requested sustained30fps result.
- Shared material aerial perspective now converges toward the actual analytic
  celestial sky, not a separate unlit CPU horizon palette. All six material
  callers supply surface-to-camera vectors, so the sky lookup uses the opposite
  viewing ray and excludes celestial discs. Eight environment/backdrop tests pass.
  Photo-study dusk horizon and daylight regressions still need rendered acceptance.
- Actual GPU output exposed and fixed two silent visual failures. Grass's single-X
  indirect dispatch exceeded the 65,535 workgroup dimension limit (258×576 on
  Beach); whole-tile X/Y dispatch preserves every candidate and now draws 547,292
  blades / 3,627,388 triangles, zero overflow, dispatch `[576,258,1,0]`.
  `/tmp/grass-cloud-compute-fixed.png`/`.json` show real visible rough through the
  production WebGPU path. Previous zero-grass frame timings cannot certify the
  intended scene. Current Ultra1280×720 live sample: p95 66.8 ms, target unmet.
- Cloud-shadow normalization retained unsigned invocation-ID arithmetic and
  collapsed the entire map to one density sample. Casting to `vec2` before the
  half-texel offset/division fixes the shared compute path. Actual 512² GPU readback
  changed from uniform222 to range134–255; 51,971 texels changed over1.65 seconds
  of real environment time (mean absolute byte delta1.255). This proves spatially
  varying, moving transmittance, not final cinematic sky/ground art acceptance.
  Eighteen weather-contract tests pass, including the integer-normalization guard.
- Camera-travel shadow probe: `/tmp/camera-cascade-travel-seq/report.json` and
  its 18 frames retain `camera-cascades` throughout a 240 m Beach traverse with
  clean WebGPU/console/network health. Frame 8 shows multiple grounded tree
  shadows; the initial/final camera poses intersect palm crowns, so this is not
  acceptable proof of unobstructed cascade transitions. Next capture must travel
  outside the tree line. The 120-frame timing sample is not a sustained benchmark.
  Added a runnable receiver-coverage regression across 24 low-sun, elevated-camera,
  yaw, and portrait/landscape combinations; all camera-shadow tests pass.
- Native cascaded shadows now integrated successfully after zone-array sampler
  consolidation. `CameraShadows` adapts Three r185 CSM: three camera-frustum
  cascades,1km range, native overlap fading/texel snapping, preserved shadow-only
  caster layer, and lens-change refitting. The far cascade supplies a live depth
  map to native godrays. Its larger volume initially washed out the sky; reduced
  atmospheric extinction/max density restores clear daylight rather than white
  fog. `/tmp/cascades-array-first.png` is the rejected haze result;
  `/tmp/cascades-clear-day.png`/`.json` is healthy strict WebGPU final still.
  21 camera/lighting/zone/terrain tests and build pass. No authored maps removed.
  Moving-camera cascade handoffs, low-sun shafts, Pineglass, reflection-camera
  behavior, resource teardown, scalable cascade budgets and sustained live timing
  remain required. This still does not certify all shadow-cutoff cases. Capture
  timing is not a benchmark because build activity overlapped this visual QA.

- Terrain zone sampler consolidation implemented with the loading worker: main,
  auxiliary, and water RGBA16F fields share one three-layer DataArrayTexture and
  one base TextureNode/sampler. CPU fields remain views into a single transferable
  buffer, with existing 2D wrappers retained for grass/water consumers. No channels,
  filtering, authored surfaces, or physics were removed. Worker byte-parity and
  terrain tests:16 pass. `/tmp/zone-array-daylight.png`/`.json` verifies the standard
  Beach daylight composition remains visually consistent and healthy in strict
  WebGPU. Frozen Ultra1280x720 p9517.5ms is not live performance certification.
  This frees two terrain sampler bindings; native CSM startup must still be
  re-tested before claiming the shadow boundary solved.

- Native CSM startup experiment rejected on this device: real terrain fragment
  bind-group validation reports **18 samplers versus the adapter's 16 limit**.
  `/tmp/cascade-startup-probe.log` and `.json` preserve the exact WebGPU errors;
  the experiment also confirms godrays cannot keep sampling the removed original
  shadow map. All temporary CSM source changes were removed. A late runtime-only
  shader mutation appeared healthy but could reuse cached light nodes, so
  `/tmp/cascade-limit-probe.json` is not CSM acceptance evidence. Next action is
  sampler sharing/reduction or shared shadow-map storage, not raising an
  unsupported adapter limit or dropping PBR maps. Native reference:
  https://threejs.org/docs/pages/CSMShadowNode.html
- Capture harness now saves QA JSON before throwing final console-health/nonblank
  failures. It still exits nonzero; failed-render evidence is no longer lost.

- Camera ownership correction: `Lighting.follow` uses the supplied active camera
  exclusively, retaining numeric focus only for callers with no camera. Removed
  obsolete ball/camera blending policy from device tiers. Regression verifies
  that a moving ball cannot shift a stationary camera's shadow footprint.
  `/tmp/camera-owned-shadows.png`/`.json` verifies camera X/Z (70,-45) equals
  shadow focus before texel snapping; strict WebGPU and health pass. Eight focused
  lighting/tier tests and build pass. Existing tree and grass GPU culling take
  camera position/projection, terrain detail anchors to camera, and reflection
  visibility tests the source camera frustum. No new content culling was added.
  The finite single-map coverage edge remains unresolved; camera ownership alone
  does not provide blended near/far shadow coverage. AGENTS.md now records the
  camera-relative contract with off-screen shadow-caster/reflection exceptions.
- Restored complete tree shadows, live overhead Ultra1280x720, 600 samples:
  `/tmp/tree-shadow-fixed-live.png`/`.json`, p50 33.3ms, p95 33.9ms, max250.2ms,
  healthy WebGPU,173 palm records. This predates the camera-ownership correction
  and fails the sustained p95<=33.3ms target; do not treat the still captures as
  evidence that the dynamic full-caster workload meets it.

- Fixed the reported single-tree-shadow defect in `TreeShadowLod`: its geometry
  shared the beauty camera's indirect draw buffer, overriding the complete shadow
  instance count with a compacted beauty count. Shadow geometry now owns a clone
  with no indirect command and is disposed by the shadow owner. Authored topology
  and attributes remain unchanged; the extra geometry allocation is a correctness
  cost to measure during later optimization. A constructor/lifecycle regression
  checks command separation, retained vertex data, instance count, and disposal.
  Matched overhead Beach Range evidence: `/tmp/tree-shadow-overhead.png` before,
  `/tmp/tree-shadow-fixed.png` after (JSON QA reports alongside). Multiple distinct
  palm shadows, including off-camera casters, are now visible. Strict WebGPU and
  health checks pass. 52 tree/lighting/weather tests and production build pass.
  This does not certify distant shadow coverage or animated performance.
- Cloud self-shadow quadrature now samples the same interval it integrates and
  uses the visible eroded density field, instead of extrapolating near-field,
  uncarved density across the sun path. `/tmp/cloud-light-integral.png`/`.json`
  is a healthy frozen Ultra Beach capture; cloud crowns are somewhat brighter,
  but cloud structure still requires visual iteration. Consulted Guerrilla's
  cloud-rendering publications for ongoing lighting/shape research:
  https://www.guerrilla-games.com/read/nubis-cubed

- Cloud-shade invalidation now tracks the immutable environment configuration in
  addition to simulation time/daylight revision. Paused cloud/wind edits refresh
  the map; disabling/re-enabling shade reuses valid data without leaving the light
  permanently unshaded. A runnable WeatherSky regression covers all four cases.
- Live cloud-shade capture: `/tmp/cloud-shadow-live.png` and `.json`, Beach Range,
  Ultra 1280x720, evaluator **unfrozen**, 120 presented-frame samples: p50 16.7 ms,
  p95 33.3 ms, max 300.1 ms. Strict WebGPU, nonblank content, 173 authored palm
  records retained, no console/network errors. This short sample with a large
  hitch is not sustained-performance acceptance. Visual review still finds gray,
  flat clouds and insufficiently convincing turf/light depth. GPU map motion
  readback, longer live timing, and Pineglass validation remain outstanding.
- Weather/depth/workload checks: 23 tests pass; production build passes with the
  existing large-chunk warning. These checks do not establish final visual quality.

- Hardware verified: MacBook Neo, Apple A18 Pro (5 GPU cores), 8 GB memory.
- First Pineglass Ultra reference: `/tmp/living-baseline-tee.png` and `.json`;
  1280x720, fixed camera, p50 66.7 ms, p95 83.4 ms; strict WebGPU and health pass.
  This is not yet the 30 fps target and is not an animated gameplay measurement.
- Beach low turf reference: `/tmp/living-baseline-beach-turf.png` and `.json`.
  Actual Beach Range route, 0.5 m camera lift, Ultra, 1280x720, healthy WebGPU.
- First bird implementation is integrated through PlayableCourseScene, including
  Range and course scenes; creator canvas excludes it. Five seeded, metre-scale
  geometric birds glide, bank, and flap using the environment clock. Existing
  scene traversal owns material/geometry disposal. No new external asset dependency.
  Further polish, Pineglass coverage, live motion and transition QA remain.
- Close flight capture exposed a persistent silhouette trail in shared TRAA:
  empty sky was treated as permanently frozen static coverage. Limit that exception
  to current depth edges and variance-clip non-edge sky. Before/after evidence:
  `/tmp/living-bird-flight.png` versus `/tmp/living-bird-flight-fixed.png`, each with
  JSON reports. Fixed capture shows one bird with no persistent trail; evaluator
  proof records actual position change over 45 live frames. Broader static-foliage
  temporal regression and sustained moving capture remain required.
- Beach palms previously declared wind model `none`; catalog now uses existing
  hierarchical wind with stiff trunks and flexible crowns. Asset files unchanged.
  Need close motion validation and animated shadow alignment before acceptance.
- Bird, temporal, and catalog checks: 27 pass. Production build passed before the
  final TRAA/catalog edits; rerun build after the next coherent graphics checkpoint.
- Source acquisition finished: Grass008 2K PNG under
  `/tmp/golf-turf-audition.TJdNVB/source`. Archive hash:
  `7974ac70e27037bf14c9c37cae02c561bb9bfbfd30c5af0a44a6acfa859e4d0b`.
  Inspected color: dense fine turf with some long pale blade traces. Packing,
  calibrated production audition, and comparison to Grass005 remain pending.

### Next checkpoint

- Grass008 production audition is complete and rejected as no convincing upgrade;
  see `premium-turf-research.md`. Original fairway restored; candidate files retained
  only outside the repository. Turf source/rendering improvement remains open.
- Tree shadows now reuse the beauty material's complete world-space deformation
  with uncompacted source IDs, identity instance transforms, and retained planted
  bounds. Animated species invalidate shadows when the shared environment time
  changes in wind; frozen/calm scenes keep cached shadows. Geometry and alpha
  remain the catalog source. No separate approximate sway function.
- Added branch lag and bounded crosswind foliage flutter to the shared geometry
  material, driven by source-space phase, per-tree seed, wind magnitude and the
  current/previous environment clocks. Applies to shadows and authored mesh LODs.
- `/tmp/living-palms-shadow.png` and `.json` validate the beach shadow path.
  `/tmp/living-palms-flutter-live.png` and `.json` validate the final shader with
  environment unfrozen throughout the sample: 1280x720 Ultra, 150 timing frames,
  p50 16.7 ms, p95 17.4 ms; backend, content and health pass. This single beach
  view does not certify Pineglass or the final goal's full camera/gameplay matrix.
- Thirty tree checks and the production build pass after this checkpoint.
  Remaining: Pineglass motion/shadow QA, grass wind polish, turf visual upgrade,
  cloud quality/shadows, occlusion-aware shafts, integrated art direction, full
  performance scaling and final acceptance suite.

### Loading experience — user-added requirement

- Public rebuild, preview, and creator-mode requests now enter the existing
  watcher mutation queue. Internal rebuild calls remain unqueued to avoid nested
  queue deadlock. `/tmp/course-mutation-recovery.json` verifies an invalid preview
  followed by two concurrently requested real rebuilds: rejected/fulfilled/fulfilled,
  distinct completed scenes, final scene ownership, resumed renderer, retained
  loader inactive, and clean production WebGPU health. Evaluator pose unexpectedly
  reset during rebuild despite retained ownership; camera lifecycle remains open.
- Loading HUD correction: parent `visibility:hidden` was insufficient because the
  active shot card explicitly sets `visibility:visible`. The pixel capture disproved
  the parent-style-only check. Changed the veil selector to `display:none` on the
  HUD root. `/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/loading-hud-resident-final-zIBdGb/warm-course-active.png`
  now visibly has no overlapping shot card; the report also verifies zero descendant
  client rectangles. Active p95 is17.6/17.5/17.5 ms cold/page/rebuild, with remaining
  maxima82.4/83.8/66.7 ms. This verifies the HUD correction, not the complete loading
  performance goal: full warm handoff remains about600 ms and cold about1834 ms.
- After-paint preparation checkpoints now measure active putting-frame p95 of
  17.5/17.7/17.6 ms for cold-page/warm-page/warm-course loading, respectively;
  maxima remain 100.3/116.7/66.6 ms. Verified directly from the raw frames in
  `/var/folders/pq/w8s452kj2ddbgdt2fp_jd3nw0000gn/T/loading-after-paint-8P2PSt/report.json`.
  This is a substantial improvement over the preceding ~100 ms active p95, not
  completion: native course handoff still produces roughly one-second long tasks.
  Exact production-pass precompilation is the next measured experiment. Include
  first-course presentation in the acceptance window, not only `loading.active`.
- Repeated use of the same material must avoid redundant loading/decoding work.
  See `asset-loading-improvements.md` for measured turf cache and real rebuild proof.
- The loading presentation uses the real seeded creator green, on the existing
  strict WebGPU device. Randomly placed balls appear one at a time and follow
  terrain contours into the recessed cup. Pre-solve using the existing Ball solver;
  show only validated makes, never steer a visible ball or alter gameplay physics.
- Verify at least one full putt under real delayed asset delivery, nonblank scene,
  clean renderer/network health, and reduced-motion handling. User refinement:
  preload the real material/ball/pin assets at initial HTML discovery, prepare
  before course residency begins, then retain the paused scene for subsequent
  rebuilds and previews. No loading-screen-for-the-loader or artificial delay.
  `/tmp/loading-green-qa.json` proves early preload, four made putts, clean WebGPU,
  and immediate retained-scene activation on a real rebuild. Cold first-visit
  device/module/asset initialization remains about2s in that run, not instant.

### Atmosphere implementation checkpoint

- Added installed Three.js shadow-aware godrays with half-resolution depth-aware
  filtering, shared sun color, and restrained sun-elevation/turbidity density.
  Night density is zero. `/tmp/living-shafts-beach.png` and `.json` pass strict
  WebGPU readiness/health at 1280x720 Ultra, 90 samples, p95 17.4 ms (fixed view).
  This proves the pass runs, not that cinematic shaft placement is accepted.
- Sixteen bird/temporal checks and production build pass. Still need backlit
  canopy shaft views, transition/night QA, clouds/shade, and the full goal matrix.
- Two generated turf previews were rejected before integration; botanical detail
  did not surpass the source scans. See `premium-turf-research.md`.

### Flag and tracer correction

- Cloth now transports the previous presented vertex positions, distinct from
  its Verlet solver's previous fixed step, into Three's velocity calculation.
- TRAA fractional-edge exceptions now apply only to tagged foliage with valid
  history. The prior unconditional static-edge blend could override rejection
  with zero fresh-sample weight and preserve departed flag silhouettes.
- `/tmp/flag-motion-fixed.png` showed persistent flag trails after motion-vector
  work alone; `/tmp/flag-motion-fixed-v2.png` removes those trails after the shared
  history fix. Real creator WebGPU, live100-frame warmup, strict health clean.
  Broader foliage/static-camera temporal regression remains part of final QA.
- Live/history tracer bodies are now opaque white, retaining only antialiased
  edge coverage and endpoint taper. Twenty-one flag/tracer/temporal tests pass.

### Dusk ground darkness resolved — September 5

The two diagnostics left unrun on September 4 were run and **exonerate the turf
occlusion path**. `scripts/qa-turf-self-shadow.mjs` /
`/tmp/grasslands-self-shadow-probe.json` reports a
without/with self-shadow luminance ratio of 0.9991 at 05:00 and **exactly 1.000 at
both 12:00 and 19:00**: `dw` is zero at that patch, so `uShadow` contributes nothing
and the `aoNode`-attenuates-indirect-light theory is wrong.
`scripts/qa-ibl-calibration.mjs` confirms the IBL scaling path is mechanically exact
(`grayCardRatio` 2.94118 = 1/0.34 at both times).

A new `scripts/qa-dusk-light-budget.mjs` then decomposed the turf's actual light
budget by toggling PMREM, hemisphere and key in the live scene
(`/tmp/grasslands-light-budget.json`). Scene-linear turf luminance:

| source | 19:00 | 12:00 | noon/dusk |
| --- | --- | --- | --- |
| terrain's own analytic term | 0.00128 | 0.13636 | 106.6x |
| PMREM sky at 0.34 | 0.00426 | 0.01138 | 2.67x |
| hemisphere fill | 0.00114 | 0.00119 | 1.05x |
| total | 0.00668 | 0.14894 | 22.3x |

`no-key` is bit-identical to baseline at both times: the terrain is lit analytically
from `uSunDir`, not from the Three light rig. Two real defects followed, neither of
them the occlusion path:

- **Golden-hour exposure adaptation was effectively absent.** `celestialExposure`
  (`EnvironmentGpuBindings._updateDaylightPalette`) held a flat +0.42 plateau for
  every sun between 0.86 and 8.05 degrees, then jumped toward +3.2 only once the disc
  was already below -1.15 degrees. The darkest ground the renderer ever presented was
  therefore the last minutes BEFORE sunset. Measured exposure was 1.704 at dusk
  versus 1.200 at noon: a 1.42x lift against a 22.3x ground-luminance drop. Adaptation
  now tracks `sunIlluminanceScale * sin(elevation)` — the direct illumination actually
  landing on level ground — compensating a quarter of the measured shortfall in stops,
  capped at 1.0 stop. The cap was first set at 1.7 stops, which — together with the
  corrected unity sky PMREM below — rendered a **fully daylit sky at a 2 degree sun**
  and was rejected on sight. With both corrections the ground takes most of its
  recovery from the corrected irradiance, so exposure only has to carry what exposure
  should. It is **exactly 1.000 above 17.5 degrees** (daylight is
  bit-identical; the Beach 15:30 capture still measures exposure 1.200 at a 36.88
  degree sun) and **exactly 4.200 at astronomical night** (unchanged). It also removes
  an old dip at the horizon crossing, where the previous curve fell to 1.210 at -1
  degree.
- **The sky PMREM diffuse multiplier was 0.34 when the physically correct value is
  unity.** `qa-sky-irradiance.mjs` had already proved the atlas reproduces the
  analytic sky's own radiance, so the ground was receiving one third of the sky light
  the same sky was drawn with. This is invisible under a high sun, where the terrain's
  analytic term supplies ~92% of turf luminance (noon turf moves only +14.8%), but at
  a 2 degree sun the PMREM is the majority of the remaining light. Now
  `SKY_IRRADIANCE_INTENSITY = 1.0`.

Measured against the user's reference photograph at matched regions (linear
luminance). Sky-to-ground contrast was 33.5x versus the photograph's 6.5x:

| region | before | after | reference |
| --- | --- | --- | --- |
| sky-high | 0.14471 | 0.27471 | 0.25085 |
| sky-horizon | 0.17442 | 0.32546 | 0.38470 |
| ground-mid | 0.00521 | 0.03308 | 0.05918 |

`nearBlackPct` falls from 0.019 to 0. Unity PMREM moved the sky by 0.2%, confirming
it is a surface-lighting term only.

An intermediate 1.7-stop cap put the ground within 4% of the photograph (0.06154)
but the sky 26% over it, which read as daylight and was rejected. The shipped
1.0-stop cap instead lands the sky near the reference and leaves the ground 44%
under it. That is the honest trade at this sun angle, and the residual is not an
exposure problem: our horizon is blue [136,154,201] where the photograph is warm
[187,162,142], so the sky is neither the right colour nor delivering the warm bounce
the real scene's ground receives.

Daylight regression: unity PMREM lifted Beach turf +23% and, because it supplies the
blue skylight the 0.34 multiplier had withheld, dropped rendered turf saturation from
0.805 to 0.663 (turf blue 15 -> 29 sRGB). Chlorophyll reflects very little blue, so
the correction was placed in the pigment rather than back in the light transport:
`TURF_BLADE_SATURATION` 1.28 -> 1.62 with a new `TURF_BLADE_LIGHTNESS` 0.90 so the
added chroma is not also an exposure lift. Beach turf-mid is now sRGB [46, 86, 15],
saturation 0.826 — blue back to its original value at the corrected luminance.

**Not established by this work.** The sky is still 26% brighter than the reference and
remains the wrong hue: ours reads blue [164,184,237] where the photograph is warm
[187,162,142], so the ground's bounce is blue rather than golden. That is the
already-open sky/horizon chromaticity item, not a darkness problem, and no exposure
value can fix it. This is also **not** a performance result: the reference-pose
captures pause the timeline and sample too few frames to benchmark.

### Grass retired at the tree line — September 5

User-reported, and a separate defect from the lighting. `Grass.js` rejected blades
with a hard binary test, `grassSurfaceCandidate.and( canopyMask.lessThanEqual( 0.0 ) )`,
justified by pine litter being an exclusive surface material. But
`Terrain` only resolves forest-floor maps for `pine-needle-litter`, so on every other
ground cover the crown disc — `canopyRadius * 1.1`, and the Grasslands jacaranda's
catalog `bounds.radius` is 15.8 m — removed the grass with **nothing to replace it**,
leaving a bald ring of bare terrain. `/tmp/canopy-grass-BEFORE2.png` shows it.

The exclusive-surface decision is now one shared predicate,
`canopyOwnsExclusiveSurface`, consumed by both `Terrain`'s forest-floor residency and
`Grass`, so the material and the geometry cannot disagree. Where no such material is
resident the crown thins the grass over the distance-inward metres **already baked
into the mask's low seven bits** — no rebake, no change to candidate identity, baking
or tile dispatch. Because the policy is a shader-build branch on a fixed ground cover,
pine courses emit the program they always did; Pineglass reports
`exclusive: true, forestFloor: true` with clean health. `/tmp/canopy-grass-final.png`
shows continuous, thinning grass under the jacaranda.

**Budget cost, stated explicitly.** At the worst-case jacaranda pose this adds 36,262
blades (+3.7%) and 266,528 triangles (+5.2%). That is not free: the far LOD2 tier was
already **97.8% full before this change** (769,046 of 786,432), and the first attempt
at these constants overflowed it by 178 blades — which **blanked every blade in the
scene**, not just the overflowing tier. Thinning was tightened (floor 0.18, reached
3 m inside the dripline) to land at 779,585 with 6,847 headroom, down from 17,386.
Two things remain open and are not fixed here: that headroom is thin enough that a
denser pose could still cross it, and an overflow costing the entire grass field
rather than degrading is a pre-existing robustness fault worth its own work.

### Grass is not the bottleneck — caps removed, September 5

Measured before optimising, on the Grasslands reference at Ultra 900x1200, 30/30 live
GPU frames with no unavailable passes. Toggling `range.grass.mesh.visible` isolates the
entire grass field:

| pass | grass on | grass off | delta |
| --- | --- | --- | --- |
| activeGPU mean | 173.25 ms | 155.69 ms | **17.6 ms** |
| Scene MRT | 59.93 | 41.70 | **18.2 ms** |
| water-analytic-daylight:a | 36.90 | 37.82 | -0.9 (noise) |
| water-analytic-daylight:b | 38.28 | 37.37 | +0.9 (noise) |
| Shadow Map x3 | 26.9 / 24.2 / 24.0 | 27.6 / 24.3 / 23.8 | ~0 |
| Grass wind (compute) | 1.21 | 1.35 | ~0 |

**All 923k blades cost ~17.6 ms of a 173 ms frame — about 10%, entirely inside Scene
MRT.** Grass is absent from the three shadow cascades and from both water reflection
passes. The dominant costs are the two planar water passes (~75 ms) and the three
shadow cascades (~75 ms); these are nested timestamps and must not be summed.

Occupancy was then measured over eleven camera poses across all three courses
(`scripts/qa-grass-lod-occupancy.mjs`). The per-tier reservations were badly matched to
how blades actually distribute — the far tier carries ~75% of every blade:

| tier | peak observed | old capacity | used |
| --- | --- | --- | --- |
| near (12 tri) | 143,724 | 393,216 | 36.6% |
| mid (8 tri) | 108,729 | 262,144 | 41.5% |
| far (4 tri) | 786,610 | 786,432 | 100.02% — an overflow |

Overflow is fail-loud by design: `_buildDrawFinalizeCompute` applies one global `bad`
flag as `bad.select( uint( 0 ), lodCount )` to **all three** draw commands, so any
single tier over its cap makes the entire grass field vanish rather than show a moving
LOD hole. Far-tier headroom is therefore a correctness property.

Capacities are now `[262_144, 262_144, 1_572_864]` — roughly 1.8x / 2.4x / 2.0x the
measured peaks — for 2,097,152 records and a 11,534,336 triangle ceiling. Record
storage rises from 88 MB to 128 MB at 64 B/blade. Blade counts are set by the density
and radius curves, not by these reservations, so this changes no visible population and
no frame time; it removes a cliff. Re-measured across the same eleven poses: **zero
overflows**, worst-case remaining headroom 118,420 / 153,415 / 838,813, peak 5.53 M
triangles against the 11.53 M ceiling. Pineglass counts are unchanged to the digit.

With the cliff gone, the canopy thinning constants were restored from the tightened
0.18 over 3 m back to **0.30 over 6 m**, chosen for how a crown actually shades grass
rather than for a budget. The jacaranda pose now renders 1,035,594 blades with far-tier
count 786,610 — the exact figure that previously blanked the whole field — with 786,254
headroom, clean health, and frame timing unchanged within noise (mean 133.7 vs 133.4 ms,
p95 150.0 vs 150.1 ms).

**Not done here.** Frustum culling admits tiles at `clip.x < w*1.30` and
`clip.y < w*1.65`; that 30%/65% slop is a plausible saving but the planar reflection
camera reuses this blade list and `mesh.frustumCulled = false`, so it needs its own
investigation. Reducing far-tier geometry below its current 4 triangles, and the two
water reflection passes that actually dominate the frame, both remain open.

### Frame profiled and the real bottleneck fixed — September 5

Every figure below is a measured toggle-off delta at the Grasslands reference pose,
Ultra 900x1200, 30/30 live GPU frames, no unavailable passes. Baseline activeGPU mean
was 173.25 ms:

| component | cost | share |
| --- | --- | --- |
| 3 jacaranda tree shadows | **43.0 ms** | 25% |
| other 23 tree shadows | ~26 ms | 15% |
| planar water reflection (one pond) | 33.2 ms | 19% |
| entire grass field (923k blades) | 17.6 ms | 10% |

Terrain and grass shadow casting is only ~1.6 ms: the shadow passes are almost
entirely trees. The water pass is one pond ping-ponged across `:a`/`:b` targets at
half resolution every frame, so its per-frame cost is ~33 ms, not the ~75 ms that
naively summing both target labels suggests.

**Root cause.** `Trees.js` slaves shadow LOD to beauty LOD
(`shadowLod = beauty.useFarLod ? 2 : (beauty.useMiddleLod ? 1 : 0)`), and Ultra
promotes every tree to LOD0 (`lod0Only: true`, `fullFidelity: true`). The Grasslands
jacaranda was added for this study and never went through
`scripts/thin-gltf-foliage-sprays.mjs`: its catalog `lod0` and `lod1` both pointed at
the raw 204.66 MB, **3,863,832-triangle** source. Three of them therefore submitted
~35 M triangles to the three shadow cascades every frame — about seven times the
entire grass field. (`island_tree_01` has the same lod0-equals-lod1 defect and is
still open; `island_tree_02` already has a real 44 → 17 MB reduction.)

**Fix.** A real three-tier chain was generated with the existing pipeline:
1,280,135 / 550,151 / 360,151 triangles. Measured at the reference pose:

| | before | after |
| --- | --- | --- |
| activeGPU mean | 173.25 ms | **110.15 ms** |
| presented p95 | 183.7 ms | **117.3 ms** |
| Scene MRT | 59.9 | 42.8 |
| water reflection (each target) | 36.9 / 38.3 | 20.9 / 20.6 |
| shadow cascades | 26.9 / 24.2 / 24.0 | 16.2 / 14.5 / 14.0 |

The water passes fell too, which establishes that trees — unlike grass — are
rendered into the planar reflection.

**Interior foliage LOD (user-proposed).** The pipeline chose sprays by a hash rank,
i.e. effectively at random, so it discarded outer canopy sprays that carry the
silhouette while keeping interior ones that are fully occluded. A new opt-in
`--retain outer` spends the budget on the visible envelope instead; the default
`hash` ordering is untouched, so every existing Pineglass derivative is unaffected.
At an identical 200k-face budget the rendered difference was decisive: hash gave a
see-through crown, naive furthest-first gave a nearly leafless tree, and
bearing-bucketed shelling gave an even, convincing canopy.

A third ordering, `--retain largest`, was then required. Applying `outer` to the
`branches` material deleted the tree's core limbs — limbs sit near the crown centre,
which is precisely what an outer-shell rule discards — and rendered floating foliage
with no visible branch structure. Limbs are the largest connected components, so
they now take `largest`; leaves take `outer`; the trunk is never thinned. This was
a self-inflicted regression: the pipeline's own contract already said structural
primitives are not thinned, and applying a foliage rule to limb geometry broke it.
See `tree-performance-lods.md` for all three failure modes.

LOD0 is deliberately held at 1.28 M rather than the 550 k that measured 93.71 ms and
p95 100.9 ms, because Ultra selects LOD0 at every distance and 550 k is visibly
see-through when a golfer stands near a tree. Preserving the Ultra visual reference
is a stated goal of this plan.

**Not fixed.** `island_tree_01`'s lod0/lod1 aliasing; the 204 MB source GLB still
sits in `public/` and will be copied into any build even though nothing references it
now; the trunk primitive is never thinned and so dominates the lower tiers (64% of
LOD2); and Ultra's promotion of every tree to LOD0 means the LOD1/LOD2 tiers only
serve lower quality modes. Grass frustum culling still admits tiles at 30%/65% slop.
At 117.5 ms p95 this pose remains far above the 33.3 ms target.

### Dusk sky chromaticity — September 5

The dusk ground work left the sky the wrong colour: at a 2.03 degree sun the horizon
rendered blue [136,154,201] where the reference photograph is warm [187,162,142], so
the sky read as daylight and delivered no warm bounce to the ground.

Cause, in `EnvironmentGpuBindings._updateDaylightPalette`: the only warm term was

```
lowSunWarmth = ((1 - elevation) * 0.16 + turbidity * 0.10) * 0.62 * twilight
```

which reaches just **0.094 at a 2 degree sun** (0.019 at noon). Mixing 9% of the sun's
chromaticity into `horizonColor` cannot turn a horizon warm, so `clearDay` stayed blue
and the blue-weighted Rayleigh in-scatter (`vec3(0.175, 0.410, 1.0)`) was then added on
top of it.

A dedicated sunset term now supplements the haze tint. `SUNSET_GLOW_STRENGTH` 0.55 over
a window closing at ~12 degrees of solar elevation, expressed in sin(elevation) like the
rest of that function. Warmth at the reference dusk becomes 0.547 and the horizon
palette moves to (0.678, 0.597, 0.589) — red-dominant for the first time. The term is
**exactly zero for every sun above the window**, and the measured Beach 15:30 daylight
capture (36.88 degree sun) is unchanged to the sRGB digit: sky [122,141,195], turf
[46,86,15]. `zenithWarmth` is deliberately still derived from the haze term alone,
because carrying the sunset glow to the zenith washed the whole dome toward the sun's
chromaticity and lifted it well above the reference.

| region | before | after | reference |
| --- | --- | --- | --- |
| sky-horizon | [136,154,201] 0.325 | **[176,165,188] 0.396** | [187,162,142] 0.385 |
| sky-high | [124,140,202] 0.275 | [154,148,196] 0.319 | [111,140,175] 0.251 |
| ground-mid | [33,51,80] 0.033 | [49,52,75] 0.036 | [59,73,50] 0.059 |

Horizon luminance now lands within 3% of the photograph with red and green close
([176,165] against [187,162]).

That broad tint alone was too diffuse — it washed the whole dome mauve, because
`clearDay = mix(horizonColor, zenithColor, upward^0.42)` still leaves ~20% horizon
contribution at 37 degrees of elevation. So the shared palette term was reduced to 0.30
and a separate, localised band added inside `skyRadiance`, kept out of the CPU
`horizonColor` that fog and the PMREM share. It has a steep elevation falloff, is
concentrated toward the sun's azimuth with a `WRAP` floor continuing a dimmer arc round
the rest of the sky, and is exactly zero above the glow window.

**The band replaces chromaticity rather than adding light.** A first attempt added the
sun's colour and made things worse: the sun-side horizon went to [201,193,214] against
the photograph's [173,141,101] — brighter and bluer, because adding warm light to a blue
sky washes it toward white. Real horizon air at this elevation has lost its blue to ~19
air masses, so the band now swaps in the sun's transmitted chromaticity at the sky's own
luminance. That chromaticity is additionally reddened (`SUNSET_BAND_CHROMA_GAMMA`)
because the band is light scattered from air on a longer path than the direct beam:
`sunColor` alone gives blue/red 0.43 where the photograph's band needs ~0.32.

Sun position was **not** changed for any of this. The 2.03 degree elevation and 299.6
degree azimuth come from the NOAA solar-position algorithm at the study's inferred
19:00 UTC / 15 July 2026 / 46.5N 7.5E clock. Verified against the camera: sun·right =
+0.843, so the sun sits to the frame's right, which matches where the photograph's glow
falls behind the clubhouse.

| region | broad tint only | with band | reference |
| --- | --- | --- | --- |
| horizon, sun side | [190,178,199] 0.468 | **[190,172,176] 0.436** | [173,141,101] 0.288 |
| horizon, away side | [175,164,187] 0.391 | **[167,158,178] 0.359** | [171,157,144] 0.348 |
| sky-high | [154,148,196] 0.319 | [141,145,199] 0.299 | [111,140,175] 0.251 |

The away-side horizon is now close on all three channels except blue (178 against 144)
and within 3% on luminance. There is a visible warm arc along the horizon, strongest on
the sun side, under a blue upper sky.

**Still open.** The sun-side band is not saturated enough — blue 176 against 101 — and
still too bright (0.436 against 0.288); the reference's sun-side horizon is *darker* and
much more saturated than its away side, while ours is brighter. The blend weight reaches
only ~0.26 in that region, so a stronger or wider mask, or letting the base gradient's
transmittance floor (`transmittance * 0.50 + 0.50`) actually extinguish blue at low sun,
are the next levers. The ground remains ~40% under the reference and green-deficient.

### The sun actually moved — sunset cliff fixed, September 5

User direction: stop tinting a 2 degree sun to look like sunset and make the engine work
at a real one. Sweeping the study's clock through the engine's own NOAA model exposed
why that had not been possible.

**`resolveDaylightSkyEnvelope` stepped at the horizon.** It took `Math.max` of a solar
branch and a twilight branch that did not meet: 0.324 just above the horizon against
`twilight * 0.12` = 0.113 just below it. Direct intensity also goes to zero at zero
elevation by definition, so the whole scene fell off a cliff the instant the sun set.
Measured at 19:20 (-0.91 degrees) before the fix: sky-high 0.019, horizon 0.023, ground
0.006, against a reference photograph at 0.251 / 0.348 / 0.059 — roughly **13x too
dark**. No post-sunset time could be lit, which is precisely why the earlier work had to
fake warmth at a sun that was still up.

The twilight branch is now `twilight ** 1.69 * 0.35`. Neither constant is free: 0.35 is
the solar branch's value at zero elevation, so the two curves meet; 1.69 reproduces the
previous astronomical-night value (0.0253 at -12 degrees) exactly. Daylight and night
are therefore untouched and civil twilight roughly doubles, with a continuous crossing
(0.338 at +0.3 degrees, 0.316 at -0.91).

**Exposure also dipped across sunset.** The adaptation proxy was
`sunIlluminanceScale * sin(elevation)`, identically zero below the horizon, so it
saturated and stopped tracking: exposure went 2.904 before sunset to 2.671 after, while
the scene lost most of its light. It now falls back to the sky envelope
(`TWILIGHT_GROUND_SHARE`), which is continuous, and the ladder is monotone:

| sun | exposure |
| --- | --- |
| noon / any sun above 17.5 degrees | 1.200 (exactly unchanged) |
| 9.55 degrees | 2.445 |
| 1.14 degrees (the study) | 3.419 |
| -0.91 | 3.491 |
| -6 (civil twilight) | 4.706 |
| -12 (night) | 5.040 (exactly unchanged) |

**The clock moved.** `site.atmosphere.localTime` 19:00 → **19:06**, recompiled. That is
1.14 degrees of solar elevation — the sun genuinely at the horizon — rather than 2.03
degrees with the sky tinted to compensate. Sunset at this location and date is ~19:06;
times past it now degrade smoothly instead of collapsing.

| region | 2-degree sun with tint | real 19:06 sunset | reference |
| --- | --- | --- | --- |
| sky-high | 0.299 | **0.2523** | 0.2509 |
| horizon, away side | 0.359 | 0.301 | 0.348 |
| horizon, sun side | 0.436 | 0.374 | 0.288 |
| ground-mid | 0.034 | 0.025 | 0.059 |

Upper sky now lands **within 0.6%** of the photograph. Beach 15:30 daylight is identical
to the sRGB digit (exposure 1.200, sky [122,141,195], turf [46,86,15]) and -22 degree
night is unchanged (exposure 5.040, envelope 0).

Sun azimuth was verified against the camera rather than assumed: sun.right = +0.843, so
it sits to the frame's right, matching where the photograph's glow falls behind the
clubhouse. An earlier check that reported "left" had the right-vector sign inverted.

**Still open.** The ground is the remaining gap at 0.025 against 0.059 — it has been
short at every sun angle tried, which points at how much of the sky's radiance reaches
the ground as irradiance rather than at exposure or sun position. The sun-side horizon
is also still too bright (0.374 against 0.288) and not saturated enough; the reference's
sun-side horizon is *darker* and more saturated than its away side, while ours is
brighter. The base gradient's `transmittance * 0.50 + 0.50` floor, which prevents blue
ever being extinguished at the horizon, is the untouched lever there.

### Dusk chromaticity and the ground's real limit — September 5

Three further corrections, each gated by the sunset window so every sun above ~12
degrees keeps its existing result exactly.

**The zenith was too pure a blue to light a scene with.** At sunset the sky IS the
light, and a neutral 0.18 card measured the irradiance chromaticity at
**0.32 : 0.37 : 1.0** — so green turf rendered blue-grey. The cause was the zenith
palette at blue/green **9.9** (0.0167, 0.0522, 0.5153); daylight carries that purity
because direct sun dominates the ground, twilight cannot. Real twilight sky desaturates
as single-scattered blue weakens and spectrally flatter multiple scattering takes over,
so the zenith now mixes toward its OWN luminance through the sunset window
(`TWILIGHT_ZENITH_DESATURATION`), losing saturation without losing brightness. Zenith
blue/green falls to 5.4 and the foreground turf goes green-dominant — [20,37,29] against
the photograph's [38,54,35], where it had been [18,37,44].

**In-scattered light was never extinguished.** The base gradient's
`transmittance * 0.50 + 0.50` floor stops blue ever being removed at the horizon, and
the Rayleigh/Mie terms were added with no extinction at all. Under a high sun that is a
fair stand-in for a multiply-scattered sky; at sunset it is not, because the sunward
horizon has the longest path of any view direction and should end up darker and more
saturated than the rest of the sky. Ours did the opposite — sun-side 0.374 against an
away-side 0.301, where the photograph is 0.288 against 0.348. Applying the view
transmittance to the in-scatter (`SUNSET_SCATTER_EXTINCTION`, ramped by the sunset
window) brings the sun side to 0.328.

Final measured state at the authored 19:06 clock, against the reference photograph:

| region | session start | now | reference |
| --- | --- | --- | --- |
| sky-high | 0.299 | **0.2550** | 0.2509 |
| horizon, away side | 0.359 | 0.2909 | 0.3478 |
| horizon, sun side | 0.436 | 0.3278 | 0.2880 |
| ground-mid | 0.034 | 0.0242 | 0.0592 |

Upper sky is within **1.6%**; both horizons within ~15%.

**Why the ground stops there — measured, not assumed.** Reading the SAME regions in
scene-linear (the MRT) and in the display PNG settles it:

| region | scene-linear | x exposure | display | transfer |
| --- | --- | --- | --- | --- |
| sky-high | 0.0831 | 0.2731 | 0.2542 | x0.93 |
| ground-mid | 0.0165 | 0.0544 | 0.0245 | **x0.45** |

The scene-linear ground/sky ratio is **0.199**, which is exactly the turf's measured
effective albedo against a 0.18 card (0.20) — the lighting is physically right. The
display ratio collapses to 0.096 entirely inside `NeutralToneMapping`, whose black
offset is `x - 6.25x^2` for `min(r,g,b) < 0.08`: it removes **69% of the ground's value
and 16% of the sky's**, and it penalises saturated colours hardest because it keys on
the minimum channel. Raising exposure until the ground clears that toe was tried and
measured — at exposure 5.664 the ground matches the photograph (0.0629 against 0.0592)
but the sky blows to 0.467 against 0.251. **No exposure satisfies both**, which is a
property of the curve, not of the scene.

Closing that last gap therefore means changing the tone mapper, and that is deliberately
NOT done here: the entire turf palette — `turfColor.js` pigments, the `LIFT` ratios,
`TURF_BLADE_SATURATION`, `TURF_BLADE_LIGHTNESS` — was graded against this curve, and the
same black offset removes 62% of daylight turf too. Changing it would invalidate that
calibration and the accepted daylight look in one step. It is a real, understood,
quantified gap with a known fix, and it wants its own pass with a full re-grade rather
than being folded into this one. The photograph is also a phone HDR capture whose
shadow lift is not a physical target.

Verified after all of the above: Beach 15:30 daylight identical to the sRGB digit
(exposure 1.200, `sunsetGlow` 0, sky [122,141,195], turf [46,86,15]); -22 degree night
unchanged (exposure 5.040, envelope 0); Pineglass and a golfer-height Grasslands view
both render clean with no console or network errors; 566/571 tests (the 5 failures
predate this work); production build passes. Frame at the reference pose is 111.9 ms
activeGPU mean, p95 118.2 ms, against 173.25 ms at the start of this work.

### Water made light-responsive — September 5

User-reported: the pond held its daylight brightness at dusk and glowed turquoise
against a dark scene. Two independent causes, both in `WaterSurface`.

**The body colour was an absolute radiance, not an albedo.** `bottomColor`,
`shallowWater`, `deepWater` and the foam term are authored constants —
`vec3(0.12, 0.19, 0.13)`, `vec3(0.009, 0.072, 0.062)`, `vec3(0.006, 0.024, 0.034)` —
added straight into `colorNode` with no dependence on incident light. `skyReflection`
and `sunGlint` did respond, but at dusk the body was **85% of the pond's luminance**, so
the pond barely dimmed while the ground fell ~4x. A new shared `surfaceLight` uniform
(direct sun on a horizontal surface plus the sky envelope, normalised against the
mid-afternoon value the constants were authored at and **clamped to 1**, so no daylight
can come out brighter than as authored) now scales the body and foam. Reflection and
glint are deliberately excluded: both already derive from the live environment, and
scaling them here would attenuate the sky's light twice.

**Fresnel was capped so water could never be a mirror.** The grazing term was scaled by
0.28 and the whole response clamped to **0.30**, so no view angle could reflect more
than a third of the sky, and the body was *added* alongside the reflection rather than
attenuated by it. Real water approaches a perfect mirror at grazing incidence. It is now
a true dielectric Schlick term (`WATER_F0` 0.02, reaching ~1 at grazing) and the body is
multiplied by `oneMinus(fresnel)`, so what the surface reflects it no longer also
transmits.

Measured on the study's pond at the 19:06 sunset, scene-linear luminance:

| state | pond | vs ground | pond sRGB |
| --- | --- | --- | --- |
| hardcoded body, capped Fresnel | 0.0892 | 3.68x | [54, 90, 98] turquoise |
| body follows light | 0.0336 | 1.39x | [35, 54, 63] |
| + real Fresnel and energy conservation | 0.0480 | 1.98x | **[60, 61, 73]** |

The final chromaticity matches the sky it is mirroring ([137,135,166]) instead of
glowing its own cyan, and it is brighter than the ground — which is correct for water
reflecting a bright sky at a grazing view, not a bug.

Across a day the pond now spans **1350x** where the body term used to be constant:
0.2163 at noon, 0.0723 at 21 degrees, 0.0177 at the 19:06 sunset, 0.0064 at -3.7, and
0.00016 at -22 degrees.

Beach daylight is unchanged (`surfaceLight` 0.9837 there, ocean [122,145,178] identical
to the digit), and Pineglass renders clean. The water contract test previously asserted
the cap as intentional (*"analytic reflection must be aggressively capped at a grazing
view"*); it now asserts the dielectric response, the energy conservation, and the
scene-light coupling, which is a strictly stronger contract.

Final state after all of this session's work: 566/571 tests (the 5 failures predate it),
production build passes, reference-pose frame 111.7 ms activeGPU mean / 115.7 ms p95
against 173.25 ms at the start, grass overflow 0, no console or network errors on the
Grasslands study, Beach Range or Pineglass.

Complete only when the visual features above work together on the production
course, temporal artifacts and lifecycle regressions are addressed, checks pass,
and this device sustains the 30 fps target in documented representative gameplay
and camera movement. Use a proposed p95 presented-frame budget of 33.3 ms in
warmed runs, reporting median, p95, spikes, CPU/GPU timing, exact resolution,
hardware, and quality mode. Report cold-start/transition hitches separately.
If that budget requires a material visual compromise, make the tradeoff explicit
and preserve the Ultra result. Update this plan with evidence as work proceeds.
