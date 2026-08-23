# Active Goal: Generated Foliage and Production Tree System

Status: **active**

## Mission

Replace the golf range's weak model/impostor tree presentation with a beautiful,
stable, performant tree system built from botanically credible foliage-cluster
textures, structural trunk/branch geometry, and per-cluster hierarchical LOD.

Then generalize the asset path so generated courses can declare foliage aliases
and a future Codex SDK workflow can help players generate, process, validate, and
cache their own local foliage packs for any course aesthetic they can describe.

Do not stop at a technically functioning prototype. Continue the inspect -> form a
specific visual hypothesis -> implement -> render -> compare -> measure loop until
the production range satisfies every blocking gate below and the result is clearly
better than the current shipped trees in stills and motion.

## Start here

Read these before changing code:

- `GOAL.md` (this file)
- `docs/AAA_VISUAL_BAR.md`
- `src/scene/Trees.js`
- `src/viewer/assets.js`
- `tools/foliage-pipeline/README.md`
- `public/assets/trees_candidates/generated_fir_clusters/README.md`
- `public/assets/trees_candidates/generated_fir_clusters/processed/v1/douglas-fir-cluster-atlas.json`
- `course.json` and `public/assets/environment/catalog.json`

Use the repository's `imagegen` skill whenever generating or editing bitmap
foliage. Use the frontend/browser testing workflow for every rendered viewer or
range change. Check current official documentation before designing the future
Codex SDK or OpenAI API integration; do not rely on remembered API details.

## Current evidence and prototype

The candidate-only proof is available in `viewer.html` as:

`tree candidate: generated Douglas-fir clusters`

It currently provides:

- one immutable eight-cluster ImageGen RGBA source sheet;
- deterministic extraction, alpha cleanup, transparent-RGB dilation, 2K atlas
  packing, aligned material masks, and UV metadata;
- one procedural 19.5 m Douglas-fir candidate with 189 oriented/crossed cluster
  cards in one foliage draw plus one tapered-trunk draw;
- stable visible silhouette at the tested 28 m, 50 m, and 100 m views;
- no observed rectangular card backgrounds, obvious alpha halo, console warning,
  or distance disappearance in those views;
- a corrected high-DPI viewer canvas sizing contract.

The candidate is **not production-ready**. The observed problems are binding work:

- foliage is too dark under the shared daylight;
- the crown is too vertically repetitive and still exposes a pole-like trunk;
- branch mass, leader construction, age variation, close-up card intersection,
  wind, local hierarchical LOD, alpha-coverage mipmaps, KTX2, and production range
  performance are not solved;
- the derived material mask exists but is not yet consumed by the shader;
- bark is a placeholder color rather than a scanned CC0 PBR material;
- no generated texture may be promoted merely because the isolated tree looks good.

## Representation contract

These rules are non-negotiable unless measured evidence proves a better approach:

1. Image generation creates source **foliage-cluster RGBA**, not full-tree images.
2. Do not ask image generation to independently redraw normal, roughness, AO,
   height, depth, or transmission maps. Derived maps must remain pixel-aligned;
   structural normals/depth should come from authored geometry or controlled bakes.
3. Bark, wood, moss, and ground-contact materials should use verified scanned CC0
   PBR sources when possible, with complete provenance and downloaded-file records.
4. Far-tree impostors are rendered from the assembled 3D tree at consistent camera,
   light, and structure. Never independently generate each view.
5. Trunks and major branches remain opaque structural geometry with independent
   LOD. Foliage stays alpha-tested and runtime-lit.
6. Preserve crowns hierarchically. Select LOD per branch/foliage cluster using
   projected screen error; do not switch an entire perception-sensitive tree to
   one dead billboard or allow a whole tree to vanish while the ball camera flies.
7. Parent/child cluster transitions must preserve local silhouette and coverage.
   Use stable temporal decisions and a measured transition method; no random-frame
   dissolve, double-dark overlap, popping, or alpha boil.
8. Wind follows trunk -> branch -> foliage hierarchy. It must bend around stable
   anchors and must not translate/rotate whole crowns as cards or flicker thin firs.
9. Tight polygonal card hulls or similarly bounded support geometry must reduce
   transparent overdraw. Oversized rectangular quads are not a shipping solution.
10. Runtime foliage color, roughness, canopy normals, and leaf/needle transmission
    must respond to the one shared environment. No pre-lit or emissive foliage cheat.

The Broadleaf-style lesson to adapt is leaf/cluster-granularity hierarchical LOD,
texture baking, and GPU-driven selection. WebGPU/Three.js does not expose the exact
mesh-shader implementation from the reference, so use the engine's existing compute
and indirect-draw tools where they fit rather than copying an incompatible API.

## Workstreams

### A. Production foliage-source pipeline

Turn `tools/foliage-pipeline` into a reproducible, configurable pipeline:

- species and visual variants come from versioned JSON configuration;
- untouched generations live under a source directory with prompt, date, tool/model
  mode, source hash, and processing lineage;
- extraction handles approved contact-sheet layouts and rejects overlap/cropping;
- alpha cleanup retains needles, stems, and fine leaf tips while removing haze;
- RGB dilation fills transparent texels far enough for the complete mip chain;
- atlas packing records normalized UVs, pixel bounds, role/density, aspect, base
  direction, recommended scale, LOD use, and source lineage;
- derive aligned roughness and thickness/transmission masks conservatively;
- generate and verify alpha-coverage-preserving mip levels;
- emit inspectable PNG sources and KTX2 production textures;
- report alpha coverage, occupied area, transparent overdraw estimate, cluster scale,
  atlas utilization, and mip coverage drift;
- fail closed on malformed alpha, insufficient separation, inconsistent anatomy,
  bad hashes, or missing provenance.

Start with Douglas fir and make species configuration real before adding more. Do
not burn generations on many species until the first tree passes in motion.

### B. Foliage laboratory

Expand the existing asset viewer rather than creating a disconnected renderer.
The lab must use the production SceneManager, daylight, atmosphere, motion history,
materials, loaders, and disposal contracts. Add controls or deterministic query/API
hooks for:

- every extracted card, atlas overview, and assembled tree;
- front/back and at least three azimuths;
- 5, 20, 50, 100, and 200 m distance presets;
- alpha-test threshold and alpha-to-coverage where actually supported;
- roughness, canopy-normal shaping, and transmission strength;
- fixed and moving sun under light and dark backgrounds;
- source alpha, material masks, card hulls, mip level, LOD node, and overdraw views;
- uncompressed PNG versus shipping KTX2 comparison;
- card/cluster counts, selected hierarchy levels, draw/triangle counts, texture
  residency, atlas utilization, and frame/GPU timing.

Automated browser captures must cover the distance and azimuth matrix. Reject or
repair visible rectangular planes, halos, crushed foliage, repeated stamps,
malformed generated branches, implausible scale, baked light, disappearing needles,
or a crown that reads as layered cardboard.

