# Conifer v4 candidate provenance

This is an isolated, viewer-only tree candidate. It is not registered in the
production tree catalog and is not referenced by `Trees.js`, course data, or
the range scene.

## Source

- Poly Haven Fir Tree 01, CC0: <https://polyhaven.com/a/fir_tree_01>
- Local source package: `public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf`
- Variant-A source GLTF SHA-256:
  `72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709`
- Source twig diffuse SHA-256:
  `8c0833a10e4fd44498d848cf9e659fe250a3813984cbd679f42430eb98c61fb8`
- Source twig alpha MD5 (the paired Poly Haven mask):
  `02ab808c8b2ff77ad9fdb2f92892db80`

The atlas uses the source-authored twig RGB and alpha maps. No AO, sun, or
shadow is baked into it. The alpha cutoff is a runtime MASK at `0.06`.

## Bake method

`scripts/build_conifer_v4.py` builds a deterministic geometry-first trunk and
primary-branch scaffold, then places many small source-textured local sprays
around whorls and crown volumes. This is a project-authored derivative of the
complete-crown silhouette reference; it does not select random individual
source triangles and does not ship the source tree's multi-million-triangle
mesh. The atlas is a 1024x1024 RGBA PNG with 4x4 tiles and cleared one-pixel
tile gutters. A single masked PBR material is embedded in each GLB.

The bake seed is `0xC04F4E`. Both LODs traverse the same 36-layer/8-branch
whorl hierarchy and retain all twelve local sprays plus 620 volume centres;
LOD1 uses crossed-pair cards instead of the close tier's four planes. This
keeps the crown layers registered while reducing topology. Both
LODs are grounded at `y=0` and vertically registered to `18.895 m` after local
spray composition:

| Candidate | triangles | glTF-Transform render vertices | bounds Y | GLB SHA-256 |
| --- | ---: | ---: | --- | --- |
| LOD0 | 38,884 | 116,652 | 0 … 18.895 m | `badaf1385f2f63c385f9379e1cdf216e701d3b69b1e34e7064b9dda79502cda1` |
| LOD1 | 20,724 | 62,172 | 0 … 18.895 m | `39b1893edd6cb87d31e3f05eba92551dff56f1c6c1522877aa090cb90c5c9170` |

Here “render vertices” means index references processed by the vertex shader,
matching `gltf-transform inspect`; it is intentionally not the smaller
deduplicated upload-vertex count.

Atlas SHA-256:
`4a0770c24e9eb6a92d66cc2f0dd0c0a2233215ddbbb49f81b2264551fb5d01e6`.

## Review status

CPU/build artifact only. The candidate has not been promoted or GPU-captured in
this cycle. Any visual/performance acceptance requires a later isolated viewer
review under production lighting; the runtime mapping is deliberately limited
to `src/viewer/assets.js` candidate entries.
