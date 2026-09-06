# Grasslands — Evening Walk

An additive, playable photo study at `/play.html?course=grasslands-reference` or
read-only creator preview `/creator.html?course=grasslands-reference`. Creator
authoring/history controls are disabled for this separate study so they cannot
modify the global workspace project. The normal Beach Range and workspace
Pineglass project are unchanged. Editable source:
`courses/grasslands-reference.project.json`; reproducible generation:
`node scripts/build-grasslands-course.mjs`.

To compile manual edits without regenerating/overwriting that editable project:
`npm run compile:course -- courses/grasslands-reference.project.json public/courses/grasslands-reference.json`.

## Reference and interpretation

The user supplied `IMG_C7866470276A-1.jpeg` on September 4, 2026. The environment
skill retains it as `references/grasslands-reference.jpeg`. Location, photographer,
species, capture time, measured distances and hidden architecture are unknown.
It is a visual reference, not a texture license. No photo pixels enter runtime
materials. The visible tiered tees, left wetland, right long clubhouse and native
grass/maintained contrast guide the composition; the unseen par-4 route, green,
hazard geometry and construction dimensions are explicitly inferred.

The study faces world +Z (180° site bearing), putting the real western sun on
the reference camera's right — verified against the camera basis, sun·right = +0.843,
which matches where the photograph's glow falls behind the clubhouse. Its clock is now
**19:06**, giving 1.14° of solar elevation: the sun genuinely at the horizon, rather
than the earlier 19:00 / 2.03° with the sky tinted to imply a sunset. Sunset at this
location and date is ~19:06. It uses the engine's UTC
interpretation, July 15, 2026 seasonal date, and default 46.5°N, 7.5°E lighting
location. These are an inferred lighting setup, **not** the photograph's verified
location/date/time. The existing ephemeris yields a 1.14° solar elevation at that
instant (19:00 was 2.03°, and the earlier 17:55 study was still 12.25°).
No warmth is baked into building or turf. The reference camera
is world `[0, terrain.heightAt(0,-35)+6, -35]`, toward `[-7, terrain+5, 105]`;
golfer-height views remain a separate acceptance requirement.

The wetland penalizes a pulled opening shot while leaving a dry right route.
The left drive bunker challenges the inside line at approximately 210 m from the
back tee; successful placement gains the open running approach. The green's right
bunker guards the poor angle while a 12 m front-left entry remains open. A broad
tilt drains toward the approach; misses left/short remain recoverable from rough
and maintained entry, rather than an enclosing ring of hazards.

## Original clubhouse asset

- Author: OpenAI Codex, commissioned in this project by the user.
- Model/script license: CC0-1.0. The reference photograph is not relicensed.
- Source: `public/assets/environment/grasslands-clubhouse/grasslands-clubhouse.blend`.
- Export: adjacent `grasslands-clubhouse.glb`; hash and dimensions in strict catalog.
- Rebuild: `/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/build_grasslands_clubhouse.py`.
- Blender 5.2, metre units, +Y-up glTF. Overall size 39 × 7.48 × 12.12 m;
  walls have a 38 × 11 m footprint. Dimensions are inferred, not surveyed.
- Actual hipped roof, individual slate courses, brick joints, stone plinth/sills,
  repeated multi-pane frames, dark glass, entrances, gutters/downpipes, ridge
  cupolas and emissive lantern panes. Sixteen shared material buckets retain
  those geometric details without one draw per brick. No billboard, image plane,
  borrowed building, or baked sunlight is used.
- Concealed/rear elevation repeats the visible facade grammar; no claim of exact
  reconstruction is made for unseen surfaces. Lamps currently have emissive panes,
  not local light pools. Fine material microtexture and hidden-side detail remain
  candidates for subsequent visual iteration.

The environment prop path preserves architecture's authored glass/metal/emission
instead of applying vegetation's matte overrides. Buildings and walls now cast
and receive real engine shadows. Strict catalog provenance allows only HTTPS
sources or narrowly scoped local editable `.blend` sources under
`/assets/environment/<asset>/<asset>.blend`.

## Native grass profile

`site.groundCover: "native-grasslands"` is render-only and opt-in. It retains the
existing GPU candidate field, camera-relative LOD, wind/history and physics surface
classification, but grades deep rough toward upright 0.67–1.15 m olive/straw blades,
with 0.12 m maintained rough and a registered muted distant undercoat. This is a
first morphology pass, not final photo fidelity: fine seedhead structure and
mature broadleaf anchors still require visual/source validation. Three native-size
Poly Haven Jacaranda source trees are being auditioned as crown-form analogues,
not assertions about the reference's botany; see `grasslands-jacaranda-provenance.md`.
Other ground-cover
profiles retain their existing values.