### C. Tree construction and hierarchical LOD

- Build a plausible Douglas-fir structural skeleton with tapered trunk, leaders,
  branch whorls, secondary branches, age/height parameters, and grounded roots/base.
- Use dense interior clusters for mass and sparse clusters at the outline. Preserve
  irregular negative space; do not fill the crown with uniform random cards.
- Author several deterministic tree identities from one species pack so a range row
  never reads as cloned Christmas trees.
- Build local parent/child cluster LODs. Merge compatible clusters by position and
  orientation, bake child appearance into parents, and retain explicit hierarchy.
- Select nodes from projected size/error in compute and compact visible cluster
  instances into indirect draws. Distance may be a broad safety bound, not the sole
  classifier.
- Keep a distant assembled-tree impostor only after its projected error is negligible.
- Integrate stable hierarchical wind with branch stiffness, phase coherence, gusts,
  and motion vectors/temporal history.
- Measure alpha overdraw and shadow cost. Preserve silhouette before adding density.

### D. Production range integration

Only promote after the laboratory gates pass. Then replace the range tree source
through the environment catalog without leaving candidate paths or silent fallbacks.

- Line the intended side vegetation zones without producing a symmetrical tunnel.
- Maintain age, height, width, density, yaw, and grouping variation.
- Preserve clear ball/target visibility and believable ecological negative space.
- Trees must remain visible through the entire launch/result camera flight whenever
  they remain in the camera frustum and above the projected-error cutoff.
- Close the course/backdrop seam from every ball-flight camera without using trees
  as a screen that hides missing terrain.
- Keep tree bases grounded on all terrain slopes and avoid repeated clean forest floor.
- Compare production captures directly against the candidate viewer and current
  range before/after views.

### E. Generated-course foliage aliases

Design the pipeline as a reusable asset system, not a Douglas-fir special case.

- Add a versioned foliage-pack manifest and a stable `foliageAlias` identifier.
- Course data references aliases and ecological/placement intent, never raw absolute
  file paths or an image-generation prompt embedded in runtime rendering code.
- A resolver maps built-in and user-local aliases to immutable, content-hashed packs.
- Define required files, coordinate/scale conventions, material channels, hierarchy,
  provenance, validation state, and compatibility version in each pack.
- Separate generation from gameplay: a future Codex SDK workflow can plan prompts,
  invoke a user's local generation capability or configured Image API, process the
  source, run viewer QA, and install an approved local pack before course loading.
- Cache by normalized generation spec plus source/processor versions. Re-running an
  unchanged request must be deterministic after source generation and must not spend
  another generation unnecessarily.
- Preserve user privacy and local ownership: do not upload local course assets or
  prompts implicitly. Make any network generation step explicit and auditable.
- A course with an unresolved required alias fails with an actionable authoring error;
  it must not silently substitute an unrelated species and change the course design.
- Keep the generation-provider interface replaceable so the renderer and course
  schema do not depend directly on one SDK transport.

## Blocking visual gates

The work cannot be marked complete if any binding viewer or production camera shows:

- rectangular card silhouettes, colored/gray/black alpha fringe, or obvious atlas
  cell boundaries;
- pole trunks, detached foliage, floating branch sprays, malformed AI anatomy,
  repeated identical tiers, a perfectly conical Christmas-tree outline, or visibly
  planar crowns;
- foliage darker than plausible forest shadow, neon/plastic needles, baked sunlight,
  inconsistent light direction, absent backlight response, or uniform roughness;
- local or whole-tree LOD pop, card explosion, double-dark crossfade, crawling alpha,
  disappearing crown sections, or trees vanishing during ball flight;
- incoherent wind, pivot slip, trunk rubber motion, branch intersection flicker, or
  frozen distant crowns next to moving near crowns;
- exposed course edge/backdrop gap, floating bases, or obvious repeated side rows;
- WebGPU validation errors, console errors, missing resources, stale candidate paths,
  or an unrecorded asset/license/generation source.

## Measurable acceptance

All of the following are required:

1. Viewer matrix: approved screenshots at 5/20/50/100/200 m from at least three
   azimuths, plus light/dark background and front/back card inspection.
2. Temporal matrix: frozen-camera and moving-camera sequences at the transition
   boundaries with no visible pop, boil, flicker, or coverage collapse. Meet the
   temporal thresholds in `docs/AAA_VISUAL_BAR.md`.
3. Range matrix: address, low rough, side-tree close, apex/ball-flight, landing, and
   return cameras show grounded, persistent, naturally varied trees and no world gap.
4. Performance: meet every relevant production and native-panel tree/environment
   budget in `docs/AAA_VISUAL_BAR.md`; do not improve average FPS by hiding trees.
5. Asset metrics: atlas/mip coverage drift and overdraw are measured and bounded;
   every production texture is compressed and every source/derivative hash validates.
6. Quality comparison: the generated-cluster result is plainly superior to the old
   production tree path in side-by-side fixed-camera captures, not merely different.
7. Engineering: `npm test` and `npm run build` pass; candidate-only assets stay out of
   production catalogs until promotion; resource switching/disposal has no leak or
   stale async completion.
8. Root acceptance: update this file with final evidence and obtain the user's visual
   approval. A green test suite or one attractive close-up is insufficient.

## Required iteration discipline

For every material visual change:

1. State the precise defect visible in a named camera/distance.
2. Identify whether its cause is source texture, processing, assembly, shading,
   hierarchy/LOD, wind, lighting, placement, or camera/viewer infrastructure.
3. Make the smallest coherent change that tests that diagnosis.
4. Run focused tests and a production build.
5. Render the same before/after camera plus the nearest transition/distance risks.
6. Inspect console health and relevant diagnostics.
7. Record the evidence and remaining defect below.

Do not respond to a bad render by blindly swapping models, increasing every tree's
size, forcing full LOD, or adding density everywhere. Diagnose the representation.

## Progress record

- **2026-08-20 — Candidate v1:** Generated and preserved an eight-cluster
  Douglas-fir sheet; added deterministic processing and metadata; assembled a
  189-card/two-draw candidate in the production asset viewer; fixed viewer high-DPI
  canvas sizing; build and focused viewer tests pass; browser QA at 28/50/100 m
  found stable silhouette and clean alpha but excessive darkness, repetitive tiers,
  exposed trunk, and no production hierarchy/wind/compression integration. Goal
  remains active.
