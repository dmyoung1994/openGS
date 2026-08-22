# Golf Simulator Environment Visual Bar

Status: binding acceptance contract for the current environment-quality goal.

The target is a grounded, high-end real-time golf broadcast image on the user's
Apple-silicon hardware. It is not a promise that a browser renderer will match a
current offline path tracer. It does mean that the shipped views must survive a
close, still-image inspection without an obvious game-render shortcut breaking the
illusion, and must preserve that quality while the camera moves.

The root agent is the acceptance authority. An implementation does not pass merely
because it builds, performs well, or improves one screenshot. It must pass every
blocking gate below and score at least **88/100**, with no scored section below 80%.

## Blocking gates

Any item below is a release blocker in any fixed production camera. The
`tree-edge-close` camera is also binding for vegetation quality even though it is a
stress-only performance view.

- No missing/floating trunks, giant stretched triangles, detached crowns, black
  foliage caps, conspicuous billboard planes, or repeated dark tree silhouettes.
- No circular patch of special grass around the ball, visible texture grid, obvious
  short-period tiling, radial material discontinuity, neon/plastic turf, or abrupt
  fairway/rough material seam.
- No floating props, uniform object burial, implausible vertical rocks, duplicated
  assembly stamp, or clean empty forest floor beneath a dense canopy.
- No exposed course edge, hard backdrop seam, faceted skyline, snow-shaped white
  blob, or mountain whose scale/detail contradicts the playable terrain.
- No missing environment lighting, emissive/pre-lit asset cheat, fake painted AO,
  crushed forest blacks, clipped sky, gray atmospheric wash, or conflicting sun
  directions between sky, shadows, water, and materials.
- No flat opaque-gray water, unstable reflections, shoreline halo, uniform concentric
  bank band, uncovered water polygon edge, or temporal shimmer visible in the
  frozen-camera sequence.
- No WebGPU validation/shader/console errors, fallback renderer, nondeterministic
  placement, asset-integrity mismatch, runtime hitch, or benchmark-contract bypass.
- No canvas/drawing-buffer resize oscillation, rapid viewport flash, repeated temporal
  reset, or user-visible window churn during gameplay, evaluation, or pass teardown.

## Scorecard (100 points)

### 1. Terrain and playing surfaces — 22 points

- Fairway, green, tee, rough, native ground, bunker sand, rock, and snow have
  distinct albedo, roughness, normal response, and declared real-world texel scale.
- Fairway mowing direction and blade/fibre response read from 2–30 m, then recede
  naturally. Close detail is surface-wide and camera-independent, never ball-centred.
- At least three spatial frequencies are visible without fighting: micro material
  detail, 2–20 m meso variation/transition, and landform-scale variation.
- Stochastic or world-space breakup prevents a recognizable repeated motif. Sloped
  geology does not visibly stretch; projection or blending follows the surface.
- Sand reads as granular and shaped, with a coherent lip/edge transition rather than
  a uniformly coloured depression.

Pass threshold: 18/22.

### 2. Vegetation and ecological grounding — 22 points

- Trees retain credible trunk, branch, and crown volume through the entire
  perception-sensitive range. Image impostors are allowed only once the projected
  error is visually negligible; they must share runtime daylight and colour response.
- LOD membership is temporally stable and does not create double-dark overlap,
  popping, crawling alpha, neighbour-frame bleed, or silhouette collapse.
- The forest reads as a community: at least three apparent age/height classes,
  asymmetric grouping, authored negative space, edge succession, and plausible
  understory/deadwood/rock contacts.
- Tree bases meet the terrain, opaque structural parts remain structural, and
  foliage transmission/roughness never resembles black cardboard or plastic.
- Grass and groundcover density serves the shot and does not occlude the ball,
  maintained route, target read, or strategic hazards.

Pass threshold: 18/22.

### 3. Lighting, atmosphere, contact, and tone — 22 points

- One daylight state drives sky radiance, sun direction/colour, direct light,
  environment fill, fog/aerial perspective, water, and runtime-relit impostors.
