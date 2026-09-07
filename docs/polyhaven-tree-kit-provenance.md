# Poly Haven tree kit promotion

The runtime tree catalog is CC0 Poly Haven only. These raw LOD0 kit pieces remain
available as authored species rather than multiplying one tree record.

Sources:

- [Tree Small 02](https://polyhaven.com/a/tree_small_02)
- [Pine Sapling Small](https://polyhaven.com/a/pine_sapling_small)
- [Island Tree 01](https://polyhaven.com/a/island_tree_01)
- [Island Tree 02](https://polyhaven.com/a/island_tree_02)

Promoted records:

| Catalog ID | Runtime role | Local derivatives |
| --- | --- | --- |
| `polyhaven-pine-sapling-small` | source-faithful whole-spray course LOD pair | `pine_sapling_small_course_lod0.glb`, `pine_sapling_small_course_lod1.glb` |
| `polyhaven-tree-small-02-hero` | raw LOD0 hero prop plus the verified same-source three-material middle mesh and alpha map | `tree_small_02_hero_lod0.glb`, `tree_small_02_lod0.glb`, `tree_small_02_leaves_alpha_1k.png` |
| `polyhaven-island-tree-01` | exact three-material modeled derivative bound to both GPU residency bands, with embedded source alpha/PBR maps | `island_tree_01.glb` |
| `polyhaven-island-tree-02` | raw LOD0 hero plus whole-component distance mesh | `island_tree_02_lod0.glb`, `island_tree_02_lod1.glb`, `island_tree_02_leaves_alpha_1k.png` |

Each record is hash-checked by the catalog before a referencing scene becomes
visible. Island Tree 02 LOD1 is built in Blender 5.2 by retaining complete,
deterministically selected source leaf and branch components (10,417 leaf
clusters and 1,278 branch components) plus a decimated source trunk. It does not
introduce cards, billboards, atlases, or replacement geometry.

Island Tree 01 intentionally references the same compact authored GLB in both
runtime bands. This keeps its exact geometry and materials while routing camera
visibility through GPU compute and indirect draws; no CPU instance compaction or
second derivative participates in rendering.
