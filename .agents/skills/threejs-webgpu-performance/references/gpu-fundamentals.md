# GPU and shader performance field guide

## Optimize the bottleneck, not the vocabulary

A frame can be limited by CPU submission, synchronization, vertex/primitive work, rasterization, fragment shading, texture/attachment bandwidth, compute, or presentation. Modern GPUs overlap work, so isolate with perturbations and whole-frame timing.

## Alpha-tested foliage and microgeometry

Foliage commonly combines the worst raster traits: many tiny triangles, double-sided cards, high-frequency alpha tests, heavy overdraw, and expensive texture sampling. Alpha discard can reduce early depth rejection because visibility is unknown until fragment evaluation.

Apply in this order:

1. Remove invisible/duplicate work while retaining all required source records.
2. Reduce subpixel and overlapping foliage by retaining complete authored sprays/components; keep trunks/branches and source attributes.
3. Use front-to-back ordering where it does not create excessive sorting/submission cost.
4. Consider an alpha-aware depth prepass only after measuring it. It can help expensive foliage shading but can lose when geometry/alpha evaluation is already dominant.
5. Build coverage-preserving alpha mipmaps. Ordinary color/alpha downsampling often shrinks or dissolves a crown at distance; rescale mip alpha to retain the chosen alpha-test coverage.
6. Test alpha-to-coverage only with MSAA and temporal stability evidence. It changes edge appearance and is not a universal replacement for alpha test.

Do not solve foliage overdraw with blurry resolution scaling or missing LOD structure.

## Shader execution

- Move invariant math out of per-fragment code and out of loops.
- Avoid recomputing normalized vectors, transforms, noise, and texture coordinates across material nodes when they can be shared.
- Prefer coherent branches. Divergent lanes execute multiple branch paths and mask results.
- Control register pressure: oversized functions, many live temporaries, and aggressive unrolling can reduce occupancy.
- Use precision appropriate to the platform and result, but verify image error; WebGPU shader language/platform behavior governs what is actually lowered.
- Replace expensive operations only when compiler output or timing shows a gain. Algebraic changes may already be performed by the shader compiler.
- Reduce shader variants and pipeline churn. Stable material feature sets improve cache reuse and avoid compile hitches.

## Compute

- Start with workgroups around one or a few native waves/warps; 64 threads (for example 8x8 for image work) is a useful hypothesis, not a law.
- Align work and memory access so adjacent lanes touch adjacent data.
- Avoid per-frame clears, scans, and atomics for static data. Use prefix/indirect techniques only when their setup is cheaper than the work avoided.
- Minimize hot atomic contention; use workgroup-local aggregation when applicable.
- Bounds checks and early exits should remain coherent where possible.
- Watch occupancy, register usage, shared memory, and divergence together. Maximizing occupancy alone is not the goal.
- Avoid CPU readbacks in the frame loop. Keep counters and indirect arguments on GPU; read diagnostics asynchronously and sparingly.

## Bandwidth and render passes

On tile-based GPUs, attachment load/store and pass boundaries can dominate even when arithmetic looks modest.

- Fuse passes when it removes material attachment traffic without forcing much more shading.
- Mark attachment load/store intent accurately; do not preserve values that are not consumed.
- Keep formats and attachment counts no larger than visual/algorithmic needs.
- Avoid full-resolution intermediates for effects that tolerate half/quarter resolution, but preserve final sharpness and temporal stability.
- Reuse render targets and buffers. Resource allocation/destruction in-frame creates hitches and memory pressure.
- Avoid unnecessary copies, resolves, and sampled re-reads of recent render targets.
- Prefer compressed, mipmapped textures supported by the target adapter. Measure decode/quality and provide valid fallbacks within the authored contract.

## Geometry and submission

- Instancing and multi-draw reduce CPU/draw overhead; they do not reduce triangles or overdraw.
- Merge static compatible geometry when it improves submission without destroying culling granularity.
- Maintain correct object/instance bounds. Missing bounds can disable useful culling; undersized bounds delete content.
- Use LOD based on projected contribution, not distance alone. Preserve silhouettes and structural payload.
- Eliminate subpixel triangles before removing large silhouette-defining pieces.
- Keep static transforms, buffers, and bind groups static. Upload only changed ranges.
- Avoid excessive material uniqueness and state changes; stable pipelines and resource layouts matter.

## “Crazy” techniques: evidence gates

These techniques can be excellent, but only after the simpler bottleneck is proven:

- GPU-driven visibility, prefix compaction, and indirect draws: good for large dynamic populations; measure dispatch/atomic cost and retained raster work.
- Hierarchical Z/occlusion culling: useful with real occluders and temporal coherence; risky for thin alpha foliage and camera cuts.
- Meshlet/cluster culling: valuable when the runtime and content pipeline support compact clusters; WebGPU/Three integration may require custom infrastructure.
- Visibility buffers/deferred texturing: can reduce material shading but add storage, bandwidth, and complexity.
- Variable-rate/foveated shading: platform-dependent and a visual tradeoff; do not emulate it by arbitrary blur.
- Temporal supersampling/upscaling: only if motion vectors, disocclusion, reactive masks, and sharpness hold under gameplay motion.
- Signed-distance or volumetric impostors: a content-representation change, not a transparent authored-model optimization; require explicit authorization.
- Bindless/texture arrays: can collapse state changes but affect material architecture and portability.
- Async compute: overlap exists only when independent work and backend scheduling support it; timestamps must prove overlap.

## Primary sources

- Khronos/Google WebGPU best practices: https://www.khronos.org/assets/uploads/developers/presentations/WebGPU_Best_Practices_Google.pdf
- AMD RDNA performance guide: https://gpuopen.com/learn/rdna-performance-guide/
- AMD occupancy explained: https://gpuopen.com/learn/occupancy-explained/
- NVIDIA advanced shader performance: https://developer.nvidia.com/blog/advanced-api-performance-shaders/
- Apple silicon GPU optimization: https://developer.apple.com/videos/play/wwdc2020/10632/
- Apple GPU memory-bandwidth measurement: https://developer.apple.com/documentation/xcode/measuring-the-gpus-use-of-memory-bandwidth
- Arm hidden mobile rendering costs: https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/finding-and-fixing-hidden-performance-problems-in-mobile-games-with-arm-performance-studio
