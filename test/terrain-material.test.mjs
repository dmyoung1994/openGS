import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('terrain keeps contact shading physically lit without emissive compensation', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /mat\.aoNode\s*=/, 'canopy contact occlusion remains an explicit material input');
  assert.match(source, /reliefScale\s*=\s*zoneDepth\.div\(CANOPY_M\.fairway\)/, 'surface-specific canopy height must affect normal response');
  assert.match(source, /const mesoA\s*=\s*mx_noise_float/, 'terrain needs a world-space meso field');
  assert.match(source, /const fibreField\s*=\s*mx_noise_float/, 'maintained turf needs directional fibre relief');
  assert.match(source, /const mesoReliefField\s*=\s*mx_noise_float/, 'maintained turf needs world-space meso normal relief');
  assert.match(source, /const soilDrift\s*=\s*mx_noise_float/, 'turf needs stable moisture/soil chroma variation');
  assert.match(source, /const mowFineAlbedoA\s*=\s*mx_noise_float/, 'fairway needs a directional mowing response');
  assert.match(source, /const sandMicro\s*=\s*luminance\(tAlb\.rgb\)\.div\(TURF_LUM\)/,
    'sand microaggregate must reuse an existing filtered material sample');
  assert.match(source, /const sandSurface\s*=\s*sandHeight\.mul\(0\.74\)\.add\(sandRake\)[\s\S]*?sandMicro\.sub\(1\.0\)\.mul\(0\.055\)/,
    'sand needs registered microaggregate, aggregate, and rake relief at declared world scales');
  assert.match(source, /sandGrain\s*=\s*zones\.sandSignal/,
    'sand pigment must reuse its registered relief signal');
  assert.doesNotMatch(source, /mat\.emissiveNode\s*=/, 'terrain must not fake bunker bounce with emissive light');
});

