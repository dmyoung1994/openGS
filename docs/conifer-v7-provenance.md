# Conifer v7 volumetric local-cluster candidate provenance

v7 is an isolated, candidate-only derivative for root's production-path
evaluation. It does not modify or replace v3/v4/v5/v6, the production catalog,
`Trees.js`, viewer mappings, course data, or benchmark definitions.

## Source and neutral composition

- Poly Haven Fir Tree 01, CC0: <https://polyhaven.com/a/fir_tree_01>
- Source GLTF SHA-256:
  `72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709`
- Source twig diffuse SHA-256:
  `8c0833a10e4fd44498d848cf9e659fe250a3813984cbd679f42430eb98c61fb8`
- Source twig alpha MD5: `02ab808c8b2ff77ad9fdb2f92892db80`

The deterministic builder retains the v6 real trunk and 36 crown layers × 8
primary branch centers. Every primary and interior local cluster is made from
three tapered planes distributed around its local branch axis, rather than one
preferred plane. LOD0 and LOD1 consume the same seed and center sequence;
structural cylinder side count is the only tier simplification. The shared
1024×1024 macro atlas is composed from source RGB/alpha maps at the runtime
16/255 alpha cutoff. No sun, shadow, ambient occlusion, or emission is baked.

The far candidate is an 8-azimuth, 4×2 neutral impostor generated from the v7
LOD0 mesh and the same macro atlas. It remains runtime-lit and is not wired to
the production tree path.

## CPU geometry and mask evidence

| Asset | triangles | glTF-Transform render vertices | bounds Y | SHA-256 |
| --- | ---: | ---: | --- | --- |
| LOD0 | 5,116 | 15,348 | 0 … 18.895 m | `d2b4eed793a301ddbee08c848da774372feaeebd72f39bea21534a1bf26e6ec9` |
| LOD1 | 3,912 | 11,736 | 0 … 18.895 m | `b1b962d0eaa0064345ad9bcbf66e6f818777419576ba4b05c634124234da5dfa` |
| macro atlas | — | — | 1024×1024 RGBA | `6c47363530004dc7585d0cc0d2ad131dcadbafdb281aaedeea36ed334b089d75` |
| eight-view impostor | — | — | 2048×1024 RGBA | `7b85e2d8b063d76c2c27e6cfc8038b9c0639f641402579b0fdf50d1dfba81c32` |

Alpha-aware orthographic masks use the exact atlas cutoff and common scale.
Results are `(LOD0 pixels, LOD1 pixels, LOD1/LOD0 ratio, LOD1 left/right
balance)`:

| azimuth | mask pixels | ratio | LOD1 balance |
| ---: | ---: | ---: | ---: |
| 0° | 11,894 / 11,740 | 0.9871 | 0.9875 |
| 45° | 11,997 / 11,785 | 0.9823 | 0.9927 |
| 90° | 11,893 / 11,700 | 0.9838 | 0.9674 |
| 135° | 11,805 / 11,607 | 0.9832 | 0.9663 |

All metrics exceed the candidate contract of 55% LOD1 occupancy and 0.55
left/right balance. Root owns isolated engine viewer review; this CPU artifact
is not a production promotion.
