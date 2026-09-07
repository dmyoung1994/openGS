---
name: threejs-webgpu-performance
description: Profile and optimize Three.js WebGPU scenes, shaders, render graphs, assets, and real-time graphics workloads while preserving visual intent. Use for low FPS, frame-time spikes, GPU or CPU bottlenecks, foliage overdraw, shader cost, draw-call pressure, memory bandwidth, LOD tuning, post-processing, resolution policy, or repeatable graphics benchmarks.
---

# Three.js WebGPU performance

Treat performance as a measured rendering problem. Preserve the application's real renderer, scene, camera, assets, quality mode, and animation path. A fast substitute is not an optimization of the target.

Repository instructions and authored-asset contracts take precedence. For claude-golfsim, read the repository `AGENTS.md` and the applicable golf environment/course skill before changing visual assets or running QA.

## Route by task

- Read [measurement.md](references/measurement.md) before profiling, benchmarking, or claiming a gain.
- Read [gpu-fundamentals.md](references/gpu-fundamentals.md) when the bottleneck is in shader execution, rasterization, bandwidth, compute, synchronization, or GPU architecture.
- Read [threejs-webgpu.md](references/threejs-webgpu.md) when changing Three.js scene structure, WebGPURenderer, TSL/node materials, instancing, LOD, renderer diagnostics, or post-processing.

## Workflow

1. State the visual and interaction invariants. Include page/scene identity, renderer backend, authored assets, camera path, animation, resolution, quality mode, and acceptable image changes.
2. Establish an immutable baseline with production frames. Record median and p95 CPU frame time, GPU completion time, per-pass timing, resolution, source/visible counts, draw/triangle counts when trustworthy, renderer health, and screenshots.
3. Classify the bottleneck by controlled perturbation. Change one dimension at a time: resolution, object class, topology, shader feature, texture bandwidth, pass count, or update frequency. Revert diagnostic mutations.
4. Fix the largest proven term first. Prefer eliminating work over making unnecessary work slightly cheaper.
5. Verify steady state and transitions. Test representative close, middle, far, worst-case, and moving cameras. Include cold/warm behavior, LOD handoffs, mode changes, and camera motion.
6. Compare against the same baseline contract. Reject gains caused by lower render scale, hidden content, missing records, wrong scene, fallback renderer, or blurred/incorrect imagery.
7. Keep only improvements with reproducible evidence. Document rejected experiments too; they prevent future agents from retrying attractive but irrelevant ideas.

## Decision rules

- If resolution reduction strongly helps, investigate fragment shading, overdraw, attachments, post-processing, or bandwidth.
- If hiding a class strongly helps but its compute setup does not, investigate that class's raster topology, alpha coverage, depth ordering, and material complexity.
- If triangle reduction helps without resolution sensitivity, investigate vertex/primitive cost and projected micro-triangles.
- If texture size or mip changes help, investigate sampling bandwidth, cache behavior, anisotropy, and alpha-coverage-preserving mips.
- If draw-call reduction helps but topology changes do not, investigate submission, bind groups, pipeline churn, and batching.
- If GPU time is low but frame cadence is bad, investigate JavaScript, layout, garbage collection, uploads/readbacks, and synchronization.
- If only transitions spike, investigate resource creation, shader compilation, shadow invalidation, history resets, readbacks, and pipeline cache misses.

## Fidelity contract

- Do not count hidden objects, discarded source records, shortened visibility, downgraded assets, fallback geometry, render-scale blur, or disabled effects as transparent wins unless the user authorizes that tradeoff.
- Optimize authored foliage by retaining complete source components and preserving geometry attributes and PBR bindings. Do not silently replace it with billboards, procedural stand-ins, or generic props.
- Keep structural geometry such as trunks and branches resident through every foliage LOD unless the source asset explicitly authors otherwise.
- Evaluate temporal stability. A still screenshot cannot approve LOD popping, alpha shimmer, disocclusion, ghosting, or dynamic-resolution oscillation.
- Fail closed when the target backend or scene is unavailable.

## Evidence to return

Report the exact before/after contract, median and p95 values, dominant passes, representative screenshots, test/build results, visual tradeoffs, rejected experiments, and remaining bottlenecks. Distinguish measured facts from inferred causes.

## Primary references

Prefer current primary documentation when details may have changed:

- Three.js WebGPURenderer, InstancedMesh, LOD, renderer Info, WebGPU post-processing, and official optimization manual.
- GPUWeb specification and explainer.
- Khronos/Google WebGPU best-practices material.
- Apple, AMD GPUOpen, NVIDIA, and Arm architecture/performance guidance.

The supporting references link the relevant primary pages and translate them into operational checks.
