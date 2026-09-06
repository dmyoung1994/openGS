# Pineglass authored tree performance derivatives

The production Pineglass tree LODs are deterministic, source-faithful
derivatives of the catalog-backed Poly Haven GLBs. They reduce alpha-tested
microgeometry by retaining complete connected foliage sprays. They do not
simplify triangles inside a spray, regenerate normals or UVs, alter vertex
colours, replace PBR maps, create billboards/impostors, or remove the authored
structural primitives. Trunks, bark, live/dead branches, source bounds, material
identities, and every placement record remain present.
The runtime TSL path explicitly decodes retained tangent-space normal maps and
rotates that result through the same storage-owned per-tree yaw as position;
strict WebGPU QA fails on any shader compilation or validation error.

The course budgets were chosen from strict-WebGPU production-frame captures at
native 1280x720 with a fixed balanced-mode presentation lock. Forcing all 505
trees to LOD0 at the terrain-relative Hole 1 tee camera measured 148.77 ms active
GPU union/frame and 145.32 ms Scene MRT. The accepted visually certified handoff
measured 118.49 ms and 115.82 ms respectively. This is a measured improvement,
not a 30 FPS acceptance: the dense tee view remains above the 33.3 ms budget.
The cheaper LOD2 experiment was rejected because it lost important crown mass.

## Production files

| Catalog asset | LOD | Foliage faces | Total faces | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| Fir Sapling Medium | 0 | 220,002 | 230,302 | `d6a9557a0936a857674bed66367a511d253e610495e7401d746cfe1416c6c137` |
| Fir Sapling Medium | 1 | 110,001 | 120,301 | `2a41ab4b760f212a285b82d53c2ba0420243976aa4325897e30e17febe9e7437` |
| Fir Sapling Medium | 2 | 35,115 | 45,415 | `8eb77805c930bcf7b105ce64a5f61ada2afacaffc5acf0923a930c4784a4f09f` |
| Pine Sapling Small | 0 | 110,407 | 110,947 | `140b1520d9e49da3688dbfb8cc030ead178203aa7f8b2a2d5c4ed2f5686f342d` |
| Pine Sapling Small | 1 | 33,279 | 33,819 | `b5a7a4e3bb77ef399ef1cba4470cbb226a26e88373b0434ca2caacc35a96ca4c` |
| Pine Sapling Small | 2 | 12,002 | 12,542 | `348ea7ccc90410c22844d62d08884718d55e07d3714e1a0e408497cea645f331` |
| Fir Tree 01 | 0 | 220,001 | 313,329 | `a18e39d5f2be69a60c0bd7ba4e9692f5c06579c737c9011b2fcad7726ea55bfc` |
| Fir Tree 01 | 1 | 100,003 | 193,331 | `7b115487fb22a905c127bf8b6dd70526d99c98aa7cf18ac32f42611b5d5cbb06` |
| Fir Tree 01 | 2 | 30,001 | 123,329 | `a4b133ce4729d3aaf862fa85b183f55dab0373c1999275a78f9bb0ea30b21a9c` |
| Pine Tree 01 | 0 | 200,096 | 222,756 | `29b1c29a20b6bbb8cb3349edd224ee803eba2ee2e966cbfa9bc5fe4753ef6679` |
| Pine Tree 01 | 1 | 80,066 | 102,726 | `5284d2e172100c68b954ef0ca658c04607dd4167ca4c52e4f47ca39878bdee0f` |
| Pine Tree 01 | 2 | 20,001 | 42,661 | `910bfef5a29f6d2faadd73c0a50fa20b13840c4a8e8eef2c67cca5f026675123` |

## Rebuild

Run `scripts/thin-gltf-foliage-sprays.mjs` against the pinned source-faithful
LOD0 for each species, then generate each lower tier from its accepted preceding
tier so every far crown remains a strict nested subset. The exact chain is:

