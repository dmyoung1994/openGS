import {launch} from 'puppeteer-core';
import {fitBrowserViewport,clickBrowserElement} from './lib/browser-viewport.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const dir=await mkdtemp(`${tmpdir()}/plant-qa-`), errors=[];
const quick=process.env.PLANT_QA_QUICK==='1';
const browser=await launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,userDataDir:dir,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--window-position=8,40','--window-size=960,640'],defaultViewport:{width:1920,height:1080}});
try {
const page=await browser.newPage();await fitBrowserViewport(page,1920,1080,{benchmark:true});page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));
await page.evaluateOnNewDocument(()=>{
  window.plantLoadProbe={frames:[],longTasks:[]};let last=performance.now();
  const tick=now=>{if(!window.golfBootstrap?.ready){window.plantLoadProbe.frames.push(now-last);last=now;requestAnimationFrame(tick)}};requestAnimationFrame(tick);
  new PerformanceObserver(list=>{for(const e of list.getEntries())if(!window.golfBootstrap?.ready)window.plantLoadProbe.longTasks.push(e.duration)}).observe({type:'longtask',buffered:true});
});
await page.goto(`${process.env.PLANT_QA_URL || 'http://127.0.0.1:5173'}/creator.html?authored=1`,{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>window.golfBootstrap?.ready,{timeout:180000});
const cold=await page.evaluate(()=>window.plantLoadProbe);
await page.reload({waitUntil:'domcontentloaded',timeout:120000});await page.waitForFunction(()=>window.golfBootstrap?.ready,{timeout:180000});
const warm=await page.evaluate(()=>window.plantLoadProbe);
await page.evaluate(async()=>{await window.golf.environmentReady;if(window.golf.creatorCanvasActive)await window.golf.showAuthoredCreatorCourse();await window.golf.environmentReady;window.golf.quality.acquirePresentationLock({mode:'balanced',renderScale:1});});
const identity=await page.evaluate(()=>({url:location.href,course:window.golf.range.course.meta.name,backend:window.golf.sm.renderer.backend.constructor.name,webgpu:window.golf.sm.renderer.backend.isWebGPUBackend,adapter:window.golf.sm.renderer.backend.device.adapterInfo,dimensions:[window.golf.sm.renderer.domElement.width,window.golf.sm.renderer.domElement.height]}));
console.log('identity',JSON.stringify(identity));
if(!identity.webgpu || identity.dimensions[0]!==1920 || identity.dimensions[1]!==1080)throw new Error('Strict WebGPU 1080p contract failed');
await clickBrowserElement(page,'#gb-plants');await page.waitForFunction(()=>document.querySelector('.plant-builder output')?.textContent.includes('segments'),{timeout:120000});
console.log('initial',await page.$eval('.plant-builder output',e=>e.textContent));
const baseline=await page.evaluate(async()=>{
  const trees=window.golf.range._treePresentation.line.trees;trees.visible=false;
  const samples=[];await new Promise(resolve=>{let last=performance.now();function tick(now){samples.push(now-last);last=now;if(samples.length===90)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)});trees.visible=true;samples.sort((a,b)=>a-b);return{median:samples[45],p95:samples[85]};
});console.log('course-with-preview-hidden',JSON.stringify(baseline));
const samples=[];
for(const preset of (quick ? ['whorled-fir','clipped-hedge'] : ['spreading-oak','whorled-fir','palm','weeping-willow','multi-stem-shrub','flowering-shrub','clipped-hedge'])) {
await page.evaluate(async preset=>{const studio=window.golf.builder.plantBuilder; const {createTreePreset}=await import('/src/trees/TreePresets.js');studio.framed=false;studio.commit(createTreePreset(preset));},preset);
await page.waitForFunction(preset=>window.golf.range._treePresentation?.line.treeBeauties[0]?.definitions.has(preset)&&document.querySelector('.plant-builder output')?.textContent.includes('segments'),{timeout:120000},preset);
await page.evaluate(()=>new Promise(resolve=>{let n=0;const frame=()=>++n>30?resolve():requestAnimationFrame(frame);requestAnimationFrame(frame)}));
const timing=await page.evaluate(()=>new Promise(resolve=>{const t=[];let last=performance.now();function frame(now){t.push(now-last);last=now;if(t.length<90)requestAnimationFrame(frame);else {t.sort((a,b)=>a-b);resolve({median:t[45],p95:t[85],diagnostics:window.golf.range._treePresentation.line.treeBeauties[0].workloadDiagnostics()})}}requestAnimationFrame(frame)}));
await page.screenshot({path:`/tmp/plant-${preset}.png`});samples.push({preset,...timing});console.log(preset,JSON.stringify(timing));
}
const motion=await page.evaluate(async()=>{
  const studio=window.golf.builder.plantBuilder, camera=window.golf.evaluatorCamera, range=window.golf.range;
  const anchor=studio.layout.center, ground=range.terrain.heightAt(anchor.x,anchor.z), result=[];
  for(const distance of [4,8,12,20,40,80,40,20,12,8,4]){
    camera.setPose({position:[anchor.x,ground+1,anchor.z+distance],lookAt:[anchor.x,ground+0.8,anchor.z],fov:42});await camera.settle(3);
    result.push({distance,...range._treePresentation.line.treeBeauties[0].residencyEstimate()});
  }
  if(!result.some(r=>r.counts.lod0)||!result.some(r=>r.counts.lod1)||!result.some(r=>r.counts.lod2))throw new Error('Camera sweep did not exercise all plant detail levels');
  const seed=studio.definition.seed;studio.commit({...studio.definition,seed:seed+1});studio.travel(studio.undo,studio.redo);if(studio.definition.seed!==seed)throw new Error('Undo failed');
  await new Promise(resolve=>setTimeout(resolve,250));await studio.previewQueue;
  return result;
});
await page.screenshot({path:'/tmp/plant-motion-final.png'});
await page.evaluate(()=>window.golf.builder.plantBuilder.close());
const fixture=await page.evaluate(async()=>{
  const raw=await fetch('/course.json').then(r=>r.json());
  const {TREE_PRESETS,createTreePreset}=await import('/src/trees/TreePresets.js');
  const points=window.golf.range._treePresentationPositions(TREE_PRESETS.length,null,TREE_PRESETS.map(name=>createTreePreset(name)));
  raw.environment.proceduralTreeDefinitions=TREE_PRESETS.map(name=>createTreePreset(name));
  raw.environment.proceduralTrees=TREE_PRESETS.map((name,i)=>({id:`qa-${name}`,definitionId:name,x:points[i].x,z:points[i].z,rotationY:0,scale:1,seed:1,age:1,health:1,windExposure:0.5}));
  raw.environment.objectBudget+=TREE_PRESETS.length;
  const phases=[];
  for(const phase of ['cold-procedural-handoff','warm-procedural-handoff']){
    const frames=[],longTasks=[];let active=true,last=performance.now();
    const tick=now=>{if(active){frames.push(now-last);last=now;requestAnimationFrame(tick)}};requestAnimationFrame(tick);
    const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())longTasks.push(e.duration)});observer.observe({type:'longtask'});
    await window.golf.previewCourse(raw);await window.golf.environmentReady;
    const cx=points.reduce((sum,p)=>sum+p.x,0)/points.length,cz=points.reduce((sum,p)=>sum+p.z,0)/points.length;
    const span=Math.max(35,...points.map(p=>Math.hypot(p.x-cx,p.z-cz)))*2;
    const y=window.golf.range.terrain.heightAt(cx,cz),camera=window.golf.evaluatorCamera;
    if(!camera.active)camera.enter();camera.setPose({position:[cx+span,y+span,cz+span],lookAt:[cx,y+8,cz],fov:55});await camera.settle(8);
    active=false;observer.disconnect();
    const plants=window.golf.range.treeBeauties.filter(b=>b.assetId==='procedural-tree').map(b=>b.workloadDiagnostics());
    if(plants.reduce((n,p)=>n+p.visible,0)!==TREE_PRESETS.length)throw new Error('The full-course fixture must show every plant preset');
    phases.push({phase,frames,longTasks,plants});
  }
  return phases;
});
await page.screenshot({path:'/tmp/plant-course-fixture.png'});
await writeFile('/tmp/plant-studio-qa.json',JSON.stringify({identity,cold,warm,baseline,samples,motion,fixture,errors},null,2));console.log('errors',JSON.stringify(errors));
if(errors.length)throw new Error('Renderer or network errors were recorded');
} catch(error){console.error(error);await writeFile('/tmp/plant-studio-qa-error.json',JSON.stringify({error:String(error),errors}));process.exitCode=1;}finally{await browser.close();await rm(dir,{recursive:true,force:true})}
