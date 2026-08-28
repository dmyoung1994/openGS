# NASA LRO Moon texture provenance

## Runtime asset

- Repository path: `public/assets/textures/moon_lroc_color_2k.jpg`
- Dimensions: 2048 × 1024, 8-bit JPEG, equirectangular, centered on 0° longitude
- SHA-256: `f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170`

## Source and credit

- Source: NASA Scientific Visualization Studio, [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)
- Original file: [lroc_color_2k.jpg](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg)
- Credit requested by the source page: NASA's Scientific Visualization Studio
- Visualizer: Ernie Wright (USRA)
- Science data: Lunar Reconnaissance Orbiter Camera Wide Angle Camera team

NASA SVS describes the map as a rendering-oriented adaptation of the Hapke-normalized
LROC WAC mosaic assembled from more than 100,000 observations. The 2025 map combines
the 643 nm, 566 nm, and 415 nm bands, is white-balanced toward human vision, and fills
the poorly illuminated polar gaps with the LRO laser-altimeter albedo map.

## Use terms

NASA's [Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
state that NASA image and 3D-rendering media, including texture maps, generally are not
subject to copyright in the United States and may be used in computer graphical
simulations when NASA is acknowledged and no endorsement is implied. This asset
contains no NASA identifier, logo, or recognizable person. The simulator credits NASA
as the source and makes no endorsement claim.

## Runtime treatment

The source JPEG is pinned byte-for-byte; no derivative resampling is committed. The
renderer decodes it as sRGB albedo, wraps it equirectangularly around the analytic moon
sphere, and applies the shared astronomical sun direction, phase terminator, and limb
falloff at runtime. The texture does not provide baked scene lighting, geometry, or
physics displacement.