test('turf transitions and grazing response stay world-stable', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /const edgeWarp\s*=\s*mx_noise_float[\s\S]*?const edgeSD\s*=\s*sd\.r\.add\(edgeWarp\)/,
    'mown/rough bake transition needs an irregular world-space ecotone');
  assert.match(source, /const maintainedTransition\s*=\s*smoothstep\(-2\.0, 2\.0, edgeSD\)/,
    'mown/rough bake transition must follow a world-space shoulder, not a camera radius');
  assert.match(source, /w\s*=\s*mix\(w, float\(1\.0\), m\.fringe\)/,
    'green surrounds must remain on the maintained turf path');
  assert.match(source, /const reliefAmplitude\s*=\s*reliefScale\.mul\(0\.82\)\.mul\(cutMicroGain\)\.clamp\(0\.22, 1\.8\)/,
    'canopy normal amplitude must separate short turf from long rough without displacing gameplay');
  assert.match(source, /cutMicroGain = mix\(cutMicroGain, float\(1\.42\), m\.green\)/,
    'green must retain dense low-cut micro relief instead of becoming optically flat');
  assert.match(source, /const fairwayMowMask = m\.fairway[\s\S]*?oneMinus\(m\.fringe\)[\s\S]*?oneMinus\(m\.green\)[\s\S]*?oneMinus\(m\.tee\)/,
    'mowing response must be owned only by authored fairway turf');
  assert.match(source, /const fibreBump[\s\S]*?\.mul\(fairwayMowMask\)/,
    'directional fibre normal must not leak onto other maintained cuts');
  assert.match(source, /const fibreRoughness[\s\S]*?\.mul\(fairwayMowMask\)/,
    'directional fibre roughness must reuse the strict fairway mask');
  assert.doesNotMatch(source, /visualMaintained\.add\(m\.green\)/,
    'green must not be double-counted through the already-composed maintained mask');
  assert.match(source, /const macroStrength\s*=\s*mix\(float\(0\.21\), cutMacroStrength, maintainedCoverage\)/,
    'each maintained cut must suppress competing macro mottling');
  assert.match(source, /const macroAlbedo\s*=\s*float\(1\.0\)\.add\(macroVariation\.b\.sub\(0\.5\)/,
    'macro albedo must remain a bounded reflectance around unity');
  assert.match(source, /cutMesoStrength = mix\(cutMesoStrength, float\(0\.12\), m\.green\)/,
    'short green turf must carry cleaner restrained meso pigment than fairway');
  assert.match(source, /const stripLay\s*=\s*smoothstep\(0\.40, 0\.60, stripWave\)/,
    'mower runs must form equal-width passes instead of one long cosine gradient');
  assert.match(source, /const mowBand\s*=\s*stripLay\.sub\(0\.5\)\.mul\(0\.045\)/,
    'fairway pigment must support rather than paint the reel-pass response');
  assert.match(source, /const mowResolution\s*=\s*oneMinus\(smoothstep\(0\.28, 1\.10, duvM\)\)/,
    'mowing must recede by surface footprint without a camera or ball-centred cutoff');
  assert.match(source, /green: grassCol\('fairway'\), fringe: grassCol\('fairway'\)/,
    'target turf must share maintained pigment instead of becoming nested albedo decals');
  assert.match(source, /zoneRoughness = mix\(zoneRoughness, float\(0\.66\), m\.green\)/,
    'target turf must remain legible through its physical cut-height response');
  assert.match(source, /const rGrassV\s*=\s*rGrassD\.add\(graze\.mul\(0\.16\)\)\.add\(mowAnisotropy\)\.clamp\(0\.68, 0\.98\)/,
    'grazing response must be monotone matte roughening, not a camera-centred ring');
  assert.match(source, /mat\.specularIntensityNode\s*=\s*this\.uSpecular\.mul\(mowSpecular\)\.mul\(cutSpecular\)/,
    'mowing needs bounded real-light dielectric response registered to leaf lay');
  assert.match(source, /cutSpecular = mix\(cutSpecular, float\(1\.14\), m\.green\)/,
    'maintained-cut identity must remain driven by the shared real-light specular path');
  assert.match(source, /const viewAlongLay\s*=\s*V\.x\.mul\(layDirection\.x\)/,
    'mowing response must include directional grazing interaction');
  assert.match(source, /zoneRoughness = mix\(zoneRoughness, float\(0\.87\), m\.fringe\)[\s\S]*?zoneRoughness = mix\(zoneRoughness, float\(0\.66\), m\.green\)/,
    'green cut height needs a distinct matte/specular response');
  assert.match(source, /zoneGrade = mix\(zoneGrade, float\(0\.925\), m\.green\)/,
    'green pigment support must remain restrained relative to fairway');
  assert.doesNotMatch(source, /uNear0|uNear1|const camDist\s*=/,
    'detail handoff must not be camera-distance/radial');
  assert.match(source, /turfSelfShadow\(set\.nrh, uvP, dNrh\.b, sunUVFull, lod, rayActive, 2\)/,
    'terrain contact must use a bounded sun-directed canopy test');
  assert.doesNotMatch(source, /screenSpace|screen-space.*ao|cameraPosition[^\n]*ao/i,
    'terrain contact must not depend on unstable screen-space AO');
});

