# Rangeform

A physics-based, procedurally generated golf simulation with a custom
WebGPU/TSL environment renderer on Three.js and a Vite development/build toolchain.

## Run it

```bash
npm install
npm run dev             # Vite development server
npm run build           # production bundle in dist/
```

## Controls

- **Space** — hit the shot with the current launch metrics
- **R** — reset the camera to address
- **F** — toggle the evaluator/free-fly camera without changing gameplay state
- **W/A/S/D** — fly forward/left/back/right while the free camera is active
- **Mouse drag** — inspect the scene from another angle; **Space/Ctrl** rise/fall
  and **Shift** temporarily increases fly speed
- **Launch Monitor panel** (top-left) — ball speed, launch angle, launch
  direction, spin rate, spin-axis tilt, plus conditions (wind, altitude, temp,
  and soft/medium/firm ground).
  Pick a club preset or dial in your own numbers.

## Environment benchmark

Run the Vite app, then capture the fixed address, low-rough, and overview views:

```bash
npm run dev
npm run benchmark:env -- --url http://127.0.0.1:5173
```

The benchmark is deliberately WebGPU-only; there is no WebGL or CPU rendering
fallback. It waits for environment assets, warms the shader/post path, records
requestAnimationFrame pacing and bounded native WebGPU timestamp intervals for
every required render pass, merges overlapping intervals, and writes `report.json` with one PNG per view to
`benchmarks/environment/`. Reports include browser, GPU adapter, WebGPU features and
limits, host platform, and the named performance tier. The low-rough capture also has
a calibrated luminance/near-black gate that catches invalid or catastrophically
underlit grass.

By default the run fails on any warning, page/shader/WebGPU error, missing timing
pass, more than eight render passes, visual regression, frozen-simulation temporal
RGB error above 0.1/255, more than 0.1% materially changed pixels, GPU frame-completion
p95 above 14 ms, rAF p95 above 18.5 ms, or hitch. Pass spans are reported for
diagnosis but never summed because WebGPU can overlap them. Use `--gpu-p95-ms`,
`--raf-p95-ms`, `--max-hitches`, `--max-render-passes`, `--temporal-mae`,
`--temporal-changed-pct`, and `--performance-tier` to define another explicit
device contract. The
`--allow-performance-miss` switch is only for debugging functional correctness: it
does not change the renderer, backend, shaders, workload, or visual quality.

Compare two same-camera PNGs with explicit perceptual budgets when reviewing a
renderer change:

```bash
node scripts/compare-render-images.mjs before.png after.png \
  --max-mae 2 --max-luma-mae 2 --max-block-mae 1 --max-changed-pct 5
```

The command exits nonzero when any supplied threshold is exceeded. Both reports must
carry the same `environmentSeed`; course dressing is deterministically generated from
that recorded seed.

## What's real here

**Ball flight** is integrated with 4th-order Runge-Kutta from true launch
conditions. Forces are gravity, aerodynamic drag, and Magnus lift, with:

- Lift and drag as functions of **spin ratio** `S = rω/v` and **Reynolds
  number** `Re = ρvD/μ`. The inspectable baseline is the USGA/R&A 2006
  trajectory-derived coefficient fit. A named modern-tour urethane profile adds
  a bounded high-speed/low-spin correction and is regression-checked against a
  published TrackMan example plus the neutral-conditions hero-driver target.
- **Spin decay** in flight (τ ≈ 24 s).
- **Air density and dynamic viscosity** from altitude, temperature, and humidity.
- **Wind that strengthens with height** (boundary-layer power law) — a towering
  shot fights more wind than a stinger.

**Ground interaction** is surface-dependent. Greens, fairway, fringe, rough,
deep rough, sand, hardpan, cartpath, and water each have their own restitution,
friction, roll resistance, and spin grab (see `src/physics/groundInteraction.js`).
Soft/medium/firm presets vary restitution, friction, and rolling resistance rather
than multiplying the final yardage.

**Rendering** is GPU-first: instanced, vertex-shader-animated grass; procedural
turf shading (per-zone grading, parallaxed micro-detail) in the fragment shader;
deterministically placed catalog trees, ferns, boulders, and deadwood; render-only
distant terrain; and a shader sky dome. The temperate-alpine biome builds a seeded,
multi-band basin with foothills, forested walls, drainage, snowline, and a lower
down-range valley opening. A cinematic camera director tracks each shot.

## Layout

```
index.html             simulator entry point + loading screen
viewer.html            isolated environment-asset viewer
scripts/               capture, benchmark, shader, and asset tooling
src/
  physics/             constants, aerodynamics, ballistics (RK4),
                       groundInteraction (surfaces), Ball (flight→roll→rest)
  terrain/             Terrain heightfield/turf shader + GPU grass pipeline
  environment/         licensed asset catalog + deterministic course dressing
  scene/               SceneManager, Sky, Lighting, Range, props, backdrop, Tracer
  camera/              CameraDirector (cinematic)
  ui/                  MetricsPanel (launch monitor + HUD)
  util/                units, noise
```

## Roadmap

The range is the foundation. Next: procedural course generation distilling
classic architecture (Raynor/Macdonald template holes, MacKenzie/Old Tom
routing and green contouring), expanded biome palettes and water-edge treatment,
and a ball-construction model (dimple size/depth/count) for the "different ball"
metrics.
