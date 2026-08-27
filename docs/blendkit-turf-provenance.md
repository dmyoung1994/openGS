# Blendkit turf provenance

The playable maintained turf uses two locally downloaded Blendkit materials. The
runtime never fetches BlenderKit and never evaluates Blender nodes; Blender is used
once to bake the authored material into the two PBR textures consumed by the WebGPU
terrain shader.

## Fairway

- Material: **Procedural Grass** / **Realistic Grass**
- Asset page: <https://www.blendkit.com/asset-gallery-detail/5b9e35dc-d8e7-4e16-a038-b48d5b8a925f/>
- Base asset ID: `5b9e35dc-d8e7-4e16-a038-b48d5b8a925f`
- Resolved version ID: `5e17ad03-1641-4068-ace0-83ce7a02c2bb`
- Local source: `public/assets/materials_src/blendkit/realistic-grass.blend`
- Source SHA-256: `4049fc373328129c366e1eaca82093dd7384c3d6a2030ff39f1e336c7d86f85a`
- Runtime tile: **1.80 m × 1.80 m**, 2048² pixels

## Green

- Material: **Golf Bentgrass**
- Asset page: <https://www.blendkit.com/asset-gallery-detail/34a832ef-bb9d-4213-89e9-9143b137d99e/?query=category_subtree:material+bentgrass+order:_score>
- Base asset ID: `34a832ef-bb9d-4213-89e9-9143b137d99e`
- Resolved version ID: `3e8efd11-e46b-4d3c-bafe-f0d7e902278c`
- Local source: `public/assets/materials_src/blendkit/golf-bentgrass.blend`
- Source SHA-256: `945866ca523dae46b6dfe1db9ad5611848eb55e9c0ba47f15081d4b741765edb`
- Runtime tile: **1.50 m × 1.50 m**, 2048² pixels

Both source records are marked **Royalty Free** by Blendkit. The source URLs, asset
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

The fairway and green maps are selected by the analytic turf masks and preserve their
own albedo, normal, height, and roughness response. The shader deliberately samples
the colour maps with a 2-mip prefilter and compresses their contrast around a physical
turf pigment. Normal, height, and roughness remain at the full screen-selected 2048²
footprint. This prevents procedural colour flecks from becoming noisy green-black
speckle while fine detail still responds to the real scene light. No fairway or green
blade-clump geometry is added; the existing geometry carpet remains reserved for
rough/deep rough.

The checked-in runtime derivatives are:

| file | SHA-256 |
| --- | --- |
| `public/assets/textures/blendkit_fairway_alb.png` | `ecfa186e0296084e044f4143465e36c6836d81c22f9475901d5c1c347f7ec4c2` |
| `public/assets/textures/blendkit_fairway_nrh.png` | `6a5a70cb1c15e2cc3477928f42897cbdcb64e7c1c1d0d2c2f152a4dd6fca4db5` |
| `public/assets/textures/blendkit_green_alb.png` | `502dcafa3446fe49774093effd914e507905dabf6ea6088ea2c71928873af73b` |
| `public/assets/textures/blendkit_green_nrh.png` | `820a6fc5c3be0a271ac95975e42f4cf079627d2aa88017192044cd485fa96668` |

To reproduce the acquisition step with the pinned version IDs:

```sh
python3 scripts/blenderkit_download.py 5e17ad03-1641-4068-ace0-83ce7a02c2bb /tmp/realistic-grass.blend
python3 scripts/blenderkit_download.py 3e8efd11-e46b-4d3c-bafe-f0d7e902278c /tmp/golf-bentgrass.blend
```

To reproduce the checked-in 2048² CPU bakes and packed runtime maps:

```sh
Blender --background public/assets/materials_src/blendkit/realistic-grass.blend \
  --python scripts/bake_material.py -- /tmp/golfsim-blendkit-2k fairway 2048 1.8 8
Blender --background public/assets/materials_src/blendkit/golf-bentgrass.blend \
  --python scripts/bake_material.py -- /tmp/golfsim-blendkit-2k green 2048 1.5 8
python3 scripts/pack_blendkit_turf.py /tmp/golfsim-blendkit-2k public/assets/textures \
  --fairway-name fairway --green-name green
```

The source files, fixed settings, runtime channel layout, and hashes are the
reproducibility record.
