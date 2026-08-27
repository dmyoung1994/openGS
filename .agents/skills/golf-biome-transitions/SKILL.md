---
name: golf-biome-transitions
description: Author and revise deterministic visual/ecological transitions at golf-course edges or inland biome regions. Use for coastlines, beaches, shore character, ecotones, biome pockets, or habitat transitions; not for changing playable-surface physics.
---

# Golf Biome Transitions

Author semantic transition records; let the engine compile physical bands and renderer weights.

## Workflow

1. Read [references/engine-contract.md](references/engine-contract.md) before editing `course.json` or using the course MCP.
2. Inspect the primary `biome`, course bounds, protected play, existing transitions, and the intended outward/inland view.
3. Choose the narrowest registered profile that expresses the request:
   - `natural-resort-beach`: maintained coastal resort with strand grass, dune, dry/wet beach, shelf, and ocean.
   - `narrow-wild-shore`: compressed, irregular shoreline character.
   - `broad-pristine-beach`: generous pale beach and shallow shelf.
   - `maritime-alpine-ecotone`: non-water inland or edge transition between maritime and alpine habitat.
4. Read [references/transition-heuristics.md](references/transition-heuristics.md) when selecting boundary sides, width, vegetation, substrate, or atmosphere.
5. Author one stable ID, seed, width scale, and explicit priority per record. Prefer `course-edge`; use `polygon-region` only for a real inland pocket.
6. Run full `normalizeCourse`/`validate_course`, then inspect `classify_biome` at representative points on both sides and inside every band.

## Invariants

- Keep `biome` as the primary biome and `meta.schema` at 3.
- Transition weights affect visual material and ecology only. Never alter playable surface IDs, lie physics, collision height, penalty state, or the authored pond system implicitly.
- Water-producing profiles are valid only on explicit course-edge sides. They may not cut through protected play.
- Priorities own overlaps deterministically. Equal-priority overlap is invalid.
- Preserve authored catalog GLBs and their PBR data. Never replace trees or environment assets with primitives, billboards, procedural stand-ins, or placeholders.
- Apply the request as one validated course transaction. If validation fails, restore the previous course.
