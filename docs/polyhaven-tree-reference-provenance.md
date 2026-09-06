# Poly Haven tree reference lane

These reference entries are isolated viewer comparisons. The same broadleaf
source families are promoted into the runtime catalog as explicit
LOD0 kit pieces; the reference lane never acts as a fallback when a production
asset is missing.

## Sources

- [Tree Small 02](https://polyhaven.com/a/tree_small_02) — broadleaf reference,
  CC0, vendored locally as `public/assets/trees/tree_small_02_lod0.glb`.
- [Island Tree 01](https://polyhaven.com/a/island_tree_01) — broadleaf reference,
  CC0, vendored locally as `public/assets/trees/island_tree_01.glb`.
- [Island Tree 02](https://polyhaven.com/a/island_tree_02) — broadleaf reference,
  CC0, vendored locally as `public/assets/trees/island_tree_02_lod0.glb`.
- [Pine Sapling Small](https://polyhaven.com/a/pine_sapling_small) — conifer
  reference, CC0, promoted as an exact variant plus whole-component LOD.

Runtime kit promotions:

- `polyhaven-tree-small-02-hero` — Tree Small 02 raw LOD0 plus its alpha map.
- `polyhaven-island-tree-01` — Island Tree 01 dense three-material modeled
  derivative with embedded source alpha and PBR maps.
- `polyhaven-island-tree-02` — Island Tree 02 raw LOD0 plus its alpha map.

The viewer loads the local GLB files through the same production WebGPU scene,
terrain, sun, atmosphere, and shadow setup used for generated-tree inspection.
The reference lane exists to compare silhouette, alpha-edge behavior, canopy
volume, bark attachment, and projected shadow quality.

Viewer entries:

- `reference: Poly Haven Tree Small 02 (CC0)`
- `reference: Poly Haven Island Tree 01 (CC0)`
- `reference: Poly Haven Pine Sapling Small (CC0)`
- `reference: Poly Haven Pine Sapling Small LOD1 (CC0)`
The files are treated as reference-only source art. Any production candidate
must still pass the local foliage manifest, validation, budget, and provenance
checks before it can enter the course runtime.
