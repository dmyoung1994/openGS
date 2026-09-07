// Read the SAME image regions in scene-linear (the MRT, pre tone map) and note the
// exposure, so the display PNG can be compared against them directly. Settles whether
// a dark ground is a lighting problem or a tone-curve problem instead of inferring it
// from two different patches. Also pins the readback's row convention explicitly.
import { spawnSync } from 'node:child_process';

async function probe() {
  const { sm, timeline, evaluatorCamera: camera } = window.golf;
  const moduleUrl = performance.getEntriesByType('resource')
    .find(item => new URL(item.name).pathname.endsWith('/three_webgpu.js'))?.name;
  if (!moduleUrl) throw new Error('Production Three module URL missing');
  const { DataUtils, HalfFloatType } = await import(moduleUrl);
  timeline.pause();
  await camera.waitForFrames(14);

  const target = sm._scenePass.renderTarget;
  const height = target.height;
  const width = target.width;
  const half = target.texture.type === HalfFloatType;
  const read = async (x, y, w, h) => {
    const data = await sm.renderer.readRenderTargetPixelsAsync(target, x, y, w, h);
    const get = i => half ? DataUtils.fromHalfFloat(data[i]) : data[i];
    const mean = [0, 0, 0];
    for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) mean[c] += get(p * 4 + c) / (w * h);
    return { rgb: mean.map(v => +v.toFixed(6)), luminance: +(mean[0] * .2126 + mean[1] * .7152 + mean[2] * .0722).toFixed(6) };
  };

  // Same fractional regions the PNG sampler uses, tried both row conventions so the
  // orientation is established from the data rather than assumed.
  const regions = { 'sky-high': [0.15, 0.10, 0.30, 0.08], 'ground-mid': [0.30, 0.55, 0.25, 0.03] };
  const out = { width, height, exposure: sm.renderer.toneMappingExposure, regions: {} };
  for (const [label, [fx, fy, fw, fh]] of Object.entries(regions)) {
    const x = Math.round(fx * width);
    const w = Math.max(1, Math.round(fw * width));
    const h = Math.max(1, Math.round(fh * height));
    const topDownY = Math.round(fy * height);
    const bottomUpY = Math.max(0, height - topDownY - h);
    out.regions[label] = {
      asTopDown: await read(x, topDownY, w, h),
      asBottomUp: await read(x, bottomUpY, w, h),
    };
  }
  return out;
}

const result = spawnSync(process.execPath, [
  'scripts/shot.mjs', '--game', '--route=/play.html?course=grasslands-reference',
  '--presentation-mode=ultra', '--presentation-scale=1',
  '--frames=40', '--cam=0,0,-35', '--terrain-lift=6',
  '--look=-7,0,105', '--look-terrain-lift=5', '--fov=65', '--size=900x1200',
  `--eval=(${probe.toString()})()`,
  '--out=/tmp/tonemap-transfer.png', '--qa-report=/tmp/tonemap-transfer.json',
], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
