import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveCloudRayInterval } from '../src/scene/WeatherSky.js';

test('deterministic cloud slab depth evaluator proves front-cloud and behind-geometry cases', () => {
  // A cloud deck occupies the 900–2400 m interval on this ray. A mountain at
  // 1600 m leaves the front 700 m of cloud visible; a mountain at 500 m ends the
  // march before cloud entry; clear depth keeps the complete AABB interval.
  const frontMountain = resolveCloudRayInterval(900, 2400, 1600, true);
  assert.deepEqual(frontMountain, {
    entry: 900, exit: 1600, length: 700, intersects: true,
  });

  const nearMountain = resolveCloudRayInterval(900, 2400, 500, true);
  assert.deepEqual(nearMountain, {
    entry: 900, exit: 500, length: 0, intersects: false,
  });

  const clearBackground = resolveCloudRayInterval(900, 2400, 0, false);
  assert.deepEqual(clearBackground, {
    entry: 900, exit: 2400, length: 1500, intersects: true,
  });
});

test('depth-aware cloud source contracts sample MRT depth and compose transport in the final pass', async () => {
  const [scene, temporal, weather] = await Promise.all([
    readFile(new URL('../src/scene/SceneManager.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scene/CloudTemporalNode.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scene/WeatherSky.js', import.meta.url), 'utf8'),
  ]);

  assert.match(scene, /const scenePass = this\._scenePass \?\? pass\(this\.scene, this\.camera/);
  assert.match(scene, /const depth = scenePass\.getTextureNode\('depth'\)/);
  assert.match(scene, /new CloudTemporalNode\([\s\S]*depth,/,
    'cloud pass must consume the authoritative Scene MRT depth texture');
  assert.match(scene, /this\.scene\.backgroundNode = this\.weatherSky\.clearBackgroundNode/);
  assert.match(scene, /resolvedScene\.mul\(cloudTransport\.a\)\.add\(cloudTransport\.rgb\)/,
    'the existing final pass must apply scene*T+scatter exactly once');
  assert.match(scene, /cloudSourceLayer\.sample\(sampleUv\)\.gather\(0\)/,
    'the common full-resolution reconstruction path must classify its 2x2 footprint in one gather');
  assert.match(scene, /If\(allCompatible\.not\(\), \(\) =>[\s\S]*cloudSourceLayer\.load\(texel\)/,
    'actual depth silhouettes must retain the exact nearest-compatible point-load search');

  assert.match(temporal, /sceneDepthNode\.load\(sceneDepthTexel\)/,
    'every cloud fragment must load one exact authoritative scene-depth texel');
  assert.match(temporal, /getViewPosition\(/);
  assert.match(temporal, /opaqueWorldPosition/);
  assert.match(temporal, /opaqueRayDistance/);
  assert.match(temporal, /cloudTransportForRay\(/);
  assert.match(temporal, /setResolutionScale\(resolutionScale\)/,
    'cloud history targets must follow the production dynamic-resolution policy');
  assert.match(temporal, /count: 2/,
    'cloud transport and source depth must stay in separate quarter-resolution MRT attachments');
  assert.match(temporal, /CLOUD_SOURCE_ATTACHMENT/);
  assert.match(temporal, /sourceMetadataClass/);
  assert.doesNotMatch(temporal, /depthFootprint|perspectiveDepthAt|cardinalDepth/,
    'each low-resolution cloud texel must use its center authoritative depth');

  assert.match(weather, /opaqueClampedExit/);
  assert.match(weather, /select\(min\(rayExit, depthDistance\), rayExit\)/,
    'finite geometry must clamp the cloud AABB exit while clear depth keeps it full');
  assert.match(weather, /return vec4\(cloudScatter, cloudTransmittance\)/,
    'cloud output must remain a composable scatter/transmittance layer');
  assert.match(weather, /marchState\.representativeDistance/);
  assert.match(weather, /scatterDistanceWeight/);

  assert.match(scene, /resettableTraa\(color, depth, vel, this\.camera, null\)/,
    'TRAA must resolve opaque beauty without repeating cloud transport reads');
});