The latest morphology adds a stable minority of seed-spike stems through the same
ribbon rows and LOD topology; no extra candidate populations are allocated. Linear
native living/straw pigments are shared by blade, terrain and backdrop paths.
`route.fairwayStartMeters: 94` leaves native separators between isolated tees while
retaining the complete strategic route and yardage. Other courses omit that field
and retain their exact existing compiled runtime and classification behavior.

## Verification status

Project compilation and architectural PBR/shadow unit checks exist in
`test/grasslands-reference.test.mjs`. Production screenshot comparison and complete
performance acceptance are pending; this document does not certify a finished
replica or 30 fps.

The first usable production capture, `/tmp/grasslands-evening-v2.png` with its
adjacent JSON report, confirmed the real PlayScene, reference-course identity,
strict hardware WebGPU, and no console/network errors. It did **not** pass visual
acceptance: native grass appeared flat/absent, the foreground tee composition was
too shallow, the horizon showed a horizontal band, and the distant crowns did not
provide the photograph's mature mass. At 900 × 1200, ultra, scale 1, that capture's
120-frame p95 was 133.8 ms. The exact-source Jacaranda audition currently retains
its full 3.86-million-triangle geometry at both catalog distance bands; this is
explicitly not an accepted shipping LOD or performance result. These failures
remain open rather than being hidden by a smaller screenshot or lower scale.

The follow-up `/tmp/grasslands-diagnostic.json` isolated the missing grass:
267 active tiles, zero accepted blades, no capacity overflow. The former indirect
dispatch flattened 576 workgroups per tile into X: 153,792 exceeded the device's
65,535 workgroups-per-dimension limit. The shared grass path now assigns one tile
to each Y row and its 576 groups to X, with a device-bound check and diagnostics
for the actual GPU dispatch arguments. Candidate identities, density, geometry
and LOD budgets are unchanged by this dispatch fix. Production verification passed:
`/tmp/grasslands-restored.json` reported 906,987 accepted blades, 5,099,072 grass
triangles, `[576,267,1]` dispatch and zero overflow. Its four-pose sequence confirmed
visible grass and improved composition at elevated reference height. The short
24-frame p95 was 166.8 ms; this remains visual-debug evidence, not performance
acceptance. Subsequent routing, orientation, pigment and horizon changes still need
their own production comparison.

The later `/tmp/grasslands-graded.png` verified separated descending tees, native
foreground and the original clubhouse in the actual elevated production view.
`/tmp/grasslands-creator-readonly.png` also verified disabled authoring controls and
the explicit read-only notice on the real Creator route. These were still the
17:55 / 12.25°-sun state, not the intended near-sunset lighting.

The controlled 19:00 capture `/tmp/grasslands-sunset.png` confirmed the 2.03° sun
but exposed severely dark terrain under a still-bright sky. Two shared rendering
defects were fixed, without changing source pigment or camera:

- The analytic sky already contains solar/lunar/twilight attenuation. Multiplying
  its captured PMREM by direct-sun strength a second time suppressed real dusk
  bounce and erased twilight lighting. PMREM now retains the existing fixed 0.34
  renderer-reference calibration; sky and hemisphere use one shared daylight /
  twilight envelope. That reference value remains a calibration assumption, not
  a certified physical-unit conversion.
- The cheaper grass Phong path previously used `BasicEnvironmentNode`, whose
  multiply-mode reflection darkened existing light instead of adding diffuse
  irradiance. It now bridges native `EnvironmentNode` diffuse PMREM irradiance to
  Phong's Lambert accumulator. Native PMREM sampling, rotation and intensity are
  retained; blade topology, population and motion are unchanged.

`/tmp/grasslands-diffuse-ibl.png` and JSON verify both corrections under strict
hardware WebGPU with no console/network errors: 923,284 blades, 5,168,148 triangles,
zero overflow, sky envelope 0.53990, PMREM intensity 0.34, hemisphere 0.21596, key
0.57574 and exposure 1.704. Grass is visibly sky-lit instead of black. This is
**not final visual acceptance**: maintained turf/building are still too dark, the
sky/horizon does not match the reference, the inland backdrop edge is conspicuous,
and the native morphology/wetland/tree mass need further work. Daylight production
reference `/tmp/beach-skylight-fixed.png` remained healthy, with readable palms,
grass and shadows. Short diagnostic captures are not sustained-FPS evidence.

