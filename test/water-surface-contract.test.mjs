import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture, RGBAFormat, UnsignedByteType, Vector3 } from 'three';
import { readFile } from 'node:fs/promises';
import {
  EnvironmentFrameState,
  ENVIRONMENT_FRAME_STATE_VERSION,
  ENVIRONMENT_WIND_ALGORITHM_VERSION,
} from '../src/environment/EnvironmentFrameState.js';
import { EnvironmentGpuBindings } from '../src/environment/EnvironmentGpuBindings.js';
import { WaterSurface } from '../src/scene/WaterSurface.js';
import { decodePNG } from '../scripts/lib/png.mjs';

function environment(windSpeed = 2) {
  return new EnvironmentGpuBindings(new EnvironmentFrameState({
    version: ENVIRONMENT_FRAME_STATE_VERSION,
    algorithmVersion: ENVIRONMENT_WIND_ALGORITHM_VERSION,
    seed: 41,
    tickSeconds: 1 / 120,
    sun: { azimuthRadians: 0.8, elevationRadians: 0.7, intensity: 85000, color: { r: 1, g: 0.94, b: 0.82 } },
    atmosphere: { turbidity: 2.3, rayleigh: 1.7, mieCoefficient: 0.005, mieDirectionalG: 0.76, exposure: 1 },
    clouds: { coverage: 0.34, density: 0.58, baseHeight: 1300, thickness: 720, advectionScale: 1 },
    wind: { speed: windSpeed, directionRadians: 0.4, referenceHeight: 10, shearExponent: 0.18, gustStrength: 0.2, turbulenceStrength: 0.2, gustSpatialFrequency: 0.035, gustTemporalFrequency: 0.27 },
  }));
}

