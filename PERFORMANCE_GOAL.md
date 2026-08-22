# Active Goal: Restore Production WebGPU Performance

Status: **complete**

## Objective

Diagnose and eliminate the shared renderer regression currently reporting roughly
56 ms GPU completion cadence in both generated-foliage and unchanged production
tree-edge views. Preserve visual quality, tree visibility, hardware WebGPU, and the
strict production workload; hiding work or relaxing acceptance budgets is forbidden.

## Blocking acceptance

1. Canonical 1280x720 full desktop suite passes its 33.3 ms GPU-completion p95 budget.
2. Canonical generated-foliage tree-edge view passes its 33.3 ms budget.
3. Address, low-rough, pond-contact, and tree-edge 2408x1506 native views pass 33.3 ms.
4. Two consecutive complete canonical cycles pass on AC power without thermal warning.
5. The 1800-second, 54000-frame, 20-rebuild generated-foliage robustness gate passes.
6. No console, WebGPU validation, missing-resource, temporal, visual, or leak failure.
7. `npm test`, `npm run build`, no-fallback verification, and `git diff --check` pass.

## Iteration rules

- Compare every suspected optimization against the same fixed camera and production
  baseline.
- Use timestamp intervals and renderer diagnostics to identify real work before editing.
- Do not disable clouds, shadows, grass, trees, post-processing, or strict workload.
- Record failed attempts and authoritative report paths.

## Evidence

- **2026-08-21 — Interim 30 FPS acceptance:** At user direction, canonical desktop,
  replacement-tree stress, and native-panel acceptance now share a 30 FPS / 33.3 ms
  GPU-completion p95 budget. Presentation telemetry uses a 34.0 ms rAF p95 allowance
  and treats frames over 50 ms as hitches. Visual, temporal, workload, feature,
  repeatability, and robustness requirements are unchanged.
- **2026-08-21 — Heavier reviewed range workload:** Generated range acceptance now
  renders 136 deterministic oak/maple/Monterey placements (100 more than the prior
  36-tree draft) across irregular side-perimeter groves. Generated bark and foliage
  use the shared PMREM, aerial perspective, direct shadow reception, and real scene
  lights; the old pre-lit foliage backlight multiplier is removed. All subsequent
  timing must include this heavier visually reviewed workload.

- **2026-08-21 — Baseline:** On AC at 100% with no thermal/performance warning,
  canonical 1280x720 tree-edge reports measured 56.66 ms for generated Lambert
  foliage and 56.48 ms for unchanged catalog trees. Their 0.18 ms difference is run
  noise; both failed the former 16.7 ms gate, establishing a shared renderer, host, or metric
  regression rather than a generated-foliage lighting regression. Reports:
  `benchmarks/generated-cycle20-tree-edge-lambert-1/report.json` and
  `benchmarks/production-cycle20-tree-edge-baseline/report.json`.
- **2026-08-21 — On-screen compositor hypothesis rejected:** A controlled trial
  moved the otherwise identical strict Chrome surface from `-4000,-4000` to `0,0`.
  Production tree-edge worsened from 56.48 to 59.17 ms, with Scene MRT at 53.35 ms
  and every full-screen pass inflated. The trial was fully reverted; report:
  `benchmarks/performance-onscreen-production-tree-edge-1/report.json`.
- **2026-08-21 — Replacement-tree fixture correction:** User review caught that the
  visible control run used legacy catalog Douglas fir, while the generated range mix
  still exercised the earlier Douglas/Italian/Monterey set. The strict
  `foliageCandidate=generated` fixture now explicitly uses mature valley oak, sugar
  maple, and Monterey cypress around the authored perimeter. Diagnostics must report
  those three aliases before any timing can count as replacement-tree evidence.
- **2026-08-21 — Structural diversity correction:** The first replacement perimeter
  review exposed obvious cloned crowns because production requested only two seeded
  skeletons per species. The forest already supports a bounded five-identity maximum;
  production now uses all five, giving independently seeded trunk lean, leader forks,
  scaffold topology, crown envelope, and card layout before per-instance age, scale,
  and yaw variation. Performance acceptance must include this reviewed diversity.
- **2026-08-21 — Broadleaf archetype correction:** Five seeds alone still inherited
  one recognizable three-leader/16-scaffold template. Each broadleaf seed now varies
  trunk lean, leader azimuth/reach/rise, 13–19 mature-oak or 12–17 maple scaffolds,
  attachment positions, 7–10/6–9 shoot density, and seeded foliage gaps. These are
  true topology/silhouette identities, not cloned geometry hidden by yaw and scale.
- **2026-08-21 — Grass bottleneck isolated:** At the reviewed diverse-tree edge,
  a 12-frame engine GPU capture measured 23.40 ms full versus 10.97 ms with only the
  grass mesh hidden. The fixed 96x96-per-tile field produced 326,354 visible patches,
  each with two substantially redundant camera-biased ribbons. Trial: retain every
  stable patch and all shading/wind/coverage rules, but submit one three-segment rooted
  ribbon whose middle-distance representation remains an analytic multi-blade tuft.
