// Compare the existing .34 IBL calibration with native unity radiance. This
// changes only an isolated diagnostic browser, never authored source/albedo.
import { spawnSync } from 'node:child_process';

async function probe(time) {
  const { sm, range, timeline, evaluatorCamera: camera } = window.golf;
  const moduleUrl=performance.getEntriesByType('resource')
    .find(item=>new URL(item.name).pathname.endsWith('/three_webgpu.js'))?.name;
  if(!moduleUrl) throw new Error('Production Three module URL missing');
  const { Scene, OrthographicCamera, PlaneGeometry, Mesh, MeshPhysicalNodeMaterial,
    Color, RenderTarget, FloatType, HalfFloatType, DataUtils } = await import(moduleUrl);
  timeline.pause();
  timeline.seek({date:'2026-07-15',time});
  await camera.waitForFrames(8);
  const cardScene=new Scene();
  cardScene.environment=sm.scene.environment;
  const material=new MeshPhysicalNodeMaterial({color:new Color().setRGB(.18,.18,.18),
    roughness:1,metalness:0,specularIntensity:0});
  const geometry=new PlaneGeometry(2,2);
  const card=new Mesh(geometry,material);
  card.rotation.x=-Math.PI/2;
  cardScene.add(card);
  const cardCamera=new OrthographicCamera(-.5,.5,.5,-.5,.1,10);
  cardCamera.position.set(0,2,0);
  cardCamera.up.set(0,0,-1);
  cardCamera.lookAt(0,0,0);
  const target=new RenderTarget(1,1,{type:FloatType,depthBuffer:false});
  const mean=(data,half,count)=>{
    const rgb=[0,0,0];
    for(let i=0;i<count;i++) for(let c=0;c<3;c++)
      rgb[c]+=(half?DataUtils.fromHalfFloat(data[i*4+c]):data[i*4+c])/count;
    return {rgb,luminance:rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
  };
  const results=[];
  try {
    for(const intensity of [.34,1]) {
      cardScene.environmentIntensity=intensity;
      const previous=sm.renderer.getRenderTarget();
      try {
        sm.renderer.setRenderTarget(target);
        sm.renderer.render(cardScene,cardCamera);
      } finally { sm.renderer.setRenderTarget(previous); }
      const grayCard=mean(await sm.renderer.readRenderTargetPixelsAsync(target,0,0,1,1),false,1);
      sm.scene.environmentIntensity=intensity;
      await camera.waitForFrames(8);
      if(sm.scene.environmentIntensity!==intensity) throw new Error('IBL diagnostic override was reset');
      const sceneTarget=sm._scenePass.renderTarget;
      const turf=mean(await sm.renderer.readRenderTargetPixelsAsync(sceneTarget,434,790,32,32),
        sceneTarget.texture.type===HalfFloatType,1024);
      results.push({intensity,grayCard,turf});
    }
    const ratio=results[1].grayCard.luminance/results[0].grayCard.luminance;
    if(Math.abs(ratio-1/.34)>.015) throw new Error(`Gray-card IBL scaling failed: ${ratio}`);
    return {time,results,grayCardRatio:ratio,solar:timeline.snapshot().solar,
      note:'Unity IBL retained only for this diagnostic screenshot; source remains .34.'};
  } finally {
    geometry.dispose(); material.dispose(); target.dispose();
  }
}

for(const [label,time] of [['dusk','19:00:00Z'],['day','12:00:00Z']]) {
  const result=spawnSync(process.execPath,[
    'scripts/shot.mjs','--game','--route=/play.html?course=grasslands-reference',
    '--presentation-mode=ultra','--presentation-scale=1','--gpu-live',
    '--frames=16','--frame-timing=1','--cam=0,0,-35','--terrain-lift=6',
    '--look=-7,0,105','--look-terrain-lift=5','--fov=65','--size=900x1200',
    `--eval=(${probe.toString()})(${JSON.stringify(time)})`,
    `--out=/tmp/grasslands-ibl-unity-${label}.png`,
    `--qa-report=/tmp/grasslands-ibl-unity-${label}.json`,
  ],{stdio:'inherit',cwd:new URL('..',import.meta.url)});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status??1);
}
