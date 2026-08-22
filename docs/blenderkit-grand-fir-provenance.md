# `blenderkit-grand-fir` provenance

Catalog id: **`blenderkit-grand-fir`** (`public/assets/environment/catalog.json`)

## Source

| field | value |
| --- | --- |
| Name | Grand Fir (8m) |
| Origin | BlenderKit |
| `assetBaseId` | `89409ff4-ba59-44c1-b482-4da17ed3f718` |
| URL | https://www.blenderkit.com/asset-gallery-detail/89409ff4-ba59-44c1-b482-4da17ed3f718/ |
| Licence | **Royalty Free** (BlenderKit free tier — *not* CC0) |
| Local source | `public/assets/trees_src/bk_alpine/grand_fir.blend` |
| Source sha256 | `9e30585f4ddeabe5eb9233a5731783dbf905ea642350f10cd7cca993212b5d3f` |

### Licence note

BlenderKit's free tier is Royalty Free, and the API reports no CC0 tree models at
all. The runtime catalog therefore records this asset as
`LicenseRef-BlenderKit-RoyaltyFree` — an explicit SPDX LicenseRef accepted
alongside `CC0-1.0` by `ACCEPTED_LICENSES` in `src/environment/EnvironmentCatalog.js`.
Royalty Free permits use of the model inside a rendered/interactive product but
restricts redistributing the asset itself; that trade-off was accepted knowingly
rather than by quietly widening the CC0 check.

## Build

```
Blender -b --python scripts/build_bk_tree.py -- bk_grand_fir_v10 \
  --output-dir public/assets/trees_candidates/bk_grand_fir_v10
Blender --background --python scripts/bake_tree_impostor.py -- \
  --input public/assets/trees/bk_grand_fir_lod0.glb \
  --output public/assets/trees/bk_grand_fir_impostor.png --frames 8 --size 512 \
  --exclude-material branches.001
node scripts/qa_tree_impostor.mjs public/assets/trees/bk_grand_fir_impostor.png
```

Pipeline version: `build_bk_tree@3-role-split-spatial-card-selection+preserve-area+neutral-impostor@2`

### Why role-split rather than a combined atlas

The earlier one-part pipeline (`scripts/build_blenderkit_tree.py`) flattens the
whole tree into a single baked atlas. On this source that fails: the needle cards
tile their texture roughly 50x, so normalising the mesh's UVs into 0..1 collapses
the entire canopy into a few pixel-wide strokes — about 1% of a 2048x4096 atlas,
against ~35% for the trunk. In engine the needles then sample mostly unbaked
texels and the tree renders as a sparse black speckle. The role-split build keeps
`trunk` / `branches` / `foliage` / `foliage_2` as separate primitives, each with
its own full-resolution tile and the mesh's original (tiled) UVs.

### Why each role's tile is baked, not copied

`fir_needles.png` is **tan** (opaque mean RGB 0.368/0.352/0.231). The green comes
from a Hue/Saturation node feeding a Translucent BSDF that is added to the
Principled lobe. Wiring the raw image into Base Color — the previous `keep:`
style — shipped a dusty-pink tree. `bake_material_tile()` bakes the evaluated
node graph into one 0..1 tile instead. It bakes on the **real role mesh** with a
`fract()`-wrapped UV layer, because these graphs mix shaders using Generated
coordinates that do not exist on a proxy plane.

Baked tile means (linear, inside authored coverage):

| role | tile | mean RGB |
| --- | --- | --- |
| `trunk` | 1024² | 0.397 / 0.321 / 0.247 |
| `branches` | 1024² | 0.239 / 0.190 / 0.142 |
| `foliage` | 512² | 0.275 / 0.295 / 0.170 |
| `foliage_2` | 512² | 0.297 / 0.315 / 0.197 |

## Runtime derivatives

| file | sha256 | triangles |
| --- | --- | --- |
| `bk_grand_fir_lod0.glb` | `c34a286f6c7742f2e778ee56a3d6c83e03a748f19a84de11bcd2f14c4dae6d7a` | 165 000 (trunk 9k, branches 26k, foliage 78k, foliage_2 52k) |
| `bk_grand_fir_lod1.glb` | `4a11b5dabc11c347796519f249016b65939e0db784f4bd87526130b29aec75f4` | 38 499 (trunk 2.5k, branches 6k, foliage 18k, foliage_2 12k) |
| `bk_grand_fir_impostor.png` | `f43bdca8d82d8885eb911495ace4c4e0d47d3ef79686db81a12de3191ab2e291` | 8 azimuth frames, 4x2, 512 px |

Dimensions 5.782 x 8.115 x 5.501 m, bounds radius 2.891, baseY 0.034, topY 8.149.

## Impostor bake change

`scripts/bake_tree_impostor.py` now thresholds alpha at `TREE_ALPHA_CUTOFF`
(0.05) instead of using it as a blend factor, matching how the runtime draws
foliage. Blending let every semi-transparent needle edge composite over the pale
bark behind it, so the card baked washed-out brown while the geometry it replaces
stayed dark green — a visible colour pop at the LOD handoff. The script also
accepts `--exclude-material` for dropping a role from the card bake.

QA gate result: coverage 17.0%, mean sRGB 51.1/62.3/31.5, green:red 1.22,
flat fraction 0.224 — passes.

## LODs preserve aggregate foliage area

Collapse decimation welds a needle quad's corners together and destroys the
silhouette its alpha depends on. Random whole-card deletion avoids torn cards
but still creates empty crown tiers. `thin_cards_to()` now bins card centroids in
a 12 x 12 x 36 crown grid, gives every occupied cell first refusal, and scales
surviving authored cards around their own centroids (1.12x LOD0, 1.38x LOD1).
This is bounded aggregate-area preservation: it keeps authored negative space
while stopping the lower crown from collapsing into a trunk and a few shelves.
LOD0 retains 19,526 + 10,365 intact foliage cards; LOD1 retains 4,726 + 2,508.
Roles remain classified by measured alpha coverage (`has_cutout` on the baked
tile), so opaque trunk and branch geometry are never treated as foliage cards.