- **2026-08-21 — Single-ribbon canonical result:** The exact diverse-tree 300-frame
  gate improved from 25.29 to 18.23 ms; Scene MRT fell from 23.28 to 16.07 ms while
  visual and temporal gates passed. Final trial reduces 13–22 cm grass ribbons from
  three longitudinal segments to a base/mid/tip curve, retaining the quadratic taper,
  bend, wind, material, coverage, and stable patch population.
- **2026-08-21 — Single-ribbon grass trial rejected by visual review:** Although the
  diagnostic reduced GPU time, user review found the resulting image substantially
  worse. The accepted two-ribbon density is fully restored. None of its performance
  measurements count toward acceptance; future work may not thin visible coverage.
- **2026-08-21 — Two-segment blade trial rejected:** The controlled 12-frame result
  regressed from 17.19 to 17.58 ms despite fewer vertices, confirming this view is
  fragment/coverage bound rather than vertex bound. The accepted three-segment curve
  was restored; no silhouette quality was traded for noise-level timing.
- **2026-08-21 — Matte grass lighting trial:** The remaining tree-edge cost is
  fragment-bound. Grass now trials shared-environment Lambert instead of evaluating
  a Phong specular lobe whose final authored contribution was only 4% of a 0.045
  control. Direct sun, shadows, PMREM, deformed normals, pigment, wind, and coverage
  remain unchanged.
- **2026-08-21 — Matte grass trial rejected:** Lambert did not improve completion p95
  (17.66 ms) and crushed the middle/bottom thirds to 10.3%/23% near-black pixels.
  Shared-environment Phong was restored; the small lobe is not the bottleneck and its
  indirect response is visually necessary.
- **2026-08-21 — Robustness budget synchronized:** The canonical 1800-second,
  54000-frame, 20-rebuild soak now uses the same 33.3 ms GPU p95 requirement as the
  user-approved interim 30 FPS contract. Goal eligibility requires that exact budget;
  a caller cannot loosen it while retaining a strict-looking report.
- **2026-08-21 — Trunk and grass visual root causes:** Per-instance yaw rotated the
  generated trunk positions but left their lighting normals in the unrotated source
  frame; the scanned tangent-space bark normal therefore made identical trees alternate
  between crushed black and polished highlights. Main trunks are now continuous smooth
  ring meshes, structure normals follow storage-authored yaw, and bark uses one matte
  0.94 roughness response with measured source-albedo normalization. The rejected sparse
  grass experiment is gone: the original 192x192 crossed-ribbon renderer is restored
  with a 0.64--0.88 occupancy range, and overlapping crowns use strongest-mask ownership
  so the added perimeter trees do not repeatedly erase the same understory.
- **2026-08-21 — First full robustness result, accounting blocker:** The qualifying
  1800-second run rendered 103,509 frames on AC, kept all GPU checkpoints at
  9.64--11.47 ms p95, completed 20 rebuilds, retained 0/20 superseded Range objects,
  and held an identical 459,420,689-byte raw Three memory total from post-prewarm to
  final. Its sole failure was the 384 MiB cap because Three's `memoryMap` charges each
  semantic `InterleavedBufferAttribute` view the complete shared backing-buffer size.
  Robustness accounting now deduplicates those views by `resource.data` identity and
  retains the raw totals separately; no cap was raised and no renderer workload changed.
- **2026-08-21 — Final 30 FPS certification:** Two consecutive AC/no-warning desktop
  suites pass all seven cameras at 11.27--16.91 ms GPU p95. Their separate generated
  tree-edge stress runs pass at 16.30 and 17.30 ms. Two complete 2408x1506 native sets
  pass: cycle 1 is 26.17/26.96/27.44/30.78 ms and cycle 2 is
  26.77/27.72/26.72/30.58 ms for address/rough/pond/tree. Every report passes visual,
  frozen temporal, grass overflow, WebGPU, console, resource, and workload validation.

  The corrected goal-eligible robustness run at
  `benchmarks/performance-30fps-robustness-final-2/report.json` passes 1,800 seconds,
  103,569 rendered frames, and 20 rebuilds. Moving-route GPU p95 is 10.11, 13.91, and
  10.26 ms at the 300/900/1740-second checkpoints. Unique tracked GPU allocation is
  exactly 366,208,673 bytes at both post-prewarm and final (raw Three total is also
  unchanged at 459,420,689); 0/20 superseded Range objects survive forced GC. The
  no-fallback browser, complete test suite, production build, and diff hygiene pass.
- **2026-08-21 — Post-certification extended-rough diagnostic:** Far-only rough work
  now uses a workgroup-coherent quarter-rate 2x2 lattice with compensated acceptance,
  while near/overlap grass remains full-rate. The forward/lateral footprint is
  96.75/64.5 m and its midfield population is 22%, eliminating the bare band after
  the 19 m base curve. A 2408x1506 generated-tree edge diagnostic passes at 33.20 ms
  GPU p95 with 221,143 blades; grass compaction is 3.95 ms p95. This run was on
  battery and is retained as non-eligible diagnostic evidence, not a replacement for
  the existing AC certification.
