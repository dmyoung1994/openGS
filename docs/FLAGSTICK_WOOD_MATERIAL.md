# Premium walnut flagstick material

The flagstick albedo was generated specifically for Rangeform with the built-in
OpenAI image-generation tool on 2026-08-28. It is not a downloaded third-party
material. The production derivative is:

- `public/assets/materials/flagstick/premium_walnut_albedo_1k.png`
- 1024 × 1024 RGB PNG, 1,645,194 bytes
- SHA-256: `98029f83b7a0559e6eee1c37542ca5e85cb94f23a144d64c308c41502998fab7`
- Source generation: 1254 × 1254 RGB PNG
- Source SHA-256: `6a959aafe90bce1bebab2b4b30ece6fd1bf0263b70a687ff5c3194d45d7d949f`
- Derivative operation: `sips -z 1024 1024`

## Generation prompt

> Use case: product-mockup. Asset type: seamless PBR albedo texture for a
> premium wooden golf flagstick in a real-time WebGPU golf simulator. Create a
> seamless square hardwood texture with elegant straight longitudinal grain for
> a slender cylindrical flagstick. Use an orthographic flat scan appearance,
> vertical grain, diffuse even exposure, warm medium-dark walnut/mahogany color,
> subtle pores, restrained golden variation, and no baked gloss, lighting,
> shadows, large knots, plank seams, end grain, objects, hardware, text, borders,
> vignette, watermark, cracks, or dramatic color variation.

## Runtime treatment

The texture wraps once around the 12–15 mm tapered circular pole and once over
its 2.48 m length, with trilinear mipmaps and 8× anisotropy. The source contains
no baked highlight. `MeshPhysicalMaterial` supplies the clear finish with 0.62
clearcoat and 0.24 clearcoat roughness under the shared environment lighting.