- **2026-08-20 — Generated species/perimeter cycle 2:** Generalized the source
  processor and immutable pack resolver, added self-contained Italian-cypress and
  Monterey-cypress candidate packs, and authored species-specific exposed-trunk
  skeletons, crowns, local hierarchical LOD, wind anchors, motion data, compressed
  KTX2 atlases/masks, and shared-daylight foliage response. The practice range now
  uses 23 Douglas firs, five Italian cypresses, and eight Monterey cypresses in nine
  deterministic asymmetric perimeter groves; it does not consume course-vibe
  placement and preserves the central target corridor. The new attachment-frame
  contract records the actual source stem root and tip for every cypress cluster;
  runtime card construction rotates that root-to-tip axis onto its supporting
  procedural branch. Fresh post-fix Italian and Monterey viewer matrices each
  captured 25/25 required distance, azimuth, alpha, material, hull, overdraw, and
  PNG/KTX2 views with zero errors. Visual inspection at 5 m and 20 m across all
  three azimuths found rooted sprays with no former sideways/dangling orientation,
  alpha rectangles, or fringe. Production build and 11 focused integration tests
  pass, with a dedicated normalized attachment-axis regression test also passing.
  A production address-camera browser check shows the mixed trees only around the
  perimeter, an open center, grounded bases, and no console/WebGPU warnings. The
  most recent strict generated tree-edge run measured 22.766 ms p95 and 20.987 ms
  Scene-MRT p95 on battery versus 27.538/25.590 ms for the shipped baseline, so the
  candidate is faster and visually stronger but still misses the 16.7 ms blocking
  absolute budget. Promotion, the complete temporal/range matrices, two consecutive
  clean full cycles, and root visual approval remain open; goal remains active.
- **2026-08-20 — Attachment/range cycles 2–3:** Replaced crop-edge-only cypress
  card orientation with a processor-authored attachment frame (source stem root,
  normalized root-to-tip axis, growth extent, and lateral support span) consumed by
  runtime hull construction. Post-fix 25-view matrices for Italian and Monterey
  cypress each pass at 5/20/50/100/200 m, three azimuths, front/back alpha, light/dark
  backgrounds, all debug modes, and PNG/KTX2 parity with zero errors; visual review
  confirms that lateral and diagonal sprays now grow from their supporting branches.
  A close-card reduction probe was rejected after removing 226 cards per Douglas tree
  changed the battery stress result only from 22.766 to 22.824 ms, proving submitted
  card count was not the binding cost; full crown density was restored. The full
  range cycle then exposed and fixed a real 105 m overview overflow: grass LOD had
  ignored camera height and tried to compact 692,291 patches into 393,216 slots.
  Height-aware projected-size safety now hands those imperceptible blades to the
  existing terrain representation, producing zero overview grass, zero overflow,
  10.04–10.17 ms GPU p95, stable luma, and unchanged ground-camera footprints.
  Two consecutive clean seven-camera generated-range runs (`cycle2` and `cycle3`)
  have zero console/WebGPU/resource errors, zero hitches, stable viewports, passing
  frozen temporal comparisons, and identical grass residency. Two real shot cycles
  also pass chase/descent/result and result/return/address with one viewport signature,
  no moving-camera projection jitter, persistent perimeter trees, and no warnings.
  On battery, address/landing/approach/overview pass 14 ms while low-rough measures
  16.706–16.969 ms and pond-contact 17.355–17.405 ms; these are provisional rather
  than AC acceptance. `npm test` passes 269/269 and the production build passes.
  Candidate promotion, authoritative AC/native-panel timing, and root visual approval
  remain open; goal remains active.
- **2026-08-20 — Rooted-spray/far-parent cycles 4–5:** Responded to the binding
  leaf-orientation defect by retaining an explicit source stem-root and tip for every
  Italian- and Monterey-cypress cluster and mapping that normalized root-to-tip axis
  onto each procedural branch in `appendHullCard`. Monterey scaffolds now use seven
  uneven, curved, wind-biased limbs with nonuniform attachment heights and flatter
  alternating sprays; the production far parent retains three smaller root/mid/tip
  stations per branch instead of two oversized terminal cards. A new Foliage Lab
  forced-parent path exposes all three species' exact production band-2 geometry.
  The Monterey forced-parent matrix completed 25/25 distance, azimuth, front/back,
  light/dark, debug, and PNG/KTX2 captures with zero browser/WebGPU errors; diagnostics
  prove all 48 branches selected band 2 and 288 parent cards at every distance. Visual
  inspection at 20 m from 0/120/240 degrees confirms woody cluster roots meet the
  scaffolds and sprays grow root-to-tip along them, with no former detached sideways
  card orientation or whole-crown collapse. The practice range remains independent of
  vibe placement and now uses 21 Douglas firs, five Italian cypresses, and ten Monterey
  cypresses in the same nine perimeter groves; mixing two Monterey identities into the
  formerly all-Douglas left-front grove removes the repeated-column wall while retaining
  the open target corridor.

  Two new seven-camera production runs (`foliage-final-full-cycle1/2`) both pass
  validation, frozen temporal stability, resource/console health, and zero grass-buffer
  overflow with identical residency. Battery GPU p95 is respectively 12.224/12.187 ms
  at address, 16.558/16.720 ms in low rough, 17.424/17.479 ms at pond contact, and
  10.694/10.719 ms at overview; pond display telemetry recorded 3/5 offscreen rAF
  hitches, so these remain provisional and are not substituted for the required AC
  certification. A discovered capture-harness boolean parsing bug was fixed: bare
  flight/return flags now retain the intended 180-frame maximum instead of coercing
  to one frame. Two real flight sequences span chase/descent/result in 43/42 sampled
  frames and two return sequences span result/return/address in 34/33 frames, each
  with one viewport signature, no moving-camera projection jitter, and no warnings.
  `npm test` passes 270/270, `npm run build` passes, and `git diff --check` is clean.
  Pack promotion still waits on root visual approval, while strict AC, native-panel,
  and robustness timing remains open because the host is on battery; goal remains active.
- **2026-08-21 — Forked-canopy/LOD/robustness cycle 6:** The corrected leaf-card
  attachment frame remains binding: every cypress cluster carries its authored stem
  root and tip, and runtime construction rotates that root-to-tip vector onto the
  supporting branch. The next fixed close view exposed a separate structural defect,
  not another card-rotation defect: Monterey cypress still read as seven spokes on a
  pollarded pole. Its scaffold is now three crooked leaders leaving the lower trunk at
  different heights, with seven asymmetric secondary limbs and 48 foliage-bearing
  branches forming distinct wind-shaped canopy pads. The post-change Monterey matrix
  and forced-far-parent matrix both pass 25/25 required views with zero errors. A real
  80-frame 12.2–207.2 m and 100-frame 107–607 m moving-camera sweep proves that local
  branch LOD transitions are distributed through the crown: near-to-mid begins around
  111 m and finishes around 223 m, while mid-to-far begins around 405 m when the tree
  is already a small screen feature; no whole-tree pop is visible.

  Two consecutive post-fork seven-camera production runs
  (`foliage-forked-final-full-cycle1/2`) pass validation, frozen temporal comparisons,
  zero overflow, console/WebGPU health, and identical residency. Battery GPU p95 is
  12.231/12.130 ms at address, 16.763/16.881 ms in low rough, 17.468/17.708 ms at pond
  contact, and 10.898/10.944 ms at overview; these remain provisional rather than AC
  evidence. The generated-foliage robustness harness now selects the actual candidate,
  validates its three forest groups and six identity-shadow draws, and checks its own
  diagnostics rather than legacy tree invariants. Rebuild testing found and fixed two
  real ownership leaks: BackdropTerrain's two node-owned rock textures and Three's
  renderer-owned PMREM capture sky sphere. The final three-rebuild smoke passes with
  zero errors, 0/3 retained Range WeakRefs, constant 226 vertex / 51 index attributes
  and 62 textures, and an identical normalized active-resource multiset. `npm test`
  passes 270/270; the production build, diff check, and no-fallback browser verification
  also pass. Strict 30-minute AC
  robustness/native-panel certification, promotion, final scoring, and root visual
  approval remain open because the host is at 37% and discharging; goal remains active.
