# Blendkit turf provenance (green and superseded fairway)

The putting green uses a locally downloaded Blendkit material. The former fairway
source is retained below as a historical audit record, but it was replaced by the
CC0 ambientCG Grass005 material documented in
`docs/ambientcg-grass005-fairway-provenance.md`. The runtime never fetches Blendkit
or evaluates Blender nodes.

## Superseded fairway source

- Material: **Procedural Grass** / **Realistic Grass**
- Asset page: <https://www.blendkit.com/asset-gallery-detail/5b9e35dc-d8e7-4e16-a038-b48d5b8a925f/>
- Base asset ID: `5b9e35dc-d8e7-4e16-a038-b48d5b8a925f`
- Resolved version ID: `5e17ad03-1641-4068-ace0-83ce7a02c2bb`
- Local source: `public/assets/materials_src/blendkit/realistic-grass.blend`
- Source SHA-256: `4049fc373328129c366e1eaca82093dd7384c3d6a2030ff39f1e336c7d86f85a`
- Former runtime tile: **1.80 m × 1.80 m**, 2048² pixels

## Green

- Material: **Golf Bentgrass**
- Asset page: <https://www.blendkit.com/asset-gallery-detail/34a832ef-bb9d-4213-89e9-9143b137d99e/?query=category_subtree:material+bentgrass+order:_score>
- Base asset ID: `34a832ef-bb9d-4213-89e9-9143b137d99e`
- Resolved version ID: `3e8efd11-e46b-4d3c-bafe-f0d7e902278c`
- Local source: `public/assets/materials_src/blendkit/golf-bentgrass.blend`
- Source SHA-256: `945866ca523dae46b6dfe1db9ad5611848eb55e9c0ba47f15081d4b741765edb`
- Runtime tile: **1.50 m × 1.50 m**, 2048² pixels

Both historical source records are marked **Royalty Free** by Blendkit. The source URLs, asset
IDs, version IDs, and hashes stay with the project so the derivative can be audited;
any redistribution should continue to follow the current Blendkit asset terms.

## Runtime packing

`scripts/bake_material.py` bakes base colour, roughness, tangent normal, and a
normalized procedural height signal. The Bentgrass file exports a mathematically flat
normal, so the packer derives a restrained 4 mm tangent normal from its prefiltered
source height; authored non-flat normals, including the fairway normal, pass through
unchanged. `scripts/pack_blendkit_turf.py` then produces the two texture reads used by
`Terrain.js`:

- `blendkit_*_alb.png`: RGB sRGB base colour, A roughness.
- `blendkit_*_nrh.png`: R/G tangent normal XY, B normalized canopy height, A white
  AO. The plane bake has no trustworthy cast-shadow AO, so directional self-shadow
  is computed from the height field under the scene sun.

The green bake preserves its own albedo, normal, height, and roughness response. No
fairway or green blade-clump geometry is added; geometry remains reserved for rough
and deep rough.

The checked-in Blendkit runtime derivatives are now the green maps only:

| file | SHA-256 |
| --- | --- |
| `public/assets/textures/blendkit_green_alb.png` | `502dcafa3446fe49774093effd914e507905dabf6ea6088ea2c71928873af73b` |
| `public/assets/textures/blendkit_green_nrh.png` | `820a6fc5c3be0a271ac95975e42f4cf079627d2aa88017192044cd485fa96668` |

To reproduce the acquisition step with the pinned version IDs:

```sh
python3 scripts/blenderkit_download.py 5e17ad03-1641-4068-ace0-83ce7a02c2bb /tmp/realistic-grass.blend
python3 scripts/blenderkit_download.py 3e8efd11-e46b-4d3c-bafe-f0d7e902278c /tmp/golf-bentgrass.blend
```

To reproduce the historical CPU bakes for audit, write the packed result to a
temporary directory. Do not copy its fairway output over the active Grass005 maps:

```sh
Blender --background public/assets/materials_src/blendkit/realistic-grass.blend \
  --python scripts/bake_material.py -- /tmp/golfsim-blendkit-2k fairway 2048 1.8 8
Blender --background public/assets/materials_src/blendkit/golf-bentgrass.blend \
  --python scripts/bake_material.py -- /tmp/golfsim-blendkit-2k green 2048 1.5 8
python3 scripts/pack_blendkit_turf.py /tmp/golfsim-blendkit-2k /tmp/golfsim-blendkit-packed \
  --fairway-name fairway --green-name green
```

The source files, fixed settings, runtime channel layout, and hashes are the
reproducibility record.
