# Pineglass roots and woodland density — 2026-09-06

The editable project and compiled course now both carry the current tall-pine
root controls. Previously only course.json enabled roots; recompilation would
have removed them. No route, terrain, surface or shot-physics settings changed.

Root seating now preserves each vertex's vertical offset around its root station.
Previously the terrain blend collapsed fully seated rings into flat fins. The
shared procedural bark has shorter irregular ridges and fine grain; Pineglass uses
6 mm relief instead of the previous 40 mm. Existing textured bark is unaffected.

Added 222 deterministic, individually editable tall-pine placements to the
existing 111 (333 total), using the existing three instanced variants. Additions
sit inside the existing woodland beds with varied scale/yaw and clustered depth.
Minimum measured added-tree spacing is 8.02 m, fairway setback 9.49 m, green-edge
setback 38.69 m and tee-edge setback 27.56 m. Existing placements are preserved.
Project compilation succeeds with 421 total environment objects, below its 720
budget, and the compiled runtime matches the project exactly.

Validation: 10 root tests and 8 procedural source/builder tests pass; production
build passes. Fitted headful Chrome rendered the real Play/WebGPU route at
1920×1080, scale 1, Battery settings, with live wind/simulation and all 333 source
trees resident. Inspected root, tee, landing, approach and overview screenshots:
`/tmp/dense-roots-axzrVI/`. Report has no console/network errors or invalid
completed-render samples. Short 180-frame samples:

| View | Mean fps | p95 frame time |
| --- | ---: | ---: |
| Roots | 28.95 | 50.0 ms |
| Tee | 22.78 | 50.5 ms |
| Landing | 29.58 | 34.4 ms |
| Approach | 36.23 | 33.6 ms |
| Overview | 21.01 | 50.7 ms |

This is a visible density increase with a material performance cost, not a
sustained-30-fps result. Keep that gap explicit. The earlier close baseline
`/tmp/roots-before.png` used frozen simulation, so its frame timing is not a valid
performance comparison. Initial QA attempts encountered a sandbox Chrome launch
restriction and then an unavailable dev server; final evidence uses the dedicated
production preview at port 4175, with no renderer substitution.

Full-hole replay: `/tmp/play-hole-A4ulOx/report.json`. All three expected rests,
one cup drop, next-hole reset and stable scene targets pass; no health errors or
invalid completed frames. The unchanged performance gate correctly fails,
including a 27.23 fps final-putt sample with p95 50.1 ms.