`scripts/qa-sky-irradiance.mjs` subsequently compared the native analytic sky and
actual production PMREM in a 3 × 5 floating-point diagnostic target (not a mock
renderer). `/tmp/grasslands-pmrem-probe.json` rules out PMREM capture exposure or
colour-space corruption: analytic/sharp-PMREM linear luminance was 0.065397 /
0.065424 at zenith, 0.153729 / 0.151913 at the view horizon, and 0.538486 / 0.521253
sunward; the small sunward difference is consistent with prefiltering. Zenith
diffuse-mip luminance was 0.100974. The real atlas is linear RGBA16F, 336 × 256.
Native readback rows retain WebGPU's 256-byte padding; the diagnostic decodes it
explicitly. Remaining darkness is not being blamed on an unverified broken PMREM.

`scripts/qa-turf-self-shadow.mjs`, `scripts/qa-ibl-calibration.mjs` and the new
`scripts/qa-dusk-light-budget.mjs` subsequently resolved the remaining dusk darkness.
The turf occlusion path was exonerated (self-shadow ratio exactly 1.000 at both noon
and 19:00), and the decomposed light budget showed the terrain's own analytic term
collapsing 106.6x from noon to dusk while the sky PMREM that should have cushioned it
was scaled to 0.34. Two corrections followed: golden-hour exposure adaptation now
tracks the direct illumination actually reaching level ground instead of holding a
flat lift until the sun is below the horizon, and the PMREM diffuse multiplier is
unity. `/tmp/grasslands-both-fixes.png` and its JSON report 923,346 blades, zero
overflow, `nearBlackPct` 0, strict hardware WebGPU and no console/network errors.
Ground-mid linear luminance is 0.06154 against the photograph's 0.05918.

This is **still not full visual acceptance for this study**. The sky remains 26%
brighter than the photograph and the wrong hue — blue [164,184,237] against the
reference's warm [187,162,142] — so the ground's bounce light is cold where the
reference is golden. The inland backdrop edge, native morphology, wetland and distant
tree mass all remain open, and these fixed-pose captures are not performance evidence.

The separately reported "grass stops near the trees" defect is also fixed. It was not
a ground-type or zone issue: the shared canopy mask retired blades outright wherever a
crown overlapped, which is correct only for `pine-needle-litter`, whose litter bed
replaces them. This course declares `native-grasslands` and `forestFloorAreas: []`, so
each jacaranda — catalog `bounds.radius` 15.8 m, times scale, times the 1.1 disc
scale — left a bald ring of bare terrain. Crowns now thin the grass instead, using the
distance field already baked into the mask. See the living plan for the measured blade
and triangle cost and the far-tier LOD headroom this consumes.

The sky chromaticity gap noted above is now partly closed. A dedicated sunset-glow
term (`SUNSET_GLOW_STRENGTH`, window closing near 12 degrees of solar elevation) warms
the low sky at a 2 degree sun without touching any higher sun; the horizon moves from
[136,154,201] to [176,165,188] against the photograph's [187,162,142], and its
luminance lands within 3%. Daylight is unchanged to the sRGB digit. The remaining
difference is distribution rather than tint: the photograph has a narrow saturated
orange band beneath a blue upper sky, while ours tints the whole dome. See the living
plan for the mechanism and the ground's remaining 40% shortfall.

Final measured state of the photo study at its 19:06 clock: sky-high 0.2550 against the
photograph's 0.2509 (within 1.6%), away-side horizon 0.2909 against 0.3478, sun-side
horizon 0.3278 against 0.2880, ground-mid 0.0242 against 0.0592. The turf reads green
rather than blue-grey after the twilight zenith desaturation, and the sun-side horizon is
now darker and more saturated than the away side, as the photograph shows.

The ground's remaining shortfall is understood and quantified rather than open-ended: in
scene-linear the ground/sky ratio is 0.199, exactly the turf's measured effective albedo,
so the lighting is correct. The display ratio falls to 0.096 inside NeutralToneMapping's
black offset, which removes 69% of dark values. No exposure satisfies both ground and
sky; closing it needs a tone-curve change plus a full turf re-grade. See the living plan.
