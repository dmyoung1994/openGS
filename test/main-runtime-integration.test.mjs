import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('production entrypoint integrates adaptive quality and the continuous timeline', () => {
  const strictInit = mainSource.indexOf('await sm.initialize()');
  const qualityInit = mainSource.indexOf('qualityController = new VisualQualityController');
  assert.ok(strictInit >= 0, 'strict WebGPU initialization must remain explicit');
  assert.ok(qualityInit > strictInit, 'quality must be constructed after strict WebGPU initialization');

  assert.match(mainSource, /import \{ VisualQualityController \} from ['"]\.\/scene\/VisualQualityController\.js['"]/);
  assert.match(mainSource, /import \{\s*ENVIRONMENT_TIMELINE_ALGORITHM_VERSION[\s\S]*EnvironmentTimeline[\s\S]*toEnvironmentFrameStateConfig/);
  assert.match(mainSource, /sm\.setRenderResolution\(\{ outputPixelCap, internalRenderScale: snapshot\.renderScale \}\)/);
  assert.match(mainSource, /qualityController\.ingestSample\(\{\s*frameMs, cpuMs: sm\.cpuFrameMs,\s*atMs:/);
  assert.match(mainSource, /_qualityLastFrameAt/);
  assert.match(mainSource, /sm\.renderingPaused/,
    'manually stepped profiler frames must not train adaptive presentation quality');
  assert.match(mainSource, /function ingestQualityFrame\(\)/,
    'adaptive presentation pacing must remain independent of simulation dt');
  assert.doesNotMatch(mainSource, /frameMs: dt \* 1000/,
    'adaptive quality must not consume SceneManager\'s simulation-clamped dt directly');
  assert.match(mainSource, /TIMELINE_RENDER_UPDATE_SECONDS/);
  assert.match(mainSource, /environmentTimeline\?\.advance\(dt\)/);

  const flightLock = mainSource.indexOf('if (flying) {', mainSource.indexOf('function updateEnvironment'));
  const timelineSync = mainSource.indexOf('syncTimelineEnvironment(timelineSnapshot)', flightLock);
  assert.ok(flightLock >= 0, 'environment updates must have an explicit in-flight branch');
  assert.ok(timelineSync > flightLock, 'timeline daylight sync must occur only after the shot-lock branch');

  assert.match(mainSource, /window\.golf = \{/);
  assert.match(mainSource, /quality: qualityApi/);
  assert.match(mainSource, /timeline: timelineApi/);
  assert.match(mainSource, /setMode\(mode, options\)/);
  assert.match(mainSource, /setRenderScale\(scale\)/);
  assert.match(mainSource, /acquirePresentationLock\(options\)/);
  assert.match(mainSource, /releasePresentationLock\(lockId\)/);
  assert.match(mainSource, /snapshot: qualitySnapshot/);
  assert.match(mainSource, /policySnapshot: \(\) => qualityController\.snapshot\(\)/);
  assert.match(mainSource, /return environmentState\?\.config \?\? environmentTimeline\.frameStateConfig\(\)/);
  assert.match(mainSource, /get ready\(\) \{ return bootstrapDiagnostics\.stage === 'ready'; \}/);
  assert.match(mainSource, /new MetricsPanel\(\{ onHit: hit, onEnvironmentChange: previewEnvironment, onContinue: continuePlay,/);
});

test('quality modes apply scalable scene workloads and disclose their owners', () => {
  assert.match(mainSource, /const QUALITY_GRASS_WORKLOADS = Object\.freeze\(/);
  assert.match(mainSource, /const QUALITY_TREE_WORKLOADS = Object\.freeze\(/);
  assert.match(mainSource, /const QUALITY_WEATHER_WORKLOADS = Object\.freeze\(/);
  assert.match(mainSource, /grass\.setWorkloadPolicy\(grassPolicy\)/);
  assert.match(mainSource, /range\.setTreeWorkloadPolicy\(treePolicy\)/);
  assert.match(mainSource, /sm\.invalidateTemporalHistory\('tree workload policy'\)/);
  assert.match(mainSource, /sm\.setWeatherSkyWorkload\(weatherPolicy\)/);
  assert.match(mainSource, /runtimeWorkloads: \{/);
  assert.match(mainSource, /trees: range\?\.treeWorkloadDiagnostics/);
  assert.match(mainSource, /waterReflections: range\?\.waterReflection\?\.diagnostics/);
  assert.match(mainSource, /weatherSky: sm\.readWeatherSkyDiagnostics/);
  assert.match(mainSource, /supported: \['grass', 'trees', 'shadows', 'waterReflections', 'weatherSky'\]/);
  assert.match(mainSource, /unsupported: \[\]/);
  assert.match(mainSource, /applyVisualQuality\(\);\s*ball = new Ball/);
});

test('timeline frame-state API is tied to the applied environment contract', () => {
  const frameStateApi = mainSource.indexOf('frameStateConfig() {');
  assert.ok(frameStateApi >= 0);
  const frameStateBody = mainSource.slice(frameStateApi, mainSource.indexOf('},', frameStateApi));
  assert.match(frameStateBody, /requireEnvironmentTimeline\(\)/);
  assert.match(frameStateBody, /environmentState\?\.config/);
  assert.match(mainSource, /Conditions panel intentionally overrides timeline wind\/cloud coverage/);
  assert.match(mainSource, /if \(!force && snapshot\.iso === environmentTimelineIso\) return snapshot/);
});

test('visual asset residency is a strict critical barrier with progressive quality requests', () => {
  const strictInit = mainSource.indexOf('await sm.initialize()');
  const manifestLoad = mainSource.indexOf('createVisualAssetResidency(VISUAL_ASSET_MANIFEST_URL)');
  const criticalAwait = mainSource.indexOf('await visualCriticalAssetsReady');
  const courseLoad = mainSource.indexOf("setBootstrapStage('course-loading'");
  assert.ok(manifestLoad > strictInit, 'visual manifest must load only after strict WebGPU initialization');
  assert.ok(criticalAwait > manifestLoad, 'critical visual verification must complete after manifest validation');
  assert.ok(courseLoad > criticalAwait, 'course construction must remain behind critical visual readiness');

  assert.match(mainSource, /import \{ createVisualAssetResidency \} from ['"]\.\/assets\/VisualAssetResidency\.js['"]/);
  assert.match(mainSource, /VISUAL_ASSET_MANIFEST_URL = ['"]\/assets\/visual-quality-manifest\.json['"]/);
  assert.match(mainSource, /visualAssetResidency\.plan\('critical', \{ includeOptional: false \}\)/);
  assert.match(mainSource, /requestVisualAssetProfile\('critical', \{\s*includeOptional: false/);
  assert.match(mainSource, /visualAssetCriticalReady = true/);
  assert.match(mainSource, /requestActiveVisualAssets\(\);/);
  assert.doesNotMatch(mainSource, /await requestActiveVisualAssets\(\)/,
    'optional active-profile residency must not block the first valid frame');
  assert.match(mainSource, /visualAssetResidency\.request\(variant, options\)/,
    'profile requests must go through the shared VisualAssetResidency coordinator');

  assert.match(mainSource, /visualAssets: visualAssetsApi/);
  assert.match(mainSource, /const visualAssetsApi = Object\.freeze\(/);
  assert.match(mainSource, /diagnostics: visualAssetDiagnostics/);
  assert.match(mainSource, /request: visualAssetReadiness/);
  assert.match(mainSource, /readiness: visualAssetReadiness/);
  assert.match(mainSource, /ready: visualAssetReadiness/);
  assert.match(mainSource, /get environmentReady\(\) \{ return Promise\.all\(\[environmentCatalogReady, environmentAssetIntegrityReady, visualAssetManifestReady, visualCriticalAssetsReady/);
  assert.match(mainSource, /visualAssets: \{/,
    'bootstrap diagnostics must carry JSON-safe visual residency status');
});
