# Backdrop Plan — Own the Valley

Status: working plan, supersedes the HDR-enclosure direction from Cycle 53/71.

## Decision

The Poly Haven Alps Field HDR stops being a render source. It is **composition
inspiration only**: where the valley opens, which way the walls lean, where the
snow-capped central peak sits. The visible backdrop becomes real game geometry
and an analytic/authored sky, all lit by the one runtime sun, one fog, and one
PMREM. The photo failed on vibe, not on quality — a saturated photograph behind a
stylized range is two worlds in one frame. No further stock-HDR hunts.

Vibe target: clean, bright, broadcast-style alpine practice range (TGL/WGT
grade). Layered depth, nearest to farthest:

1. Turf hero (fairway/rough/targets) — already the strongest element, keep it
2. Near tree line (hero LOD0/LOD1 conifers + community impostors)
3. Forested foothills with meadow bands (Band A geometry)
4. Broken mineral massif with a snow-capped central hero peak (Band B geometry)
5. Clean sky with at most a few soft clouds

One palette throughout. Distance desaturation via the shared FogExp2, not via
per-layer color hacks.

## Baseline (captured 2026-08-15)

Full 7-camera suite **PASS** with the photo backdrop in place:

| Camera | GPU p95 | Hitches | Worst MAE | Mean luma |
|---|---:|---:|---:|---:|
| address-tee | 9.40 ms | 0 | 0.0049 | 97.6 |
| low-rough | 11.15 ms | 0 | 0.0141 | 65.3 |
| landing-crosscourse | 9.11 ms | 0 | 0.0019 | 81.8 |
| landing-return | 10.73 ms | 0 | 0.0037 | 98.2 |
| approach-green | 9.42 ms | 0 | 0.0001 | 94.1 |
| pond-contact | 11.51 ms | 0 | 0.0201 | 72.2 |
| overview | 9.92 ms | 0 | 0.0001 | 73.1 |

Budget is 14 ms. Headroom for the new geometry: ~3–5 ms.
Screenshots: `benchmarks/environment/` (startup + settled + 32 temporal frames).

## What already exists (most of the work is wiring + tuning)

- `src/scene/BackdropTerrain.js` — the full procedural alpine shell is present
  but disabled. `_buildAlpine()` (line 28) returns an empty group with
  `proceduralShell: false`. All the machinery below is intact:
  - `alpineComposition(seed)` — dominant/secondary wall bearings, downrange
    opening bearing, snowline (360–430 m), peak scale
  - `alpineSampler()` — domain-warped ridge skeleton, baked 128² USGS 3DEP
    North-Cascades table for the far massif (`NORTH_CASCADES_DEM`), three
    landform tiers (near shoulder / middle wall / far massif), U-shaped
    downrange opening with saddle + floor cut, snow/rock/scree/cliff fields
    packed into vertex attributes
  - `ringPatches()` + `buildPatch()` — radial ring meshes with analytic
    continuous-sampler normals (8 m span taps) and alternating triangulation
  - `worldMaterial()` — PBR forest/rock/snow/talus response: slope+geology
    exposure, mineral patches, bedding, moisture drift, altitude bands