```sh
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/fir_sapling_medium_component_lod0.glb --output public/assets/trees/fir_sapling_medium_course_lod0.glb --target-faces 220000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/fir_sapling_medium_course_lod0.glb --output public/assets/trees/fir_sapling_medium_course_lod1.glb --target-faces 110000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/fir_sapling_medium_course_lod1.glb --output public/assets/trees/fir_sapling_medium_course_lod2.glb --target-faces 35000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/pine_sapling_small_exact_a.glb --output public/assets/trees/pine_sapling_small_course_lod0.glb --target-faces 110000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/pine_sapling_small_course_lod0.glb --output public/assets/trees/pine_sapling_small_course_lod1.glb --target-faces 33000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/pine_sapling_small_course_lod1.glb --output public/assets/trees/pine_sapling_small_course_lod2.glb --target-faces 12000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/fir_tree_01_source_lod0.glb --output public/assets/trees/fir_tree_01_course_lod0.glb --target-faces 220000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/fir_tree_01_course_lod0.glb --output public/assets/trees/fir_tree_01_course_lod1.glb --target-faces 100000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/fir_tree_01_course_lod1.glb --output public/assets/trees/fir_tree_01_course_lod2.glb --target-faces 30000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/pine_tree_01_source_lod0.glb --output public/assets/trees/pine_tree_01_course_lod0.glb --target-faces 200000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/pine_tree_01_course_lod0.glb --output public/assets/trees/pine_tree_01_course_lod1.glb --target-faces 80000
node scripts/thin-gltf-foliage-sprays.mjs --input public/assets/trees/pine_tree_01_course_lod1.glb --output public/assets/trees/pine_tree_01_course_lod2.glb --target-faces 20000
```

The tool
requires exactly one matching foliage primitive, retains whole connected
components with deterministic ranking, retains axis-extrema components, copies
each retained source attribute in its original typed representation, writes
correct derivative metadata, and writes atomically through a partial GLB.

The original and intermediate source-faithful GLBs remain the reproducible input
artifacts. Catalog runtime URLs point only to the `*_course_lod*.glb` outputs.

## Runtime policy

Every source placement is assigned exactly one complete authored mesh tier; no
tree, trunk, branch role, or shadow caster is distance-culled. A derivative may
be selected only when the catalog declares a reviewed
`visualMaxProjectedPixels`. The four Pineglass LOD1 assets are certified through
24 projected pixels and retain byte-identical structural primitives, so their
trunks and branches cannot disappear. LOD2 is disabled (`0`) because its reduced
crown mass was not acceptable. Any tree without a positive LOD1 certification
fails closed to LOD0. Runtime camera motion only updates GPU
visibility/indirect lists and never reloads tree assets. Tree materials mark thin
coverage reactive for temporal reconstruction, while the shadow renderer uses a
complete static authored caster list independent of beauty LOD.

## Spray retention ordering

`scripts/thin-gltf-foliage-sprays.mjs` takes `--retain hash|outer|largest` (default
`hash`). Every derivative in the table above was built with `hash`, which matches
`process_pine_tree.py`'s ordering so a thinned tier selects the same nested set as
a fresh Blender bake; those files are unaffected by the option existing.

`--retain outer` instead spends the face budget on the canopy envelope, because a
crown occludes its own interior and interior sprays cost triangles no outside
camera can see. It buckets sprays by bearing from the primitive's bounding-box
centre (24 azimuth × 12 elevation) and walks the buckets round-robin, taking each
bearing's outermost remaining spray first.

Two details are load-bearing, both found by rendering the result:

- Ordering by radius alone is **not** a shell. It spends the whole budget on the
  few sprays sitting at the bounding radius and leaves the rest of the crown bare —
  the rendered tree came out nearly leafless. The per-bearing round-robin is what
  makes it an envelope.
- The anchor must be the bounding-box centre, not the vertex centroid. Once a tier
  is a hollow shell its centroid no longer sits inside the crown; it drifts toward
  whichever side kept more geometry and each derived tier then strips one side of
  the tree. With the box centre, the reported centre and max radius stay identical
  across all three tiers.

Structural primitives are still never thinned under either ordering.

`--retain largest` takes the biggest connected components first. Structural limb
geometry needs this: a tree's core limbs are its largest components, and the other
two orderings both delete them — `outer` because limbs sit near the crown centre,
`hash` because it ignores size. Thinning the jacaranda's `branches` material with
`outer` produced a tree with floating foliage and no visible limb structure. Leaves
take `outer`, limbs take `largest`, and the trunk is never thinned at all.
