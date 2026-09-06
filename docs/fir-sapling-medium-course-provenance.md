# Poly Haven Fir Sapling Medium course asset

Pineglass Forest uses Poly Haven's
[Fir Sapling Medium](https://polyhaven.com/a/fir_sapling_medium) as its dense
middle-canopy layer. The source is CC0. It remains a sapling: distributed records
use `forest-understory` at 0.95–1.55× native scale (about 8.4–13.7 m), and eight
deliberate tee-frame placements remain at or below 1.55×. It is not relabeled or
inflated into a 25–45 m mature tree.

The official files API is `https://api.polyhaven.com/files/fir_sapling_medium`.
The authoritative 1k glTF source SHA-256 is
`2e80cd49d716c99bdead5a42aa6441e89443044d9a0edc31b56b5dbf87fc41de`.
`scripts/fetch_polyhaven_fir_sapling_medium.mjs` verifies every source dependency
against the API's MD5 records. `scripts/process_fir_sapling_medium.py` combines
only the official twig RGB and alpha channels, retains whole connected twig-card
components in 48 vertical crown bands, preserves the two structural primitives,
and exports all source PBR maps. It does not decimate individual cards, create an
atlas/billboard, or procedurally reconstruct foliage.

Source-faithful intermediate derivatives:

- LOD0: `fir_sapling_medium_component_lod0.glb`, 330,417 faces, SHA-256
  `bbc16e15987ca3c3c42e95d2d44abcddef6b3dd7c17fadd627b8c07a9f5475af`.
- LOD1: `fir_sapling_medium_component_lod1.glb`, 210,672 faces, SHA-256
  `f0456d2fe509ca7c9c70b83cab074509005f8573ca4800330d48ed1c860e11cb`.

Both tiers preserve `fir_sapling_medium_branches` (25,470 indices) and
`fir_sapling_medium_branches_dead` (5,430 indices). LOD0 has 960,351 twig
indices; the middle tier has 601,116. Production applies a second deterministic
whole-spray budget to these intermediates; see `docs/tree-performance-lods.md`.
The current registered lineage is
`polyhaven-fir-sapling-medium-whole-component-lods@4:three-tier-course-spray-budgets`;
LOD2 retains both complete structural primitives and 35,115 whole-spray foliage faces.

The production middle tier uses a shadow-receiving Lambert node material with
the real source RGB/normal/AO/alpha maps, stable 0.06 alpha coverage, PMREM fill,
directional shadows, aerial perspective, and bounded sun-oriented needle
transmission. This keeps the retained geometry crisp rather than blurring it.

The strict WebGPU course proof classified all 199 fir-sapling records with no
distance, policy, budget, or invalid-membership drops. The dedicated near crown
view classified four fir saplings in LOD0 and five in LOD1; the middle handoff
view kept all 22 visible fir saplings in LOD1. Current performance evidence is
recorded in `docs/tree-performance-lods.md` rather than this source-asset record.
