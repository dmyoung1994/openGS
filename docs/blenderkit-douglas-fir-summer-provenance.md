# `blenderkit-douglas-fir-summer` provenance

Catalog id: **`blenderkit-douglas-fir-summer`** (`public/assets/environment/catalog.json`)

| Field | Value |
| --- | --- |
| BlenderKit asset | Tree Dougles Fir / Tree Fir Summer |
| `assetBaseId` | `61faa48a-786a-427f-a318-5242f98447bb` |
| Source URL | https://www.blenderkit.com/asset-gallery-detail/61faa48a-786a-427f-a318-5242f98447bb/ |
| Access | Free |
| License | BlenderKit Royalty Free |
| Downloaded blend SHA-256 | `19bc2d96a53e6554ccb454e521804994f19ad644b595f17dcd85d9ff2ecb96af` |

The runtime derivatives were built with `scripts/build_bk_tree.py`. The source's
separate 1K leaf colour and opacity maps are packed into one cutout texture, with
a 0.78 foliage exposure grade chosen in the production range under its real
daylight. The authored 25.439 m dimensions are retained; the model is not an
enlarged sapling.

The eight-view far atlas is a lighting-neutral derivative from
`scripts/bake_tree_impostor.py`; all sun, sky, fog, wind, and shadow response is
applied by the runtime.
