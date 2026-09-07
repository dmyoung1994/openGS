# Strategic green design

Use this guide to design original greens informed by enduring architectural principles. Do not reproduce a famous green's measurements, contour map, or identity.

## Design sequence

1. Define the target shot: length, trajectory, likely dispersion, wind, firmness, and whether a running entry should remain viable.
2. Choose the rewarded approach angle and explain why reaching it from the prior shot costs or saves risk.
3. Map five zones before shaping: entry, primary pin region, alternate pin region, collection/recovery area, and rejecting edge.
4. Select one primary contour family and at most one supporting device. Fit both to the site's landform.
5. Shape the surrounds with the green. Specify what happens to misses short, long, left, and right and which recovery shots each lie permits.
6. Set target green speed before evaluating slopes. Faster surfaces require quieter hole locations.
7. Create explicit surface-drainage exits. Avoid accidental closed depressions.
8. Validate pin capacity, cup clearance, slopes, drainage, approach visibility, recoverability, and render/physics agreement.

## Contour grammar

- **Tilted plane:** one dominant fall with small shoulders or shelves. Use angle and wind to change effective size.
- **Redan:** diagonal green with a high entry shoulder that feeds a running shot across the surface. Preserve a side-door route; do not reduce it to a diagonal bunker arrangement.
- **Crowned or pushed-up:** a quiet core sheds misses toward varied surrounds. Keep a credible entry and recovery network; a uniformly repelling dome is monotonous.
- **Tier and shelf:** connect distinct playable regions with a broad transition. Never use a wall, crease, or unmaintainable cliff.
- **Spine and quadrants:** a ridge separates lines and pin regions. Let the ridge redirect marginal approaches without making every cross-green putt absurd.
- **Saddle:** two shoulders create a central pass or collection route. Ensure water can leave the low line.
- **Punchbowl or backboard:** enclosing slopes gather shots. Leave an open drainage and visual entry rather than sealing a bathtub.
- **Fallaway or false front:** use selectively to test distance control. Make the rejection readable from the playing view and provide a fair recovery.

Combine devices only when they express one coherent idea. Prefer broad, low-frequency landforms over ripples, noise, or many unrelated humps.

## Lessons from exemplary courses

### Shinnecock Hills — land, offset and wind

- Let existing landforms establish the green plane, bunker tie-ins, and approach orientation.
- Offset or cant the green relative to the fairway so position and wind change the effective target.
- For a Redan-like idea, make the high-side ground route a real alternative that feeds the ball toward the target.
- Moderate speed or setup when firm, contoured surfaces combine with strong wind; difficulty is multiplicative.

Transfer the relationship among landform, angle, wind, and ground play. Do not clone Shinnecock's seventh green.

### Augusta National — contour as strategy

- Use width and short grass so angle, trajectory, spin, and imagination matter more than raw hazard count.
- Let large-scale approach topography and internal green contour work together. A good side of the fairway should simplify one pin while complicating another.
- Use slopes as backboards, feeders, deflectors, or rejection zones; each contour must produce a recognizable shot outcome.
- Preserve creative recovery options around the green instead of defaulting every miss to rough or sand.

Transfer contour-led strategy and expressive short grass. Do not imitate a Masters hole or its pin locations.

### Pinehurst No. 2 — edges and recovery

- Use a crowned or pushed-up surface to make apparent green size larger than effective landing area.
- Vary the edges: a receptive entrance, a soft shoulder, a sharper shedding edge, and one or more collection areas are more interesting than a symmetrical dome.
- Design the putt, chip, pitch, bump, and bunker recovery choices at the base of the green before finalizing its crown.
- Provide width earlier in the hole so the player can improve the approach angle rather than face a purely aerial exam.

Transfer the edge-and-recovery network. Do not make every green a turtleback.

### Pasatiempo — bold contour married to hazards

- Treat green, bunkers, and surrounds as one continuous sculptural complex.
- Use bold macro-contours with calm plateaus embedded inside them; visual drama does not excuse insufficient pin area.
- Preserve contour intent when rebuilding the rootzone and drainage. Final grades, pin capacity, and maintainability must agree.
- Use historical or reference evidence as a model to interpret, not a texture to trace.

Transfer the integration of bold contour, hazards, pin regions, and drainage. Do not reproduce the sixteenth.

### Calusa Pines — manufactured height with natural flow

- On a flat site, build height using wide, soft, connected ridges rather than isolated mounds.
- Use elevation to reveal or conceal parts of the target, separate holes, and make each complex distinct.
- Pair dramatic raised greens and deep hazards with sufficient width, alternate play, and readable scale.
- Make artificial landforms appear geologically continuous beyond the maintained turf.

Transfer bold modern scale and flowing landforms. Do not equate spectacle with maximum severity.

