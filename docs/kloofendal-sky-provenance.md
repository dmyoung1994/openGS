# Kloofendal 48d Partly Cloudy Pure Sky

- Source: https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
- Official file API: https://api.polyhaven.com/files/kloofendal_48d_partly_cloudy_puresky
- Asset: `kloofendal_48d_partly_cloudy_puresky_1k.hdr`
- Resolution: 1024×512 Radiance HDR
- Poly Haven API MD5: `c69498687e876bf68d2a8b8a62234eb9`
- Repository SHA-256: `fd94c84997b8a3c353b62c2125a9b44e19509956986a126e472684432a02d798`
- License: CC0
- Authors: Greg Zaal (original), Jarod Guest (sky edits)
- Offline source bright-sun direction in Three's equirectangular convention:
  approximately `(0.55304, 0.74301, 0.37694)`.
- The authoritative game sun remains the sole direct light. The HDR is rotated by
  `-2.962` radians around +Y for source-azimuth alignment and is not used to create
  another directional light. Because source elevation is about 48.2° while the
  authored sun is about 37.2°, WeatherSky removes the measured 1–5° solar core/halo
  from the HDR sample and adds only the authoritative analytic sun delta; PMREM and
  water therefore receive no unshadowed duplicate direct key.
