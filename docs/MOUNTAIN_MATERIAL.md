# Alpine mountain material

The distant alpine shell keeps its procedural GPU geometry and authoritative
height sampler. Its exposed-rock PBR response uses Poly Haven's **Rocky
Terrain** aerial scan as a physically scaled 90 m material source.

- Source: https://polyhaven.com/a/rocky_terrain
- Author: Amal Kumar
- License: CC0 1.0
- Source dimensions: 90 m × 90 m
- Runtime derivatives: 1K JPG diffuse and OpenGL normal
- Diffuse SHA-256: `429315865fd89c150272592f6d93def174c6f69804a565ff08e53627a885579b`
- Normal SHA-256: `a6556e1220c6e6c822e68ceeb9589719e4db8c87340199657cc705fea6ecf391`

Only the two runtime derivatives are shipped. Original high-resolution source
files and Blender authoring files are not deployed.

The scan is sampled in the WebGPU node shader through world-space top and
steep-face projections. Its original ground color is not used literally on the
cliff: luminance establishes granite slabs and cracks, restrained chroma carries
weathering, and the matching normal map supplies registered surface response.
Authored slope/cover data selects exactly one base substrate (vegetation,
intact granite, or deposited talus); snow is deposited last in up-facing
cavities and benches. Mountain vertices, sampler output, displacement amplitude,
the Band A/ribbon dead belt, atmosphere, and gameplay terrain are unchanged.
