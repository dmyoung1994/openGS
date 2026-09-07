# Premium turf source research — 2026-09-04

## Decision

Prioritize a fairway comparison of the existing ambientCG Grass005 against
Poliigon Fine Grass 4588 and Short Grass 3204 when licensed source files are
available. Evaluate ambientCG Grass008 as an openly redistributable alternative.
No new material has been installed or proven superior in the production renderer.

### Grass008 audition result

Downloaded the official 2K PNG archive (SHA-256
`7974ac70e27037bf14c9c37cae02c561bb9bfbfd30c5af0a44a6acfa859e4d0b`),
packed original channels using the existing Grass005 packer with pinned Grass008
source hashes, and temporarily selected it in Terrain with its measured means.
Used the same 1.2 m calibrated tile and unchanged pigment, contrast, camera and
lighting. Runtime means: luminance 0.19871259, height 0.26623446, AO 0.55971991,
roughness 0.70995690. Production capture `/tmp/living-grass008-beach-turf.png`
and JSON report passed strict WebGPU, nonblank and health checks.

Decision: do not promote. At the close beach pose it remains visually very similar
to Grass005, with pale longer blades and no convincing improvement to the premium
short-cut character. Restored the original Terrain binding and moved audition
assets out of public into `/tmp/golf-turf-audition.TJdNVB/`; no candidate textures
remain shipped. Broader turf quality work remains open, including material light
response and a higher-resolution Grass005 comparison or licensed paid sources.
For putting greens, keep a distinct very short, dense turf material: a garden-lawn
scan cannot be assumed to represent putting turf by shrinking its UV scale.

The existing fairway is Grass005 at 2K over a calibrated 1.2 m tile, not the older
BlenderKit procedural fairway implied by the runtime filenames. The existing
green is baked BlenderKit Golf Bentgrass. Preserve these as reference materials.

## Shortlist (publisher claims; suitability is our assessment)

| Source | Verified listing details | Intended audition |
| --- | --- | --- |
| [Poliigon Fine Grass 4588](https://www.poliigon.com/texture/fine-grass-texture/4588) | 1–8K, 4.5 m square; diffuse, normals, gloss, reflection, AO, bump and displacement including 16-bit variants; premium | Leading paid fairway candidate for fine texture and natural variation. Garden grass, not a verified golf species or cut. |
| [Poliigon Short Grass 3204](https://www.poliigon.com/texture/short-grass-texture/3204) | 1–4K, 2.5 m square; diffuse, normals, gloss, reflection, AO, displacement including 16-bit | Maintained fairway/tee comparison; inspect yellow patches and blade size. |
| [ambientCG Grass005](https://ambientcg.com/view?id=Grass005) | Official API: clean/lawn/short tags, procedural with bitmap elements, PNG/JPG archives through 8K; CC0 | Current benchmark; compare higher-resolution source before assuming a different material is better. |
| [ambientCG Grass008](https://ambientcg.com/view?id=Grass008) | Lawn material, procedural with bitmap elements, archives through 8K; CC0 | Free alternative for fairway/first cut; exact visual superiority unproven. |
| [Textures.com Checkered Lawn PBR0809](https://www.textures.com/download/grass-checkered-lawn-pbr0809/142622) | Through 4K; albedo, height, normal, roughness, AO; premium | Mowing reference. Avoid adopting fixed checker markings as the course-wide material: the engine already owns mowing direction. |
| [Poliigon Lush Grass 4586](https://www.poliigon.com/texture/lush-grass-texture/4586) | Listed 6 m physical coverage | Secondary first-cut/rough candidate; verify all source maps before acquisition. |
| [BlenderKit Procedural Turf](https://www.blendkit.com/asset-gallery-detail/47fcded8-5049-4835-ac9c-ea45822bc2de/) | Publisher explicitly targets sports fields and golf courses | Adjustable baking candidate; validate source license and output against existing Golf Bentgrass. |

## Other sources searched

Queried Poly Haven's official texture API. Grass-name matches were aerial grass
rock, grass/concrete pavement, grass paths 2/3, grassy cobblestone, leafy grass,
sparse grass, and withered grass. This search did not reveal a dedicated manicured
golf-turf texture. Poly Haven remains useful for natural margins.

Also searched Fab/Quixel, Adobe Substance community materials, CGAxis, CGTrader,
cgbookcase, TextureCan, ShareTextures, and Texturing.xyz. Search visibility and
metadata varied; none provided enough verified evidence in this pass to displace
the shortlist. Do not mistake absent search results for absent catalog content.
Textures.com's 2x2 m Grass Scan 2 provides up to 10K and translucency, but its
weed/thistle content makes it a natural-margin candidate rather than premium turf:
https://www.textures.com/download/grass-scan-based-pbr-material-2-2x2-meters/143129

## Acquisition and visual acceptance

Commercial listings are research candidates, not permission to redistribute raw
maps in a web app or repository. Check the applicable license and existing user
entitlement before ingestion; no purchase was made. AmbientCG CC0 sources can
be auditioned without that commercial-source dependency.

Use exact publisher maps, recorded physical scale or explicit calibrated scale,
and registered color/normal/height/roughness/AO channels. Inspect at ball height,
address, fairway distance, and grazing low sun on both beach and Pineglass routes.
Judge density, blade scale, directional sheen, tiling, shadow depth, and motion
stability together. Preserve camera, lighting, exposure, and mapping contract for
comparisons. Texture resolution alone does not establish realism.

The initial Pineglass Ultra capture is `/tmp/living-baseline-tee.png` with report
`/tmp/living-baseline-tee.json`. At 1280x720 it passed nonblank/backend/health checks;
150 presented timing samples gave p50 66.7 ms and p95 83.4 ms. This fixed-camera
sample is not an animated gameplay performance certification. Its 111 tree-source
records differ from the pose-sweep script's hardcoded 505 assertion: resolve the
current course identity and source records before using that sweep unchanged.
Visual inspection shows turf detail becomes quite uniform toward the distance;
evaluate the material's distance filtering and lighting alongside source quality.

## Imagegen audition — not promoted

Two built-in imagegen candidates were generated and visually inspected. Both
retain looping, moss-like microstructure instead of convincingly clipped blades.
The second also has overly bright tips and dark cavities. Neither earned PBR
packing or a production replacement; the existing scanned maps remain in use.
These are preview artifacts, not project-referenced assets. Originals remain in
`/Users/dmyoung/.codex/generated_images/01a06e48-794c-73e1-bc06-165c75811dcc/`:

- `exec-e22c5099-4947-4c62-9a0b-eecff3b56f42.png` — initial albedo candidate.
- `exec-540e363d-0779-40f1-853b-fd054a1debf8.png` — targeted botanical correction.

Final revision prompt (built-in tool, first candidate as edit target):

> Edit this turf texture candidate. Preserve the square full-frame top-down seamless material layout and uniform diffuse illumination, but replace the tangled looping moss-like strands with botanically recognizable short flat straight and gently tapered creeping bentgrass leaf blades. The turf must look like a real premium golf fairway mown to 10 mm: tightly packed small narrow cut blades with blunt clipped tips, overlapping in varied directions, not curly threads, moss, lichen, hair, or artificial carpet. Moderate blade-level tonal variation, natural muted chlorophyll green, occasional pale clipped tips, no deep black cavities. No directional shadows, no highlights, no broad mowing stripes, no vignette, no scene objects. Photorealistic cross-polarized base-color texture representing 0.6m square. Match all four edges for tiling. Single color texture, no text.
