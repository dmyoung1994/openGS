# Poly Haven Pine Tree 01 course asset

Pineglass Forest uses Poly Haven's [Pine Tree 01](https://polyhaven.com/a/pine_tree_01)
as its tall conifer canopy. The model is CC0 and was authored by Rico Cilliers
(modeling) and Rob Tuytel (photography). It supplies the explicit pine silhouette
and needle canopy requested by the course brief; existing broadleaf models remain
secondary woodland variety rather than being mislabeled as pines.

The official acquisition manifest is `https://api.polyhaven.com/files/pine_tree_01`.
The authoritative 1k glTF source hash is
`c81e8eebbda722313f07bed37b8b9156ce520f7fa95488d83a694d02fffdb469`.
The reviewed `process-pine-tree-blender-5.2-material-preserving-spray-lods@8`
runtime derivative preserves the source bark, trunk-b, dead-branch, and twig
primitives independently together with their normals, UVs, two vertex-colour
streams, and each primitive's embedded PBR maps. The source crown contains
247,690 disconnected authored twig/spray components. The accepted LOD0 retains
complete authored sprays totaling 200,096 foliage faces; LOD1 retains a nested
whole-spray subset totaling 80,066 faces (40.0% of LOD0 foliage), and LOD2 retains
20,001 whole-spray faces for sub-80-pixel silhouettes. All three tiers
keep the same bounded structural budgets: 9,000 bark faces, 9,000 trunk-b faces,
and all 4,660 dead-branch faces. The rejected v5 distance derivative both merged
the differently textured bark/trunk primitives and collapse-decimated structure
to 2,698 faces, producing the skeletal black crown and opaque brown triangular
shards visible in strict WebGPU address views. No billboard,
impostor, atlas, procedural reconstruction, placeholder, or generic-tree fallback
is registered.

The official 1k glTF itself references JPEG colour/normal/ARM maps and declares
the twig material `OPAQUE`; it does not embed coverage. Poly Haven's same files
manifest and Blender package provide the authored `twig_alpha` PNG separately.
The catalog therefore pins that PNG and the loader attaches it to the exact
`pine_tree_01_twig.001` material before the production TSL material is built.
The shader samples its red channel with stable 0.10 near-tier and 0.06
middle-tier alpha tests, retains depth writes, and uses the same authored
coverage for shadow clones. The separately
published `twig_mask` is a material mask rather than opacity and is deliberately
not substituted. Thus the imported foliage is dense authored alpha-mapped
twig/spray geometry—not fully modeled individual needles, invented cards, a
billboard, or an impostor.

LOD0 retains the source MeshStandard PBR response. At the authored LOD1 handoff,
foliage uses a shadow-receiving `SharedEnvironmentTreeLambertMaterial` while
retaining the exact source material name, RGB and alpha maps, UVs, geometry
normals, normal map, and AO map. This bounded middle shader removes the distant
microfacet/specular cost without becoming unlit or substituting geometry; structural
parts remain on their source PBR materials.

Source-faithful intermediate geometry:

- `public/assets/trees/pine_tree_01_source_lod0.glb` — SHA-256
  `ebf761bf46b9ce9bd3fd45ad2b80fff7593f7fe6fbd93ff858023c4be874e6a7`
- `public/assets/trees/pine_tree_01_source_lod1.glb` — SHA-256
  `dc6fa3533a70fbc286002b5c21de5ff7abbe85731eb8911e5af1040e1fefd01e`
- `public/assets/trees/pine_tree_01_twig_alpha_1k.png` — SHA-256
  `6f91aa99f2c27108d6f817f874954aa7df8bfbb4dea2673e9322555a6ae79d99`

Reproduction uses the official files API (including its dependency URLs and
MD5 records), pins the source glTF SHA-256, pins Blender 5.2.x, and emits the
exact catalog filename:

