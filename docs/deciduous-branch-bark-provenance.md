# Deciduous branch bark source provenance

The broadleaf candidate packs reuse the branch material from Poly Haven's
`Island Tree 01` asset: <https://polyhaven.com/a/island_tree_01>.

- Source/author: Poly Haven contributors
- License: CC0 1.0
- Downloaded source directory: `public/assets/trees_src/island_tree_01`
- Albedo: `island_tree_01_branches_diff_1k.jpg`, SHA-256
  `bee5ec22196e9e31ad0c95a5a9b4636571cc0124d5bb27a92f1e307d289cc60d`
- OpenGL normal: `island_tree_01_branches_nor_gl_1k.jpg`, SHA-256
  `2d67393ba76a0f49cf965fa0c99d8c16268e71e87b1203d35539bfdb971a514e`
- ARM: `island_tree_01_branches_arm_1k.jpg`, SHA-256
  `9e3f82263247ce4f619692cea4c4f6fe9936ff465a86623481849062642c7d05`

The files are copied byte-for-byte into each immutable candidate pack. Runtime
species calibration changes only the PBR material response; the scan is not
painted, relit, or converted into an emissive texture.
