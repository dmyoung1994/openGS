# Poly Haven tree reference lane

These reference entries are isolated viewer comparisons. The same source families
are now promoted into the Premium Range runtime catalog as explicit kit pieces;
the reference lane remains useful for close visual comparison and never acts as a
fallback when a production derivative is missing.

## Sources

- [Tree Small 02](https://polyhaven.com/a/tree_small_02) — broadleaf reference,
  CC0, vendored locally as `public/assets/trees/tree_small_02_lod0.glb`.
- [Island Tree 01](https://polyhaven.com/a/island_tree_01) — broadleaf reference,
  CC0, vendored locally as `public/assets/trees/island_tree_01.glb`.
- [Pine Tree 01](https://polyhaven.com/a/pine_tree_01) — conifer reference,
  CC0, vendored locally as `public/assets/trees/pine_tree_01_canonical_lod0.glb`.

Runtime kit promotions:

- `polyhaven-fir-tree-01` — Fir Tree 01 source LOD0/LOD1 plus its baked atlas.
- `polyhaven-fir-tree-01-variant-b` and `polyhaven-fir-tree-01-variant-c` — the
  two additional Fir Tree 01 source silhouettes as direct hero props.
- `polyhaven-pine-tree-01` — Pine Tree 01 canonical LOD0/LOD1 plus its baked atlas.

The viewer loads the local GLB files through the same production WebGPU scene,
terrain, sun, atmosphere, and shadow setup used for generated-tree inspection.
The reference lane exists to compare silhouette, alpha-edge behavior, canopy
volume, bark attachment, and projected shadow quality against the generated
Southern live oak and loblolly pine candidates.

Viewer entries:

- `reference: Poly Haven Tree Small 02 (CC0)`
- `reference: Poly Haven Island Tree 01 (CC0)`
- `reference: Poly Haven Pine Tree 01 (CC0)`

The files are treated as reference-only source art. Any production candidate
must still pass the local foliage manifest, validation, budget, and provenance
checks before it can enter the course runtime.
