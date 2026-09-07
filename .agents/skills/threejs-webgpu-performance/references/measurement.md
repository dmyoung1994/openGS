# Deterministic graphics measurement

## Baseline contract

Freeze the things that can counterfeit a gain:

- exact route and scene identity;
- strict target renderer/backend and adapter status;
- viewport, device pixel ratio, internal render dimensions, and render scale;
- quality/workload mode and presentation locks;
- camera position, look target, FOV, and terrain-relative elevation;
- authored source records, assets, hashes, LOD thresholds, and visible counts;
- animation, wind, simulation, shadow state, post graph, and exposure;
- power/thermal state when available.

Capture sentinels before and after each sample. Reject a sample when a sentinel changes unexpectedly.

## Measure production frames

Do not pause the render loop and manually invoke a different frame path unless the task is explicitly to profile that path. A clean WebGPU capture is:

1. Activate the target scene and acquire the desired production quality lock.
2. Pose the engine-owned evaluator camera.
3. Let resource creation, shadow updates, and temporal history settle.
4. Fence earlier GPU work with `device.queue.onSubmittedWorkDone()`.
5. Arm timestamp capture.
6. Wait for real `requestAnimationFrame` frames through the engine.
7. Fence completion and collect results.

Use browser/CDP process metrics over the same frame interval for CPU task/script duration. Also collect rAF cadence because GPU completion and user-visible frame delivery answer different questions.

## Timestamp interpretation

- GPU timestamp spans can overlap or nest. Never sum per-pass means unless the render graph proves they are disjoint.
- Use whole-frame GPU completion as the frame budget and pass timings for attribution.
- Separate one-time shadow, PMREM, upload, pipeline compile, and history-reset frames from steady-state samples; report both when transitions matter.
- Prefer median for typical behavior and p95/p99 for stability. Keep max values but do not optimize a single unexplained outlier first.
- Run enough frames to cover dynamic behavior. Repeat the baseline to estimate noise before judging a small change.

## Bottleneck perturbation matrix

Change one factor, use a large reversible delta, and restore it afterward.

| Perturbation | Strong improvement suggests |
| --- | --- |
| Internal pixel count down | fragment shading, overdraw, attachments, post, bandwidth |
| Hide one object class | that class's raster/material/update workload |
| Keep object count, cut topology | vertex/primitive/micro-triangle pressure |
| Keep topology, simplify material | fragment/texture/branching cost |
| Keep material, reduce alpha-covered layers | overdraw and lost early-Z efficiency |
| Reduce texture dimensions/mips/aniso | texture bandwidth/cache pressure |
| Disable one render pass | attachment bandwidth or pass cost |
| Freeze transforms/animation | CPU traversal, uploads, skinning/wind, bounds |
| Collapse draws without changing pixels | CPU submission/bind/pipeline overhead |
| Remove readbacks/fences | CPU-GPU synchronization stalls |

The perturbation is diagnostic, not automatically a shippable solution.

## Camera suite

Use at least:

- a close low camera that exposes material, alpha, and LOD fidelity;
- a middle-distance camera around LOD handoffs;
- a far/high camera with maximum visible coverage;
- a known worst-case address/gameplay camera;
- continuous forward and reverse motion through each handoff.

For golf routing, derive poses from the current routing geometry rather than stale hardcoded coordinates when possible. Terrain-relative Y prevents underground or aerial false samples.

## QA gates

- Page identity and target scene are explicit.
- Canvas is nonblank and target content is visible.
- Renderer is strict WebGPU with no WebGL/fallback adapter.
- No unexpected console, page, HTTP, or request failures.
- Camera ownership is the engine's evaluator path.
- Source records and authored asset residency match baseline.
- Final screenshot and motion sweep show no missing structure, popping, blur, shimmer, or ghosting.

In claude-golfsim, use the repository's Puppeteer/Chrome production harness contract. Never silently switch to headless software rendering or DOM-only validation.
Use `node scripts/benchmark-course-pose-sweep.mjs --quick --motion` for the
Pineglass route matrix. For an isolated production capture, use a complete
command such as `node scripts/shot.mjs --game --route=/creator.html
--authored-course --hole=pineglass-hole-1 --presentation-mode=balanced
--presentation-scale=1 --gpu-live --gpu=24 --frame-timing=150
--cam=-300,0,308 --terrain-lift=2.1 --look=-291,0,59
--look-terrain-lift=1 --fov=48 --out=/tmp/pineglass-shot.png
--qa-report=/tmp/pineglass-shot.json`. Prefer
`--terrain-lift`/`--look-terrain-lift` so routing elevation changes cannot place
the evaluator camera underground.

## Benchmark output schema

Store machine-readable results with:

- commit/worktree label and timestamp;
- browser/GPU/backend identity;
- route, scene, mode, scale, dimensions;
- named camera pose;
- warmup/sample counts;
- rAF mean/median/p95/max;
- CPU TaskDuration and ScriptDuration per frame;
- whole-frame GPU mean/median/p95/max;
- per-pass mean/p95/max without invalid summation;
- renderer draw/triangle/texture/geometry diagnostics;
- source/visible/LOD counts;
- screenshot path and health errors.

## Primary sources

- Three.js renderer information: https://threejs.org/docs/pages/Info.html
- Three.js responsive rendering and high-DPI cost: https://threejs.org/manual/en/responsive.html
- GPUWeb specification: https://gpuweb.github.io/gpuweb/
- WebGPU explainer: https://gpuweb.github.io/gpuweb/explainer/
- NVIDIA pipeline bottleneck method: https://developer.nvidia.com/gpugems/gpugems/part-v-performance-and-practicalities/chapter-28-graphics-pipeline-performance
