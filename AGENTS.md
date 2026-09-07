# Agent instructions

## Simulator input

- Shots are driven by measured ball speed, launch angle/direction, spin rate and
  spin axis. Do not require club selection or infer ball flight from a club label.
  Optional device-supplied club metadata is informational; development presets
  are test inputs, not a player workflow. Include low-speed putts in validation.

## Continuity during active work

- Treat incoming side messages as updates to the active task unless the user
  explicitly cancels or replaces it. Incorporate corrections and constraints
  immediately; answer questions or handle authorized side requests, then resume
  the remaining work without waiting for another “continue.” Update the plan to
  reflect new information and results while preserving the original objective
  and unfinished requirements. If the current mode prevents a requested action,
  state that limitation briefly, retain the action as pending, and continue all
  permitted work.

## Local app and visual QA

- Fit each dedicated browser test window inside the current display's available
  bounds. Keep benchmark rendering dimensions explicit; scale the browser's
  presentation viewport when necessary instead of opening an oversized or
  off-screen window or silently reducing the benchmark render resolution.

- Use `puppeteer-core` with the installed Google Chrome binary as the canonical
  path to inspect, interact with, and screenshot the local app. Launch a dedicated
  headful Chrome process with a fresh temporary `userDataDir`; do not attach to the
  user's normal profile or depend on an extension bridge.
- Preserve the real production path during QA: enable WebGPU, use the actual local
  route, wait for `window.golfBootstrap.ready`, and use `window.golf` plus
  `window.golf.evaluatorCamera` for engine diagnostics and deterministic camera
  poses. `scripts/shot.mjs` is the repository capture harness; custom probes should
  follow the same launch and readiness contract.
- Do not use the in-app Browser runtime, standalone Playwright, software rendering,
  DOM-only substitutes, or mocked scene state for local visual QA. A Puppeteer
  failure is a QA failure: report the exact launch, readiness, console, network, or
  renderer blocker rather than silently changing the rendering path.
- For rendered changes, capture evidence for page identity, non-blank content,
  strict WebGPU readiness, console/network health, the target interaction, and the
  final screenshot. Store temporary captures outside the repository unless they are
  intentionally committed evidence.

## Rendering and assets

- Pineglass uses the custom procedural `tall-pine` definition by explicit user
  choice. Profile and improve that forest; do not switch it back to catalog trees.
  Catalog preservation rules below apply to courses that explicitly use those
  assets, not to replacing this procedural content selection.

- Distance-based visual culling and LOD must use the active rendering camera,
  never the ball, player, tee, or a stale camera pose. Visibility tests use that
  camera's current view frustum with conservative bounds for animated geometry.
- Auxiliary passes must preserve their contribution to the camera view: retain
  off-screen shadow casters whose shadows reach visible receivers, and use the
  reflected camera for reflection-pass visibility. Do not reuse the beauty
  camera's compacted draw list as a shadow or reflection visibility list.

- Treat catalog-backed Poly Haven GLBs as the source of truth. Preserve their
  authored geometry, normals, UVs, vertex colours, alpha, and PBR maps.
- Do not introduce procedural, billboard, atlas, placeholder, or generic-prop
  fallbacks for authored tree assets. If a catalog asset cannot render through the
  production path, fail closed and fix that path.
- Diagnose the rendering path before replacing a strong source asset. An asset
  that looks excellent in Blender or its source viewer but poor in the simulator
  may expose an implementation defect, not an asset-quality problem.
- Compare the same asset in Blender and the production simulator under matched
  physical scale, camera, and lighting as closely as practical. Check colour-space
  interpretation, PBR channel packing, normal orientation and strength, UVs,
  alpha handling, texture filtering/mipmaps, LODs, exposure/tone mapping, and
  temporal motion/history before deciding the source needs replacement. Record
  unavoidable differences between reference and runtime rendering.
- Fix shared rendering defects at their source; do not compensate with degraded
  assets, baked lighting, blur, or asset-specific hacks. Acceptance requires the
  asset to look convincing in the actual simulator, at both close and gameplay
  distances and during motion—not only in an external preview.
- Source or create better assets when comparison demonstrates a genuine content
  limitation. Blender and image generation are available authoring tools. Keep
  editable source files, physical scale, source/author/license information, and
  reproducible export or processing steps. Generated PBR channels must remain
  spatially consistent; an attractive colour image alone is not a PBR material.
- Newly authored assets are explicit content additions or replacements, never
  silent fallbacks for broken catalog assets. Preserve existing originals and
  validate replacements through the production path before switching references.

## Refactoring and implementation

- Asset loading must preserve responsive animation and input on the main thread,
  including the real putting scene shown during loading. Async network requests
  do not make synchronous decoding, packing, scene construction, or GPU uploads
  non-blocking. Move transferable CPU preparation into workers and split unavoidable
  main-thread work into bounded chunks. Measure loading-scene frame cadence and
  long tasks during cold loads, warm reloads, and handoff; total load time alone
  cannot certify a smooth loading experience.

- Refactor, replace, or delete obsolete code when that produces a better shared
  implementation; do not keep layering features over a flawed system. Reuse
  existing capabilities and installed tools before adding another implementation.
- Trace callers and resource ownership before changing shared code. Verify the
  replacement with relevant tests and rendered evidence before removing the old
  path. Preserve gameplay physics and unrelated user work; graphics changes must
  not silently change collision surfaces or ball behaviour.
- Prioritize visual quality, then measure and tune the complete scene toward
  sustained 30 fps on the target device while retaining higher-quality settings
  for stronger hardware. Do not claim performance or visual success from isolated
  asset previews, narrow benchmarks, or tests that omit the affected workflow.