test('pond bank material follows the authored filtered water SDF', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /waterZoneTexture/, 'Terrain must expose the pond SDF as a borrowed GPU texture');
  assert.match(source, /waterTexture\?\.dispose\(\)/, 'Terrain must own and release the pond SDF texture');
  assert.match(source, /turfZoneMasks\(this\._zoneMap\.texture, this\._zoneMap\.waterTexture/,
    'terrain shading must consume the authored pond SDF rather than a circular fallback');
  assert.match(source, /const waterSample = texture\(waterTex/,
    'bank transition must use one filtered water SDF and baked-signal lookup');
  assert.match(source, /const bankWidthNoise = waterSample\.y[\s\S]*?const bankWidth = float\(0\.15\)\.add\(bankWidthNoise\.mul\(0\.15\)\)[\s\S]*?const bankEnvelope = oneMinus\(smoothstep\(0\.0, bankWidth, bankDistance\)\)\.mul\(outsideWater\)/,
    'bank material must remain SDF-derived within the literal 0.15–0.30m intrusion');
  assert.match(source, /const bankExposure = smoothstep\(0\.42, 0\.76[\s\S]*?const waterBank = bankEnvelope\.mul\(bankExposure\.mul\(0\.82\)\.add\(0\.08\)\)/,
    'world-stable ecology must break the bank envelope rather than draw a ring');
  assert.match(source, /const waterBankWet = oneMinus\(smoothstep\(0\.0, 0\.075, bankDistance\)\)/,
    'wet toe must be confined to the first 7.5cm of contact');
  assert.match(source, /const wetBank = vec3\(0\.042, 0\.049, 0\.043\)/,
    'wet bank needs a restrained cool mineral palette above black-ring values');
  assert.match(source, /const mineralPatch = smoothstep\(0\.73, 0\.86, bankMottle\)/,
    'bank needs sparse larger exposed mineral patches');
  assert.match(source, /const fleckMask = smoothstep\(0\.58, 0\.82, bankPebble\)/,
    'bank needs restrained detail-atlas gravel breakup');
  assert.match(source, /dFdx\(m\.waterMottle\)/, 'mineral patches need real daylight-lit normal relief');
  assert.match(source, /const grassIntrusion = m\.waterGrass/, 'outer bank must dissolve into existing turf pigment');
  assert.match(source, /const outerBlend = mineralPatch\.mul\(0\.24\)\.mul\(oneMinus\(grassIntrusion\.mul\(0\.84\)\)\)/,
    'outer bank must be existing turf interrupted by sparse mineral exposure');
  const bankStart = source.indexOf('// Pond banks are a shallow alpine mineral shelf');
  const bankEnd = source.indexOf('// Revetted (stacked-sod) faces', bankStart);
  assert.ok(bankStart >= 0 && bankEnd > bankStart, 'pond bank material section must remain explicit');
  assert.doesNotMatch(source.slice(bankStart, bankEnd), /mx_noise_float/,
    'bank variation must be baked/shared rather than evaluated as full-screen fragment noise');
  assert.match(source, /m\.waterBank\.mul\(0\.075\)/, 'wet bank needs a darker, higher-roughness response');
  assert.doesNotMatch(source, /CircleGeometry.*water|water.*CircleGeometry/i,
    'pond-bank shading must not reintroduce circular fallback geometry');
});

test('high-end ground pass retains broad pigment, relief, and matte variation after mip reduction', async () => {
  const source = await readFile(new URL('src/terrain/Terrain.js', ROOT), 'utf8');
  assert.match(source, /wx\.mul\(0\.036\).*wz\.mul\(0\.029\)/s,
    'turf needs an ecological-scale world-space soil drift below the blade atlas');
  assert.match(source, /fibreField\).*\.mul\(0\.34\)/,
    'maintained turf needs enough stable normal relief to survive distance filtering');
  assert.match(source, /cutMesoNormal = mix\(cutMesoNormal, float\(0\.19\), m\.visualFairway\)[\s\S]*?cutMesoNormal = mix\(cutMesoNormal, float\(0\.065\), m\.green\)[\s\S]*?mesoGradient\.mul\(cutMesoNormal\)/,
    'turf needs class-specific broad normal breakup, not only mower grain');
  assert.match(source, /nativeRockPatch[\s\S]*?nativeBump = mesoGradient\.mul\(0\.34\)/,
    'native mineral response must follow real slope and registered world-space relief');
  assert.match(source, /surfaceRoughness = mix\(mix\(rGrassV, float\(0\.97\), steepR\), zoneRoughness, 0\.56\)/,
    'world-space canopy roughness must remain visible without a glossy sheet');
});