```sh
node scripts/fetch_polyhaven_pine_tree_01.mjs --output-dir /tmp/pine_tree_01_source
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python scripts/process_pine_tree.py -- \
  --input /tmp/pine_tree_01_source/pine_tree_01_1k.gltf \
  --output public/assets/trees/pine_tree_01_source_lod0.glb \
  --variant b --lod 0
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python scripts/process_pine_tree.py -- \
  --input /tmp/pine_tree_01_source/pine_tree_01_1k.gltf \
  --output public/assets/trees/pine_tree_01_source_lod1.glb \
  --variant b --lod 1
# Authoring machines without Blender can retune a verified derivative by
# retaining complete connected sprays and compacting only unused vertices:
node scripts/thin-gltf-foliage-sprays.mjs \
  --input public/assets/trees/pine_tree_01_source_lod0.glb \
  --output public/assets/trees/pine_tree_01_course_lod0.glb \
  --target-faces 200000
node scripts/thin-gltf-foliage-sprays.mjs \
  --input public/assets/trees/pine_tree_01_course_lod0.glb \
  --output public/assets/trees/pine_tree_01_course_lod1.glb \
  --target-faces 80000
node scripts/thin-gltf-foliage-sprays.mjs \
  --input public/assets/trees/pine_tree_01_course_lod1.glb \
  --output public/assets/trees/pine_tree_01_course_lod2.glb \
  --target-faces 20000
shasum -a 256 public/assets/trees/pine_tree_01_source_lod0.glb
shasum -a 256 public/assets/trees/pine_tree_01_source_lod1.glb
```

The final checksum must match the catalog before the derivative is accepted.

The production catalog uses deterministic whole-spray derivatives of these
intermediates; see `docs/tree-performance-lods.md` for exact runtime hashes,
face budgets, and measurements.

The accepted near tier contains 200,096 foliage faces plus 22,660 authored
structure faces. It was thinned from the prior verified 560,000-face whole-spray
derivative (`6a37ca19…ffbe`) with the repository Node utility. The utility changes
only the foliage primitive's connected-component membership and index remap;
retained positions, normals, UVs, vertex colours, source material identities,
alpha, and PBR textures are copied exactly. LOD1 is the distinct nested 80,066
foliage-face middle tier.

## WebGPU review

All three official source variants were reviewed at the same 700k complete-spray
density with the official alpha in the production asset viewer. Variant B remains
the canonical choice: it has the widest, most continuous lower and middle branch
layers. Variants A and C concentrate foliage in the upper crown and expose a
longer bare trunk. All three are intentionally open, deadwood-rich pines; this
source cannot become a dense living fir without changing the licensed source.

The final `play.html` proof used a fresh headful Chrome profile, strict WebGPU,
`PlayScene`, native render scale, and the evaluator camera across seven golfer and
contact views. Pine Tree 01 is deliberately an open mature accent rather than the
sole forest wall: the course contains eight immutable Pine Tree 01 records, layered
with 88 mature Fir Tree 01 records, 199 Fir Sapling Medium records, and 210 Pine
Sapling Small regeneration records. At the final address pose, 20 mature pines
were visible in authored LOD1; the
remaining records were behind the camera or outside its frustum. Distance,
policy, budget, invalid-membership, and overflow rejection were all zero.

The older settled 30-frame capture measured 30.11 ms completion p95 under a
superseded scene/camera contract. Current immutable production evidence is in
`docs/tree-performance-lods.md`: it shows a material improvement but still fails
the 33.3 ms target. The composition keeps the 80,066-face whole-spray LOD1 and
its bounded Lambert/needle-transmission path;
performance comes from honest age-class layering and fewer open-pine anchors,
not a billboard, proxy, missing source record, blur, or giant-scaled sapling.

The strict catalog records 7.153 × 14.858 × 7.535 m authored bounds, an 8 m
minimum spacing, protected-surface clearances, and temperate maritime/alpine
compatibility. Any missing hash, decode failure, or geometry verification error is
terminal and must not substitute another tree source.
