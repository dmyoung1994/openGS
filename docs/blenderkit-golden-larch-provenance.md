# `blenderkit-golden-larch` provenance

Catalog id: **`blenderkit-golden-larch`** (`public/assets/environment/catalog.json`)

## Source

| field | value |
| --- | --- |
| Name | Larch Tree Fall Season |
| Origin | BlenderKit |
| `assetBaseId` | `33e69cd4-2035-4718-aad1-fdfe3618cf01` |
| URL | https://www.blenderkit.com/asset-gallery-detail/33e69cd4-2035-4718-aad1-fdfe3618cf01/ |
| Licence | **Royalty Free** (BlenderKit free tier — *not* CC0) |
| Local source | `public/assets/trees_src/bk_alpine/larch_fall.blend` |
| Source sha256 | `d69d45112aac9160e8e4be1463159d11feb1e6527bd955ce61b8248ced6a84bb` |

See the licence note in `blenderkit-grand-fir-provenance.md`; the same
`LicenseRef-BlenderKit-RoyaltyFree` identifier applies.

## Build

```
Blender -b --python scripts/build_bk_tree.py -- bk_golden_larch
Blender --background --python scripts/bake_tree_impostor.py -- \
  --input public/assets/trees/bk_golden_larch_lod0.glb \
  --output public/assets/trees/bk_golden_larch_impostor.png --frames 8 --size 512
node scripts/qa_tree_impostor.mjs --palette autumn public/assets/trees/bk_golden_larch_impostor.png
```

Pipeline version: `build_bk_tree@2-role-split-node-graph-tile-bake+neutral-impostor@2`

## Known limitation: flat canopy albedo

The foliage role's tile bake writes nothing, so the canopy falls back to a flat
golden colour measured from the source texture (linear 0.787 / 0.659 / 0.222)
combined with the authored alpha cutout. That fallback is deliberate: an opaque
flat material would turn the canopy into solid quads, so `bake_material_tile()`
emits flat RGB **plus the source alpha** whenever a card role fails to bake.

In practice the tree still reads well — a flat albedo under real sun/sky picks up
enough shading variation to look like foliage — but the canopy carries no texture
detail up close, and `qa_tree_impostor.mjs` correctly reports the card as ~97%
one flat colour. Placements keep it at the forest edge rather than at address
distance. Fixing it properly means finding why this graph bakes empty (the trunk
role on the same source bakes fine).

The previous `gold_alpha` build style — flat gold over a dilated copy of the
source alpha — is retired. Its empty-canopy output was never a colour problem: it
was the generated-image encode bug now fixed in `_packed_srgb_image()`.

## Runtime derivatives

| file | sha256 | triangles |
| --- | --- | --- |
| `bk_golden_larch_lod0.glb` | `d5d5e3a27c838253bb7614d588f29296f52a38be4893f37cf58e7cf39f01152d` | 140 000 (foliage 90k, branches 50k) |
| `bk_golden_larch_lod1.glb` | `035b246c9b392005ed63b71c8fbad2aff6ba9e39cbe8779276c22d123a5e01c1` | 41 066 |
| `bk_golden_larch_impostor.png` | `9c40aa9003c8b576a974c3a381e93aedffe090413a9d00f625dcaed9796c46f5` | 8 azimuth frames, 4x2, 512 px |

Dimensions 20.511 x 39.09 x 22.788 m, bounds radius 11.394. It is a large tree:
course placements scale it to 0.40–0.50 (15.6–19.5 m) as an autumn accent at the
forest edge.