test('water is a cheap shared-daylight material with depth, shore, and coherent ripples', async () => {
  const detailTexture = new DataTexture(
    new Uint8Array([128, 128, 0, 0]), 1, 1, RGBAFormat, UnsignedByteType,
  );
  const sharedEnvironment = environment();
  const water = new WaterSurface({
    environment: sharedEnvironment,
    pond: { x: 0, z: 0, r: 8, depth: 1.6 },
    level: 0,
    segments: 24,
    detailTexture,
  });
  assert.equal(water.mesh.children.length, 0, 'analytic water remains one mesh/draw');
  assert.equal(water.mesh.material.colorNode?.isNode, true);
  assert.equal(water.mesh.material.normalNode?.isNode, true);
  assert.equal(water.mesh.material.type, 'MeshBasicNodeMaterial');
  const source = await readFile(new URL('../src/scene/WaterSurface.js', import.meta.url), 'utf8');

  assert.match(source, /MeshBasicNodeMaterial/,
    'water must avoid the scene PMREM dielectric path at grazing view');
  assert.match(source, /authoritative analytic sky once/);
  assert.match(source, /const contactIntrusionWidth = sedimentField\.mul\(0\.15\)\.add\(0\.15\)/,
    'water contact must vary world-stably within the literal 0.15–0.30m band');
  assert.match(source, /material\.opacityNode = smoothstep\([\s\S]*?contactIntrusionWidth\.mul\(0\.45\), contactIntrusionWidth, shoreDistance/,
    'the existing water draw must use the irregular SDF contact directly');
  assert.match(source, /const pondDepth/);
  assert.match(source, /const opticalPath = float\(1\)\.div\(viewDotNormal\.max\(0\.38\)\)/);
  assert.match(source, /const opticalShoreDistance = shoreDistance\.add\(sedimentField\.sub\(0\.5\)\.mul\(1\.35\)\)/,
    'world-stable bottom detail must irregularize optical shallows without moving the shore');
  assert.match(source, /this\.pond\.r \* 0\.48/,
    'shallow-bottom transmission must retain a broad irregular shelf around a deeper center');
  assert.match(source, /const shallowWater = vec3\(0\.009, 0\.072, 0\.062\)/,
    'shallow water must remain blue-green without an electric cyan rim');
  assert.match(source, /const deepWater = vec3\(0\.006, 0\.024, 0\.034\)/,
    'deep water must remain readable above near-black navy');
  assert.match(source, /const absorptionDepth = shallowFade\.mul\(pondDepth\)[\s\S]*?sedimentField\.mul\(0\.20\)/,
    'Beer–Lambert path must vary coherently with the existing shallow detail');
  assert.match(source, /const waterInterior = smoothstep/);
  assert.match(source, /const contactWater = shallowWater\.mul/);
  assert.match(source, /sedimentField\.mul\(0\.04\)\.add\(0\.94\)/,
    'shallow transmission must nest into shore without a dark cutout edge');
  assert.match(source, /const shallowBottomReveal = oneMinus\(shallowFade\)\.mul\(viewDotNormal\)/,
    'overhead views must reveal bottom while grazing angles retain the PBR response');
  assert.match(source, /\.mul\(0\.13\)/, 'bottom return must remain bounded');
  assert.doesNotMatch(source, /const wetBank/);
  assert.match(source, /buildShoreSdf/);
  assert.match(source, /water-authoritative-shore-sdf/);
  assert.match(source, /signedDistanceToFeature/);
  assert.match(source, /const bankFade = smoothstep/);
  assert.match(source, /skyRadiance\(reflectedDirection, \{ includeSun: false \}\)/,
    'water reflection must use the shared analytic sky rather than a second target');
  assert.match(source, /const fresnel = float\(0\.018\)/,
    'analytic reflection must be aggressively capped at a grazing view');
  assert.match(source, /oneMinus\(viewDotNormal\)\.pow\(5\)\.mul\(0\.28\)/,
    'water reflection must use a bounded per-pixel Schlick Fresnel response');
  assert.match(source, /const sunGlint = smoothstep\(0\.994, 0\.9995, sunAlignment\)/,
    'optional glint must follow the shared sun direction and remain narrow');
  assert.match(source, /world-anchored wave bands|world-anchored wave/);
  assert.match(source, /impactFoam/);
  assert.match(source, /material\.normalNode = transformNormalToView\(worldNormal\)/);
  assert.match(source, /const calmDirection = vec2\(0\.82, 0\.57\)/);
  assert.match(source, /smoothstep\(0\.02, 0\.20, windSpeed\)/);
  assert.doesNotMatch(source, /windDirection\.add\(vec2\(0\.001, 0\)\)\.normalize/);
  assert.match(source, /water_detail_rgba\.png/);
  assert.match(source, /const broadDetail = texture/);
  assert.match(source, /const fineDetail = texture/);
  assert.doesNotMatch(source, /envMapIntensity|roughnessNode/,
    'the removed PMREM material controls must not leave a dead lighting path');
  assert.match(source, /const broadUv = vec2/);
  assert.match(source, /const capillarySlope = vec2/,
    'existing samples must provide bounded multi-directional capillary breakup');
  assert.match(source, /const contactSlopeWeight = smoothstep\(0\.06, 0\.35, shoreDistance\)/,
    'water normals must flatten smoothly into the authoritative shore contact');
  assert.match(source, /wave\(windDirection, 0\.72, baseAmplitude\.mul\(0\.08\)/,
    'the prevailing analytic train must remain sub-pixel');
  assert.doesNotMatch(source, /const waveFacet|const waveBreakup/,
    'body color must not encode long analytic wave bands');
  assert.match(source, /oneMinus\(smoothstep\(6, 20, cameraDistance\)\)/);
  assert.match(source, /age\.lessThan\(8\.0\)/);
  assert.match(source, /age\.mul\(-0\.31\)\.exp\(\)/);
  assert.match(source, /const geometry = outlineGeometry\(this\._outline, pond\)/,
    'all ponds must draw the one compiled high-resolution contour');
  assert.doesNotMatch(source, /CircleGeometry|_shoreRadius/,
    'water may not retain a divergent low-sided or circular geometry fallback');
  assert.match(source, /const surfaceColor = transmitted\.mul\(opticalVariation\)/,
    'body color should carry depth while normals carry physical wave response');
  assert.match(source, /const capillaryResidue = smoothstep\(0\.68, 0\.91, crestBreakup\)/);
  assert.match(source, /sedimentField\.sub\(0\.5\)\.mul\(2\)\.clamp\(-1, 1\)/,
    'shallow optical breakup must be signed and bounded, not a dirt decal');

  // The analytic path must not allocate or render a planar target per frame.
  assert.doesNotMatch(source, /RenderTarget/);
  assert.doesNotMatch(source, /setRenderTarget/);
  assert.doesNotMatch(source, /setSize\(/);
  assert.doesNotMatch(source, /setPixelRatio\(/);
  assert.doesNotMatch(source, /uniformTexture/);
  assert.doesNotMatch(source, /viewportSharedTexture|viewportDepthTexture|viewportSafeUV/);
  assert.doesNotMatch(source, /uniformCubeTexture|cubeTexture\(/);

  assert.deepEqual(water.reflectionDiagnostics(), {
    mode: 'analytic', ready: true, revision: 0, size: 0, proxyMeshes: 0,
    fixedCanvas: true, renderTargetChurn: false,
  });
  assert.equal(water.captureReflection(), false);
  assert.equal(water.getDebugMode(), 'none');
  water.addImpact(new Vector3(1, 0, 2), 18);
  assert.equal(water._impacts[0].value.x, 1);
  assert.equal(water._impacts[0].value.y, 2);
  for (const mode of ['ssr-hit', 'ssr-color', 'depth', 'ray-end', 'crossing', 'min-gap', 'ray-start', 'ray-direction', 'ray-exit', 'none']) {
    assert.equal(water.setDebugMode(mode).getDebugMode(), mode);
  }
  assert.throws(() => water.setDebugMode('unknown'), /Water debug mode/);
  water.dispose();
});

test('Range gives water shared environment bindings without a reflection target', async () => {
  const range = await readFile(new URL('../src/scene/Range.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(range, /skyRadiance/);
  assert.doesNotMatch(main, /skyRadiance: sm\.weatherSky/);
  assert.doesNotMatch(range, /new RenderTarget|setRenderTarget/);
  assert.doesNotMatch(main, /captureWaterReflections\(/);
});

test('calm-water construction keeps a finite prevailing wave direction', () => {
  const detailTexture = new DataTexture(
    new Uint8Array([128, 128, 0, 0]), 1, 1, RGBAFormat, UnsignedByteType,
  );
  const water = new WaterSurface({
    environment: environment(0),
    pond: { x: 0, z: 0, r: 8, depth: 1.6 },
    level: 0,
    segments: 24,
    detailTexture,
  });
  assert.equal(water.mesh.material.normalNode?.isNode, true);
  assert.equal(water.mesh.material.colorNode?.isNode, true);
  water.dispose();
});

test('irregular pond water uses an authoritative shoreline SDF and clipped mesh', () => {
  const detailTexture = new DataTexture(
    new Uint8Array([128, 128, 0, 0]), 1, 1, RGBAFormat, UnsignedByteType,
  );
  const pond = {
    x: 0, z: 0, r: 8, depth: 1.6,
    shape: [
      { x: 7, z: -1 }, { x: 4, z: -6 }, { x: -2, z: -7 },
      { x: -7, z: -3 }, { x: -6, z: 4 }, { x: 0, z: 7 }, { x: 6, z: 5 },
    ],
  };
  const water = new WaterSurface({ environment: environment(), pond, level: 0, detailTexture });
  assert.ok(water._shoreTexture, 'irregular ponds must allocate the static shore SDF');
  assert.ok(water._outline.length >= 96, 'water mesh must use the rounded high-resolution authority');
  assert.equal(water.contains(0, 0), true);
  assert.equal(water.contains(8, 8), false);
  assert.notEqual(water.mesh.geometry.type, 'CircleGeometry');
  water.dispose();
});

test('water detail bake is small, RGBA, deterministic-source, and never generated per frame', async () => {
  const bytes = await readFile(new URL('../public/assets/textures/water_detail_rgba.png', import.meta.url));
  const image = decodePNG(bytes);
  assert.equal(image.width, 256);
  assert.equal(image.height, 256);
  assert.equal(image.channels, 4);
  const generator = await readFile(new URL('../scripts/gen_water_detail.mjs', import.meta.url), 'utf8');
  assert.match(generator, /integer period across the tile/);
  assert.match(generator, /R,G = signed capillary-wave slope/);
  assert.match(generator, /B\s+= sparse crest breakup/);
  assert.doesNotMatch(generator, /Math\.random/);
});
