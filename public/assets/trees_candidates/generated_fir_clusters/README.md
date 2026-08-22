# Generated fir foliage cluster candidates

These images are source candidates for a branch-cluster tree renderer. They are
not whole-tree billboards and are not wired into the production range yet.

## `douglas_fir_branch_cluster_v1.png`

- Generator: OpenAI ImageGen
- Mode: `stylized-concept`
- Canvas: 1536 x 1024 RGBA
- Intended role: alpha-tested Douglas-fir branch-spray albedo/coverage tile
- Alpha QA: transparent exterior with anti-aliased foliage coverage
- Runtime lighting: the image is deliberately lighting-neutral; do not treat it
  as a normal, roughness, depth, or physically measured material map

Prompt:

> Use case: stylized-concept. Asset type: lighting-neutral foliage cutout for a
> real-time WebGPU conifer branch-cluster atlas. One isolated, photorealistic
> Douglas fir branch spray viewed orthographically from directly above,
> consisting of a woody secondary branch with many smaller twigs and dense
> natural short needles; botanically plausible irregular growth, asymmetric
> silhouette, varied needle directions and visible interior gaps. Genuinely
> transparent background with clean alpha, no ground, no sky, no shadow plane.
> High-end scanned game foliage texture, realistic rather than illustrative.
> Branch runs generally left-to-right with a mild diagonal; the entire spray
> fits inside the canvas with 8 percent transparent padding; broad usable cluster
> silhouette, not a whole tree. Flat overcast cross-polarized capture, even
> neutral illumination, minimal directional shading, no baked sunlight, no rim
> light, no ambient-occlusion-blackened interior. Mature Pacific Northwest
> Douglas-fir needles, deep neutral forest green with restrained natural
> variation; brown-gray twig. Crisp individual needle groups at the perimeter,
> denser overlapping needle masses inside, visible branch structure through
> selected gaps. Transparent RGBA cutout; one branch cluster only; no whole tree,
> trunk, cones, text, labels, watermark, border, contact shadow, cast shadow,
> glow, depth of field, blur, painterly marks, duplicated mirrored foliage, or
> black/white background; suitable for alpha-tested runtime lighting and
> mipmapping.

Before production use, build several independently generated silhouettes, trim
each card mesh to its alpha hull, generate alpha-coverage-preserving mipmaps, and
derive normals/depth from authored geometry or a controlled bake—not ImageGen.

## `source/douglas-fir-source-sheet-v1.png`

- Generator: OpenAI ImageGen built-in tool
- Mode: `stylized-concept`
- Canvas: 1024 x 1536 RGBA
- Generated: 2026-08-20
- Intended role: immutable eight-cluster Douglas-fir source sheet
- Derived output: `processed/v1/`

Prompt:

> Use case: stylized-concept. Asset type: production source sheet for
> alpha-tested foliage cards in a realistic Three.js WebGPU golf simulator.
> Create exactly eight clearly separated, botanically consistent Douglas-fir
> branch clusters from the same mature Pacific Northwest tree: sparse outer
> sprig, small medium-density cluster, large medium-density cluster, dense
> interior cluster, young brighter growth, darker mature growth, subtly dry
> variation, and an irregular silhouette-breaking cluster. Genuinely transparent
> RGBA background; no environment, ground, sky, or backdrop. Realistic twigs,
> woody secondary stems, and short flat needles; every needle belongs to visible
> branch structure. High-end scanned game-foliage reference appearance,
> photorealistic rather than illustrative. Clean 2-column by 4-row layout with
> generous transparent separation and complete uncropped clusters. Flat neutral
> overcast cross-polarized capture with no baked directional light, cast shadows,
> rim light, glow, depth of field, or darkened interiors. Deep neutral forest
> green with restrained natural variation and brown-gray twigs. Crisp needle
> tips, readable gaps, irregular asymmetry, plausible branching. No whole tree,
> trunk, cones, roots, floating needles, mirrored duplicates, text, grid lines,
> border, watermark, colored background, blur, or malformed fused branches.