- Direct sun is legible, but open-sky shadows retain coloured detail. No second
  shadow-casting fill light, pre-lit texture, or emissive foliage is used to fake it.
- Specular response and roughness separate turf, needles, bark, rock, sand, and water
  without a global glossy or chalky look. PMREM/environment lighting is coherent.
- Contact darkening is subtle, selective, and geometry-aware. It grounds solid bases
  without outlining every object or dirtying translucent foliage.
- Atmosphere creates distance and integrates the backdrop while preserving a clear
  focal route. Exposure and tone mapping retain cloud/sky highlights and forest detail.

Pass threshold: 18/22.

### 4. Water, geology, backdrop, and composition — 18 points

- Water has view-dependent Fresnel response, coherent sky/sun reflection, depth or
  shore variation, small-scale normal movement, and a physically believable bank.
  The bank must grade from saturated waterline mineral/soil into irregular gravel and
  turf intrusion; it may not read as a continuous radial dirt ring.
- Backdrop silhouettes are non-repeating and geologically plausible. Detail remains
  hierarchical at skyline, ridge, outcrop, and material scales.
- Aerial perspective matches the shared atmosphere, producing depth without using
  fog to hide geometry or course boundaries.
- Foreground, playable midground, and backdrop form one palette and light field.
  Hero views keep a readable fairway/target window and avoid a symmetrical corridor.

Pass threshold: 15/18.

### 5. Temporal quality and performance — 16 points

- All seven production cameras: GPU completion p95 <= 33.3 ms, request-animation-
  frame p95 <= 34.0 ms, and zero frames over 50.0 ms at 1280x720,
  `high-desktop-webgpu` on the user's machine.
- Native-panel very-high-quality probes at 2408x1506 (`address-tee`, `low-rough`,
  `pond-contact`, and `tree-edge-close`) must retain the same renderer features and
  pass visual/temporal gates with GPU completion p95 <= 33.3 ms. This is the actual
  5-core Apple A18 Pro / 8 GB / Metal 4 target, not a scaled desktop surrogate.
- `tree-edge-close` stress camera: GPU completion p95 <= 33.3 ms, rAF p95 <=
  34.0 ms, zero frames over 50.0 ms. It must pass the same visual quality gates;
  the interim 30 FPS target does not authorize reduced foliage coverage or features.
- Frozen-time 32-frame sequences: RGB MAE <= 0.15 and pixels changing by more than
  8% <= 0.20%. No visible LOD pop, alpha boil, shadow crawl, reflection flicker, or
  post-process reset.
- Resize ownership is singular and observable: identical CSS viewport/DPR events are
  no-ops, a real resize causes exactly one drawing-buffer resize and one temporal
  invalidation, and evaluator/harness teardown never repeatedly resizes the live view.
- Production build, complete test suite, asset derivative hashes, engine diagnostics,
  deterministic 32-phase placement, course validation, and no-fallback checks pass.

Pass threshold: 14/16.

## Fixed evaluation suite

The canonical views are defined in `scripts/benchmark-environment.mjs` and must not be
moved to make an implementation pass:

1. `address-tee` — route, fairway material, initial composition, distant enclosure.
2. `low-rough` — turf transition, alpha stability, close lighting and scale.
3. `landing-crosscourse` — maintained/native edge, meso ecology, target hierarchy.
4. `landing-return` — reverse-light consistency and planted-edge variation.
5. `approach-green` — target read, bunker/green material, alpine backdrop.
6. `pond-contact` — water, shoreline, rock/vegetation grounding.
7. `overview` — landform continuity, course edge, macro repetition, backdrop seams.
8. `tree-edge-close` — binding close vegetation quality and separate stress budget.

Each acceptance cycle consists of:

