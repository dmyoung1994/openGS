// Decompose the turf's actual light budget into direct key, PMREM sky irradiance
// and hemisphere fill, at dusk and noon, in the real production scene. This is a
// read-and-restore diagnostic: no authored source, albedo or geometry is touched.
import { spawnSync } from 'node:child_process';

async function probe() {
  const { sm, range, timeline, lighting, evaluatorCamera: camera } = window.golf;
  const moduleUrl = performance.getEntriesByType('resource')
    .find(item => new URL(item.name).pathname.endsWith('/three_webgpu.js'))?.name;
  if (!moduleUrl) throw new Error('Production Three module URL missing');
  const { DataUtils, HalfFloatType } = await import(moduleUrl);
  const initial = timeline.snapshot();
  const hemiIntensity = lighting.hemi.intensity;
  const sunIntensity = lighting.sun.intensity;

  // Two patches: maintained turf near the fairway centre and the near-foreground
  // native grass. Both are read from the real scene MRT, not a diagnostic card.
  const patches = [
    { label: 'turf', x: 434, y: 790, w: 32, h: 32 },
    { label: 'native-fore', x: 300, y: 980, w: 32, h: 32 },
  ];
  const readPatch = async (p) => {
    const target = sm._scenePass.renderTarget;
    const data = await sm.renderer.readRenderTargetPixelsAsync(target, p.x, p.y, p.w, p.h);
    const half = target.texture.type === HalfFloatType;
    const read = i => half ? DataUtils.fromHalfFloat(data[i]) : data[i];
    const mean = [0, 0, 0];
    for (let pixel = 0; pixel < p.w * p.h; pixel++) {
      for (let c = 0; c < 3; c++) mean[c] += read(pixel * 4 + c) / (p.w * p.h);
    }
    return { rgb: mean, luminance: mean[0] * .2126 + mean[1] * .7152 + mean[2] * .0722 };
  };

  // SceneManager re-pins environmentIntensity from its own calibration on every
  // daylight update, so each case asserts the override actually survived the frame.
  const applyCase = async (env, hemi, key) => {
    sm.scene.environmentIntensity = env;
    lighting.hemi.intensity = hemiIntensity * hemi;
    lighting.sun.intensity = sunIntensity * key;
    await camera.waitForFrames(8);
    if (sm.scene.environmentIntensity !== env) throw new Error(`environmentIntensity override reset: ${sm.scene.environmentIntensity}`);
    const out = {};
    for (const p of patches) out[p.label] = await readPatch(p);
    return out;
  };

  const cases = [
    ['baseline-0.34', 0.34, 1, 1],
    ['env-unity', 1.0, 1, 1],
    ['no-hemi', 0.34, 0, 1],
    ['env-unity-no-hemi', 1.0, 0, 1],
    ['no-key', 0.34, 1, 0],
    ['env-only', 0.34, 0, 0],
    ['black', 0.0, 0, 0],
  ];

  const result = [];
  try {
    timeline.pause();
    for (const time of ['19:00:00Z', '12:00:00Z']) {
      timeline.seek({ date: '2026-07-15', time });
      await camera.waitForFrames(8);
      const snapshot = timeline.snapshot();
      const measurements = {};
      for (const [label, env, hemi, key] of cases) {
        measurements[label] = await applyCase(env, hemi, key);
      }
      result.push({
        time,
        solarElevationDeg: snapshot.solar.elevationRadians * 180 / Math.PI,
        atmosphericTransmission: snapshot.solar.atmosphericTransmission,
        daylightFactor: snapshot.solar.daylightFactor,
        exposure: sm.renderer.toneMappingExposure,
        hemiIntensity: lighting.hemi.intensity,
        measurements,
      });
    }
    return { patches, result };
  } finally {
    sm.scene.environmentIntensity = 0.34;
    lighting.hemi.intensity = hemiIntensity;
    lighting.sun.intensity = sunIntensity;
    timeline.seek(initial.epochMilliseconds);
    if (!initial.playback.paused) timeline.play(initial.playback.rate);
    await camera.waitForFrames(8);
  }
}

const result = spawnSync(process.execPath, [
  'scripts/shot.mjs', '--game', '--route=/play.html?course=grasslands-reference',
  '--presentation-mode=ultra', '--presentation-scale=1', '--gpu-live',
  '--frames=16', '--frame-timing=1', '--cam=0,0,-35', '--terrain-lift=6',
  '--look=-7,0,105', '--look-terrain-lift=5', '--fov=65', '--size=900x1200',
  `--eval=(${probe.toString()})()`,
  '--out=/tmp/grasslands-light-budget.png', '--qa-report=/tmp/grasslands-light-budget.json',
], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
