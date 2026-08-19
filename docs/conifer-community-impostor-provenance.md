# Experimental far-conifer community impostor

`conifer_community_v1_impostor.png` is a deterministic, offline experimental
derivative of
the verified CC0 Poly Haven `fir_tree_01` lineage already cataloged as
`polyhaven-fir-sapling-medium`. It is a neutral albedo/alpha atlas: no direct
light, ambient occlusion, or baked normal is introduced. It is not currently
loaded by production: the runtime forest layer was rejected for insufficient
forest-scale readability and remains disabled. If promoted later, it must use
the shared MeshStandardNodeMaterial key/PMREM and a bounded upward-biased
normal for crossed-card stability.

- Source atlas: `/assets/trees/conifer_v3_impostor.png`
- Source SHA-256: `172bb2935dcada2c686b0e19e0b5962b79f921e19d9f0277fbfd503464c7ca48`
- Output: `/assets/trees/conifer_community_v1_impostor.png`, 2048 × 1024 RGBA,
  4 × 2 frames at 512 × 512
- Output SHA-256: `30d9c0567b92ee7be3e429982887881c3598950ed445f54bfefbf1f00e6b6d79`
- Generator: `scripts/build_backdrop_conifer_community.py@backdrop-community-impostor-v1`
- License/source: CC0-1.0, https://polyhaven.com/a/fir_tree_01
- Derivative catalog: `public/assets/environment/backdrop-community-catalog.json`

Each frame composites seven deterministic, mirrored/varied source crowns with
transparent gutters and aligned-but-irregular bases. Production
`BackdropTerrain` deliberately does not instantiate this derivative; the
sidecar catalog records it as an offline experiment, not a startup asset.
