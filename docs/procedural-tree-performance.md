# Dense procedural forest performance — September 6, 2026

Measured on the MacBook Neo, Apple A18 Pro (6 CPU cores, 8 GB), using installed
headful Chrome, strict WebGPU, `/play.html?course=current&start=1`, 1920×1080
rendering and presentation scale 1. The current Pineglass course contains **333**
procedural trees. Measurements include the existing uncommitted course/root/rendering
work; those changes were preserved. The earlier 111-tree results are not its performance baseline.

## Retained changes

- Keep near geometry intact. Simplify intermediate branch rings in reduced tiers
  using centreline distance plus taper error, retaining every stem's endpoints and
  original bark arc length. Root geometry bypasses this simplification. Middle/far
  tolerances are tree height / 1200 and / 360 (about 25/83 mm for a 30 m tree).
- Use the existing coverage-compensated foliage reduction with strides 1/4/12.
  This changes distant needle granularity; it retains explicit 3D foliage, tree
  placements, crown spread, materials and animation. No asset substitution occurs.
- Battery/balanced use detail-threshold multipliers 2.5/1.75. Quality keeps multiplier
  1; Ultra retains full near geometry. All distance decisions use the active camera.
- Enclose the actual geometry from every tier in visibility bounds, since enlarged
  reduced-tier sprays can extend outside the source skeleton. Shadow compaction
  still uses its own shadow camera and retains off-screen contributing casters.
- Six-core high-capability devices start Auto in balanced. Adapter capacity alone
  overestimated first-shot throughput. Measured headroom can still promote them to
  quality; manual higher modes remain available.

## Measurements

The same fixed battery tee pose before/after:

| Metric | Before | After |
| --- | ---: | ---: |
| Frame rate | about 23–25 fps | 32.5–33.3 fps |
| GPU completion cadence | 41–44 ms | 29.8–30.6 ms |
| Submitted beauty tree triangles | 4,539,654 | 1,546,886 |
| Submitted shadow tree triangles | 4,331,940 | 1,440,640 |
| Source trees | 333 | 333 |

GPU completion cadence is the throughput measure. Native pass intervals overlap;
their durations must not be added together. Shadow triangle diagnostics describe
the current independently compacted caster list, not a sum across all cascades.

Final production three-shot replay: drive **36.6 fps**, approach **39.0 fps**, putt
**33.4 fps**, each at **34.3 ms p95**. The low-speed putt completed the hole; cup
audio and next-hole reset passed, with no invalid rendering frames or
console/network errors. First callback latency stayed below 34 ms. The strict
34 ms p95 gate **failed by 0.3 ms**, so this is a throughput improvement rather
than a complete frame-pacing sign-off. An earlier configuration passed that gate
(`/tmp/play-hole-VwfEqT/report.json`); it does not supersede the final result.
Starting Auto in quality previously missed first-shot frame pacing before demotion.

Temporary evidence:

- Baseline: `/tmp/dense-forest-baseline.json` and `.png`.
- Final fixed-mode tee: `/tmp/tree-headroom-after.json` and `.png`.
- Full replay: `/tmp/play-hole-OGVgDn/report.json`, shot screenshots and cup close-up.
- Focused checks: `/tmp/tree-fps-final-tests.log` (43 passing tests).
- Endurance attempt: `/tmp/play-endurance-t2ItRq/report.json` and `interrupted.png`.
  Nine 30-second windows (4.5 minutes) retained all 333 trees, native resolution,
  live animation and zero invalid frames/errors. Windows ranged **29.96–34.46 fps**
  with **33.9–34.4 ms p95**. The run was stopped after the strict 30 fps / 34 ms
  gate had failed; this is not a ten-minute pass or a sustained-performance sign-off.
- Full suite: 610/624 passing. The same 14 failures reproduced with the FPS changes
  removed (`/tmp/tree-all-tests.log`, `/tmp/tree-baseline-failures.log`).

Whole-tree box culling, separate crown culling, front-to-back instance sorting and
precomputed normal transforms did not show repeatable gains and were removed.
Conditional turf-edge normal reconstruction did not show repeatable improvement.
Lambert foliage saved GPU time but visibly darkened the forest, so it was rejected.
Diagnostic hidden-part, unlit and reduced-resolution probes were not retained.

The fuller builder preset is separately committed as `a4307b9`. The saved course's
definition was not replaced during this performance pass. Physics and measured
launch-packet handling are unchanged.