- **2026-08-21 — AC certification preflight (invalidated by external load):** AC power
  is now present at 100% charge with no macOS thermal or performance warning, and the
  generated path again passes all seven visual thresholds, frozen temporal checks,
  zero-overflow diagnostics, 270/270 tests, production build, diff hygiene, and the
  no-fallback browser check. The first strict AC timing attempt is not accepted:
  an already-running regular Chrome GPU process remained continuously active at about
  33% CPU with one renderer at about 14–15%, while the benchmark uses a separate clean
  Chrome instance. Under that contention every generated camera missed 14 ms
  (19.89–31.23 ms). A shipped-tree control at the light overview camera also regressed
  to 22.29 ms versus its established uncontended 8–11 ms range, proving the failure is
  global host contention rather than candidate foliage cost. These reports are retained
  at `benchmarks/generated-foliage-ac-cycle1` and `tmp/ac-contention-baseline-overview`
  but are explicitly non-qualifying. Strict cycles will resume only after the external
  Chrome renderer is idle; all remaining acceptance gates stay open.
- **2026-08-21 — Monterey bark/joint cycle 7:** Close 5 m inspection isolated two
  structural causes behind the apparently missing bark and sky-visible limb joints.
  The tapered-cylinder side indices were wound inward despite outward vertex normals,
  so front-face culling exposed dark far walls; every segment now uses outward winding.
  In addition, touching polygon rings at crooked elbows and parent/child attachment
  centers left view-dependent wedge cracks. Radius-scaled axial overlap now buries
  child starts inside their parents, and closed end rings prevent any residual open
  cylinder from revealing sky. Monterey's verified Pine Tree 01 CC0 albedo, normal,
  and ARM maps are explicitly bound through its standard PBR node material; a bounded
  linear albedo calibration and reduced normal strength retain fissure detail, while
  the open canopy no longer applies hundreds of stacked alpha-card shadows to its own
  exposed structure. Three final 5 m azimuths and the complete 25-view Monterey matrix
  show continuous bark-covered trunk, leaders, scaffolds, and sprays without the former
  open-ring gaps; the matrix has zero browser/WebGPU errors. A dedicated winding,
  material-binding, overlap, and cap regression passes; the complete suite is now
  271/271, the production build passes, and diff hygiene is clean. A first strict
  tree-edge sample remains non-qualifying at 23.09 ms p95 against 16.7 ms, although its
  visual and frozen temporal gates pass; performance certification and root approval
  therefore remain open and the goal stays active.
- **2026-08-21 — Reproducibility/performance attribution cycle 8:** Controlled
  tree-edge probes rejected two tempting quality regressions. Replacing the complete
  foliage material with a flat one-texture shader changed Scene-MRT p95 by only
  0.01 ms, while moving all generated foliage offscreen saved only about 0.34 ms;
  the generated crowns are not the source of the remaining close-camera budget miss.
  Even hiding the complete 326,362-patch grass raster left Scene MRT at 18.04 ms and
  frame completion at 18.82 ms. The host had returned to battery power for these
  diagnostic runs, so none are acceptance timing and all hidden/flat experiments
  were reverted; tree and turf quality remain intact.

  A separate pack rebuild audit found that binary foliage and bark outputs were
  deterministic but provenance JSON depended on the chosen output directory. The
  processor now serializes config-relative provenance and pins the exact species
  configuration SHA-256 in each manifest. Fresh canonical and alternate-directory
  builds of Douglas fir, Italian cypress, and Monterey cypress are each 9/9 files
  byte-identical, including manifests and metadata. Their maximum mip-coverage drift
  is respectively 0.000817, 0.000757, and 0.001312; transparent-overdraw estimates
  are 0.5741, 0.7001, and 0.6539, all inside configured fail-closed bounds. The full
  suite remains 271/271, production build, browser no-fallback integration, and diff
  hygiene pass. A post-regeneration generated-path smoke also passes 600+ moving
  frames and three complete rebuilds with zero validation errors, 0/3 retained Range
  WeakRefs, and stable owned GPU resources; it is explicitly not goal-eligible at
  45 seconds on battery. Strict AC/native/robustness gates and root approval remain
  open; the goal stays active.
- **2026-08-21 — Provider/local-alias workflow cycle 9:** A completion audit found
  that the earlier reusable-course work stopped at a runtime resolver comment: there
  was no normalized generation request, provider/cache boundary, explicit install
  gate, or way for Range to resolve a real `local.*` pack. Current official OpenAI
  image-generation documentation was reviewed before designing the integration. The
  implemented authoring contract remains transport-neutral: a direct Image API or a
  Responses image-tool adapter can be injected later, as can a fully local generator,
  without changing gameplay or the renderer. Normalized botanical intent, exact
  prompt, provider/model version, processor version, and config SHA form a stable
  cache key; unchanged requests reuse immutable source bytes and do not call the
  provider again. Network providers require explicit consent and receive no implicit
  course files, screenshots, paths, or unrelated assets. Processing, viewer review,
  and installation are separate injected stages, and installation requires both an
  affirmative QA decision and an explicit install request.

  The browser now accepts an immutable pre-bootstrap registry of same-origin local
  pack descriptors. Range passes that registry to the existing fail-closed resolver,
  so a course can use a versioned `local.*` alias without embedding a path; external
  URLs, traversal, unknown fields, incompatible versions, candidate manifests, and
  hash mismatches are rejected without builtin substitution. Manifest validation now
  also requires a valid generation-spec hash and consistent candidate/approved state,
  and memoization includes the descriptor root. New workflow, privacy, cache, QA,
  registry, and approved-local verification tests bring the full suite to 277/277;
  the production build and diff hygiene pass. A hardware-WebGPU generated address
  smoke after the bootstrap change also passes visual/temporal/resource validation,
  complete classification for all three aliases, zero grass overflow, and zero errors
  (12.21 ms battery timing is diagnostic only). AC/native/long-robustness certification,
  promotion, and root visual approval remain open; the goal stays active.