## Simulator geometry heuristics

These are project defaults, not universal architecture rules. Override them deliberately for green speed, player ability, climate, and design intent.

- Measure gradients on the authoritative physics height field, not only the render mesh.
- Keep ordinary putting regions mostly in the 0.5–4% range. Reserve 4–8% for expressive traversal, feeders, shoulders, and separators.
- Use 6–12% transitions sparingly and keep them out of intended cup neighborhoods. Treat sustained slopes above 12% as surrounds unless slow speed and testing justify them.
- Around a candidate cup, require a quiet neighborhood at least 3 m in radius. At roughly 10–11 feet of green speed, target no more than about 2.5–3% local slope; re-evaluate rather than blindly applying this range at other speeds.
- Keep normal cup candidates at least 4.5 m from the green edge and farther from false fronts or severe hazards when needed. The USGA article cited below reports a common setup practice of about five paces/15 feet, not a Rule of Golf.
- Target at least four meaningfully separated daily pin sites and preferably six or more on a full-size green. Distribute them across distinct approach and putting problems.
- Avoid a design where less than 30% of the core can support plausible pin rotation. This is a project warning threshold, not a governing standard.
- Keep height-field tie-ins continuous. Do not hide sharp steps under material blends.
- For multi-tier greens, give each tier enough depth to receive the intended shot and make the connecting ramp broad enough to read from the approach.
- Check a straight and breaking putt from each pin region, plus approach outcomes from the preferred, neutral, and poor angles.

Slope and speed are coupled. A historically bold contour maintained at modern fast speed can lose usable hole locations. Preserve architectural interest by choosing an appropriate speed before flattening the design.

## Green brief

Record this before generating geometry:

```yaml
target_shot: carry, trajectory, dispersion, wind
target_speed_ft: expected Stimpmeter range
primary_contour: one contour family
supporting_contour: optional second device
preferred_approach: origin and rewarded angle
target_topology: connected or intentional island
approach_tie_ins: maintained route, entry width, and continuous landforms
ground_entry: open, partial, or aerial-only with reason
pin_regions: location, size, local slope, approach problem
miss_map: short, long, left, right outcomes and recoveries
drainage_exits: explicit low routes off the surface
inspiration: transferable principles and sources
not_a_replica_of: named precedents that must not be copied
```

## Geometry authoring contract

Translate the brief into geometry in this order. Do not start by drawing a
circle and decorating it with elevation spots.

1. Draw the entry axis and the preferred approach axis.
2. Place the quiet pin regions as actual areas with a 3 m calm neighborhood.
3. Draw a non-generic boundary around those regions. Use a nose, bay, shoulder,
   pinch, or offset lobe only where it changes entry, recovery, or a pin's
   effective width. A spline alone does not make an almost-round polygon
   architecturally specific.
4. Set `grade:{slopeX,slopeZ,blend}` when the inherited site bumps prevent quiet
   pin areas; start with a modest drainage slope and a broad tie-in. Build the
   primary contour with explicit `green.contours` records. Use
   `{kind:"ridge",points:[...],width,height,falloff}` for a broad spine and
   `kind:"plateau"` or `"shelf"` for quieter regions. Combine at most a few
   purposeful forms with `"swale"` or `"drainage-channel"` exits. The legacy
   `contour` name alone creates no height. Do not invent `ridgeContours`,
   Gaussian zones or profile fields; see engine.md for the validated contract.
5. Carry the landform through the collar and surrounds with a broad tie-in.
   Assign distinct short, long, left, and right outcomes before adding hazards.
6. Verify that the primary contour is visually and physically legible. As a
   review trigger, a full-size green with both less than about 0.45 m relief and
   a 90th-percentile slope below roughly 1.75% probably has no readable contour
   idea. This is a diagnostic, not a requirement to make every green severe.
7. Reject an almost circular result unless radial symmetry is strategically
   intentional and recorded in the brief. Review silhouette from the normal
   approach camera, not only from overhead.

For a spine-and-quadrants green, keep the ridge broad and low-frequency, place
quiet pin regions off the ridge, and make cross-ridge putts a deliberate cost of
missing the preferred approach angle. For a tier-and-shelf green, use bounded
flat-core plateau zones and a broad transition rather than stacked Gaussian
mounds.

Across a multi-hole course, vary orientation, size, contour family, entry condition, edge behavior, pin distribution, and recovery palette. Do not solve every hole with a huge two-tier green.

## Failure patterns

- A circle or ellipse with generic noise and no strategic relationship to the approach.
- One severe slope covering the entire surface, leaving no calm pin neighborhoods.
- A tier step that reads as a wall or produces a mesh/physics discontinuity.
- Every edge repelling and every miss requiring the same recovery.
- A hidden false front, blind hazard, or collection area invisible from the normal camera.
- Decorative contour that does not alter approach, putting, or recovery decisions.
- A large nominal area with little usable pin rotation.
- A closed bowl with no surface-drainage outlet.
- Famous-course mimicry substituted for site-specific reasoning.