test('backdrop depth fade comes from the shared atmosphere, not a private grade', async () => {
  const source = await readFile(new URL('src/scene/BackdropTerrain.js', ROOT), 'utf8');
  // This used to pin a haze the material mixed in itself, toward a fixed
  // grey-teal constant, on its own smoothstep of view distance. That is a
  // per-layer colour grade in all but name: it did not track the sun, the sky, or
  // the fog colour, so the backdrop drifted away from the world in front of it.
  // Depth fade is now the one aerial-perspective term the sky, water, and trees
  // already share, applied after lighting so transmittance is ordered correctly.
  assert.match(source, /const atmosphericDistance = toCamera\.length\(\)[\s\S]*?aerialPerspective\(\s*outputNode\.rgb,\s*toCamera,\s*atmosphericDistance,?\s*\)/,
    'backdrop must fade through EnvironmentGpuBindings.aerialPerspective using the actual shared camera path');
  assert.match(source, /material\.fog = false/,
    'a fragment must not receive both scene fog and aerial perspective');
  assert.doesNotMatch(source, /hazeColor/,
    'the backdrop must not own a private haze colour');
  assert.doesNotMatch(source, /material\.emissiveNode\s*=/,
    'backdrop must not fake relief with emissive light');
});

test('backdrop uses deterministic world-space PBR breakup and alternating patch diagonals', async () => {
  const source = await readFile(new URL('src/scene/BackdropTerrain.js', ROOT), 'utf8');
  assert.match(source, /MeshStandardNodeMaterial/, 'backdrop must use the WebGPU node PBR path');
  assert.match(source, /mx_noise_float/, 'backdrop material needs non-repeating world-space variation');
  assert.match(source, /material\.roughnessNode\s*=\s*mix/, 'native rock/snow response must not be globally uniform');
  assert.match(source, /backdropGeology/, 'backdrop needs explicit rock/scree/snow material fields');
  assert.match(source, /material\.normalNode\s*=\s*transformNormalToView/, 'backdrop geology needs lit normal breakup');
  assert.match(source, /normalWorld\.abs\(\)\.sub\(0\.18\)\.max\(0\.0\)\.pow\(vec3\(4\.0\)\)/,
    'alpine mineral albedo needs slope-aware world projection rather than stretched XZ mapping');
  assert.match(source, /function biplanarField\(/,
    'mineral source should use a shader-only biplanar projection for stable face scale');
  assert.match(source, /const top = mx_noise_float\(/,
    'biplanar geology needs a world-XZ top basis');
  assert.match(source, /const side = mx_noise_float\(/,
    'biplanar geology needs a height-varying side basis');
  assert.match(source, /const topWeight = weight\.y\.add\(0\.16\)/,
    'steep faces must be dominated by the isotropic side basis, not an XZ stripe projection');
  assert.match(source, /y\.mul\(frequency\)\.add\(warp\.mul\(0\.45\)\)/,
    'side geology must vary through world Y at the same physical scale as X/Z');
  assert.doesNotMatch(source, /TextureLoader|graniteTexture|alpine_granite_albedo_v1\.png|\btexture\s*\(/,
    'alpine geology must not own a sampled granite image');
  assert.match(source, /const mineralGrade = float\(1\.0\)\.add\(mineralVariation\)/,
    'procedural mineral variation must grade the rock endmember rather than the whole surface');
  assert.match(source, /albedo = mix\(albedo, mineral, mineralCoverage\)/,
    'mineral source must remain subordinate to the per-pixel rock classification');
  assert.match(source, /backdropSource = 'procedural-alpine-shell'/,
    'alpine horizon geometry is owned by the authored shell, not a photographic HDR');
  assert.match(source, /proceduralShell = true/,
    'alpine runtime must build the shell that owns the skyline');
  assert.match(source, /const strata\s*=\s*clamp\(0\.52/, 'alpine vertices need non-periodic strata breakup');
  assert.match(source, /const gullyMask\s*=\s*smootherstep/, 'alpine faces need narrow erosion channels');
  assert.match(source, /const faceRibs\s*=\s*smootherstep/, 'alpine faces need intermediate rock ribs');
  assert.match(source, /const talusFan\s*=\s*smootherstep/, 'alpine faces need deterministic talus fans');
  assert.match(source, /const cliffCut\s*=\s*clamp\(cliffField/, 'alpine faces need geometry-scale cliff cuts');
  assert.match(source, /- cliffField \* \(mountain \* 16/, 'cliff skeleton must alter height through a bounded erosion cut');
  assert.match(source, /- gullyMask \* \(mountain \* 10/, 'gully erosion must remain bounded so cuts cannot compound into needles');
  assert.match(source, /const mountain\s*=\s*smootherstep\(260, 2350/, 'alpine relief should use one broad non-layered mountain envelope');
  assert.match(source, /const dominantSpur\s*=\s*Math\.exp/, 'ridge relief should follow a coherent world-space strike');
  assert.match(source, /const talusToe\s*=\s*talusFan/, 'talus should build a geological toe below exposed faces');
  assert.match(source, /const exposureByAltitude\s*=\s*0\.36\s*\+\s*smootherstep/, 'rock exposure must transition through alpine vegetation and retain lower-wall outcrops');
  assert.match(source, /const slopeExposure = smoothstep\(0\.26, 0\.66, slope\)/,
    'shared PBR must expose rock from the analytic surface slope');
  assert.match(source, /const rockMask = heightBlend\(rockNominal, vegetationRelief, rockRelief/,
    'rock must interlock with vegetation by relief rather than fading linearly');
  assert.match(source, /const lowerWallRock = cliffGate\.mul\(1\.08\)/,
    'lower wall outcrops must remain visible below the snowline');
  assert.match(source, /material\.positionNode = vec3\(vertexX, vertexY, vertexZ\)[\s\S]*?\.add\(normalGeometry\.mul\(vertexDisplacement\.mul\(shellFade\)\)\)/,
    'alpine shell must carry bounded GPU vertex relief through the existing topology');
  assert.match(source, /const vertexDisplacement = vertexMacro\.sub\(0\.5\)\.mul\(26\.0\)/,
    'vertex relief must stay in broad and meso geology scales');
  assert.match(source, /const snowShed = float\(1\.0\)\.sub\(smoothstep\(0\.38, 0\.78, slope\)\)/,
    'snow must remain on high alpine faces but still shed from near-vertical walls');
  // The sampler no longer bakes albedo. It used to run ~30 sequential Color.lerp
  // calls per vertex into a `color` attribute that was then interpolated across
  // 30 m triangles, which averaged every classification decision into one khaki
  // and threw away all of it below house scale. Classification is per pixel now.
  assert.doesNotMatch(source, /geometry\.setAttribute\('color'[\s\S]{0,80}alpine/,
    'the alpine shell must not bake vertex albedo');
  assert.match(source, /sampler\.bakesVertexColor = false/,
    'the alpine sampler must declare that it emits no baked albedo');
  assert.match(source, /const cover = attribute\('backdropCover', 'vec4'\)/,
    'per-pixel classification needs the broad cover gates');
  assert.match(source, /spurFrame - 330\) \/ 450/, 'toe spurs need broad bounded planes rather than narrow spikes');
  // Screen-space derivatives of a world-space field are not a terrain property:
  // the world distance dFdx spans is whatever one pixel covers, so the same rock
  // got centimetre-scale relief at the course edge and ~10 m of it at 2 km. That
  // is what drew the dark streaked banding across the far faces. Gradients are
  // now taken at a fixed offset in metres, as Hollow's HeightToNormal does.
  assert.match(source, /broadGradientsVarying\.z\.mul\(8\.0\)/,
    'resistant ribs need meso normal breakup at a real world amplitude');
  assert.doesNotMatch(source, /dFdx\(/,
    'backdrop normals must not come from screen-space derivatives');
  assert.doesNotMatch(source, /Math\.sin\(radial \* 0\.0041/, 'alpine relief must not form radial shell terraces');
  assert.match(source, /if \(\(ix \+ iz\) & 1\)/, 'patch triangulation should not bias one diagonal');
  assert.match(source, /const normalStep = 64/, 'patch normals must sample the shared continuous world field at a far-band physical span');
  assert.doesNotMatch(source, /geometry\.computeVertexNormals\(\)/,
    'patch-local normals would create lighting seams across the continuous world');
});

test('alpine normal graph uses one derivative per relief scale and no value normals', async () => {
  const source = await readFile(new URL('src/scene/BackdropTerrain.js', ROOT), 'utf8');
  const normalGraph = source.slice(source.indexOf('const structuralGradientVarying = varying('), source.indexOf('// Matte dielectric throughout'));
  assert.equal((normalGraph.match(/broadGradientsVarying\.z\.mul\(8\.0\)/g) || []).length, 1);
  assert.equal((normalGraph.match(/broadGradientsVarying\.x\.mul\(14\.0\)/g) || []).length, 1);
  assert.equal((normalGraph.match(/fine\.gradX\.mul\(5\.0\)/g) || []).length, 1);
  assert.doesNotMatch(normalGraph, /broadGradientsVarying\.[zw]\.mul\(12\.0\)/,
    'meso normal must not stack duplicate amplitudes');
  assert.doesNotMatch(normalGraph, /broadGradientsVarying\.[xy]\.mul\(12\.0\)/,
    'macro normal must not stack duplicate amplitudes');
  assert.doesNotMatch(normalGraph, /const structuralNormal\s*=|structuralFace\.sub\(0\.5\).*vec3/,
    'mask values must not be used as arbitrary normal XYZ offsets');
  assert.match(normalGraph, /const structuralGradientVarying = varying\(structuralGradient, 'vAlpineStructuralGradient'\)/,
    'structural normal must arrive from the vertex finite-difference graph');
  assert.doesNotMatch(normalGraph, /const secondaryNormal = vec3\(|const strikeAt =|const secondaryAt =/,
    'structural noise must not be recomputed per fragment');
  assert.match(normalGraph, /vertexReliefBump\.mul\(0\.78\)/,
    'mountain-scale displaced geometry must keep its normal independent of mineral coverage');
  assert.doesNotMatch(normalGraph, /vertexReliefBump\.mul\(rockDetail/,
    'snow/pale faces must not lose the structural normal');
});

test('rough blade density includes a stable ecological-scale cluster field', async () => {
  const source = await readFile(new URL('src/terrain/Grass.js', ROOT), 'utf8');
  assert.match(source, /const edgeWarp = mx_noise_float\( vec3\( worldX\.mul\( 0\.045 \), worldZ\.mul\( 0\.036 \), 317\.0 \)/,
    'rough residency must share the world-space fairway ecotone rather than a ruler-straight cutoff');
  assert.match(source, /const clearForFairway = smoothstep\( -2\.4, 0\.6, edgeSD \)/,
    'rough edge should fade through an irregular render-only shoulder');
  assert.match(source, /macroCluster\s*=\s*mx_noise_float/, 'rough clustering must be world anchored');
  assert.match(source, /mix\( hE, ecological, roughMask \)/, 'cluster field must be confined to rough transitions');
  assert.match(source, /keepCandidate\s*=\s*hC\.lessThan/, 'rough density must explicitly reject candidates');
  assert.match(source, /ROUGH_COVERAGE_MIN\s*=\s*0\.28/, 'rough occupancy must retain a dense coverage floor');
  assert.match(source, /ROUGH_COVERAGE_MAX\s*=\s*0\.66/, 'rough occupancy must retain solid tuft mass');
  assert.match(source, /ROUGH_COLONY_FLOOR\s*=\s*0\.64/, 'rough colonies must not collapse to sparse wire blades');
});

test('rough colonies vary tuft height, heading, and albedo without another draw', async () => {
  const source = await readFile(new URL('src/terrain/Grass.js', ROOT), 'utf8');
  assert.match(source, /const colony = smoothstep/, 'colony gate should be a stable world-space field');
  assert.match(source, /heightClass\.assign\( mix\( 0\.62, 1\.36/,
    'rough stems need an authored height spread even when far-only work is guarded');
  assert.match(source, /const orient = hA\.mul\( 6\.2831853 \)\.add\( ecological/, 'blade heading should inherit colony orientation');
  assert.match(source, /const colourVariation = vec3\(/, 'rough albedo needs restrained blade-to-blade variation');
});