- **2026-08-21 — Foliage laboratory controls cycle 10:** The isolated production
  viewer now exposes deterministic alpha-test, roughness-mask strength, canopy-normal
  shaping, transmission-strength, and fixed/moving-sun controls. Their defaults compile
  to the reviewed production material response; bounded query hooks affect only the lab.
  Alpha-to-coverage is explicitly reported unavailable because the production WebGPU
  renderer uses a non-MSAA target with temporal antialiasing. The moving mode rotates
  the shared direct-light direction, visible sun disc, terrain response, actual
  directional light, and its shadow map together while retaining the fixed prefiltered
  sky as a reference bounce rather than rebuilding PMREM every frame.

  A fresh 31-view Monterey matrix covers the required 5/20/50/100/200 m and three-
  azimuth views plus six material/sun-control probes. It reports zero console, resource,
  or WebGPU errors; every probe returned the requested bounded shader value, and the
  240-frame moving-sun capture retained all 384 selected close cards. Visual inspection
  of all three 5 m azimuths confirms that the repaired bark-covered structural joints
  remain sealed without sky-visible attachment gaps. The in-app browser integration
  could enumerate Chrome but repeatedly routed local navigation to a disconnected
  instance, so the repository's established hardware-WebGPU Puppeteer capture harness
  supplied this rendered evidence at `tmp/foliage-lab-controls-monterey`. Focused tests,
  production build, and diff hygiene pass. Full-suite rerun, explicit atlas/card/mip
  lab views, AC/native/long-robustness certification, promotion, and root visual approval
  remain open; the goal stays active.
- **2026-08-21 — Complete lab/source cleanup cycle 11:** The generated-tree lab now
  switches among the assembled tree, complete source atlas, all eight extracted cards,
  and explicit mip levels 0/4/8 while retaining PNG/KTX2 selection and the production
  SceneManager/disposal path. Forced mips use nearest magnification so their retained
  texels can be inspected, and JSON diagnostics enumerate the exact cluster names,
  mip, texture mode, atlas metrics, and draw count. The capture harness now accepts an
  exact `--only` set for focused repeatable probes. A 35-view Monterey matrix exercises
  all tree, debug, material, sun, atlas, card, mip, and PNG/KTX2 cases with zero console,
  resource, or WebGPU errors.

  The all-card view exposed 32 disconnected one-to-332-pixel source islands that the
  old rectangular crop copied despite selecting the correct main component. Processor
  v3 now floods through non-zero antialiased texels from each high-confidence selected
  component and copies only that connected silhouette. All 24 Douglas-fir, Italian-
  cypress, and Monterey-cypress card crops now contain exactly one connected alpha
  component. Fresh canonical and independent alternate-directory v3 builds are each
  9/9 files byte-identical. Douglas-fir, Italian-cypress, and Monterey-cypress maximum
  measured mip drift is respectively 0.000817, 0.000791, and 0.000903; overdraw is
  0.5741, 0.7003, and 0.6543. Post-cleanup 5 m Monterey views at 0/120/240 degrees show
  no floating flecks and retain sealed, bark-covered limb attachments; 20/50/100/200 m
  and PNG/KTX2 views retain the reviewed crown without disappearance. The suite passes
  279/279, production build, no-fallback hardware browser check, and diff hygiene pass.
  The host remains at 94% on battery with no thermal warning, so strict AC/native and
  long-robustness certification were not attempted; those gates, promotion, and root
  visual approval remain open and the goal stays active.
- **2026-08-21 — Fixed-camera superiority/production visual cycle 12:** A controlled
  `tree-edge-close` comparison now captures the generated and shipped tree paths from
  the same immutable production camera. The shipped path places the camera inside an
  opaque, crushed-black crown and fails its visual gate at 17.67 mean sRGB luma; the
  generated perimeter remains fully readable at 99.60 luma, preserves the range and
  mountain composition, and shows grounded Douglas-fir and Monterey-cypress structure.
  Its 23.36 ms GPU p95 is also lower than the shipped path's 28.37 ms in this battery
  diagnostic, though neither number is accepted as strict performance evidence.

  A fresh post-v3 seven-camera production run at `tmp/generated-v3-production-visual`
  passes all visual thresholds, every frozen temporal comparison, stable viewport,
  complete generated-species diagnostics, and console/WebGPU/resource validation with
  zero errors. Direct inspection of address, low rough, both landing directions,
  approach, pond contact, and overview confirms that the nine asymmetric groves remain
  confined to the practice-range perimeter, preserve the central target corridor, and
  expose no course-edge gap or source-cleanup regression. Reinspection of Monterey at
  5 m from 0/120/240 degrees confirms that all trunk, leader, scaffold, and branch
  sockets remain closed and bark-covered; dark back-facing limbs retain bark detail
  under the shared daylight rather than using a flat fill. A separate 2408x1506
  `tree-edge-close` visual-only probe likewise shows continuous sockets without
  subpixel sky leaks at native panel resolution and passes visual, temporal, and
  validation checks. Battery timing is explicitly non-qualifying: low rough reached
  17.93 ms and pond contact 20.66 ms with offscreen rAF hitches. Strict AC native-panel
  timing and 30-minute robustness certification, final score, promotion, and root
  visual approval remain open; the goal stays active.
- **2026-08-21 — Authored multi-pack production contract cycle 13:** The promotion
  audit found that the candidate query could inject all three generated species, but
  authored `course.json` accepted only one `foliageAlias`; promoting that state would
  have silently collapsed Italian and Monterey placements to Douglas fir. Course
  normalization now accepts either one versioned `foliageAlias` or an ordered, unique
  `foliageAliases` list of one to three packs, never both. The practice-range perimeter
  derives every species slot from that exact declaration, supports coherent one- and
  two-pack designs, and throws if runtime placement ever emits an undeclared alias.
  Raw paths remain forbidden and every built-in/local pack still passes the immutable
  manifest and content-hash resolver before loading.

  Nineteen focused schema/resolver/perimeter tests pass, including duplicate,
  malformed, ambiguous, empty, over-capacity, single-local-pack, and two-local-pack
  cases. The complete suite passes 280/280, the production build and no-fallback
  browser contract pass, and diff hygiene is clean. A post-change hardware-WebGPU
  address smoke loads the reviewed Douglas/Italian/Monterey KTX2 packs as three
  independently classified groups with complete residency, stable viewport, passing
  frozen temporal output, zero errors, 100.10 mean luma, and unchanged perimeter
  composition. Its 12.17 ms GPU p95 is battery diagnostic only. The shipped course
  deliberately remains unpromoted pending strict AC/native/robustness acceptance and
  user visual approval; the goal stays active.
