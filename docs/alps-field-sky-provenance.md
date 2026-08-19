# Alps Field 2K HDR

- Source: https://polyhaven.com/a/alps_field
- Official file API: https://api.polyhaven.com/files/alps_field
- Metadata API: https://api.polyhaven.com/info/alps_field
- Asset: `alps_field_2k.hdr`
- Resolution: 2048 × 1024 Radiance HDR
- Poly Haven API MD5: `5abfeb43c4d60566973da21483e8cfbd`
- Repository SHA-256: `90ef5a4e0c46d0177a06406b59142a6bb426176a85c195fa23d2e443383a9e12`
- License: CC0
- Author: Andreas Mischok
- Capture metadata: Alps alpine valley, sunny partly-cloudy morning/afternoon,
  high-contrast natural light.
- Measured source solar direction in Three HDRLoader/equirectangular
  convention: `(0.599337, 0.670422, 0.437413)`.
- Rotation: `-2.929351` radians around +Y aligns source azimuth with the
  authoritative game sun. Source elevation differs, so WeatherSky removes the
  measured solar core for IBL and adds only the authoritative analytic sun
  delta; no duplicate directional sun is introduced.

`sky-manifest-kloofendal-1k.json` and the original 1K HDR remain available as
the rollback A/B baseline. Promotion is contingent on fixed evaluator captures
showing a better alpine horizon without a ground seam or photographic billboard
conflict.
