# Alpine backdrop DEM prototype

This prototype uses a compact, offline-processed height sample from the USGS
3D Elevation Program (3DEP) Bare Earth DEM Dynamic service. It is render-only;
the course physics heightfield and all gameplay placement remain unchanged.

## Source and license

- Provider: U.S. Geological Survey (USGS), The National Map / 3DEP.
- Dataset/service: `3DEPElevation` ImageServer, USGS 3DEP Bare Earth DEM Dynamic.
- Official source endpoint used on 2026-08-13:
  `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=-121.35,48.715,-121.25,48.785&size=128,128&format=tiff&pixelType=F32&bboxSR=4326&imageSR=4326&f=image`
- Geographic bounds (WGS84 EPSG:4326): west `-121.35`, south `48.715`, east
  `-121.25`, north `48.785` (North Cascades / Picket Range, Washington).
- Service response: 128 x 128 float32 GeoTIFF, elevation in metres; source
  response range 271.1007996–2466.9582520 m.
- USGS 3DEP products are public domain. The USGS specification states that all
  3DEP products are public domain: https://pubs.usgs.gov/tm/11b9/tm11B9.pdf
  (see the product description and licensing note). The program overview is
  also maintained at https://www.usgs.gov/3d-elevation-program/about-3dep-products-services.

## Checked-in artifacts

- `public/assets/terrain/north-cascades-pickets-128.png` — 16-bit normalized
  grayscale PNG, 128 x 128, 28 KiB (`sha256`:
  `3e3f7bdb41c4d1d1b272cd9b25952e4319419e30d8cd09907c85b358055f7b42`).
- `src/terrain/northCascadesDem.js` — generated `Uint16Array` runtime table,
  94 KiB (`sha256`:
  `17ed54f7793ebdabd71e67f70a5888f52923cc4397cd929551ff09c4858c16d1`).
  Keeping the table bundled avoids a runtime fetch; the PNG is the portable
  offline height asset that can be inspected or regenerated.
- The fetched source response used to generate these artifacts had
  `sha256` `02e2a18c3e33f215cd8627aa2d5ec52c65daf158eb79d5422c557d6e71ba6357`.

Regenerate from an official response with:

```sh
curl -fsSL 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=-121.35,48.715,-121.25,48.785&size=128,128&format=tiff&pixelType=F32&bboxSR=4326&imageSR=4326&f=image' -o /tmp/north-cascades-3dep.tif
python3 scripts/build_backdrop_dem.py /tmp/north-cascades-3dep.tif \
  --png public/assets/terrain/north-cascades-pickets-128.png \
  --module src/terrain/northCascadesDem.js
```

The script linearly quantizes the source range to 16-bit unsigned samples. The
runtime maps that square to a 7.6 km x 7.6 km world-space field, bilinearly
samples it, and clamps at the edge (no repeat/tile). A 180 m smootherstep apron
blends every sample exactly into the authoritative playable terrain. Existing
ring meshes, shared world-space PBR material, patch normals, draw/pass count,
and deterministic seeded meso breakup are preserved.

## Visual/performance scope

The DEM changes only the low-frequency alpine ridge/drainage skeleton. The
existing CPU ring sampler still supplies meso erosion and material geology, so
there is no extra mesh, draw, post pass, or network request. The added bundled
table is 94 KiB of static module data and is sampled during patch construction,
not per-frame.