- **2026-08-21 — Deterministic approval-gated promotion cycle 14:** The reusable
  foliage workflow previously stopped at an injected installer interface and had no
  concrete safe path for promoting reviewed built-in packs. A provider-neutral
  `promote-pack.mjs` command now requires an affirmative approval record containing
  the exact candidate-manifest SHA-256, reviewer, UTC review time, and named evidence.
  It validates the candidate schema and every declared byte/hash before writing,
  refuses a destination inside the candidate, never overwrites an existing install,
  preserves every required atlas/mask/metadata/bark byte exactly, and changes only the
  copied manifest's candidate/approved state plus its content-hashed promotion record.
  Rejected decisions and stale manifest pins fail before creating the destination.

  Two promotion tests exercise byte preservation, manifest-only approval, overwrite
  refusal, negative decisions, and stale approval pins using temporary directories;
  the complete suite passes 282/282 and the production build/diff check pass. The
  reviewed packs and `course.json` remain deliberately unchanged because no user
  approval record exists yet. Strict AC/native/robustness certification and final
  visual approval remain open; the goal stays active.
- **2026-08-21 — Strict fixed-camera power eligibility cycle 15:** The long robustness
  harness already rejected battery-powered Metal evidence, but the fixed-camera
  benchmark did not record or enforce host power. It could therefore produce a green
  strict-looking report that was ineligible under the acceptance contract. The harness
  now recognizes only the canonical seven-camera 1280x720, tree-edge 1280x720, and four
  named 2408x1506 native contracts with their exact budgets, sample counts, tier, and
  temporal thresholds. On macOS it records `pmset` power/thermal state and marks each
  report's goal eligibility; a canonical run off AC injects a blocking validation error
  before scenario collection. Noncanonical or explicit `--allow-performance-miss`
  diagnostics remain runnable but are always labeled ineligible.

  A real battery preflight of the strict generated tree-edge command now exits failed
  with `canonicalTimingContract: true`, `acPowerEligible: false`, `eligible: false`,
  and zero completed scenarios. A relaxed generated address diagnostic still passes
  visual/temporal/WebGPU validation at 13.04 ms while explicitly reporting itself
  non-eligible. The complete suite remains 282/282; production build, no-fallback
  browser verification, and diff hygiene pass. The host is still discharging, so no
  strict timing claim is made and the goal stays active.
- **2026-08-21 — Promotion-state diagnostics cycle 16:** A final production audit
  found that the isolated generated tree hard-coded `candidateOnly: true` and the
  instanced forest omitted validation state, so an approved promoted pack would still
  report stale candidate diagnostics. Direct pack loading now rejects any mismatch
  between `candidateOnly` and `validation.state`; both tree and forest diagnostics
  derive `candidateOnly` and `validationState` from the verified manifest. No
  promotion-only renderer branch or asset mutation is introduced.

  Thirteen focused candidate/resolver/promotion tests pass; the complete suite remains
  282/282 and the production build/no-fallback browser checks pass.
  A real hardware-WebGPU address smoke reports all three generated KTX2 forests as
  `candidateOnly: true`, `validationState: candidate`, and classification-complete,
  with zero console/WebGPU/resource errors. The same diagnostic path will report
  `approved` only after the approval-gated promoter and production resolver accept an
  approved manifest. Strict AC/native/robustness certification and user approval remain
  open; the goal stays active.
- **2026-08-21 — External-gate audit cycle 17:** The host remains on battery for the
  third consecutive goal turn (84%, discharging) with no thermal or performance
  warning. The canonical fixed-camera harness now correctly refuses to collect strict
  Metal evidence off AC, and the 1800-second/54000-frame/20-rebuild robustness contract
  independently requires AC. Replacing these with relaxed battery timings would violate
  the binding acceptance bar. All remaining battery-safe production work has been
  exhausted: the branch sockets and Monterey bark pass close/native visual review; pack
  processing, aliases, local registry, promotion, and validation-state diagnostics are
  fail-closed; the complete suite is 282/282; build, no-fallback browser verification,
  deterministic pack rebuilds, asset hashes, and diff hygiene pass. No pack is promoted
  because the approval-gated promoter also correctly requires explicit user visual
  approval. The goal is blocked only on AC certification and that approval; resume on AC
  to run two canonical desktop/tree/native cycles plus the long robustness gate, then
  review, approve, promote, and execute the final production verification.
- **2026-08-21 — Broadleaf species cycle 18:** Added immutable ImageGen source sheets
  and candidate-only v3 packs for California valley oak and sugar maple. Both contain
  eight connected, bottom-rooted summer branchlets with processor-authored attachment
  frames, aligned material masks, alpha-coverage mip chains, UASTC KTX2 textures, and
  byte-pinned CC0 Poly Haven deciduous bark. Oak measures 0.000536 maximum mip drift
  and 0.6931 transparent overdraw; maple measures 0.000544 drift and 0.7135 overdraw,
  both within the fail-closed pack thresholds. The runtime now has distinct broadleaf
  skeletons rather than conifer configuration variants: a 17 m, low-forked mature oak
  with three heavy leaders, sixteen irregular 7–10 m scaffolds, a broad asymmetric
  crown, and 894 close cards; and an 18.5 m maple with a lower fork, fifteen ascending
  scaffolds, an oval crown, and 752 close cards. Both retain two draws and branch-local
  projected-error LOD.

  Interactive Browser QA caught and fixed a real primary-fork gap: the skeleton had
  estimated a straight broadleaf trunk while structural geometry used a crooked one.
  Both now sample the identical trunk curve and bury leader starts inside it. Focused
  hardware-WebGPU matrices at 5/20/50/100/200 m, three near/far azimuths, and overdraw
  debug complete with zero console, resource, or WebGPU errors. At 200 m the oak
  distributes 103–107 branches into LOD1 and the maple 120, preserving their distinct
  wide-versus-upright silhouettes. These packs remain lab-only: no course, catalog,
  production range placement, or promotion changed, and any eventual range use will
  be purpose-built around the perimeter rather than environment-vibe placement.

  A separate user-requested img2threejs sub-agent experiment records the supplied
  reference accurately as a probable giant-sequoia/redwood-form conifer, not an oak.
  Its isolated 56 m two-draw candidate passes viewer/build/tests but remains explicitly
  non-promotable because the reference license is unknown, close foliage is stylized,
  bark lacks scanned PBR relief, and img2threejs 1.4.4 exposes no vegetation adapter.
  Fresh rebuilds of both broadleaf packs compare byte-for-byte with the checked-in
  derivatives (oak manifest SHA-256 `c3b36fb3589e2b9de31ee82c2b215d458d6298c420f6edf7e2502b47df404b73`;
  maple `46f1d86f1dd90a05b0a9f20613271441a9e55bdb75ec937fa8935c17e2dbe3a0`).
  The complete suite is 285/285; production build, no-fallback browser verification,
  and diff hygiene pass. A non-goal-eligible 45-second production-renderer smoke
  completed 2,425 frames and three rebuilds with no console/WebGPU/resource errors,
  but correctly failed its 14 ms GPU p95 target at 19.30, 15.64, and 21.64 ms. This
  smoke covers the existing generated range species, not the new lab-only broadleafs,
  so it is recorded as a production performance regression signal rather than
  broadleaf acceptance evidence.
  Broadleaf root visual approval, complete temporal matrices, production placement,
  strict AC/native timing, and long robustness certification remain open; the goal
  stays active.
