# Agent instructions

## Local app and visual QA

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

- Treat catalog-backed Poly Haven GLBs as the source of truth. Preserve their
  authored geometry, normals, UVs, vertex colours, alpha, and PBR maps.
- Do not introduce procedural, billboard, atlas, placeholder, or generic-prop
  fallbacks for authored tree assets. If a catalog asset cannot render through the
  production path, fail closed and fix that path.
