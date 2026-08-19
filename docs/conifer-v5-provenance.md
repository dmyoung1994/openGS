# Conifer v5 candidate provenance

v5 is an isolated candidate-only derivative. It does not replace v4 and is not
registered in the production tree catalog, `Trees.js`, course data, or runtime
viewer mappings.

## Source and hierarchy

- Poly Haven Fir Tree 01, CC0: <https://polyhaven.com/a/fir_tree_01>
- Local source GLTF SHA-256:
  `72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709`
- Source twig diffuse SHA-256:
  `8c0833a10e4fd44498d848cf9e659fe250a3813984cbd679f42430eb98c61fb8`
- Source twig alpha MD5:
  `02ab808c8b2ff77ad9fdb2f92892db80`

The bake seed is `0xC04F4E`. Both geometry tiers use the v4 36-layer/8-branch
hierarchy, all local branch centres, crossed-pair sprays, and the same 1024²
source-authored RGB/alpha branchlet atlas. v5 LOD0 is the accepted v4 LOD1
population (20,724 triangles). v5 LOD1 keeps every whorl/crown layer and a
deterministic outer subset of six local sprays per branch plus 167 volume
sprays (12,000 triangles), avoiding bare-pole decimation.

## Offline normal and impostor bake

After geometric normals are generated, branchlet vertices outside atlas tile 0
use the bounded parent-puffiness blend that v4 evaluated at runtime:

`normal = normalize(0.64 * sourceNormal + 0.36 * parentOutward)`

The parent outward vector uses a `0.12` vertical weight. Tile 0 remains on its
authored/geometric bark normal. This is a normal attribute bake only; no sun,
sky, AO, or emissive term is written into the GLB or texture.

The existing offline source-atlas rasterizer produces a neutral 8-azimuth,
4×2 impostor (`2048×1024`, 512 px/frame). Runtime lighting remains required.
Measured alpha coverage at the runtime 16/255 cutoff is `0.174703`.

| Asset | triangles | glTF-Transform render vertices | bounds Y | SHA-256 |
| --- | ---: | ---: | --- | --- |
| LOD0 | 20,724 | 62,172 | 0 … 18.895 m | `63d4ba1293fa86a487498a75f1c41f9a4da8505cded1c4bf2a90e0560453bb22` |
| LOD1 | 12,000 | 36,000 | 0 … 18.895 m | `e6100d890a4f3c2b5bf0643dae59d53a20dbc13d91d601b70952b458b5af1ddb` |
| branchlet atlas | — | — | 1024×1024 RGBA | `4a0770c24e9eb6a92d66cc2f0dd0c0a2233215ddbbb49f81b2264551fb5d01e6` |
| impostor | — | — | 2048×1024 RGBA | `105e9de0d50cd0c97d298e354b4b07a07e968a0ba15883c517932695c7410ee6` |

“Render vertices” is the index-reference count reported by
`gltf-transform inspect`, not the deduplicated upload count.

## Review status

CPU/build artifact only. Root owns isolated visual/runtime evaluation and any
future viewer or production wiring decision.