- `src/scene/WeatherSky.js` — full analytic-sky fallback when `skyManifest` is
  null (`environment.skyRadiance`), analytic sun delta, optional analytic cloud
  slab (enabled; default `DEFAULT_CLOUD_COVERAGE = 0.38` in `src/main.js`, live on
  the Conditions panel's Cloud cover slider)
- `src/scene/SceneManager.js` — `configureWeather(environment, skyManifest)`,
  PMREM capture of `weatherSky.iblBackgroundNode` (analytic path already named
  `analytic-daylight-pmrem`), fog/horizon coupling in `_applyEnvironmentDaylight`
- `src/main.js` line 120/349 — `loadSkyManifest()` → `configureSkyManifest`
- ~40 sampler tests in `test/backdrop-terrain.test.mjs` already pin the
  composition (valley opening, ridge tiers, wall landforms, snowline bounds)
- Community impostor mid/far tree layer + catalog
  (`public/assets/environment/backdrop-community-catalog.json`)
- BlenderKit bake pipeline precedent: `scripts/bake_material.py`, bentgrass
  bake, per-asset provenance docs + hash tests

## Phases

Each phase ends with: dev-server check (restart if down) → targeted
`shot.mjs` captures → full `npm run benchmark:env` → read PNGs → judge.
Perf numbers only count on AC power.

### Phase 1 — Drop the photo, own the sky

1. `src/main.js`: stop loading the manifest (pass `null` to
   `configureSkyManifest`; keep `loadSkyManifest`/`SkyManifest.js` for the
   A/B skybox variant below). `WeatherSky` falls back to the analytic sky;
   PMREM, water reflections (`skyRadiance`), and IBL all follow the same node.
2. Update contracts in the same change: `test/sky-manifest.test.mjs` pins the
   active manifest file; adjust to the no-manifest contract (or repoint it at
   the A/B skybox manifest if that wins).
3. Analytic sky vibe pass in `EnvironmentGpuBindings.skyRadiance`: brighter
   zenith blue, warm horizon band whose color **equals the fog color**, soft
   bounded sun halo. One sun contract unchanged (DirectionalLight is the only
   direct key; no HDR disc).
4. Clouds A/B (judge by capture, not opinion): **B wins, shipped.**
   - A: clear (former default)
   - B: re-tuned analytic slab — **shipped at coverage 0.38.** Both historic
     rejection modes are fixed. The horizon smudge was geometric, not artistic:
     `cloudDistance` divides by `direction.y.max(0.10)`, so every ray below ~5.7°
     lands at the same slab distance and the noise smears along one line. The old
     `horizonMask` (`smoothstep(0.025, 0.12, …)`) reached full opacity *inside*
     that band. Fix: mask widened to `smoothstep(0.10, 0.30, …)` so clouds only
     exist above ~17°, plus base 1500→2200 m and thickness 760→600 m. Flat white
     cutout islands are fixed by `cloudDensity.pow(1.35)` before the alpha cap and
     a stronger `cloudTop` term in `lightGrade`.
   - Coverage is now a live control (0–70%) via `MetricsPanel` →
     `applyEnvironmentConditions` → `SceneManager.refreshWeatherSkyClouds()`, which
     rebuilds the sky node *only* when coverage crosses zero. Clouds never touch
     PMREM/IBL (`iblBackgroundNode` is built cloud-free) or post (`_setupPost`
     branches on `usesVolumetricClouds`, permanently false), so an in-range drag
     costs nothing and 0% still compiles the clear sky with no cloud grade.
   - C: baked stylized skybox (Blender/BlenderKit): equirectangular ~2K, clean
     blue with 3–4 soft painterly puffs, sun placed at the authored
     azimuth/elevation, loaded through the same manifest mechanism (yaw
     rotation + solar-core masking already implemented). This is the TGL-style
     range sky; it is a texture but a *stylized* one, matched to the world it
     sits behind.
5. Gate: all seven cameras still ≤ 14 ms, zero hitches, temporal MAE ≤ 0.15,
   and the sky reads as the same world as the turf.

### Phase 2 — Valley geometry: re-enable the shell, vertex-smart

The mountains are 1.4–3.3 km out. At 40° FOV from golfer height, 1 m of
geometry at 2 km projects to well under a pixel. The far massif is perceived
as **skyline + broad faces**, so it does not deserve a radial grid. Two bands:

**Band A — near wall and foothills (0–1.4 km): ~25–30 k verts**
- Four rectangular patches from `ringPatches` (existing), ~30 m spacing
  (relief here is visible: spurs, drainage, the 300–500 m wall band, tree-line
  base). This band keeps the full geology vertex attribute (rock/snow/scree/
  cliff) and the full `worldMaterial` response.

**Band B — far massif (1.4–3.3 km): ~2–4 k verts**
- Cylindrical azimuth ribbon instead of a radial grid: 256–512 azimuth columns
  × 2–3 depth rows. Heights and normals from the **same continuous sampler**
  (analytic 8 m span taps, same logic as `buildPatch`), so the silhouette is
  smooth against the sky and faces light coherently.
- Split into 4–8 azimuth segments with per-segment bounding spheres for
  frustum culling; most frames render 2–3 of them.
- Skip the geology attribute where the shader can get away with altitude/slope
  tint + fog (decide by capture; the 3 km wall is already ~20 % hazed by the
  current FogExp2).
- No shadow casting, no shadow receiving, render-only, static.

**Composition (photo as reference, not a copy):**
- Keep the downrange U-shaped opening (existing `openingWindow` /
  `openingFloorCut`).
- Two asymmetric forested side walls (existing dominant/secondary lobes).
- Hero: central-downrange snow-capped peak — the peak currently borrowed from
  the photo. Bias `farMassif` amplitude + snowline to a dominant central
  bearing; keep the side walls lower and bluer.
- Meadow bands in the foothills (existing `groundField` / wall-wash machinery)
  so the Band A wall is not a uniform green slab.

**Hard budgets (assert in tests, not vibes):**
- Total backdrop verts ≤ ~40 k (playable terrain is 82 k for reference)
- Cold-range `ready` stays ≤ 3.5 s (CPU cost of sampling ~30 k vertices
  through the fbm/DEM sampler — measure before tuning; if startup misses,
  pre-bake Band A heights to a bundled table like `northCascadesDem.js`)
- Band B draws ≤ 8, Band A draws ≤ 4; zero shadow flags
- Full suite ≤ 14 ms GPU p95, `tree-edge-close` ≤ 16.7 ms

**Contract flips (same change as the code):**
- `test/backdrop-terrain.test.mjs` line 36 currently pins "runtime delegates
  the horizon to HDR and builds no procedural shell" — invert it to pin the
  new build + budgets above.

### Phase 3 — One light field, one palette

- Fog color == sky horizon color (coupling exists in
  `_applyEnvironmentDaylight`; verify with the analytic sky and re-tune
  density — it was tuned against the photo wall and may over/under-haze the
  new geometry).
- Mountain palette, desaturated toward the range's broadcast look:
  blue-green conifer foothills (not the photo's saturated green), warm-gray
  rock, soft snow with a cool shade tint.
- Mid/far conifer community: distance desaturation, softer edges, broken
  repetition (Cycle 71 blocker: "too saturated, repetitive, and hard-edged").
- Re-shoot all seven cameras; compare against the Phase 0 baseline PNGs with
  `scripts/compare-render-images.mjs` for the ground plane (ground must not
  regress; sky/backdrop regions are expected to change).

### Phase 4 — Blender/BlenderKit assets, only what captures demand

Pipeline precedent exists (bake → hash → provenance doc → test, e.g.
`turf-grass001-provenance.md`). Candidates, in priority order, **each gated by
a capture review first**:
1. Stylized skybox (Phase 1 option C) if analytic clouds lose the A/B
2. Rock/granite PBR set for Band A outcrops if procedural rock reads flat
3. Snow PBR set if the snowline band needs normal/roughness response
4. Meadow band texture for foothills if the meadow wash reads as paint

All placement stays terrain-grounded (current props are grounded; no
floating-asset work is planned or needed).

### Phase 5 — Rewrite the contract so the dark path stays closed

`docs/AAA_VISUAL_BAR.md` pushed the HDR hunt; it must change with the
direction:
- Reframe the target: coherent stylized broadcast range image (TGL/WGT grade),
  not a photographic match. Remove gates that imply photographic realism.
- Add hard anti-goals: no stock photographic HDR backgrounds; backdrop
  geometry, sky, water, and props must share the runtime sun/fog/PMREM;
  photographic references are composition inspiration only.
- Keep the performance gates unchanged (hardware facts, not style).
- Re-baseline the scorecard after Phases 2+3 land; run two consecutive clean
  acceptance cycles as before.

## Standing validation loop

1. Dev server: check `http://127.0.0.1:5173`; if down, start a fresh
   `npm run dev` (standing instruction).
2. Fast look: `node scripts/shot.mjs --game --cam x,y,z --look x,y,z --out /tmp/x.png`
   → read the PNG. `--probe` for numeric region sRGB.
3. Full: `npm run benchmark:env` (7 cameras, 1280×720, 14 ms gate, 32-frame
   temporal).
4. Stress: `npm run benchmark:env -- --scenario tree-edge-close --gpu-p95-ms 16.7`.
5. AC power for any perf number.

## Risks

- **Startup cost**: CPU sampling of ~30 k verts through the fbm/DEM sampler on
  cold range. Measure in Phase 2 step 1; fallback is a bundled pre-baked
  height table (pattern: `northCascadesDem.js`).
- **Silhouette faceting** on the Band B ribbon against sky: analytic
  continuous-sampler normals + ≥256 columns + alternating diagonals; verify
  from `overview` first, since it looks at the wall at the longest range.
- **Fog re-tune coupling**: density changes move every far pixel in every
  camera; change it last, in Phase 3, and diff against baseline.
- **Test contracts**: two tests pin the current HDR/empty-shell state
  (`backdrop-terrain.test.mjs:36`, `sky-manifest.test.mjs`). Flip them in the
  same change as the code they describe, never before.