```text
npm test
npm run build
npm run benchmark:env
npm run benchmark:env -- --scenario tree-edge-close --gpu-p95-ms 33.3
npm run benchmark:env -- --scenario address-tee --size 2408x1506 --gpu-p95-ms 33.3 --out benchmarks/environment-native-address
npm run benchmark:env -- --scenario low-rough --size 2408x1506 --gpu-p95-ms 33.3 --out benchmarks/environment-native-rough
npm run benchmark:env -- --scenario pond-contact --size 2408x1506 --gpu-p95-ms 33.3 --out benchmarks/environment-native-pond
npm run benchmark:env -- --scenario tree-edge-close --size 2408x1506 --gpu-p95-ms 33.3 --out benchmarks/environment-native-tree
npm run benchmark:robustness
npm run verify:no-fallback-browser
```

The evaluator reviews the final PNG and representative temporal frames at native
resolution, then records scores and concrete defects. Numeric luminance/performance
gates catch regressions; they do not replace visual judgment.

## Technical basis for this bar

The chosen techniques follow primary engine/platform documentation and original
rendering literature rather than copying a single engine feature wholesale:

- Three.js WebGPU/TSL provides a shared node graph, MRT/post-processing, TRAA, GTAO,
  SSR/SSGI building blocks, and PMREM integration:
  <https://threejs.org/docs/pages/TSL.html>
- Three.js PMREM prefilters environment radiance for the GGX BRDF, which is the basis
  for coherent material/environment specular response:
  <https://threejs.org/docs/pages/PMREMGenerator.html>
- NVIDIA's original impostor work describes image impostors as view-limited and
  recommends replacement based on visual error, supporting geometry-first near/mid
  LODs rather than distance alone:
  <https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-21-true-impostors>
- NVIDIA's mip-level analysis explains why alpha-tested foliage requires deliberate
  per-mip coverage handling instead of ordinary filtered atlas mips:
  <https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-28-mipmap-level-measurement>
- GPU Gems terrain work combines photographic detail, procedural low-frequency
  variation, triplanar projection, and multi-resolution geometry to avoid obvious
  repetition and stretched slopes:
  <https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu>
  and
  <https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry>
- Epic's Landscape documentation retains high-resolution normal information across
  geometric LODs and uses mip-based smooth LOD transitions; its runtime virtual
  texture guidance also treats shared surface data as a way to blend actors into
  terrain. Those ideas inform our smaller WebGPU implementation:
  <https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-outdoor-terrain?application_version=4.27>
  and
  <https://dev.epicgames.com/documentation/en-us/unreal-engine/runtimevirtual-texturing-quick-start-in-unreal-engine>
- Apple recommends selecting Metal texture storage/usage for GPU access and checking
  actual device feature support rather than assuming a desktop GPU capability:
  <https://developer.apple.com/documentation/metal/optimizing-texture-data>
  and <https://developer.apple.com/metal/capabilities/>

## Acceptance record

The record is updated after each full engine-harness run. The goal is complete only
when every blocking gate passes, the total score is at least 88/100, no section is
below its threshold, and two consecutive clean acceptance cycles show no regression.

