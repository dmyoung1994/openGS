# Fresh pine-straw terrain material

`public/assets/textures/fresh_pine_straw_albedo_v2.png` was generated with the
built-in OpenAI ImageGen tool on 2026-08-31 for this project. An overly orange first
pass was rejected; the final targeted revision used this prompt:

> Use case: precise-object-edit. Asset type: seamless tileable game-terrain albedo
> texture representing a physical 2 meter by 2 meter area. Input images: Image 1 is
> the edit target; Image 2 is the real-world color and maintenance reference only.
> Primary request: revise only Image 1's pine-needle color distribution and natural
> material variation so it matches the fresh but believable maintained pine straw in
> Image 2. Color palette: reduce the strong uniform orange saturation by about 25
> percent; use a natural interwoven mix of approximately 55% warm russet needles, 30%
> muted copper-brown needles, and 15% older tan-brown needles; retain dark compact gaps
> between layers. Materials/textures: keep the same dense interlocking longleaf
> pine-needle mat, true 15–25 cm strand scale, layered curled strands, and nearly
> complete soil coverage; add subtle broad low-frequency density/value variation
> without isolated spots. Composition/framing: perfectly perpendicular top-down,
> edge-to-edge, same uniform real-world scale, no perspective or focal object.
> Lighting/mood: neutral flat cross-polarized scan lighting with no directional
> shadows, vignette, highlights, or ambient color cast. Constraints: change only the
> color/material variation; remain seamless on all four edges; no painted tint wash;
> no text, logo, or watermark. Avoid: saturated orange carpet, monochrome fibers,
> exposed dirt patches, gray litter, leaves, grass, moss, stones, pinecones, sticks,
> wood chips, hay, sawdust, obvious repetition, border.

The reference pair retained the shipped Poly Haven Forest Ground 03 albedo for scale
and an Augusta pine-straw photograph for colour and maintenance. SHA-256:
`73a0eb1d89acfbf6ab4eb4321641c86e1a1644fbe989ad38c33d4d33c734e0f9`.

`scripts/pack_fresh_pine_straw.py` resamples that source to 2048² and deterministically
derives registered roughness, tangent-normal, height, and ambient-occlusion channels.
The runtime uses the resulting two RGBA maps at a physical two-metre repeat:

- `fresh_pine_straw_color_roughness_v2.png`: albedo RGB + roughness A.
- `fresh_pine_straw_normal_height_ao_v2.png`: normal RG + height B + AO A.

The renderer keeps colour, normal, height, roughness, and AO on one UV and reuses the
existing bounded parallax path. This replacement adds no geometry, draw call, texture
binding, or terrain collision change.
