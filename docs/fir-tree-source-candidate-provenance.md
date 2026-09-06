# Fir Tree 01 source-faithful production derivative

Pineglass Forest uses this source-faithful variant B derivative as its primary
mature overstory. The course has 88 immutable Fir Tree 01 records at authored
mature heights of 18–28 m. Pine Tree 01 remains an intentionally open emergent
accent. The fir derivative preserves source geometry attributes and PBR maps and
keeps complete connected twig components; it is not a billboard, impostor,
procedural reconstruction, or fallback.

Source: Poly Haven Fir Tree 01, CC0, authored by Poly Haven:
<https://polyhaven.com/a/fir_tree_01>

The pinned source model is
`public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf` (SHA-256
`72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709`). The
production derivative uses variant B (`meshes[1]`) and preserves its trunk, bark, dead
branch, and twig primitives, source normals, UVs, and vertex colours. Twig
components are selected as complete connected components in deterministic
vertical reservoirs; individual twig triangles are never selected in isolation.

Source twig maps:

- diffuse JPEG SHA-256 `8c0833a10e4fd44498d848cf9e659fe250a3813984cbd679f42430eb98c61fb8`
- alpha PNG SHA-256 `3f399629337e7ac3af27a01b08ffb9c0d60224a9dd374a1427761a5c2eea9d6e`
- normal JPEG SHA-256 `d470dc39b1d02bbeba06feb0ad818680ef3c24623b4db597270301a5fb8c9369`
- arm JPEG SHA-256 `d66c81fc073ee7ea97a76b6da2399769f16944e50ef0e007f09c95619f597c79`

`scripts/build_fir_tree_source_candidate.py` combines only the source twig
diffuse and sidecar alpha into an embedded RGBA PNG; it does not bake lighting
or albedo. Bark/trunk/branch maps remain source JPEGs. Generated GLBs are kept
under `public/assets/trees/` and embed
`extras.productionDerivative: true`.

Pinned source-faithful intermediate hashes from the deterministic build are:

- LOD0 `d4e1e9073d1d38a051076631705ad4cd31c762167a1ff37db6f3ec8f717ee66d`
- LOD1 `aaa95b404595d111c651d31f77c67aeb969171b944a72791b2b0cc63ae498b6e`

LOD0 contains 556,299 total faces (462,971 foliage) and 709,954 vertices. LOD1
contains 386,242 total faces (292,914 foliage) and 474,000 vertices. Both files
are grounded by subtracting the selected source minimum Y and preserve
`POSITION`, `NORMAL`, `TEXCOORD_0`, `COLOR_0`, and `COLOR_1` on retained
geometry, four authored PBR material identities, and all 12 source textures.
Both tiers keep an identical 93,328-face structural payload (bark, trunk, and
dead branches), an identical source base Y, and exact shared bounds. LOD1's
78,159 foliage components are a deterministic subset of LOD0's 123,470 rather
than a separately shuffled crown. Their authored bounds are approximately
5.56 × 14.055 × 6.038 m.
The production catalog uses deterministic whole-spray derivatives of these
intermediates; see `docs/tree-performance-lods.md`. Its lineage is
`build_fir_tree_source_candidate@7-nested-source-faithful-three-tier-course-spray-budgets:variant-b`.
The registered LOD2 keeps the identical 93,328-face structural payload and a
nested 30,001-face whole-spray foliage subset.

Rebuild:

```sh
python3 scripts/build_fir_tree_source_candidate.py \
  --input public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf \
  --output-dir public/assets/trees \
  --variant b
```
