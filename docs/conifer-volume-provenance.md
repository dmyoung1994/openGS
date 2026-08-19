# Alpine conifer volume derivative

The production tree record `polyhaven-fir-sapling-medium` is sourced from the
CC0 Poly Haven Fir Tree 01 reference: [Poly Haven Fir Tree 01](https://polyhaven.com/a/fir_tree_01).
The source lineage is retained in `public/assets/environment/catalog.json` with
the original source hash. The shipped runtime derivatives are generated locally
by `scripts/build_conifer_canonical.py`; they contain no runtime network fetch.

The baker emits a deterministic one-primitive, indexed Float32 mesh with an
opaque tapered trunk, structural branch wood, and radial 3-D needle bundles.
The geometry is intentionally source-independent authoring geometry licensed by
the project under the source record's CC0 lineage; no source texture or baked
lighting is embedded. Vertex COLOR_0 stores neutral role albedo and the shared
production daylight path provides lighting.

| derivative | vertices | triangles | SHA-256 |
| --- | ---: | ---: | --- |
| `conifer_volume_v2_lod0.glb` | 140,844 | 46,948 | `763b679beabc8fc910605902058f5ecd52636a1e4d4455f530fe0cadbd81d6cd` |
| `conifer_volume_v2_lod1.glb` | 33,282 | 11,094 | `5f1d66a6bfbbb6c2394ae1e4eb8ce93d3b7a3a68d845927d6b878e23b484cd7c` |
| `conifer_volume_v2_impostor.png` | 8-view atlas | — | `6a3f3a7861966439129996541959b9434a2aa34ea436f96a35f4a31632afeb69` |

The existing GPU classifier retains exclusive geometry/impostor bands and
deterministic age, width, yaw, and wind records. The old source-derived fir and
the experimental pine-sapling derivatives remain unreferenced for comparison.
