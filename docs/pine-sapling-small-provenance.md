# Poly Haven Pine Sapling Small runtime promotion

Source: [Pine Sapling Small](https://polyhaven.com/a/pine_sapling_small),
CC0, authored by Rico Cilliers and Rob Tuytel.

`scripts/fetch_polyhaven_pine_sapling_small.mjs` downloads the official 1k
glTF package from `https://api.polyhaven.com/files/pine_sapling_small`, verifies
every API-provided MD5, and explicitly acquires the sidecar twig alpha PNG. The
pinned source glTF SHA-256 is
`f358c01926861dd082f32dba60f7c9fba232b585a985cf38c0d2229eecf4bc48`.

`scripts/process_pine_sapling_small.py` promotes complete source variant A. It
combines only the official twig diffuse RGB and alpha coverage into an embedded
RGBA PNG. LOD0 keeps all 142,506 authored triangles. LOD1 retains complete
connected twig components to approximately 40,000 foliage faces; it never
samples isolated triangles and never creates cards, billboards, atlases,
procedural geometry, or a replacement species. Both GLBs preserve source
indices, normals, UVs, material roles, and PBR maps.

Pinned source-faithful intermediate outputs:

- LOD0 `pine_sapling_small_exact_a.glb`, SHA-256
  `37b334e2f955b22f605a865561dcb040da49fb7f56347f614c188e7a4c043043`
- LOD1 `pine_sapling_small_component_lod1.glb`, SHA-256
  `107ff6390f7606c19280f1b57568b98e04ea9a8f1106ae9748cbfbea38119a98`

The production catalog uses deterministic whole-spray derivatives of these
intermediates; see `docs/tree-performance-lods.md`.

Rebuild:

```sh
node scripts/fetch_polyhaven_pine_sapling_small.mjs \
  --output-dir public/assets/trees_src/pine_sapling_small
python3 scripts/process_pine_sapling_small.py \
  --input public/assets/trees_src/pine_sapling_small/pine_sapling_small_1k.gltf \
  --output public/assets/trees/pine_sapling_small_exact_a.glb --variant a
python3 scripts/process_pine_sapling_small.py \
  --input public/assets/trees_src/pine_sapling_small/pine_sapling_small_1k.gltf \
  --output public/assets/trees/pine_sapling_small_component_lod1.glb \
  --variant a --target-faces 40000
```