The deterministic processor at `tools/foliage-pipeline/process-source.mjs`
extracts the eight cells, cleans faint background alpha, dilates transparent RGB,
packs a 2K atlas, derives aligned roughness/transmission/coverage channels, and
writes UV metadata. The PNG derivatives remain candidate-only and inspectable;
they are not yet KTX2 shipping assets.

## `source/douglas-fir-source-sheet-v2.png`

- Generator: OpenAI ImageGen built-in tool
- Mode: `stylized-concept`
- Canvas: 1024 x 1536 RGBA
- Generated: 2026-08-20
- Source SHA-256: `2fb5a9236647efc445e24fecea69abe2b6a2b672d7c1912d4ac91aa0599a7302`
- Intended role: replacement immutable source with validator-safe cell gutters
- Processing config: `tools/foliage-pipeline/species/douglas-fir.v1.json`

The v1 processor audit found cross-cell fragments or boundary contact in five of
eight cells, so v1 remains preserved evidence and cannot be promoted. V2 was
generated as a distinct source rather than overwriting that lineage.

Prompt:

> Use case: stylized-concept. Asset type: production source sheet for
> alpha-tested foliage-cluster textures in a realistic Three.js/WebGPU golf
> simulator. Create exactly eight distinct, botanically credible Douglas-fir
> branch clusters from the same mature Pacific Northwest tree in a strict
> two-column by four-row contact sheet: sparse outer sprig, small medium-density,
> large medium-density, dense interior, younger brighter growth, darker mature
> growth, subtly dry variation, and irregular silhouette breaker. Center every
> cluster entirely inside its equal-size cell with at least 15 percent genuinely
> transparent gutter on all sides. No needle, twig, glow, shadow, haze, or stray
> fragment may touch or cross a cell boundary; no cluster may overlap another
> cell; keep every branch and needle tip uncropped. Photorealistic high-end
> cross-polarized scanned game-foliage appearance, realistic short flat needles,
> brown-gray secondary stems, irregular asymmetric growth, visible interior gaps,
> and plausible attachment. Flat neutral overcast lighting-neutral albedo, deep
> neutral forest green, true RGBA transparency, crisp fine tips. No baked sun,
> rim or cast light, AO-blackened interiors, glow, depth of field, background,
> whole tree, trunk, roots, cones, floating needles, malformed anatomy, mirrored
> duplicates, text, grid, border, watermark, haze, blur, or painterly marks.

## Rejected generation evidence

`source/douglas-fir-source-sheet-v3.png` is the targeted spacing edit of v2.
It is preserved for audit but rejected: the tool returned RGB with a baked
checkerboard instead of RGBA transparency (SHA-256
`0f1e7cd3c3bb53241fae12559d940d003834a774263c567d8b9f28e05c93ec2f`).
The processor fails it closed before extraction.

`source/douglas-fir-source-sheet-v4-rejected-rgb.png` is a targeted
photoreal-anatomy edit of v2. It materially improves twig/needle anatomy, but is
rejected because ImageGen returned a 1024 x 1536 RGB file with a painted
checkerboard rather than transparent RGBA (SHA-256
`3d5fe90e524cf368b9d968f34b9bf11c168267e98d7b55a0bfd35195ea5efcd2`).
The prompt preserved the eight-cell layout while requesting photographic
Pseudotsuga branchlets, neutral cross-polarized-style light, clean connected
bases, no directional light or AO, and genuine transparent fine-tip alpha.

`source/douglas-fir-source-sheet-v5-rejected-rgb.png` is the single corrective
edit of v4. Its prompt requested only removal of the checkerboard and genuine
RGBA around the unchanged eight clusters. It again returned RGB with the matte
baked in (SHA-256
`0a5a48ccfaf3ef4426c01801cc065c6bbcb07b84cb9ce2ff44eac50f2a0da30b`).
It is preserved as rejected evidence and is never processed or loaded. V2
therefore remains the immutable authoritative source until a future generation
passes the alpha contract without inferred or hand-painted transparency.
