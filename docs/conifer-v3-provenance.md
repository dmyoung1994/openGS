# Conifer v3 provenance

This document describes the deterministic `conifer_v3_*` assets. The
production environment catalog references this family by its existing catalog
entry; the two GLBs below are the optimized geometry derivatives used by that
entry.

## Source maps

- Model/source family: Poly Haven **Fir Tree 01**, CC0: <https://polyhaven.com/a/fir_tree_01>
- Diffuse: `public/assets/trees_src/fir_tree_01/textures/fir_tree_01_twig_diff_1k.jpg`
- Paired alpha: `fir_tree_01_twig_alpha_1k.png`, downloaded from the official
  Poly Haven asset delivery endpoint; MD5
  `02ab808c8b2ff77ad9fdb2f92892db80`.
- Paired mask: `fir_tree_01_twig_mask_1k.png`, same endpoint; MD5
  `bffb132164ba6325c8846d71436eeae2`.

The alpha PNG is used directly. It is not inferred from UV occupancy, color
differences, or a runtime network request. The staged atlas is packed from
source-authored spray crops with transparent gutters.

## Generated assets

`scripts/build_conifer_v3.py` creates the tapered trunk, primary branches, and
irregular branchlet-cluster scaffold. That geometry is project-authored and
does not claim a CC0 derivative license. The extracted source pixels remain
CC0 under the source asset terms; the generated mesh and atlas composition are
covered by this project’s repository license. Each LOD is one combined
authored-alpha primitive/material: opaque bark uses atlas tile 0 and branchlet
sprays use the paired source alpha map with `MASK` cutoff `0.06`.

The builder is deterministic (`seed=0xC01F3E`) and embeds source
identifiers and hashes in each GLB `extras` object. It performs no runtime
network access. The optimized geometry uses four-plane local branchlet sprays
and deterministic volume sampling while retaining the irregular whorl scaffold.
LOD0 is 7,868 triangles / 23,604 vertices. LOD1 shares the exact whorl and volume
cluster centers but reduces each local spray from four planes to a crossed pair;
it is 4,420 triangles / 13,260 vertices (56.2% of LOD0). Their registered bounds
remain within about 2 cm and both are approximately 18.65 m high, with a continuous
trunk and no tree-sized billboard planes. LOD1 additionally tightens each spray
rectangle to its measured source-alpha bounds at the runtime cutoff, reducing
weighted card area by 8.62% without deleting crown layers or changing topology.
The current LOD1 SHA-256 is
`708d30b08ede8ae7440602aa795abbb9d278d64e63e2fc185abef650773a0883`.
The branchlet atlas
hash is unchanged
(`4a0770c24e9eb6a92d66cc2f0dd0c0a2233215ddbbb49f81b2264551fb5d01e6`) and the
impostor atlas is intentionally unchanged
(`172bb2935dcada2c686b0e19e0b5962b79f921e19d9f0277fbfd503464c7ca48`).

Rebuild command:

```sh
python3 scripts/build_conifer_v3.py \
  --source-dir public/assets/trees_src/fir_tree_01/textures \
  --output-dir public/assets/trees \
  --prefix conifer_v3
```
