# Conifer v8 alpha-footprint production provenance

v8 is the reviewed production derivative of v7 for the catalog's
`polyhaven-fir-sapling-medium` alpine tree. The original trial bytes remain in
`public/assets/trees_candidates/conifer_v8/` for regression comparison; runtime
catalog URLs use the promoted copies under `public/assets/trees/`.

## Source and method

- Poly Haven Fir Tree 01, CC0: <https://polyhaven.com/a/fir_tree_01>
- Source GLTF SHA-256:
  `72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709`
- Source twig diffuse SHA-256:
  `8c0833a10e4fd44498d848cf9e659fe250a3813984cbd679f42430eb98c61fb8`
- Source twig alpha MD5: `02ab808c8b2ff77ad9fdb2f92892db80`

The v7 36-layer × 8-branch hierarchy, deterministic seed, real trunk/primary
branches, and three local planes per cluster are unchanged. For each macro tile,
the alpha-tested pixels at 16/255 are enclosed by a guarded, simplified
convex-hull polygon (epsilon 0.11 tile widths, 4-pixel radial guard, at most
6 vertices). UVs follow the hull and world-space plane extents follow its
tapered local coordinates, so transparent rectangular gutters are not
rasterized. The guard preserves the source alpha edge; no sun, shadow, AO, or
emission is baked.

Production paths declared by the catalog are:

- `/assets/trees/conifer_v8_lod0.glb`
- `/assets/trees/conifer_v8_lod1.glb`
- `/assets/trees/conifer_v8_impostor.png`

The standalone macro atlas is retained at `/assets/trees/conifer_v8_macro_atlas.png`
for inspection; the GLB materials contain their runtime atlas payload.

## CPU artifact evidence

| Asset | triangles | render vertices | bounds Y | SHA-256 |
| --- | ---: | ---: | --- | --- |
| LOD0 | 6,234 | 18,702 | 0 … 18.895 m | `a2557e64685bb3c4e1d0354c986e8724f84b4e91284877a170771251636dd925` |
| LOD1 | 5,030 | 15,090 | 0 … 18.895 m | `7d67ec2113b2eff760ec03648c903c630c5ce0854374f964b5c0dbe414fa9fac` |
| macro atlas | — | — | 1024×1024 RGBA | `6c47363530004dc7585d0cc0d2ad131dcadbafdb281aaedeea36ed334b089d75` |
| eight-view impostor | — | — | 2048×1024 RGBA | `029e6badad5b1983c16ab175928b991f3646054e220db580480b71957d67c593` |

Summed local-card area is `2,784.04` versus the v7 full tapered-card baseline
of `4,346.58`, a `35.95%` reduction. Alpha-aware masks retain 98.1–99.4% of
v7 silhouette pixels at 0°, 45°, 90°, and 135°. LOD1 retains 98.1–98.4% of
LOD0 pixels, with left/right balance 0.960–0.990. Root owns isolated engine
GPU evaluation and accepted the v8 production wiring. The promoted GLBs retain
the exact geometry, material, and BIN payloads of the trial; only glTF JSON
metadata clears `candidateOnly` and records the production generator. The PNG
atlas/impostor bytes are unchanged. `Trees.js` selects the same v8 macro-atlas
material branch from its authored material role, so promotion cannot silently
fall back to the v3–v6 shading path.
