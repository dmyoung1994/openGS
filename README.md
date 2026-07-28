# Claude GolfSim

A physically accurate, procedurally generated golf simulation in Three.js. No
build step, no bundler — just ES modules, a vendored copy of Three.js, and a
tiny static server.

## Run it

```bash
node serve.js          # http://localhost:5173  (live-reload on)
LIVE=0 node serve.js   # disable live-reload
node serve.js 8080     # custom port
```

That's the whole toolchain. Three.js is vendored in `vendor/` and resolved by
the import map in `index.html`. Nothing to install.

## Controls

- **Space** — hit the shot with the current launch metrics
- **R** — reset the camera to address
- **Launch Monitor panel** (top-left) — ball speed, launch angle, launch
  direction, spin rate, spin-axis tilt, plus conditions (wind, altitude, temp).
  Pick a club preset or dial in your own numbers.

## What's real here

**Ball flight** is integrated with 4th-order Runge-Kutta from true launch
conditions. Forces are gravity, aerodynamic drag, and Magnus lift, with:

- Lift and drag as functions of **spin ratio** `S = rω/v` and **Reynolds
  number** `Re = ρvD/μ`. Lift uses a 2nd-order polynomial in `S`; drag models
  the classic **drag crisis**. Coefficients are calibrated to TrackMan tour
  launch data across the bag (**~3.8% mean carry error, driver → wedge**).
- **Spin decay** in flight (τ ≈ 24 s).
- **Air density** from altitude, temperature, and humidity (so altitude and
  hot/cold days change carry the way they really do).
- **Wind that strengthens with height** (boundary-layer power law) — a towering
  shot fights more wind than a stinger.

**Ground interaction** is surface-dependent. Greens, fairway, fringe, rough,
deep rough, sand, hardpan, cartpath, and water each have their own restitution,
friction, roll resistance, and spin grab (see `src/physics/groundInteraction.js`),
so a wedge checks up on a green, a ball releases on fairway, and rough kills roll.

**Rendering** is GPU-first: instanced, vertex-shader-animated grass; procedural
turf shading (mowing stripes, micro-detail) in the fragment shader; instanced
tree line; a shader sky dome. A cinematic camera director tracks each shot.

## Layout

```
serve.js               zero-dependency static server + live-reload
index.html             import map + loading screen
vendor/                three.module.js, ImprovedNoise.js
src/
  physics/             constants, aerodynamics, ballistics (RK4),
                       groundInteraction (surfaces), Ball (flight→roll→rest)
  terrain/             Terrain (heightfield + turf shader), Grass (instanced)
  scene/               SceneManager, Sky, Lighting, Range, Tracer
  camera/              CameraDirector (cinematic)
  ui/                  MetricsPanel (launch monitor + HUD)
  util/                units, noise
```

## Roadmap

The range is the foundation. Next: procedural course generation distilling
classic architecture (Raynor/Macdonald template holes, MacKenzie/Old Tom
routing and green contouring), water and richer foliage, and a ball-construction
model (dimple size/depth/count) for the "different ball" metrics.
