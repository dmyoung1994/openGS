# Procedural Plant Studio

Open **Plants** in the Course Creator camera toolbar. Select a preset, edit its
parameters, and inspect the result in the production course. Edits are temporary
until **Save to library** or **Place in course**. Course Undo removes placements;
the studio has its own undo/redo for authoring. JSON import/export retains the
editable definition. An existing course definition cannot be silently replaced
by placing a different plant with the same ID.

The eight starting forms are spreading oak, whorled fir, tall pine, palm, weeping willow,
multi-stem shrub, flowering shrub, and clipped hedge. They are editable form
presets, not claims of species-level botanical accuracy.

The Tall Pine preset now starts with a heavier trunk (ratio 0.022), stronger
primary/secondary branches, longer limbs and larger overlapping needle sprays.
Its nominal trunk is 37.5% thicker; seed-1 crown bounds are about one-third wider.
Branch and spray counts remain unchanged. Choose **Tall pine** or **Reset** to use
these defaults; saved course and library definitions retain their authored values.

The September 6 crown pass passes 27 focused tests and the production build.
Matched production WebGPU 1080p builder captures, preset selection, undo and
camera travel through all three detail tiers are recorded in
`/tmp/pine-crowns-ack3IQ/report.json` with no console/network errors. The single
preview retains 50,244 near triangles before and after. Open-ground samples run
42–49 fps after the change; the woodland comparison remains around 21–24 fps
(`/tmp/pine-crowns-fLUUv8/report.json`). These short builder measurements do not
certify sustained 30 fps or a full forest using the revised definition.

## Controls and data

- `version: 2` opts into `plant` controls. Unversioned definitions still load.
- Existing `parameters` control branch orders, lengths, angles in degrees,
  curvature, splits, taper, multiple trunks, leaf dimensions, and blossom counts.
- `plant.structure`, `foliage`, `bark`, `envelope`, `life`, `wind`, and `quality`
  add crown scaling, droop, collars, buttresses, foliage variation, bark ridges,
  box/ellipsoid pruning, life stages, shared environmental wind, and pixel-based
  detail thresholds. Distances use metres.
- `plant.profiles` contains ordered `[position, value]` points over normalized
  0–1 ranges. Edit the points directly or double-click the preview to add a point.
- Material slots accept same-origin procedural-tree PNG/KTX2 color, normal,
  roughness, and AO textures. Color maps use sRGB; data maps remain linear.
  Texture scale applies consistently to all PBR channels.
- A definition seed determines structure independently of foliage settings.
  Placement seeds select a bounded shared variant. Placement age and health use
  three age stages and two health states; definition life controls remain continuous.
- Library saves retain the first editable original as `definition.original.json`.
  Source reference images remain intact; `thumbnail.png` comes from the production renderer. Catalog GLBs use their
  separate existing asset path.

## CLI and agent tools

```sh
npm run tree:build -- presets
npm run tree:build -- schema
npm run tree:build -- preset --name palm --seed 12 --output /tmp/palm.json
npm run tree:build -- validate --definition /tmp/palm.json
npm run tree:build -- diagnose --definition /tmp/palm.json
```

The tree MCP exposes `create_tree_preset`, `describe_tree_schema`,
`validate_tree_definition`, `generate_tree_diagnostics`, and `save_plant_asset`,
alongside the existing fitting and blending tools. CLI fitting accepts
`--locked` as comma-separated parameter paths. Blending rejects incompatible
foliage families. Image fitting remains an approximate silhouette tool.

## Runtime and verification

Skeleton generation and geometry packing run in a worker. Editor changes cancel
superseded workers and keep the last valid preview. A bounded 64 MiB CPU buffer
cache reuses recent results. GPU resources remain owned by their forest.
Each structural variant has three geometry tiers; lower tiers preserve woody
structure and compensate foliage footprint as leaf count falls. Beauty and
reflection cameras classify their own visibility; shadow casters retain an
independent complete list. Wind uses the shared environment clock with explicit
current/previous motion for the temporal render path.

```sh
node --test test/plant-builder.test.mjs test/procedural-tree-builder.test.mjs test/procedural-tree-source.test.mjs
npm run build
PLANT_QA_URL=http://127.0.0.1:5173 node scripts/qa-plant-builder.mjs
```

The QA harness uses dedicated headful Chrome and strict WebGPU. It writes
screenshots and `/tmp/plant-studio-qa.json`, including all preset captures,
camera detail transitions, cold/warm loading, and a temporary preset collection in the course
preview. It does not place test plants in the saved course.

The full-course 1080p measurements on this Mac are approximately 150–185 ms per
frame. The matching view with the procedural preview hidden is approximately
166 ms. **The 30 fps target is not achieved.** These measurements establish that
the existing complete scene already exceeds that budget; they do not certify
large procedural forests or species-level visual quality. Loading probes also
record long tasks, so worker preparation alone is not a claim of hitch-free loading.

The focused tree tests pass. The broader suite currently has five failures in
existing routing, grass, and catalog assertions; their details are in
`/tmp/plant-full-tests-final.log` for this implementation session.

## Pineglass tall-pine forest

Pineglass now uses 111 procedural tall pines from the editable `tall-pine` preset.
The original catalog-tree project is retained at
`courses/pineglass-catalog-trees.project.json`; its source GLBs remain intact.
The converted project retains all non-tree objects and playing surfaces. One tree
(`fern-gate-north-forest-wall-3`) moved 0.5 m to satisfy the procedural fairway
clearance; all other tree positions are unchanged. The preset uses three seeded
structural variants, a nominal 25 m trunk, raised whorled branches, needle sprays,
and the existing worker preparation, wind, and three mesh detail tiers.

The first production Balanced capture after the conversion, at 1920×1080 on
A18 Pro, measures 31.72 ms median GPU time (32.67 ms p95) and 33.06 ms mean
presentation time across 120 frames. All 111 procedural records remain present;
32 targeted tests and the production build pass. Balanced/Battery use the far
procedural shadow mesh and quarter-resolution, 24-step light shafts; higher
modes retain the richer settings. These short samples establish progress, not
completion of the sustained all-pose/motion 30 fps acceptance gate.

The subsequent live Play check exposed a Battery mapping error: the weather tier
is named `conservative`, so the light-shaft budget must check that name. With it
fixed, the two-minute 1080p Auto run averaged 25.55 fps after warmup. Disabling
the periodic GPU profiler did not improve cadence (25.45 fps).

Needles now use two triangles with pointed ends instead of four triangles with
nearly coincident tip edges. Length, middle width, bend, spray count, and branch
structure stay intact. This reduced visible tree triangles from 3,522,920 to
2,306,500 in the same Play view and raised the live average to 27.66 fps.
The forest also samples the authoritative wind once per tree at both current
and previous times, sharing those buffers with every beauty and shadow draw.
Per-needle flutter and motion vectors remain active. These changes apply to the
procedural source; they do not substitute content for catalog-backed assets.

With shared wind samples, the same two-minute live Auto Play test averages
28.74 fps after the first 20 seconds, with 49.9 ms p95 presentation time,
1920×1080 output, all 111 trees, and no console/network/renderer errors.
Evidence: `/tmp/play-auto-pines-wind.json` and `.png`. The build and 34 targeted
tests pass. Sustained 30 fps is still an open acceptance requirement.
