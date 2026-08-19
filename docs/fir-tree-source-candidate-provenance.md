# Fir Tree 01 source-faithful candidate (isolated)

This is an evaluation-only candidate. It is not referenced by `Trees.js`, the
environment catalog, `course.json`, or any production asset barrier.

Source: Poly Haven Fir Tree 01, CC0, authored by Poly Haven:
<https://polyhaven.com/a/fir_tree_01>

The pinned source model is
`public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf` (SHA-256
`72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709`). The
candidate uses variant A (`meshes[0]`) and preserves its trunk, bark, dead
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
under `public/assets/trees_candidates/fir_tree_01/` and embed
`extras.candidateOnly: true`.

Measured output:

- LOD0: 112,264 vertices, 144,996 triangles, bounds height 18.904 m.
- LOD1: 25,360 vertices, 22,941 triangles, bounds height 18.914 m.

Pinned candidate hashes from the deterministic build are:

- LOD0 `9a9dc86713c48a77449b8ba4545dcce8699c6b834f8d4b1415da91e21c9c7475`
- LOD1 `27bd4f73e3b77ddddaa5d3cb94ee38843bb11d2ebda4e57df78585d8030b2678`

The small LOD height difference is from source component reservoirs; both are
grounded by subtracting the selected source minimum Y. No production promotion
or GPU acceptance is implied by these files. A future viewer comparison must
measure the full production-lit near/mid/far tree path before catalog review.

Rebuild:

```sh
python3 scripts/build_fir_tree_source_candidate.py \
  --input public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf \
  --output-dir public/assets/trees_candidates/fir_tree_01
```