- **2026-08-21 — Rooted camera-facing foliage cycle 19:** User review rejected the
  img2threejs reference-sequoia experiment and identified broadleaf cards collapsing
  into long one-pixel strips when their planes reached roughly 90 degrees to the
  camera. The experiment's scene module, viewer entry, tests, and entire unlicensed
  candidate/evidence directory were removed; no production reference existed.

  Generated cards now carry immutable `foliageAxis` and `foliageCardUp` vertex
  attributes. The GPU preserves each vertex's root-to-tip axial displacement while
  biasing only its lateral axis toward the camera (0.88 for oak/maple; 0.76 for
  crossed conifer/cypress sprays). This retains a small authored component so cards
  do not become coplanar, and it does not translate the branch attachment point.
  Current and previous camera positions resolve separate card frames for valid TRAA
  velocity rather than treating billboarding as untracked motion.

  The engine capture harness passed oak views at 5 m from 0/120/240 degrees, a 20 m
  view, normal debug, and a continuous 24-frame 90-degree camera sweep with no
  collapsed-card strips or console/WebGPU errors. Focused maple and Douglas-fir
  oblique captures also retain full card width and rooted volume. The complete suite
  is 283/283; production build, no-fallback browser verification, and diff hygiene
  pass. The rejected candidate directory was moved to
  `/tmp/claude-golfsim-rejected-img2threejs-reference-tree-20260821` for recoverable
  disposal rather than silently retained in the repository.
- **2026-08-21 — Shared foliage lighting and temporal-boundary cycle 20:** User
  review of the mature valley oak identified two separate renderer defects: the
  leaves cast a strong ground shadow while reading self-lit, and a post-drag frame
  showed horizontal ghosting through the clouds, canopy, branches, and trunk.
  Beauty foliage now uses a diffuse-only lit node material with the same real
  DirectionalLight and PMREM environment as production trees. Its camera-facing
  deformed normal feeds that lighting model, the engine PMREM irradiance is bridged
  into indirect diffuse, and the aligned thickness mask retains only a bounded
  backlight lift. Diagnostic alpha/material/normal/LOD/hull modes remain exact unlit
  views. A specular Phong trial was rejected after measuring no visual justification
  for its alpha-overdraw cost; matte Lambert keeps the intended response.

  The apparent trunk failure was not bark topology or its normal map. Structure-only
  captures exposed stale canopy silhouettes in the independent quarter-resolution
  cloud reprojection history. `SceneManager.invalidateTemporalHistory()` previously
  reset only full-resolution TRAA; it now also resets `CloudTemporalNode`. Free-camera
  mouse-look invokes that shared invalidation exactly once on drag release in both the
  viewer and production entry points. Engine evaluator evidence records
  `viewer free-camera drag settled` at release, followed by a clean settled capture;
  structure-only reset captures show clean bark and clouds without retained foliage.

  Final hardware-WebGPU oak captures cover front light, back/dark inspection, moving
  sun after 240 settled frames, and deformed-normal debug with zero console, resource,
  or WebGPU errors. Directional leaf response and sky-shadow fill are visibly distinct
  while the candidate remains two draws (894 selected close cards, 14,044 structural
  triangles, 11,483 foliage triangles across all LODs). The complete suite passes
  285/285; production build, no-fallback browser verification, and diff hygiene pass.

  AC strict timing is now eligible, but the authoritative tree-edge gate fails at a
  system-wide 56 ms completion cadence: generated Lambert measures 56.66 ms and the
  unchanged catalog-tree production baseline measures 56.48 ms in the same canonical
  1280x720/16.7 ms contract. The generated-lighting delta is therefore within run
  noise, not the cause of the regression, but the absolute production performance
  gate remains red. Long soak/native certification and promotion are not valid while
  that shared baseline fails, and root visual approval is still required; the goal
  remains active.
- **2026-08-21 — Dense range, bark continuity, and 30 FPS certification cycle 21:**
  The generated range now uses exactly 136 deterministic valley-oak, sugar-maple,
  and Monterey-cypress trees in 18 irregular side-perimeter groves while preserving
  the center corridor. Five independently seeded identities per species vary trunk,
  leader, scaffold, crown, gap, age, scale, and yaw instead of cloning one silhouette.
  The mature broadleaf main trunk is one continuous smooth-ring mesh rather than a
  stack of capped cylinders. Storage-authored placement yaw now rotates structure
  normals in the same frame as positions; the invalid yaw-blind tangent-space bark
  normal was removed, and measured scan albedo is normalized into one matte 0.94-
  roughness shared-environment response. This removes the alternating black/polished
  trunk artifact while retaining real direct light, PMREM fill, canopy shadows, and
  aerial perspective. Both viewer and production beauty foliage/structure receive
  the shared shadow field; no pre-lit foliage multiplier remains.

  The visually rejected sparse/patch grass experiments are fully absent. Production
  again uses the original 192x192 GPU candidate field and dense crossed three-segment
  ribbons, now with a 0.64--0.88 occupancy range and 0.88 colony floor. Overlapping
  tree crowns use strongest-mask ownership rather than repeatedly erasing the same
  roots. The fixed tree-edge view retains 133,078 visible blades, low rough 159,257,
  and pond 133,104, all with zero overflow. Direct engine review of address, low rough,
  reverse-light, pond, and close tree-edge captures shows solid rough coverage and
  consistent matte trunks without the former yaw-dependent polished/dark bands.

  Two consecutive AC/no-warning desktop suites pass all seven cameras at
  11.27--16.91 ms GPU p95; generated tree-edge stress passes at 16.30/17.30 ms. Two
  complete 2408x1506 native sets pass at 26.17--30.78 ms and 26.72--30.58 ms. The
  goal-eligible 1,800-second robustness run renders 103,569 frames, passes all three
  moving-route GPU captures at 10.11--13.91 ms p95, completes 20 rebuilds, retains
  0/20 superseded Range objects, and holds unique GPU allocation exactly flat at
  366,208,673 bytes. Shared interleaved buffers are counted once by backing identity;
  raw Three accounting is retained and also stays exactly flat at 459,420,689 bytes.
  Complete tests, production build, no-fallback browser, temporal, visual, resource,
  and diff-hygiene gates pass. Performance certification is complete; candidate pack
  promotion and root visual approval remain open, so the broader foliage goal stays
  active.
