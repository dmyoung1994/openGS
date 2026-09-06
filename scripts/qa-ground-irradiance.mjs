// Why is the ground darker than the sky implies? Measures the turf patch against a
// neutral 0.18 card lit by the same environment, and isolates every term that can
// attenuate the ground's INDIRECT light. At a low sun the sky is nearly all the light
// there is, so anything multiplying ambient is multiplying the whole scene.
// Read-and-restore: no authored source, albedo or geometry is touched.
import { spawnSync } from 'node:child_process';

async function probe() {
  const { sm, range, timeline, lighting, evaluatorCamera: camera } = window.golf;
  const moduleUrl = performance.getEntriesByType('resource')
    .find(item => new URL(item.name).pathname.endsWith('/three_webgpu.js'))?.name;
  if (!moduleUrl) throw new Error('Production Three module URL missing');
  const {
    Scene, OrthographicCamera, PlaneGeometry, Mesh, MeshPhysicalNodeMaterial,
    Color, RenderTarget, FloatType, HalfFloatType, DataUtils,
  } = await import(moduleUrl);

  const terrain = range.terrain;
  const initial = timeline.snapshot();
  const saved = { ao: terrain.uAO.value, shadow: terrain.uShadow.value, hemi: lighting.hemi.intensity };

  const readPatch = async (x, y, w, h) => {
    const target = sm._scenePass.renderTarget;
    const data = await sm.renderer.readRenderTargetPixelsAsync(target, x, y, w, h);
    const half = target.texture.type === HalfFloatType;
    const read = i => half ? DataUtils.fromHalfFloat(data[i]) : data[i];
    const mean = [0, 0, 0];
    for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) mean[c] += read(p * 4 + c) / (w * h);
    return { rgb: mean, luminance: mean[0] * .2126 + mean[1] * .7152 + mean[2] * .0722 };
  };

  // A 0.18 neutral Lambertian lit only by scene.environment gives sky irradiance
  // independent of any terrain shading term.
  const cardScene = new Scene();
  cardScene.environment = sm.scene.environment;
  cardScene.environmentIntensity = sm.scene.environmentIntensity;
  const material = new MeshPhysicalNodeMaterial({
    color: new Color().setRGB(0.18, 0.18, 0.18), roughness: 1, metalness: 0, specularIntensity: 0,
  });
  const geometry = new PlaneGeometry(2, 2);
  const card = new Mesh(geometry, material);
  card.rotation.x = -Math.PI / 2;
  cardScene.add(card);
  const cardCamera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
  cardCamera.position.set(0, 2, 0);
  cardCamera.up.set(0, 0, -1);
  cardCamera.lookAt(0, 0, 0);
  const cardTarget = new RenderTarget(1, 1, { type: FloatType, depthBuffer: false });
  const readCard = async () => {
    const previous = sm.renderer.getRenderTarget();
    try {
      sm.renderer.setRenderTarget(cardTarget);
      sm.renderer.render(cardScene, cardCamera);
    } finally { sm.renderer.setRenderTarget(previous); }
    const data = await sm.renderer.readRenderTargetPixelsAsync(cardTarget, 0, 0, 1, 1);
    const rgb = [data[0], data[1], data[2]];
    return { rgb, luminance: rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 };
  };

  const cases = [
    ['baseline', {}],
    ['no-canopy-AO', { ao: 0 }],
    ['no-self-shadow', { shadow: 0 }],
    ['no-AO-no-shadow', { ao: 0, shadow: 0 }],
    ['no-hemisphere', { hemi: 0 }],
  ];

  const result = [];
  try {
    timeline.pause();
    for (const time of ['19:06:00Z', '12:00:00Z']) {
      timeline.seek({ date: '2026-07-15', time });
      await camera.waitForFrames(10);
      const snapshot = timeline.snapshot();
      const measurements = {};
      for (const [label, overrides] of cases) {
        terrain.uAO.value = overrides.ao ?? saved.ao;
        terrain.uShadow.value = overrides.shadow ?? saved.shadow;
        lighting.hemi.intensity = overrides.hemi ?? saved.hemi;
        await camera.waitForFrames(8);
        measurements[label] = {
          turf: await readPatch(434, 700, 32, 32),
          native: await readPatch(300, 950, 32, 32),
        };
      }
      terrain.uAO.value = saved.ao;
      terrain.uShadow.value = saved.shadow;
      lighting.hemi.intensity = saved.hemi;
      await camera.waitForFrames(6);
      result.push({
        time,
        solarElevationDeg: snapshot.solar.elevationRadians * 180 / Math.PI,
        exposure: sm.renderer.toneMappingExposure,
        environmentIntensity: sm.scene.environmentIntensity,
        uAO: saved.ao,
        grayCard: await readCard(),
        measurements,
      });
    }
    return result;
  } finally {
    geometry.dispose(); material.dispose(); cardTarget.dispose();
    terrain.uAO.value = saved.ao;
    terrain.uShadow.value = saved.shadow;
    lighting.hemi.intensity = saved.hemi;
    timeline.seek(initial.epochMilliseconds);
    if (!initial.playback.paused) timeline.play(initial.playback.rate);
    await camera.waitForFrames(8);
  }
}

const result = spawnSync(process.execPath, [
  'scripts/shot.mjs', '--game', '--route=/play.html?course=grasslands-reference',
  '--presentation-mode=ultra', '--presentation-scale=1', '--gpu-live',
  '--frames=30', '--cam=0,0,-35', '--terrain-lift=6',
  '--look=-7,0,105', '--look-terrain-lift=5', '--fov=65', '--size=900x1200',
  `--eval=(${probe.toString()})()`,
  '--out=/tmp/ground-irradiance.png', '--qa-report=/tmp/ground-irradiance.json',
], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
