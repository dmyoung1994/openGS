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
- Use physically restrained screen-space ambient occlusion to restore contact at bunker lips, rock intersections, foliage bases, and terrain folds. It supports geometry; it cannot replace relief or shadows. Reject halos, dirty open turf, foliage-card rectangles, and camera-distance pumping.
- Keep the sky seamless and horizon-aware. Match sky luminance and hue to the distant terrain and haze.
- Evaluate exposure from both golfer height and broadcast height. Turf may not clip to neon green or collapse to black.

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
- Compose novelty from stable seeded assemblies, not unique untracked meshes.
- Keep protected gameplay and camera corridors deterministic and unchanged between runs.
- Measure frame time with post-processing, shadows, water, and dense environment dressing active together.
- Read the live canvas `data-golfsim-performance` snapshot during browser QA. Record FPS, p95 frame time, drawing-buffer size, draw calls, triangles, active quality tier, GTAO state, visible/total decoration counts, and environment draw-bucket count.
