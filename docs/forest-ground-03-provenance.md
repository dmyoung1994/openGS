# Poly Haven Forest Ground 03 provenance

[Forest Ground 03](https://polyhaven.com/a/forrest_ground_03) is a CC0 Poly
Haven material depicting fallen pine needles, twigs, and forest litter. The
course fetches the exact 2K JPEG albedo, OpenGL normal, packed ARM, and displacement
maps exposed by Poly Haven's API. `scripts/fetch_polyhaven_forest_ground_03.mjs`
pins and verifies every upstream MD5 before writing a source file.

`scripts/pack_forest_ground_03.py` then creates two registered 2K RGBA bindings:

- `forrest_ground_03_color_roughness_2k.png`: source albedo RGB + ARM roughness G.
- `forrest_ground_03_normal_height_ao_2k.png`: OpenGL normal RG + displacement R + ARM AO R.

The packed files are declared in `public/assets/visual-quality-manifest.json` with
byte counts and SHA-256 digests. Packing changes only channel layout; it does not
procedurally replace or reinterpret the authored surface.

The maps repeat at a physical two-metre scale. A bounded three-layer parallax
march interprets the authored displacement as 28 mm of pine-straw and twig relief,
then retires by screen footprint and grazing angle before it can smear. Normal,
height, AO, roughness, and colour share the same UV and the sampled tangent normal
is composed with the terrain basis on slopes.

One terrain-owned R8 habitat field drives both the litter material and long-grass
eligibility. Pine litter is exclusive: every crown-habitat texel rejects blade
geometry, while actual rough and deep rough outside that habitat retain grass.
The material shoulder remains filtered in the ground shader. Tees, fairways, fringes,
greens, bunkers, and water remain authoritative even where a canopy overlaps them.