- **2026-08-21 — Extended rough footprint and compute-compacted midfield cycle 22:**
  The projected rough footprint now reaches 96.75 m forward and 64.5 m laterally at
  high tier instead of terminating at 31.82/16.32 m. Far-only tiles evaluate one
  stable lane from every 2x2 world-cell block in workgroup-coherent quarter-rate
  batches, with their acceptance ceiling and current/previous LOD probabilities
  compensated together. Near and overlap tiles retain the full 192x192 candidate
  lattice. The accepted midfield peak rises from the visibly bare 9% population to
  22% while preserving the complete horizon. Terrain under long rough consumes the
  exact shared blade pigment transform and matching mean value, so inter-blade pixels
  no longer expose a different grey-green material.

  Grass frustum metadata now bakes each tile's authoritative heightfield extrema and
  expands the upper bound through the tallest blade canopy; GPU culling no longer
  assumes every root is at world y=0. Engine captures explicitly select the generated
  valley-oak, sugar-maple, and Monterey-cypress path. At 1280x720 the filled low-rough
  view passes at 21.00 ms GPU p95 with 203,932 visible blades and the generated
  tree-edge passes at 23.84 ms with 223,447. The 2408x1506 generated tree-edge
  diagnostic passes the 33.3 ms budget at 33.20 ms; grass compaction is 3.95 ms p95,
  overflow is zero, and visual/temporal gates pass. The host is on battery, so this
  last report is intentionally non-goal-eligible until the identical strict command
  is repeated on AC. The broader foliage goal remains active pending root visual
  approval and candidate promotion.
- **2026-08-21 — Close flight camera and persistent broadcast tracer cycle 23:** The
  flight director now targets an 8.8--11 m trajectory-relative chase offset instead
  of the former 42 m cap, uses a faster bounded spring, and carries a modest lateral
  broadcast offset that reveals shot shape rather than looking directly down the
  tangent. Ascent remains above the ball without pitching upward; descent biases the
  landing solution 85% back toward the ball so the physical ball stays the subject.

  The tracer remains one GPU-storage, compute-appended, indirect ribbon. Its curve
  increases from six to eight bounded subdivisions and uses a finite fallback width
  basis for near-end-on views. A 10.5 px soft red-amber envelope, orange-gold body,
  and 2.8 px warm centerline replace the pale opaque strip without additive-white
  blowout. Endpoint tapering is clean in both geometry and opacity. Automatic fade
  is removed, and application source contains exactly one tracer reset: immediately
  before the next real `ball.launch(params)` call. Rest, result orbit, smooth address
  return, manual address framing, and idle time preserve the completed shot.

  Engine flight capture spans chase/descent/result with the generated oak, maple,
  and Monterey perimeter active, stable viewport ownership, no console errors, and
  the ball held in close framing. A separate result/return/address sequence reaches
  address with the tracer still visibly present in the final frame. The production
  build, no-fallback browser, diff hygiene, and complete 294/294 regression suite pass.
  Root visual review subsequently rejected this amber/ivory treatment as an oversized
  glowing laser; its styling evidence is superseded, while the camera and persistence
  contracts remain accepted implementation constraints.
- **2026-08-21 — Foresight-reference tracer cycle 24:** Official FSX Play imagery was
  used as the visual reference. It shows one solid cobalt-blue trajectory with no
  bloom envelope or pale center, a restrained antialiased silhouette, a deeper tail,
  and gradual thinning toward the ball. The rejected 10.5 px halo, ivory core, and
  amber/gold palette are removed. The same one-draw GPU ribbon is now 6.4 px at full
  profile, deep-to-vivid cobalt, edge-feathered only at its outer pixel, and narrowed
  from 62% of trajectory length through a clean endpoint collapse.

  Two hardware-WebGPU engine flight captures cover chase, descent, landing, and result
  with the generated oak/maple/Monterey range active. The line remains crisp against
  both turf and sky, holds the ball endpoint, and no longer blooms into an opaque white
  or orange pole. A result/return capture confirms that the completed blue path remains
  present after landing; the sole reset remains immediately before the next actual
  launch. The complete 294/294 suite, production build, no-fallback hardware-browser
  verification, and diff hygiene pass. Root visual approval of this replacement remains
  required before the broader foliage goal can close.
- **2026-08-21 — Augusta Southern parkland candidate cycle 25:** The existing
  generated foliage workflow is now extended with two candidate-only species driven
  by immutable ImageGen source sheets and the versioned `foliage-pipeline-v3`: Southern
  live oak (`local.southern-live-oak.augusta.v1`) and loblolly pine
  (`local.loblolly-pine.southeast.v1`). Both sheets pass strict eight-component
  extraction, aligned masks, coverage-preserving PNG mips, UASTC KTX2 encoding, and
  self-contained CC0 bark provenance. The live oak uses the forked broadleaf skeleton;
  loblolly has a dedicated open layered Southern-pine scaffold instead of inheriting
  the narrow Douglas-fir silhouette.

  A query-gated `?foliageCandidate=augusta` preview registers both local packs without
  changing production approval state. Its deterministic 136-slot perimeter pulls the
  front/mid groves toward the maintained rough edge while keeping the central hitting
  corridor outside `|x| <= 22`. The browser confirms the two exact local aliases, 67
  live-oak records, 69 loblolly records, five seeded identities per species, complete
  GPU classification, and zero console/request errors. Isolated oak and loblolly
  viewer matrices cover 5/20/50 m beauty, alpha, and LOD views; range address, landing,
  and tree-edge WebGPU smoke captures pass visual luminance/temporal gates. The host
  is on battery and offscreen presentation cadence is 66--67 ms, so these captures are
  visual/temporal evidence only—not AC/native performance certification or promotion
  approval. Full regression/build verification remains required before this cycle can
  be considered for root visual acceptance.
- **2026-08-22 — Premium Range geometry cycle 26:** Added a separate query-gated
  `premium-range.json` test course instead of replacing the checkpoint course. The
  long Southern parkland range now spans 300 m laterally and 514 m downrange, uses
  nine target greens from 40 to 450 yards, eleven bunker targets, a V-shaped
  maintained corridor, and a 136-slot perimeter that reaches past 430 m. Premium
  candidate age scales raise the tree frame to mature 30 m+ specimens while the
  front groves move into the rough band for a golfer-height Augusta-style tee
  frame. Use `?course=premium-range&foliageCandidate=augusta` to test it.

  The benchmark harness now preserves URL query routes and accepts target-prop
  counts from the authored target set. Real Premium Range address, tree-edge,
  landing, and overview WebGPU captures pass with both local packs, no console or
  request errors, complete generated-foliage classification, and stable visual /
  temporal gates. Battery/offscreen timing remains smoke evidence only; no AC
  performance certification or foliage promotion is implied.