| Cycle | Terrain /22 | Vegetation /22 | Light /22 | World /18 | Temporal /16 | Total | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| Baseline | 12 | 10 | 15 | 10 | 15 | 62 | Fail: visible tree cards, weak material hierarchy, backdrop/geology and water below target |
| Integration 1 (partial) | 12 | 4 | 13 | 9 | 3 | 41 | Fail: source fir loses crown volume at most azimuths; LOD1 rejected; 101 LOD0 trees drive address GPU p95 to 139.7 ms; washed daylight, uniform turf, smooth/faceted backdrop. Resize loop fixed and temporal MAE 0.020, but performance and visual blocking gates fail. |
| Integration 2 (partial pond) | 11 | 4 | 15 | 6 | 5 | 41 | Fail: pond still reads as a flat blue band and stock planar reflector is incompatible with production MRT materials (invalid empty WGSL outputs, 9 render passes). Backdrop remains swollen/faceted and near rough uniform. Resize ownership is now directly proven stable over all 32 frames: one viewport signature/revision, MAE 0.053, 0.054% changed pixels. Forest remains 67 visible LOD0 trees and drives GPU p95 to 131.1 ms. |
| Cycle 16 (stable integration) | 13 | 10 | 16 | 9 | 15 | 63 | Fail visual bar: resize ownership and temporal reconstruction are fixed (worst prior rough view MAE 0.009, 0.039% changed, viewport revision 1); production views are within the 14 ms target in isolated runs. Fairway/green remain broad matte fills, mountains read as smooth layered shells, pond as opaque cobalt, and the binding forest view contains 79 impostors with no geometry. |
| Cycle 17 (geometry residency probe) | 14 | 5 | 16 | 11 | 11 | 57 | Fail blocker: widening high-tier geometry residency exposes black stretched/torn LOD1 pine triangles, converts only 4/79 visible trees, and raises tree-edge GPU p95 to 19.47 ms. Temporal/viewport remain stable (MAE 0.025, 0.078% changed, one viewport revision), proving the corruption is tree geometry/material rather than resize churn. |
| Cycle 18 (stable integrated rebuild) | 15 | 14 | 13 | 12 | 13 | 67 | Fail visual/performance bar: cold range reaches verified `ready` at 3.05 s with no console/WebGPU errors; 146/146 tests and build pass; five of seven production views meet 14 ms. Low-rough (14.27 ms) and pond (15.52 ms) narrowly miss. Trees are grounded and corruption-free, rough has thick dense crossed blades, pond geometry meets its authored shoreline, and resize/temporal stability pass. Blocking visual defects remain: pale flat daylight/turf, smooth dark-green foothill shelf, weak ecology/depth hierarchy, and conspicuous circular green-complex rings in overview. |
| Cycle 20 (combined material/daylight/backdrop pass) | 15 | 14 | 13 | 13 | 13 | 68 | Fail visual/performance bar: clean WebGPU startup reaches `ready` at 3.37 s with no validation errors; all seven frozen views keep one stable viewport and pass temporal gates (worst MAE 0.0256 / 0.0612% changed). The circular green-complex and pond-material rings are gone, water is coherent and cheap, and five views meet the 14 ms battery-run GPU gate. Low-rough (16.49 ms, 80,762 unchanged blades) and pond (16.68 ms, 73,130 unchanged blades) miss. Blocking visual defects remain: direct daylight barely models the landform, mown turf reads as a pale matte fill at golfer distance, the first alpine wall is a smooth dark-green slab despite added far geology, and the forest edge lacks sufficient ecological depth. |
| Cycle 21 (lower-sun/material-direction pass) | 16 | 13 | 10 | 13 | 15 | 67 | Fail visual/performance bar: clean restart and canonical engine cameras reach `ready` at 3.10 s with no console, WebGPU, resize, or temporal errors. Mowing direction and dense thick rough geometry read more clearly, but the integrated luminance hierarchy regressed: exposed turf and rock approach chalk-white while conifer crowns/trunks and the 300–1680 m alpine toe are crushed into broad dark masses. The toe still reads as one smooth slab instead of geological/ecological planes. Five views pass 14 ms; low-rough is 15.90 ms with 80,762 unchanged blades and pond-contact is 16.84 ms. Visual total remains below 88 and lighting/vegetation/world thresholds fail. |
| Cycle 22 (foliage rebalance and grass work refactor) | 16 | 15 | 12 | 12 | 15 | 70 | Fail visual/performance bar: clean integrated startup reaches `ready` at 3.12 s with no console, WebGPU, resize, hitch, or temporal failures. Thick crossed rough remains 80,762/73,130 blades and the per-blade state refactor improves low-rough from 15.90 to 14.92 ms and pond from 16.84 to 16.07 ms on battery, but both still miss 14 ms. Tree trunks/crowns retain more real shadow detail and water remains cheap/coherent. Blocking visual defects are structural: pale playable turf, a smooth dark foothill slab, a gray mineral cap, and a sparse uniform tree curtain read as disconnected flat layers; the course landform and ecology lack the meso-scale relief, hierarchy, and overlap required by the bar. |
| Cycle 23 (structural landform and needle transmission) | 17 | 17 | 13 | 12 | 13 | 72 | Fail visual/performance bar: collision-authoritative course relief reaches 3.85 m with maintained slope capped at 7.35%, the backdrop silhouette gains asymmetric spurs/drainage, and the forest gains valid 515-object depth plus bounded sun-oriented needle transmission. All canonical views load with stable viewports and pass frozen temporal gates, but the integrated visual still reads as pale turf beneath a large dark low-detail wall. Low-rough is 15.69 ms, pond-contact is 17.70 ms with one hitch, and the binding tree view is 23.21 ms / 16 hitches because 79 of 90 visible trees remain LOD0; it therefore fails both the 16.7 ms tree budget and visual-performance coherence. |
| Cycle 24 (directional turf and LOD experiment) | 20 | 17 | 14 | 14 | 13 | 78 | Fail overall bar, with turf accepted provisionally: broad 7 m mower passes now read primarily through normal/roughness/specular response with only +/-2% albedo support; low-rough improves from 15.69 to 13.14 ms and pond from 17.70 to 12.05 ms while preserving exact 80,762/73,130 blade counts, 192 grid, coverage, and 7.5–18 mm widths. The corrected backdrop lifts the black shelf and exposes more face polarity but still has an over-dark ridge underside. Moving tree residency from 79/8/3 to 45/42/3 does not solve the fragment-bound close forest: tree-edge remains 24.57 ms and fails 16.7. Total and tree performance remain blocking. |
| Cycle 29 (shared tone and semantic tree LOD) | 20 | 16 | 17 | 14 | 13 | 80 | Fail visual/native-performance bar: 158/158 tests and the production build pass; all seven fixed cameras keep stable 32-frame viewports/temporal history, exact rough counts remain 80,762/73,130, and their battery-run GPU p95 values are <=12.30 ms. A constants-only shared-light calibration lowers the key/exposure, raises real PMREM/hemisphere fill, keeps open rough above 78 luma, and caps the brightest maintained crop at 134.99. The tree LOD1 fast path now distinguishes the authored bark tile from needle tiles and removes most purple-trunk/neon-crown error, but its low-battery tree-edge sample is 21.12 ms and lacks valid AC attribution. Root visual review still rejects the flat cloudless sky, repetitive analytic pond bands/hard contact, broad smooth first ridge, and simplified mid-tree wall as obvious real-time shortcuts. Three cameras also present at ~30 Hz on battery despite 10.87–12.30 ms GPU completion, so rAF/hitch, native-panel, robustness, and two-clean-cycle gates remain open. |
| Cycle 30 (pond interference and backdrop meso-relief) | 20 | 16 | 17 | 16 | 13 | 82 | Fail overall/native-performance bar: 160/160 tests and production build pass. Root's isolated production-preview suite has no console/WebGPU/fallback or viewport errors and every 32-frame temporal sequence passes. Water remains one draw/two existing samples while replacing the corrugated dominant train with lower-amplitude multidirectional interference, shore-slope attenuation, bounded view-path absorption, and brighter shallow contact. The first 300–1400 m wall gains bounded real +/-6 m ribs, drainage slots, and talus tied to its existing PBR response. An attempted sparse volumetric sky was rejected for large low-resolution rectangular reconstruction blocks and fully disabled. Root score remains below 88 because the clear sky is empty, the mid-tree wall still simplifies conspicuously, and pond shallows/contact remain too uniformly opaque. At 16–19% battery, four views miss the 14 ms GPU gate by 0.12–0.76 ms and rAF schedules near 30 Hz; these are recorded but cannot substitute for AC/native certification. |
| Cycle 31 (irregular pond shallows and tree varying compression) | 20 | 16 | 17 | 16 | 13 | 82 | Fail overall/native-performance bar: pond optics now use the authoritative SDF plus world-stable sediment irregularity to expose a broad saturated shallow perimeter overhead while retaining grazing sky response; the one-draw/two-sample pond passes its isolated battery gate at 13.29 ms and frozen temporal gates. The LOD1 tree semantic role is compressed from an RGB to scalar vertex varying, improving the low-battery tree-edge sample from 21.12 to 18.42 ms with unchanged 24/46/20 residency and warm-bark/olive-needle grading, but still missing 16.7. A direct analytic cloud layer was technically stabilized but rejected twice: first as faint horizon smudges, then as flat white cutout islands; production clouds remain disabled. 160/160 tests pass. With battery at 9–13%, the full/native/robustness and two-cycle gates remain open, and visual total does not advance because clear sky, mid-tree simplification, matte maintained-surface sameness, and game-like range props remain visible. |
| Cycle 34 (HDR/daylight and surface integration; unscored) | — | — | — | — | — | — | Pending AC visual verdict: 169/169 tests, asset hashes, focused invariants, and production build pass. A verified local 1K CC0 Radiance sky now supplies the visible background, solar-core-masked PMREM, and the pond's existing one-sample cheap sky response. Its measured source-space solar core is removed before IBL and replaced in the visible sky by only the authoritative analytic sun delta, preventing a second unshadowed key; Three's actual HDRLoader/equirectangular convention and yaw are covered by manifest tests. Maintained turf gains cut-specific normal/roughness/specular hierarchy without new samples or passes; grounded PBR range furniture replaces billboard-like props; effective pre-LOD rough blade width is now literally bounded to 7.5–18 mm with density/coverage/grid/geometry unchanged. No GPU, screenshot, temporal, native-panel, robustness, score, or two-cycle claim is made because the host reached 4% battery. The active goal remains open until the complete engine-camera battery runs twice on AC and root visual review reaches every threshold. |
| Cycle 35 (CPU integration and prop batching; unscored) | — | — | — | — | — | — | Pending AC visual verdict: 172/172 tests, production build, derivative integrity, and diff checks pass. The six target assemblies now retain their unique readable sign faces while batching poles, cloth, grounded bases, posts, and tee markers, reducing target/tee furniture from 38 to 11 real draw buckets; the canonical harness locks the shipped instance and draw contract. The local Radiance asset is decoded in-test to find its actual brightest solar pixel, verify its manifest yaw under Three's flip/equirectangular convention, and prove the solar core is excluded from IBL; stale asynchronous HDR callbacks now dispose the actual decoded texture. Maintained-surface fibre response consumes its shared mask once instead of double-weighting the green transition. No GPU, screenshot, native-panel, resize/temporal, robustness, score, or consecutive-cycle claim is made at 3% battery. The active goal remains open for the complete fixed engine-camera suite and two consecutive root-accepted AC cycles. |
| Cycle 48 (reel-width fairway mowing) | 20 | 16 | 17 | 16 | 14 | 83 | Fail overall bar, with mowing accepted: the former warped ~7 m bands are replaced by perfectly linear 2.54 m reel passes / 5.08 m alternating cycles. One strict fairway mask owns albedo support, leaf-lay normal, roughness, and dielectric response; green, collar, tee, rough, native, sand, and pond bank are excluded. Address, landing, approach, and overview evaluator cameras pass visual, temporal, viewport, and battery-run performance gates at 10.84–12.75 ms GPU p95. The 31.82 m camera-forward sparse rough tail retains 7.5–18 mm rooted blades and exact close density. Close/mid conifer quality, first-wall composition, pond outline, and bunker construction remain blockers. |
| Cycle 51 (authoritative hazard contours) | 20 | 16 | 17 | 16 | 14 | 83 | Fail overall bar, with pond and bunker construction accepted provisionally: one compiled rounded contour now drives pond basin height, surface/physics, water triangulation/containment, shoreline atlas, and bank mask; the low-sided polygon and continuous dark bank ring are gone. Bunkers preserve authored area/center/depth while gaining deterministic 1.29–1.41 anisotropy, three unequal noses, directional floors, grade-flush rims, and a shared irregular 0.30–0.50 m turf-face/sand inset used by rendering and lies. Overview passes at 10.91 ms GPU p95 with zero hitches and stable temporal output; 186/186 tests and build pass. Sand micro-material, tree realism/performance, and backdrop wall depth remain open. |
| Cycle 53 (Alps HDR valley integration) | 20 | 16 | 17 | 16 | 12 | 81 | Fail overall/performance bar: a pinned CC0 2K Alps Field HDR supplies photographic mountain scale while its measured source sun is masked and replaced by the authoritative shared sun. A widened U-shaped 45–63 m saddle through the procedural near/middle wall exposes the massif downrange without revealing the course edge; address/approach composition materially improves, but the remaining central wall is still smoother and greener than the photographic background. Every attempted fuller conifer derivative and tree shader shortcut was measured and rejected/reverted; accepted v3 hashes and three exclusive LOD draws remain intact, leaving the close tree visual/performance blocker unresolved. Root clean state passes 188/188 tests, production build, derivative hashes, diff check, temporal/viewport gates, and no-fallback browser integration. At 24–26% battery, address GPU p95 is 25.20 ms with one hitch and the multi-scenario browser exits after two views; AC/native-panel, robustness, tree-edge <=16.7 ms, and two consecutive cycles remain unproven. |
| Cycle 57 (grass material and conifer R&D) | 21 | 16 | 17 | 16 | 12 | 82 | Fail overall/performance bar: the rough keeps exactly 80,981 blades, 13 active tiles, the 31.82 m camera-forward tail, 7.5–18 mm rooted widths, crossed ribbons, shared daylight, shadows, MRT, and stable temporal output while a shared-environment Phong path lowers low-rough GPU completion p95 from 19.01 to 15.56 ms; the darker result is root-accepted as denser and less chalky, but still misses 14 ms. The benchmark now checkpoints every scenario atomically, so full-suite browser exits retain actionable evidence. Current production v3 remains binding and fails tree-edge at 23.47 ms / Scene MRT 18.77 ms with 24/46/20 residency; its skeletal crowns remain below the visual bar. Isolated conifer v4 proves a grounded, full-volume source-atlas silhouette and a registered LOD handoff, but its raw 4–5x geometry cost prevents production promotion; an optimized candidate remains in progress. The smooth green first wall, production tree realism/performance, native-panel suite, robustness, and two consecutive clean cycles remain open. |
| Cycle 71 (photographic enclosure and v8 integration) | 17 | 15 | 18 | 14 | 14 | 78 | Fail visual bar, while the desktop performance blocker is cleared: the verified photographic Alps HDR now forms the complete runtime enclosure and the rejected smooth procedural shell submits zero runtime geometry. All seven production cameras pass at 8.43–10.80 ms GPU p95 with zero hitches, stable viewports, and frozen temporal output; two consecutive `tree-edge-close` stress runs pass at 16.61 and 16.37 ms. The close v8 conifer retains credible trunk/crown volume, but mid/far communities are too saturated, repetitive, and hard-edged against the photographic valley. Fairway, green, and tee still flatten into broad matte green planes; the pond remains an idealized blue analytic bowl in eye and overhead views. Native-panel, robustness, no-fallback, two full consecutive cycles, and production promotion of the v8 trial assets remain open. |
| Generated foliage cycle 6 (unscored) | — | — | — | — | — | — | Pending AC/root verdict: three deterministic generated species now occupy nine purpose-built asymmetric practice-range perimeter groves without course-vibe placement. Italian- and Monterey-cypress cards map processor-authored stem-root-to-tip axes onto their supporting branches; Monterey now uses a three-leader exposed-trunk architecture instead of a radial fan. Species and forced-parent matrices pass 25/25 views, moving 12–607 m sweeps show branch-local rather than whole-tree LOD transitions, and two consecutive seven-camera battery runs pass validation, temporal, overflow, console, and residency gates. A generated-path three-rebuild robustness smoke passes with 0/3 retained Range WeakRefs and an exact stable GPU-resource multiset after fixing backdrop texture and PMREM sky-sphere ownership. This row remains deliberately unscored: strict AC/native-panel timing, the 30-minute robustness gate, production promotion, and root visual approval are still required. |
