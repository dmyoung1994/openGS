# Pineglass Forest strict WebGPU QA

> Performance note: the figures in this document are historical composition QA
> from an earlier scene/camera contract. The current immutable production-frame
> comparison and unresolved 33.3 ms budget failure are authoritative in
> `docs/tree-performance-lods.md`.

## Historical layered-forest revision — 2026-08-29

The final canonical headful `play.html` run uses 593 environment objects:
88 mature Fir Tree 01 records, 8 mature Pine Tree 01 accents, 199 Fir Sapling
Medium records (191 distributed plus eight deliberate tee-frame placements),
210 native-scale Pine Sapling Small regeneration records, 70 ferns, and 18
rock/deadwood accents. Forest-floor
material now follows the resolved crown-disc union with only short same-habitat
connectors; assembly rectangles no longer appear as brown terrain bands.

In that earlier revision, all ten static views plus a 30-frame live evaluator-camera move completed in
one strict WebGPU browser session. The 30-frame native GPU capture reported
28.70 ms tracked GPU per frame, 30.11 ms completion p95, and 32.50 ms live frame
EWMA in balanced mode. Every one of the 505 tree records remained classified;
there were no distance/policy/budget drops and no console, page, HTTP, request,
or renderer errors. The motion pass advanced 30 rendered frames through
`evaluatorCamera.movePose()` with zero evaluator-camera temporal cuts. Current
evidence is `/tmp/pineglass-qa-report.json` and the `/tmp/pineglass-*.png`
capture matrix.

The accepted near/middle handoff pair is
`/tmp/pineglass-fir-crown-lod0-near.png` and
`/tmp/pineglass-fir-crown-handoff-mid.png`. The near view classified four fir
saplings, three pine saplings, and three mature firs in LOD0. The middle view
retained the distinct authored LOD1 for all 22 visible fir saplings, one mature
pine, 16 pine saplings, and nine mature firs. Both Fir Tree 01 tiers now retain
an identical complete structural payload and exact grounding; the middle foliage
set is a deterministic subset of the near set. The continuous camera pass
reported no temporal invalidation and held the reset count stable at five.

The middle foliage shader retains the source RGB, normal/AO maps, and alpha map,
but accepts the authored needle fringe at a hard 0.06 cutoff instead of the
near-tier 0.10 cutoff. It remains opaque, depth-writing, and non-dithered; this
adds no blur, transparency blend, billboard, or replacement geometry.

Captured 2026-08-28 with `scripts/shot.mjs`, a dedicated headful Google Chrome
profile, the production `/index.html?view=practice` route, real WebGPU, and the
versioned evaluator camera. Screenshots and raw reports remain temporary in
`/tmp`; they are not runtime assets.

Every accepted capture proved `window.golfBootstrap.ready`, evaluator camera
API 1.0, a non-blank 1280 × 720 canvas, a real WebGPU renderer/backend with no
WebGL or fallback adapter, and no console, page, request, or HTTP errors.

## Historical target-view matrix

The camera arguments below use the harness's required separate `--cam` and
`--look` tokens. Earlier `--cam=...` experiments were discarded because that
syntax leaves the default camera active.

| View | Camera evidence | Tracked GPU | Completion p95 | rAF p95 | Capture |
| --- | --- | ---: | ---: | ---: | --- |
| Hole 1 par-4 tee | `(-300,5,313)` → `(-290,1.2,95)` | 20.67 ms | 18.56 ms | 34.2 ms | `/tmp/pineglass-h1-tee-correct.png` |
| Hole 2 par-3 tee | `(-227,5,-120)` → `(-55,1.2,-126)` | 16.58 ms | 15.03 ms | 33.8 ms | `/tmp/pineglass-h2-tee-correct.png` |
| Hole 3 par-5 tee | `(-88,5,-63)` → `(-168,1.2,165)` | 20.25 ms | 19.44 ms | 33.8 ms | `/tmp/pineglass-h3-tee-correct.png` |
| Hole 3 approach | `(-205,6,335)` → `(-221,0,419)` | 14.11 ms | 14.84 ms | 34.1 ms | `/tmp/pineglass-h3-approach.png` |

These superseded captures remained below the 33.3 ms GPU budget under their
older contract; they are not current performance acceptance. The headful
off-screen Chrome rAF cadence sits near 30 Hz (33.3–34.4 ms) even when measured
GPU work is 14–21 ms; this is reported rather than hidden.

Additional strict captures cover both Hole 1 landing directions, its approach,
both Hole 3 landing directions, a low-oblique Hole 1 green view, and the complete
site overview:

- `/tmp/pineglass-h1-landing-left.png`
- `/tmp/pineglass-h1-landing-right.png`
- `/tmp/pineglass-h1-approach.png`
- `/tmp/pineglass-h3-landing-left.png`
- `/tmp/pineglass-h3-landing-right.png`
- `/tmp/pineglass-h1-green-oblique.png`
- `/tmp/pineglass-overview-whole.png`

The moving-shot capture wrote 32 real production frames across chase, descent,
and result phases under `/tmp/pineglass-moving-flight-seq/`. It retained one
viewport signature, one cached shadow focus/map version, temporal jitter during
camera motion, and no moving-ball course-shadow caster.

## Asset and runtime findings

- Pine Sapling Small is acquired from Poly Haven's official files API with every
  source dependency MD5-verified. Runtime LOD0 is exact variant A; LOD1 retains
  whole connected source components and all source PBR/alpha maps.
- Island Tree 01 uses the reviewed three-material derivative with source PBR maps
  and embedded source alpha. It is 23,273 triangles and remains modeled geometry;
  there is no billboard, impostor, procedural tree, or generic-prop fallback.
- The production TSL tree path now consumes a catalog `alphaMap` when the source
  keeps coverage separate from JPEG RGB.
- The earlier 360-object revision below is retained as historical evidence; it
  was superseded by the final layered-forest revision above.
