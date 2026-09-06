# Fairway Grass005 provenance

- Source: ambientCG **Grass 005** (`Grass005`)
- Author/publisher: ambientCG (the official record names no individual contributor)
- Source page: https://ambientcg.com/view?id=Grass005
- API metadata: https://ambientcg.com/api/v2/full_json?id=Grass005&include=displayData,dimensionsData,mapData,downloadData,tagData
- Official archive: https://ambientcg.com/get?file=Grass005_2K-PNG.zip
- Archive SHA-256: `22ebad413aad388fd09e109cd2ecb4f8193b2af12908b8c3ba90f87438ec83e4`
- License: Creative Commons CC0 1.0 Universal
- License page: https://docs.ambientcg.com/license/
- Runtime calibration: **1.20 m × 1.20 m**
- Source resolution: 2048 × 2048 pixels (0.586 mm/texel at runtime calibration)
- Selection basis: official `clean`, `lawn`, and `short` tags; dense fine-bladed
  coverage; a complete color/normal/displacement/roughness/AO set; and no bare-soil,
  broadleaf-weed, or coarse yellow-thatch islands.

ambientCG does not declare physical dimensions for Grass005 (its API dimension fields
are zero). The runtime scale is therefore explicit project calibration, not publisher
metadata. A 1.20 m tile puts the source's dominant lying blade traces in the roughly
10–30 mm band, retains sub-millimetre texel density, and passed the canonical golfer-eye
and ball-adjacent WebGPU review without reading as oversized lawn. Do not silently
change this scale if ambientCG later publishes physical dimensions; re-audit it.

The official lossless source-map hashes are pinned in
`scripts/pack_ambientcg_grass005.py`. The packer fails closed if any source map does
not match the acquisition record. The 16-bit displacement is deterministically
rounded to the runtime's eight-bit packed channel; the authored OpenGL normal is not
derived, sharpened, or relit.

## Runtime derivative

The existing runtime binding names are retained so the replacement does not add
duplicate resident files or alter the texture-array contract:

- `public/assets/textures/blendkit_fairway_alb.png`
  - RGB: source sRGB color
  - A: source roughness
  - SHA-256: `129d315bbc22e6ff05a6fb5a3c54474ec9845b86afbdf615a4e8a21f996cdc76`
- `public/assets/textures/blendkit_fairway_nrh.png`
  - RG: source OpenGL normal X/Y
  - B: source displacement
  - A: source ambient occlusion
  - SHA-256: `300200a8f864dd383ba05dc8688e97196081419d06005362dd45b7a334932970`

Measured runtime means are linear albedo luminance `0.20198728`, displacement
`0.25848001`, AO `0.60995079`, and roughness `0.70157140`. Terrain preserves resolved
fine-blade color and registered PBR response near the ball, then resolves the finite
tile to measured means by screen-space footprint before repetition becomes visible.

## Reproduction

```sh
curl -L 'https://ambientcg.com/get?file=Grass005_2K-PNG.zip' -o /tmp/Grass005_2K-PNG.zip
unzip /tmp/Grass005_2K-PNG.zip -d /tmp/Grass005_2K-PNG
python3 scripts/pack_ambientcg_grass005.py /tmp/Grass005_2K-PNG
```
