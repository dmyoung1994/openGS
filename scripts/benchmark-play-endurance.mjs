import {launch} from 'puppeteer-core';
import {fitBrowserViewport} from './lib/browser-viewport.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
const directory=await mkdtemp('/tmp/play-endurance-'),profile=await mkdtemp('/tmp/play-endurance-chrome-'),errors=[];
console.log(`Evidence: ${directory}`);
const browser=await launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,userDataDir:profile,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--window-position=8,40','--window-size=960,640'],defaultViewport:{width:1920,height:1080}});
try {
 const page=await browser.newPage();await fitBrowserViewport(page,1280,720);
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
 page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));
 await page.goto('http://127.0.0.1:4173/play.html?course=current&start=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.golfBootstrap?.ready&&window.golf,{timeout:180000});
 const identity=await page.evaluate(()=>({url:location.href,title:document.title,view:document.body.dataset.view,scene:window.golf.range.sceneKind,webgpu:window.golf.sm.renderer.backend.isWebGPUBackend,trees:window.golf.range.treeWorkloadDiagnostics(),creatorVisible:document.querySelector('#gb-panel')?.getBoundingClientRect().width>0}));
 if(!identity.webgpu||identity.view!=='practice'||identity.creatorVisible||identity.trees.sourceCount!==111)throw Error('Play identity failed '+JSON.stringify(identity));
 await fitBrowserViewport(page,1920,1080,{benchmark:true});

 await page.evaluate(()=>{
  const g=window.golf,t=g.range.terrain,c=g.evaluatorCamera;c.enter();
  c.setPose({position:[-300,t.heightAt(-300,308)+2.1,308],lookAt:[-291,t.heightAt(-291,59)+1,59],fov:40});
 });
 await new Promise(r=>setTimeout(r,20000));
 await page.screenshot({path:`${directory}/start.png`});
 const before=await page.evaluate(()=>({quality:window.golf.quality.snapshot(),memory:window.golf.sm.renderer.info.memory}));
 await page.evaluate(()=>{
  const g=window.golf,t=g.range.terrain,c=g.evaluatorCamera;
  window.endurance={started:performance.now(),frames:[],stop:false};let previous=null;
  const tick=now=>{
   const e=window.endurance;if(e.stop)return;
   if(previous!==null)e.frames.push(now-previous);previous=now;
   const seconds=(now-e.started)/1000,cycle=seconds%120;
   // One minute at the expensive tee, one minute of smooth travel out and back.
   const amount=cycle<60?0:Math.sin((cycle-60)/60*Math.PI)**2;
   if(cycle<60&&cycle>0.1&&amount===e.lastAmount){requestAnimationFrame(tick);return;}
   e.lastAmount=amount;
   const z=308-amount*340,x=-300+amount*26,lx=-291+amount*19,lz=59-amount*133.9;
   c.movePose({position:[x,t.heightAt(x,z)+2.1,z],lookAt:[lx,t.heightAt(lx,lz)+1,lz],fov:40});
   requestAnimationFrame(tick);
  };requestAnimationFrame(tick);
 });
 const windows=[];
 for(let index=0;index<20;index++){
  await new Promise(r=>setTimeout(r,30000));
  const sample=await page.evaluate(()=>{
   const e=window.endurance,frames=e.frames.splice(0).sort((a,b)=>a-b),g=window.golf;
   return {elapsedMs:performance.now()-e.started,frames:frames.length,
    fps:1000/(frames.reduce((a,b)=>a+b,0)/frames.length),p50:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1),
    quality:g.quality.snapshot(),gpu:g.sm.gpuProfiler.lastCapture,
    visibility:document.visibilityState,simulationFrozen:g.sm.freezeSimulation,
    resolution:[g.sm.renderer.domElement.width,g.sm.renderer.domElement.height],
    trees:g.range.treeWorkloadDiagnostics(),memory:g.sm.renderer.info.memory,camera:g.evaluatorCamera.getState()};
  });
  windows.push(sample);
  console.log(JSON.stringify({window:index+1,fps:sample.fps,p95:sample.p95,mode:sample.quality.activeMode}));
  await writeFile(`${directory}/report.json`,JSON.stringify({identity,before,windows,errors},null,2));
  if(sample.resolution[0]!==1920||sample.resolution[1]!==1080||sample.quality.renderScale!==1||sample.simulationFrozen||sample.trees.sourceCount!==111)throw Error('Endurance fidelity changed');
  if(errors.length)throw Error(JSON.stringify(errors));
 }
 await page.evaluate(()=>{window.endurance.stop=true});
 await page.screenshot({path:`${directory}/final.png`});
 if(windows.some(w=>w.fps<30||w.p95>34||!(w.quality.observation?.gpuP95<=33.3)))throw Error('Endurance performance gate failed; inspect saved windows');
}finally{await browser.close();await rm(profile,{recursive:true,force:true});}
