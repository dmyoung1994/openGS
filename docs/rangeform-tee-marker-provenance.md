# Rangeform crest and limestone tee-marker provenance

## Brand source

The selected crest was generated with the built-in ImageGen tool, then reduced to
deterministic vector contours for the production logo and carved marker geometry.
The original transparent source is retained unchanged.

- Selected output: interlocking heritage `RF` cipher, generation UUID suffix `1136`
- Runtime source: `public/assets/branding/rangeform-crest-imagegen.png`
- SHA-256: `13085bd8980b60a6999880cdb76279c3110efa8fe61f9ebcd64e4a280b770ae0`
- Production vectors: `rangeform-crest.svg`, `rangeform-crest-mono.svg`
- Trace contract: alpha threshold 32, 3 px contour approximation, even-odd fill

Final ImageGen prompt:

> Create an original high-end country-club emblem for Rangeform built around an
> exact interlocking serif `RF` cipher inside a restrained circular double-ring
> seal. Use a single deep forest green on transparency, strong broad vector-like
> shapes, balanced negative space, and no other lettering, gradients, shadows,
> texture, mockup, 3D treatment, golf ball, crossed clubs, crown, or watermark.

## Stone material

- Source: [ambientCG Travertine 009](https://ambientcg.com/view?id=Travertine009)
- License: CC0 1.0
- Download: `Travertine009_1K-JPG.zip`
- Physical source size: 1.2 m x 1.2 m
- Runtime maps: original 1K JPG color, OpenGL normal, roughness, and ambient occlusion

| Runtime map | SHA-256 |
| --- | --- |
| `travertine_009_color_1k.jpg` | `6561c87d92aef321aef4095fbcc5518cec4d711e642be6beaa90d13829e6cd2b` |
| `travertine_009_normal_gl_1k.jpg` | `635256a78537253a2d2bc5fef5fcda6e4e03349b960c57f15cf721b7cf5ba098` |
| `travertine_009_roughness_1k.jpg` | `f4094c2149e257f4b6e17e5c5da70101fcbffaf0ce4016ab5d6aac7e45112e37` |
| `travertine_009_ao_1k.jpg` | `6333a47aa0ee5007da41f095aad67536658a68cdd88a3d21e7dd4469fdb6389b` |

## Production model

Run `npm run marker:build` to regenerate the SVGs and GLB from the pinned crest
paths. The output is one indexed primitive with 6,404 vertices and 8,800 triangles.
It is a 21 cm stone sphere buried 3 cm into the turf, with a player-facing 45-degree
planar cut, 18.5 cm logo face, UV0/UV1, normals, vertex-darkened engraving patina,
and a 2 mm carved crest recess. The patina remains part of the same stone PBR draw.

- Runtime GLB: `public/assets/props/rangeform-tee-marker/rangeform-limestone-tee-marker.glb`
- SHA-256: `aaff1acaee6c112cf704774afe562d4af6446da0de39d70429263ffb495f4569`
