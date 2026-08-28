# Visual Fidelity

Treat fidelity as a hierarchy of readable physical scales, not as a post-processing preset.

## Four-scale construction

1. **Micro, 0.02–0.30 m:** turf fibers, mowing grain, sand grains/rakes, soil aggregate, rock pores. Express with scale-correct albedo, normal, roughness, AO, and shallow height/parallax. Avoid repeated high-contrast motifs.
2. **Meso, 0.30–8 m:** bunker lips, rough tufts, washouts, ledges, roots, shrub masses, small rock fields. Use authored geometry or licensed kit pieces where silhouette or shadow matters.
3. **Landform, 8–120 m:** ridges, bowls, shelves, ravines, shoulders, and backdrops. Author these in the authoritative height field when they affect play. Use separate rock/cliff meshes for vertical faces and overhangs.
4. **Atmosphere, 120 m and beyond:** terrain continuation, canopy masses, haze, sky, and horizon. Hide the finite course edge through continuation and occlusion, never a visible plane seam.

All four scales must reinforce the same geology, climate, maintenance level, and time of day.

## Surface materials

- Use distinct PBR sources for green, fairway, rough, bunker, native ground, and exposed rock. Do not derive them only by tinting one fairway texture.
- Record source, author, license, physical scan size, resolution, and any channel packing in provenance.
- Set real-world repeats from the source scan dimensions. Add a lower-frequency macro variation layer so a fairway does not reveal a tile grid from elevated cameras.
- Turf is dielectric and predominantly matte. Keep roughness high; obtain definition from normals, contact shadow, grain direction, and restrained albedo range rather than specular glare.
- Use anisotropic filtering and mipmaps for photographic surface maps unless a deliberate packed-atlas constraint requires another reviewed setting.
- Height/parallax is render-only and shallow. It must not visibly move a ball-contact surface or create a mismatch with collision.
- Keep total fragment texture units within the supported WebGL budget. Prefer documented atlases or channel packing and test the compiled shader in the browser.

## Terrain and geology

- Preserve the authoritative gameplay terrain. Add render-only microdetail only below collision-significant scale.
- Do not expect a height field to create cliffs. Compose licensed rock faces, slabs, and boulders along a common strike, bedding angle, and material family.
- Bury the lower 10–35% of rock pieces or surround them with talus and groundcover so they belong to the site.
- Build outcrops as systems: one dominant face, two or three supporting masses, scattered fragments, then vegetation in cracks and sheltered toes.
- Preserve drainage logic. Exposed rock, soil, moisture vegetation, and wash lines must respond to the same slope and flow pattern.

## Lighting, atmosphere, and contact depth

- Treat sun direction, sun color, sky environment, ambient fill, fog, and exposure as one time-of-day system.
- The sun drives the dominant shadow and warm/cool relationship. Environment light supplies believable fill but must not flatten form.
- At night, hand dominant-light ownership to the moon only when its real contribution exceeds the residual solar contribution. Moon direction, phase, disc shading, cloud response, reflections, and shadows must agree.
- Keep exposure continuous across golden hour, twilight, and night. Sunset should preserve playable turf and cloud detail without bleaching the warm horizon; night adaptation may lift the course while the sky retains a darker value hierarchy.
- Render stars as sub-pixel or softly resolved points in world direction. Fade them through daylight, horizon air mass, turbidity, and lunar glare; reject repeated cells, square blocks, and star fields bright enough to contaminate environment lighting.
- A readable moon may use a modest display-size concession at gameplay FOV, but preserve its astronomical direction and phase. Prefer a mission-derived, provenance-recorded global albedo map when authentic lunar identity is requested, then apply limb falloff and the shared solar incidence so it reads as a body rather than a flat white decal.
- Use physically restrained screen-space ambient occlusion to restore contact at bunker lips, rock intersections, foliage bases, and terrain folds. It supports geometry; it cannot replace relief or shadows. Reject halos, dirty open turf, foliage-card rectangles, and camera-distance pumping.
- Keep the sky seamless and horizon-aware. Match sky luminance and hue to the distant terrain and haze.
- Evaluate exposure from both golfer height and broadcast height. Turf may not clip to neon green or collapse to black.

## Mowing and maintained turf