## Source provenance

- [USGA: The Evolution of Shinnecock Hills](https://www.usga.org/content/usga/home-page/history/the-evolution-of-the-shinnecock-hills-golf-course.html) — Flynn's use of natural landforms, offset greens, strategic routing, wind, and the Redan example.
- [USGA: How Wind Affects Course Maintenance at Shinnecock Hills](https://www.usga.org/content/usga/home-page/articles/2026/06/how-wind-affects-course-maintenance-shinnecock-hills.html) — interaction among wind, firm conditions, contour and setup.
- [Golf Course Architecture: Architects' Choice — Augusta National](https://www.golfcoursearchitecture.net/content/architects-choice-no-4) — contour-led strategy, width, sparse hazards, and short-grass recovery.
- [Pinehurst: No. 2 Restoration](https://www.pinehurst.com/news/the-pinehurst-no-2-restoration-a-hole-by-hole-tour/) — strategic choices, restored width, natural areas, and original character.
- [USGA: Building Blocks of Great Course Architecture](https://www.usga.org/content/usga/home-page/articles/2025/10/building-blocks-great-course-architecture.html) — greens and varied surrounds as primary strategic defenses, including Pinehurst No. 2.
- [Pasatiempo: Restoration Project](https://restoration.pasatiempo.com/restoration/about.html) — restoring MacKenzie contours, marrying greens/bunkers/surrounds, increasing pinable area, and modern drainage.
- [Calusa Pines: Architects' Vision](https://calusapinesgolfclub.com/architect-vision) — height as the soul of the course, broad flowing manufactured landforms, elevated targets, and shot variety.
- [USGA: Architectural Speed Limit](https://www.usga.org/content/usga/home-page/course-care/forethegolfer/2017/the-architectural-speed-limit-for-putting-greens.html) — coupling green speed to contour and usable hole locations.
- [USGA: Hole Location, Location, Location](https://www.usga.org/content/usga/home-page/course-care/forethegolfer/2018/hole-location--location--location.html) — practical edge clearance, false-front awareness, and speed/slope considerations.
- [USGA: Putting Green Construction Resources](https://www.usga.org/course-care/specialty-articles/usga-putting-green-construction.html) — smooth subgrade, drainage along maximum fall, and avoidance of water-holding depressions.

## Intricate greens and live reading

Use asymmetric two-wing, angled hourglass, offset boomerang, or long diagonal
forms when they create different entries and pin problems. Give concave bays a
reason, keep receiving lobes large enough for the intended shot, and preserve
wide playable connections between them. Complexity is varied golf, not a
serrated perimeter. Author 6–48 sparse controls, inspect the normalized curve
at low oblique and overhead views, and keep alternate pins away from necks.

The Green grid toggles one-metre lines with travelling pulses. Each axis moves
with its downhill slope component; level axes remain still. Colour progresses
continuously from teal at level through gold at 3% to coral at 6% and above.
This is a slope display, not a predicted putt or calibrated ball speed. Verify
quiet pin neighborhoods and breaking/straight low-speed putts with the actual
height sampler. Keep geometry edits separate from display-only grid changes.

## Protection palette

Choose one primary defense and at most one supporting defense before drawing a
green. Vary the combination across holes; do not default to flanking bunkers.

- **Contour defense:** unequal wings separated by a broad spine; a safe approach
  leaves a longer cross-contour putt. Keep an open running entry and recovery ground.
- **Angle defense:** a diagonal or boomerang surface with sand on one side; position
  on the preceding shot earns the long axis or a feeding shoulder. The opposite
  side remains a genuine bailout with a different recovery problem.
- **Depth defense:** a long waisted green, deep rear shelf and offset front hazard;
  carry and distance control choose the tier. The waist must remain playable and
  each receiving region must accommodate dispersion and alternate pins.
- **Ground defense:** a false front, fallaway edge or collection hollow with dry
  recovery. Shape this through grade/contours and surrounding landforms; a colour
  boundary alone does not create a false front. Keep rejection slopes away from pins.
- **Carry defense:** an explicitly requested island or water-side target with fair
  carries, a visible hazard and real relief rules. Check current engine support
  before promising detached geometry. Do not add water merely for visual variety.

Design front, back, left and right misses individually. Tie every concavity,
protruding nose and hazard to an approach angle, pin region or recovery decision.
Avoid serrated outlines and mandatory penalty walls. Validate the normalized
curve, hazard separation, a maintained entry, quiet pin neighborhoods, and both
conservative and challenging lines from the preceding shot. Record the selected
defense and earned advantage in the course brief.
