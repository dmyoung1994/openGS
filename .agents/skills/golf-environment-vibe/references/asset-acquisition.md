# Catalog asset acquisition

Use this workflow only when the current catalog cannot satisfy a visual or ecological role explicitly required by the course brief and the active agent has authorized network access. Catalog reuse remains the default.

## Source decision

1. Name the missing role before searching: species/form, life stage, material, scale, biome, and intended placement job.
2. Search the official Poly Haven catalog and asset APIs first. Poly Haven CC0 GLBs are the source of truth for authored tree assets in this repository.
3. For a non-tree asset unavailable from Poly Haven, use another source only when its canonical page states a license compatible with repository redistribution and modification and identifies the author. Never use a search thumbnail, mirror, re-upload, or asset with ambiguous terms.
4. Stop and report the gap when the license, canonical source, author, or downloadable original cannot be verified. Do not substitute a primitive, procedural model, billboard, atlas, placeholder, or generic prop.

## Ingest contract

1. Announce the missing role and candidate licensed source in the live status stream before downloading.
2. Download the exact source file to temporary storage first. Record its canonical asset page, direct-file/API URL, author, license, retrieval date, and SHA-256 before creating derivatives.
3. Preserve authored geometry, normals, UVs, vertex colours, alpha, and PBR maps. Keep the source GLB authoritative; use existing repository conversion and optimization scripts for runtime derivatives rather than rebuilding the asset by hand.
4. Add a focused provenance document under `docs/`. Add or update the strict v2 catalog entry with source metadata, `derivativeLineage.sourceHash`, `pipelineVersion`, runtime-file hashes, dimensions, bounds, LODs, spacing, slope, grounding, clearances, biome tags, and honest fidelity labels.
5. Keep one acquisition checkpoint coherent: source/provenance, derivatives, catalog metadata, and required course references must agree. Never leave a course pointing at an uncataloged or unverified file.

## Verification

- Run the relevant catalog and environment tests plus `npm run verify:visual-assets`.
- Load the real production WebGPU route and verify the authored GLB, textures, alpha, grounding, lighting, and LOD transitions. A missing or invalid catalog derivative is a terminal failure.
- Remove temporary downloads after the verified derivative and provenance are safely represented; do not commit unrelated source archives or preview images.
