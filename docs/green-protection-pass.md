# Pineglass green protection pass

Realistic authoring: reuse the existing green outline, grade and contour systems.
Hole 1 retains its unequal wings and contour defense. Hole 2 now has a diagonal
two-part target, a feeding ridge and a quiet back-left pin; its right-side bunker
leaves the opposite side available for dry recovery. Hole 3 has a long waisted
outline and raised rear shelf: short-left and right-side sand punish different
misses, while the open front supports a running approach and a short recovery.
The creator prompt and green-design reference now require varied primary defenses.

Existing greenside hazards retain their stable IDs, owning holes and geometry.
Distances below are approximate boundary samples in metres, not flight predictions.
Hole 2 carries use its primary tee; Hole 3 uses a point 90 m before the green
center along the final route tangent. Route progress is measured to bunker center.

| Owning hole / hazard ID | Shot context | Route progress / lateral offset | Front / clear carry | Green clearance | Earned benefit / bailout |
| --- | --- | --- | --- | --- | --- |
| 2 / `pineglass-hole-2-bunker-guard` | Par-3 approach | 93% / 16.4 m | 138.6 / 148.1 m | 6.7 m | Accurate angle avoids sand; opposite-side dry miss |
| 3 / `pineglass-hole-3-bunker-front-left` | Short approach | 98% / 16.0 m | 76.6 / 86.4 m | 3.0 m | Carry control reaches the front target; open central entry |
| 3 / `pineglass-hole-3-bunker-right` | Rear-shelf approach | 100% / 16.1 m | 86.6 / 96.1 m | 5.2 m | Correct depth and line reach the shelf; front target remains available |

Validation: compiler and production build pass; 30 focused authoring, grid,
surface and physics tests pass. Dedicated headful Chrome rendered the actual
WebGPU play route at 1920×1080, with overview and route-aligned approach captures
for all three holes. No console errors or failed network requests; texture
preload timing warnings remain. Each 3 m pin neighborhood stays entirely on
green, with sampled maximum slopes of 0.76%, 0.94% and 0.58%. Canonical 2 mph
putts settle with finite state on every hole. Evidence: `/tmp/green-protection-qa.json`
and `/tmp/pineglass-hole-{1,2,3}-{overview,approach,low}.png`.

Tees and route centerlines are unchanged, so green-to-next-tee travel, crossing
play, backtracking and start/finish routing have not been redesigned or newly
certified by this green-only pass. No new water, forced carry or detached platform
has been introduced. This pass does not establish full-course performance.
