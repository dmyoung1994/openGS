# Course Creator earth frame material

The exposed side wall beneath the Course Creator's finite green uses Poly Haven's
**Dirt** scan. It replaces the former procedural brown vertex tint
with registered albedo, OpenGL normal, and roughness maps.

- Source: https://polyhaven.com/a/dirt
- Author: Charlotte Baglioni
- License: CC0 1.0
- Source dimensions: 2 m × 2 m
- Runtime derivatives: 1K JPG diffuse, OpenGL normal, and roughness
- Diffuse SHA-256: `6ce6ca7e28ed046f7f93fa60dcb29f8cf42cd5a539adc5676675acccfa34efd3`
- Normal SHA-256: `5a5f97d920fdcdf352b350b95558bf48bb306be1fe61a47418aadc60b7deb0ce`
- Roughness SHA-256: `eff62d5ae7bf0c46b84173bc46f07528dd164aa39f5d550c93a805b36f54b704`

The side-wall UV follows physical distance around the organic perimeter and physical
depth down the wall, both at the scan's authored 2 m repeat. The seam owns a
duplicated vertex column so the repeat never stretches across the closing segment.
The presentation wall remains separate from authoritative terrain and collision.
