# Maintained turf Grass001 provenance

- Source: ambientCG **Grass 001** (`Grass001`)
- Author/publisher: ambientCG
- Source page: https://ambientcg.com/view?id=Grass001
- Official archive: https://ambientcg.com/get?file=Grass001_1K-JPG.zip
- Archive SHA-256: `902f447a64171c8099589642d5bf2d1d6e52c40e94d957eb78eae722084b0cfb`
- License: Creative Commons CC0 1.0 Universal
- License page: https://docs.ambientcg.com/license/
- Physical scan size: **1.40 m × 1.40 m**, as declared by the ambientCG v2 API
- Source resolution: 1024 × 1024 pixels (1.367 mm/texel)

Pinned source-map SHA-256 values are embedded in
`scripts/pack_ambientcg_grass001.py`. The packer fails closed if an official map
does not match those values.

## Runtime derivative

The source is packed into the existing two texture reads:

- `public/assets/textures/turfdetail_alb.png`
  - RGB: source sRGB color
  - A: source linear roughness
  - SHA-256: `c597fbd00dbb4e1c7476297f34607982314ab91ac48636b979efbc036ab73d3c`
- `public/assets/textures/turfdetail_nrh.png`
  - RG: source OpenGL normal X/Y
  - B: source displacement
  - A: source ambient occlusion
  - SHA-256: `a3fb4ceb7eb5063027fc22aa33ebcd621b96556b78d7729c5a2e1aace33d1539`

No source lighting is synthesized or baked into the normal map. Terrain keeps the
source's declared 1.40 m repeat, normalizes its measured linear albedo luminance in
the shader, and uses the existing texture-footprint resolve to remove source motifs
when they cease to be resolvable. Course-scale variation remains world-stable and
separate from this finite tile.
