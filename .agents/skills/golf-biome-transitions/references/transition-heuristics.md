# Transition heuristics

Build a transition in physical order. Later layers must follow the earlier ones.

1. **Landform:** continue the authored boundary grade; establish dune, shelf, shoulder, or alpine relief without creating a gameplay-height discontinuity.
2. **Hydrology:** put wet sand and shelf water seaward of dry substrate. Water begins outside a valid declared course edge; inland pockets remain non-water.
3. **Substrate:** progress from living soil/turf through dune or mineral ground to dry sand, wet sand, shelf, and deep water. Reuse the engine's licensed PBR families at profile-specific scale.
4. **Vegetation:** reduce maintained turf into strand/native weight, then retire vegetation before wet substrate. For alpine pockets, transition through compatible understory before canopy/geology changes.
5. **Catalog assets:** select only biome-compatible catalog GLBs. Use transition habitat/vegetation weights to place coherent communities, keeping tees, greens, landing areas, recovery routes, and hazard visibility clear.
6. **Atmosphere:** match distant color, haze, exposure, wind response, and horizon composition to the same transition. Atmosphere reinforces geography; it does not conceal a seam.

At a course/backdrop join, both meshes must share the exact edge substrate and depth
ownership. Introduce outward geology through irregular semantic weights on the
backdrop itself; never add a third filler surface or a uniform material band.

## Profile choice

- Natural resort: balanced, maintained inland edge; moderate dune and beach; clean view windows.
- Narrow wild shore: compressed width, stronger strand/rock character, limited groomed sand.
- Broad pristine beach: generous dry sand and shelf; sparse asset punctuation and broad negative space.
- Maritime–alpine: no water bands; use slope, geology, understory, canopy, and haze to express the ecological shift.

Use `widthScale` for site scale, not to fix a wrong profile. Inspect several points along every boundary because deterministic noise varies band width without changing order.