- Treat fairway striping primarily as directional leaf lay under the shared sun, moon, view, and sky—not alternating painted lanes.
- Keep mower passes world-stable, course-aligned, physically scaled, and confined to authored fairway turf. Do not let the signal leak onto fringe, green, tee, sand, water banks, or the rough ecotone.
- Use restrained albedo support only when diffuse conditions would otherwise erase the lay. Normal, roughness, specular, and pigment responses must remain registered and fade by screen-space footprint before they alias.
- Judge pass contrast from golfer and broadcast height in multiple sun directions. Reject hard graphic boundaries, persistent equal-value bands in flat light, wet/plastic sheen, or stripes that dominate fairway contour and strategy.
- Treat green-to-fringe and fringe-to-surround cuts as maintenance boundaries, not biome transitions. Resolve them against the exact authored green SDF over only the antialiasing width; do not reuse ecological edge warp or metre-scale crossfades.
- Build showcase greens with a compact legal pin shelf plus distinct shoulders, ridges, swales, and drainage exits. A uniformly radial mound or softened oval does not demonstrate 3D authoring quality.
- A small finite hero maquette may add one deterministic instanced short-blade canopy to make its collar readable from the elevated authoring camera. Root every blade strictly inside the exact fringe SDF, keep physical blade dimensions, and retain filtered PBR turf underneath; do not generalize the allocation to all maintained course turf without a measured performance review.
- When a finite presentation exposes a soil section, use a provenance-recorded, physically scaled PBR soil material with seam-safe perimeter UVs. Do not substitute a flat brown wall; if the isolated void removes all plausible bounce, any restrained presentation lift must remain registered to the same albedo rather than becoming a flat emissive color.
- Keep showcase flagsticks at believable physical diameter relative to the 108 mm cup. A premium wood treatment may use a provenance-recorded, longitudinal seamless albedo with real clearcoat response, but the texture must not justify enlarging the pole, baking highlights, or replacing the circular collision silhouette.

## Course-edge integration

- Continue the render terrain beyond the playable boundary with compatible elevation, material, and haze.
- Break the boundary with overlapping foreground, middle-ground, and distant masses. Use vegetation, outcrops, washes, and terrain shoulders rather than a uniform perimeter ring.
- Reserve intentional view windows toward the target and landmark. Density is subordinate to composition and playability.

## Acceptance views

Capture and inspect all of these before accepting visual work:

- golfer-height tee view;
- landing-area view in both strategic directions;
- approach view and green backdrop;
- low oblique view across bunker, water, or rock contacts;
- elevated overview for tiling, grids, object repetition, and boundary seams.

Reject the result if any view shows texture grids, bright plastic turf, floating or uniformly distributed kit pieces, alpha-card silhouettes, horizon seams, exposed course edges, mismatched sun/sky, or unreadable strategic ground.

## Performance and determinism

- Treat 30 FPS as the minimum live-course contract on integrated Apple-silicon-class hardware. Verify an idle golfer view and a moving shot camera; target average frame time below 33.3 ms and p95 below 33.3 ms after loading settles.
- Use catalog-backed environment objects for repeated foliage, rocks, and deadwood. The renderer batches identical catalog geometry/material variants and selects LOD per placement; unique embedded models bypass that fast path.
- Reuse geometry and textures, instance repeated forms, and use category-aware LOD distances. Preserve distant tree silhouettes longer than shrubs and groundcover; cull sub-pixel accents first.
- Keep GTAO enabled as a low-frequency contact effect. At reduced quality, render it below native resolution and omit distant foliage from its normal buffer rather than deleting contact shading from terrain, bunker lips, rocks, and nearby vegetation.
- Cache the directional shadow map while the sun and authored shadow casters are static. Moving spectacle pieces must not force a course-scale shadow redraw every frame.
- Fit that cached directional map to a stable authored course footprint. Do not chase a flying ball with stepped shadow-camera recentering; exclude sub-pixel moving casters from the cache during motion and restore their real shadow at rest.
- Apply bloom once from an existing resolved linear-HDR texture, before tone mapping, and attenuate it with cloud transmittance rather than materializing another full-resolution composite. Threshold it above ordinary sky, cloud, and turf radiance, keep the blur bounded and low resolution, and reject halos on white UI, tracers, fairways, or the lunar disc itself.
- Keep temporal projection jitter active through moving broadcast cameras; camera translation is not antialiasing for the current frame. Reproject with real velocity/depth, reject disocclusions, and inspect palms, flags, tracer edges, turf boundaries, and shadow silhouettes throughout a complete shot—not only after the camera settles.
- Follow the temporal resolve with a restrained display-referred spatial edge pass when fast camera disocclusions still expose hard one-frame samples. Keep it after HDR bloom and tone mapping so it cannot smear lighting energy or feed glare; reject foliage crawl, diagonal stair steps, and broad texture blur.
- Compose novelty from stable seeded assemblies, not unique untracked meshes.
- Keep protected gameplay and camera corridors deterministic and unchanged between runs.
- Measure frame time with post-processing, shadows, water, and dense environment dressing active together.
- Read the live canvas `data-golfsim-performance` snapshot during browser QA. Record FPS, p95 frame time, drawing-buffer size, draw calls, triangles, active quality tier, GTAO state, visible/total decoration counts, and environment draw-bucket count.
