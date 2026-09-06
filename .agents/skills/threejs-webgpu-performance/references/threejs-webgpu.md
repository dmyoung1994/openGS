# Three.js and WebGPURenderer application guide

## Renderer and version contract

- Verify `renderer.isWebGPURenderer`, the backend type, adapter fallback state, canvas dimensions, pixel ratio, and internal render-target size.
- WebGPURenderer can fall back through a WebGL backend in some configurations. If the task targets WebGPU, fallback is a failed sample.
- Check the current Three.js release documentation and issues before relying on experimental behavior. WebGPU batching/indirect paths continue to evolve.

## Diagnostics

- `renderer.info` is useful for calls, triangles, points, lines, geometries, and textures, but interpret it with render graphs and indirect work in mind.
- Set `renderer.info.autoReset = false` only when intentionally aggregating a whole multi-pass frame, and reset it at a known boundary.
- Name render and compute passes so timestamp reports identify useful work.
- Compile/warm representative material and camera paths before steady-state timing. Report cold pipeline-creation hitches separately.

## Scene graph and object work

- `InstancedMesh` reduces draw calls for compatible geometry/material pairs. Update matrices in bulk and mark `instanceMatrix.needsUpdate` only after changes.
- Compute correct bounding boxes/spheres after instance setup. Recompute only when transforms truly change.
- Avoid per-frame `traverse`, allocations, material cloning, and scene add/remove churn in hot loops.
- Dispose geometries, materials, textures, node resources, and render targets when replacing a scene, but do not churn them during ordinary camera movement.
- Share immutable geometries/material resources where ownership and disposal are explicit.
- Merge static compatible geometry when the CPU is draw-bound, while retaining enough spatial chunks for culling.

## LOD and visibility

- Three's `LOD` is CPU/object-level and distance-based. GPU-driven instanced scenes often need custom projected-size classification and indirect draws.
- Keep LOD geometry ready; camera motion should update visibility/indirect arguments, not reload models.
- Use hysteresis or a transition band, then test both directions in motion.
- A structural subset must remain in every LOD. For trees, missing trunks/limbs are a failed derivative.
- Object frustum culling still needs a conservative superset bound even when instance visibility is compacted on GPU.
- Do not mistake instancing for raster optimization: every surviving instance still pays vertex, primitive, alpha, and fragment cost.

## TSL/node materials and shaders

- Factor shared nodes/expressions rather than rebuilding equivalent node graphs per material or frame.
- Keep uniform values in uniforms; do not regenerate materials to update wind, time, thresholds, or camera state.
- Limit feature combinations that create distinct pipelines.
- Inspect generated WGSL when copied Three materials mix map properties with explicit TSL nodes. A `normalNode`, `colorNode`, or opacity node can override property-driven paths.
- Avoid dynamic branches for static material capabilities; separate stable pipelines when that reduces divergence without exploding draw calls.
- Reuse storage/uniform buffers and update changed ranges.

## Textures and alpha

- Use mipmaps for minified content, but alpha-tested foliage needs alpha-coverage-preserving mip generation. Simply enabling ordinary mipmaps can make needles vanish.
- Match color space to the map's meaning: color maps use the authored color space; normal, roughness, metalness, AO, height, and masks remain data.
- Use compressed GPU formats when the production asset pipeline and adapter support them.
- Set anisotropy based on grazing-angle benefit and measured cost, not a global maximum.
- Pool identical immutable textures carefully. Preserve transforms, channels, sampling state, and color-space semantics.

## Post-processing and resolution

- WebGPU post-processing uses a node-based output graph. Reuse nodes/targets and avoid redundant full-resolution passes.
- Measure pass fusion against bandwidth and pipeline complexity. A fused pass can save attachment traffic, especially on tile GPUs.
- Keep internal render scale explicit. Three's responsive-rendering manual warns against blindly multiplying every canvas dimension by device pixel ratio; cap or choose resolution deliberately.
- Dynamic resolution needs hysteresis, stable measurement windows, transition tests, and an image-quality floor. It is not evidence that a fixed-quality scene became cheaper.
- Temporal accumulation needs valid history invalidation on camera cuts, resolution changes, and material/scene discontinuities—but not on unrelated policy changes.

## Asset pipeline

- Preserve authored geometry attributes, material identities, texture bindings, alpha, and PBR maps.
- Prefer deterministic offline work to per-frame runtime preprocessing.
- For dense foliage, retain complete connected sprays/components and prioritize silhouette/vertical coverage. Record source hash, pipeline version, output hashes, face counts, attributes, materials, and bounds.
- Verify every derivative in close, handoff, and far motion views plus the worst raster workload.

## Primary sources

- WebGPURenderer: https://threejs.org/docs/pages/WebGPURenderer.html
- WebGPU renderer guide: https://threejs.org/manual/en/webgpurenderer
- InstancedMesh: https://threejs.org/docs/pages/InstancedMesh.html
- LOD: https://threejs.org/docs/pages/LOD.html
- Renderer Info: https://threejs.org/docs/pages/Info.html
- WebGPU post-processing: https://threejs.org/manual/en/webgpu-postprocessing.html
- Optimize lots of objects: https://threejs.org/manual/en/optimize-lots-of-objects.html
- Responsive/high-DPI rendering: https://threejs.org/manual/en/responsive.html
- Experimental SceneOptimizer: https://threejs.org/docs/pages/SceneOptimizer.html
- Current WebGPU performance issue examples: https://github.com/mrdoob/three.js/issues/33797 and https://github.com/mrdoob/three.js/issues/31055
