# Grasslands mature broadleaf form audition

- Official source: [Jacaranda Tree, Poly Haven](https://polyhaven.com/a/jacaranda_tree).
- Authors: Rico Cilliers (model), Rob Tuytel (guidance), verified through the
  official asset info API on September 4, 2026.
- License: CC0-1.0, stated on the official asset page.
- API: `https://api.polyhaven.com/files/jacaranda_tree`.
- Download: official 1k glTF and all declared dependencies plus the companion
  leaves-alpha PNG. Every downloaded file is checked against the API MD5 and
  recorded with SHA-256 in the generated `source-provenance.json`.
- Source glTF SHA-256:
  `ba4aa8ab4c3e3741ce3699604d6ec1607cd6b126ae2d32abbcc0d98e8edb3be4`.
- Runtime GLB SHA-256:
  `9edca50c2e36d371a560bc749e9b3f10c83ccfeb95bfb60d91c023bd886c59d7`.
- Alpha SHA-256:
  `c708a7e928a2e4d26981b021a22deeefc0ebb0e467f60b53cfa636a7e24d68f7`.

Reproduce with `node scripts/fetch-grasslands-jacaranda.mjs <temporary-directory>`.
The installed glTF-Transform 4.2.1 NodeIO repacks the official source into one GLB,
registering all extensions so authored IOR and specular values are preserved.
No decimation, recoloring, UV changes, replacement leaves, cards, billboards,
atlas generation or geometry alteration is performed. The source's original
branches, trunk and foliage materials remain independent. The sidecar alpha is
registered to the glTF texture origin (`flipY: false`).

The native source bounds are 24.417 × 19.469 × 19.155 m; geometry contains
3,863,832 triangles (branches 1,231,286; trunk 230,112; leaves 2,402,434).

## Course LOD derivatives

The same exact source was originally declared in both residency bands pending a
source-faithful LOD. Measured on 2026-09-05, that cost **43.0 ms of a 173.25 ms
frame — 25% of the whole frame** for three trees, because the shadow renderer takes
the beauty tier and Ultra promotes every tree to LOD0, so 3 × 3.86 M triangles were
submitted to each of three shadow cascades. The derivatives below replace it:

| LOD | Leaves | Branches | Trunk | Total | Band | SHA-256 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 700,010 | 350,010 | 230,112 | 1,280,132 | 75 m | `ebbed22b…` |
| 1 | 200,015 | 120,106 | 230,112 | 550,233 | 300 m | `e95662c5…` |
| 2 | 80,017 | 50,008 | 230,112 | 360,137 | 1200 m | `e9d6f1e8…` |

Exact hashes are in `public/assets/environment/catalog.json`. Rebuild:

```sh
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/environment/jacaranda-tree/jacaranda-tree.glb --output a.glb --material leaves   --target-faces 700000 --retain outer
node scripts/thin-gltf-foliage-sprays.mjs --input a.glb --output jacaranda-tree-course-lod0.glb --material branches --target-faces 350000 --retain largest
node scripts/thin-gltf-foliage-sprays.mjs --input jacaranda-tree-course-lod0.glb --output b.glb --material leaves   --target-faces 200000 --retain outer
node scripts/thin-gltf-foliage-sprays.mjs --input b.glb --output jacaranda-tree-course-lod1.glb --material branches --target-faces 120000 --retain largest
node scripts/thin-gltf-foliage-sprays.mjs --input jacaranda-tree-course-lod1.glb --output c.glb --material leaves   --target-faces  80000 --retain outer
node scripts/thin-gltf-foliage-sprays.mjs --input c.glb --output jacaranda-tree-course-lod2.glb --material branches --target-faces  50000 --retain largest
```

Each tier is generated from its accepted predecessor, so every crown is a strict
nested subset. The two materials use different orderings on purpose. Leaves take
`--retain outer`, because a crown occludes its own interior and the budget belongs
on the visible envelope. Limbs take `--retain largest`, because a tree's core limbs
are its biggest connected components: thinning them with `outer` deletes exactly the
limbs nearest the crown centre and renders a tree whose branch structure is visibly
missing, which is what a first attempt here did.
The trunk is a structural primitive and is never thinned, which is why it is
unchanged across all three tiers and dominates LOD2 at 64% of its faces — reducing
it would need a different tool and is not attempted here.

At Ultra every tree is promoted to LOD0 (`lod0Only: true`, `fullFidelity: true`),
so only the LOD0 tier is selected there; LOD1/LOD2 serve the lower quality modes.
LOD0 is deliberately kept at 1.28 M rather than the 550 k that a tighter budget
allowed, because a golfer standing near the tree sees LOD0 at Ultra and 550 k
renders a visibly see-through crown. Measured at the reference pose: activeGPU mean
173.25 → 110.15 ms and presented p95 183.7 → 117.3 ms, with no visible close-up
difference from the 3.86 M source. This is a large measured improvement, **not** a
30 fps claim — the pose remains far above the 33.3 ms budget.

The photo study uses three 0.78–0.85-scale mature anchors, not inflated saplings.
This is a **form analogue** for the photograph's wide mature crowns. Photograph
location/species are unverified; a Jacaranda identity is not asserted for the
reference landscape, and this choice does not change other courses' biome palette.
Production visual audition remains required before accepting these anchors.

The existing Island Tree 01 was investigated first. Its official web-page width
metadata says 12.5 m, but the official downloadable glTF has no scale transform and
positions prove 4.755 × 5.027 × 4.818 m. The current catalog matches that actual
download. This is a source-form limitation, not evidence the simulator shrinks it.
