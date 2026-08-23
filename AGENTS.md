# Agent instructions

## Local app and visual QA

- Use the in-app Browser tools as the canonical way to inspect, interact with, and
  screenshot the local app. The required route is the Browser runtime exposed by
  `mcp__node_repl__js` and the repository's browser skill instructions.
- Do not use Puppeteer, standalone Playwright, external Chrome automation, or
  `page.screenshot()` for local visual QA. Do not silently substitute another
  browser surface.
- If the in-app Browser cannot be connected or cannot perform the required check,
  stop and report the exact blocker rather than switching tools. Unit tests,
  builds, and non-visual diagnostics may still run through the repository's normal
  scripts.
- For rendered changes, capture Browser evidence for page identity, non-blank
  content, console health, the target interaction, and the final screenshot.

## Rendering and assets

- Treat catalog-backed Poly Haven GLBs as the source of truth. Preserve their
  authored geometry, normals, UVs, vertex colours, alpha, and PBR maps.
- Do not introduce procedural, billboard, atlas, placeholder, or generic-prop
  fallbacks for authored tree assets. If a catalog asset cannot render through the
  production path, fail closed and fix that path.
