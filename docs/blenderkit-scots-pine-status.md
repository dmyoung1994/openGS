# `bk_scots_pine` — built, NOT promoted

The 29 m Scots pine (`Pine Tree Sylvestris`, BlenderKit `assetBaseId`
`440f7605-084d-4788-b3ea-08f0d808f121`, Royalty Free,
`public/assets/trees_src/bk_alpine/scots_pine.blend`) builds cleanly through
`scripts/build_bk_tree.py -- bk_scots_pine` and is visible in the asset viewer as
`tree: blendkit scots pine (role-split)`. It is deliberately **not** in the
runtime catalog.

## What works

It is the source that forced the instance-realization path, and that path is
correct now:

* the canopy exists only as ~14 200 geometry-nodes instances; `modifier_apply`
  and `convert(target='MESH')` both silently drop them, `duplicates_make_real()`
  realizes them (3.19M triangles);
* density is reduced by dropping **whole seeded instances**, never by decimating
  cards, so every surviving spray keeps its authored alpha shape;
* all three role tiles bake correctly — trunk bark 100% lit
  (linear 0.271/0.199/0.129) and needles green (0.332/0.387/0.113).

## Why it is not promoted

At the instance budget that keeps LOD0 to a sane size (620 of 2942 `needles_3`
and 1250 of 2941 `Pine_needle_1` — 21% density, 349k triangles, 43 MB GLB), the
crown is too thin to read as a pine. At 44 m it is a dark scraggly spindle; at
120 m it nearly disappears. Full authored density is ~2M triangles, which is not
shippable through the current pipeline.

The `branches.003` role (the twiglet inside each spray, 161k triangles of dark
bark buried in the canopy) is dropped at build time — it was clutter, not
structure, and the real limbs live in `trunk.main.001`.

## What would fix it

1. **Mesh compression.** Every other catalog derivative went through
   `gltf-transform` + meshoptimizer; these role-split builds do not. Quantized +
   meshopt geometry would cut the GLB several-fold and make a denser canopy
   affordable.
2. **A density-first impostor.** This tree lives in the background band. Bake the
   card from a FULL-density realization (no instance thinning) while shipping a
   thin LOD0/LOD1 for the rare near case; the card then carries the crown mass at
   the distance the species is actually used.

Either is a pipeline change, not an asset fix, so the pine waits rather than
shipping a spindly tree into the range.
