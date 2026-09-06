// Isolate the existing sun-dependent turf AO multiplier in the actual production
// scene at dawn, daylight and dusk. All diagnostic state is restored afterward.
import { spawnSync } from 'node:child_process';

async function probe() {
  const { sm, range, timeline, evaluatorCamera: camera } = window.golf;
  const moduleUrl = performance.getEntriesByType('resource')
    .find(item=>new URL(item.name).pathname.endsWith('/three_webgpu.js'))?.name;
  if (!moduleUrl) throw new Error('Production Three module URL missing');
  const { DataUtils, HalfFloatType } = await import(moduleUrl);
  const initial = timeline.snapshot();
  const strength = range.terrain.uShadow.value;
  const result = [];
  const readPatch = async () => {
    const target = sm._scenePass.renderTarget;
    const data = await sm.renderer.readRenderTargetPixelsAsync(target,434,790,32,32);
    const half = target.texture.type === HalfFloatType;
    const read = i=>half?DataUtils.fromHalfFloat(data[i]):data[i];
    const mean = [0,0,0];
    // 32 RGBA16F pixels occupy 256 bytes; RGBA32F is 512, so neither has padding.
    for (let pixel=0;pixel<32*32;pixel++) {
      for(let channel=0;channel<3;channel++) mean[channel]+=read(pixel*4+channel)/(32*32);
    }
    return {rgb:mean,luminance:mean[0]*.2126+mean[1]*.7152+mean[2]*.0722};
  };
  try {
    timeline.pause();
    for (const time of ['05:00:00Z','12:00:00Z','19:00:00Z']) {
      timeline.seek({date:'2026-07-15',time});
      range.terrain.uShadow.value=strength;
      await camera.waitForFrames(8);
      const withSelfShadow=await readPatch();
      range.terrain.uShadow.value=0;
      await camera.waitForFrames(4);
      const withoutSelfShadow=await readPatch();
      result.push({time,solar:timeline.snapshot().solar,strength,withSelfShadow,withoutSelfShadow,
        ratio:withoutSelfShadow.luminance/withSelfShadow.luminance});
    }
    return {patch:{x:434,y:790,width:32,height:32},result};
  } finally {
    range.terrain.uShadow.value=strength;
    timeline.seek(initial.epochMilliseconds);
    if(!initial.playback.paused) timeline.play(initial.playback.rate);
    await camera.waitForFrames(8);
  }
}

const result=spawnSync(process.execPath,[
  'scripts/shot.mjs','--game','--route=/play.html?course=grasslands-reference',
  '--presentation-mode=ultra','--presentation-scale=1','--gpu-live',
  '--frames=16','--frame-timing=1','--cam=0,0,-35','--terrain-lift=6',
  '--look=-7,0,105','--look-terrain-lift=5','--fov=65','--size=900x1200',
  `--eval=(${probe.toString()})()`,
  '--out=/tmp/grasslands-self-shadow-probe.png','--qa-report=/tmp/grasslands-self-shadow-probe.json',
],{stdio:'inherit',cwd:new URL('..',import.meta.url)});
if(result.error) throw result.error;
process.exit(result.status??1);
