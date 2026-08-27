# Universal ball-flight model

The production flight model depends on ball launch state and atmosphere only:

- ball speed and three-dimensional launch direction;
- total angular velocity, including signed spin-axis tilt;
- air density, viscosity, wind, gravity, and regulation ball dimensions.

Club names never enter the aerodynamic or integration path. Presets may produce
launch values and may drive visual effects, but identical launch states produce
identical flights regardless of any `club` metadata.

## Aerodynamics

The default coefficients come from Spencer Ferguson's 2023 University of
Waterloo thesis, [A Two-Armed Forward Dynamic Model of a Golf Drive](https://hdl.handle.net/10012/19337),
section 3.4, equation 3.15:

```text
CD = 0.1304 + 0.9287 S - 0.8259 S²
CL = 0.0504 + 1.2031 S - 1.1490 S²
CM = 0.01 S
```

`S = |ω|r/|v|` is the instantaneous non-dimensional spin ratio. Ferguson fitted
the model to 1,040 outdoor 2021 Pro V1 shots spanning lob wedge through driver.
GCQuad measured launch state, FlightScope X3 tracked the actual flight, and wind
was below 1.3 m/s. On the held-out 20%, the reported mean absolute errors were
2.74 yd carry, 1.68 yd offline, and 1.28 yd apex. The observed spin-ratio range
was 0.02–0.75; live integration holds the 0.75 boundary rather than extrapolating
the quadratic into unsupported states. The identified spin-moment coefficient
drives vector spin decay through the same Runge-Kutta integration as velocity.

The older 2006 USGA/R&A iron-flight coefficient table remains available as an
inspectable baseline, but the previous high-speed/low-spin driver correction has
been removed from the default path.

## GCQuad comparison corpus

`src/physics/calibration.js` contains 22 normalized records from:

- the two owner-supplied GCQuad device photos;
- a public [FSX session export](https://github.com/christianrehn/CombineTest/blob/master/test/data/SessionData/tmp/20221112PLAYER_11505.session);
- GCQuad/TrackMan comparison screenshots in [Jacopo Falsarella's thesis](https://thesis.unipd.it/handle/20.500.12608/49763), figures 4.14–4.15;
- five-shot [GCQuad robot-test averages](https://metasealgolf.com/urethane-golf-balls/robot-test).

Foresight [documents launch state as measured data and flight results as calculated](https://help.foresightsports.com/hc/en-us/articles/47144162581523-Ball-Launch-Data-Measurements-Ball-Flight-Results).
Consequently, the corpus compares our
model with FSX/GCQuad output; it is not mislabeled as measured ground truth. The
Falsarella low-spin example is especially useful: GCQuad reported 326 yd while
TrackMan reported 311 yd for the same shot, and the source explicitly identifies
the GCQuad result as inflated.

Run the reproducible report with:

```sh
npm run validate:flight
npm run validate:flight -- --json
```

Under the harness's declared sea-level ISA, still-air, flat-ground conditions,
the current 22-record GCQuad comparison MAE is 2.43 yd carry. The owner's 157
mph / 11.7° / 4,199 rpm / 17° R shot simulates to 242.8 yd versus 244 yd. The
157 mph / 6.3° / 3,024 rpm / 33° L shot simulates to 212.0 yd versus 221 yd.
That second axis leaves about 2,536 rpm as backspin and about 1,647 rpm as the
lateral spin component, so treating all 3,024 rpm as vertical lift would be a
physics error.

## Input signs

The launch panel displays direction explicitly:

- negative azimuth or spin axis: `L`;
- positive azimuth or spin axis: `R`;
- zero: straight/neutral.

Spin-axis input now covers ±60°, including the owner's 33° L result. Tests verify
that L curves left, R curves right, and arbitrary club metadata cannot affect
carry, curve, or apex.
