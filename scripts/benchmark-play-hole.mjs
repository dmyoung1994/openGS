import { launch } from 'puppeteer-core';
import { fitBrowserViewport, clickBrowserElement } from './lib/browser-viewport.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// Synthetic launch packets recorded against Pineglass; this is a workflow replay,
// not a claim that these packets came from physical launch-monitor hardware.
const directory=await mkdtemp('/tmp/play-hole-'),profile=await mkdtemp('/tmp/play-hole-chrome-'),errors=[];
console.log(`Evidence: ${directory}`);
const browser=await launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,userDataDir:profile,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--window-position=8,40','--window-size=960,640'],defaultViewport:null});
try {
 const page=await browser.newPage();await fitBrowserViewport(page,1920,1080,{benchmark:true});
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));
 await page.goto(new URL('/play.html?course=current&start=1',process.env.VIEWER_URL||'http://localhost:5173').href,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.golfBootstrap?.ready&&window.golf,{timeout:180000});
 const identity=await page.evaluate(()=>({url:location.href,ready:window.golfBootstrap.ready,webgpu:window.golf.sm.renderer.backend.isWebGPUBackend,scene:window.golf.range.sceneKind,scenePass:window.golf.sm._scenePass.uuid,sceneTarget:window.golf.sm._scenePass.renderTarget.texture.uuid,initial:window.golf.play.snapshot(),cup:window.golf.ball.cup}));
 if(!identity.webgpu||identity.scene!=='play')throw Error('Wrong production scene');
 if(!identity.scenePass||!identity.sceneTarget)throw Error('Missing shared scene-pass identity');
 await page.mouse.click(8,8);
 await page.evaluate(()=>window.golf.audio.ready);
 await page.waitForFunction(()=>window.golf.audio.snapshot().unlocked);
 await page.evaluate(()=>{
  window.gameplayCanvasCaptures=0;
  const canvas=window.golf.sm.renderer.domElement,toBlob=canvas.toBlob;
  canvas.toBlob=function(...args){window.gameplayCanvasCaptures++;return toBlob.apply(this,args)};
  window.holeCompletedRenders=0;
  const sm=window.golf.sm,render=sm._renderFrame;
  sm._renderFrame=function(...args){const result=render.apply(this,args);window.holeCompletedRenders++;return result};
  window.holeTiming={active:false,last:null,lastRenderCount:null,frames:[],invalidFrames:0};
  function tick(now){
   const t=window.holeTiming,g=window.golf;
   if(t.active){
    if(t.last===null)t.firstCallbackLatencyMs=performance.now()-t.startedAt;
    else t.frames.push(now-t.last);
    if(g.sm.renderer.domElement.width!==1920||g.sm.renderer.domElement.height!==1080
      ||g.sm._renderResolution.internalRenderScale!==1||g.sm.freezeSimulation||document.visibilityState!=='visible'
      ||(t.last!==null&&t.lastRenderCount===window.holeCompletedRenders))t.invalidFrames++;
   }
   t.last=now;t.lastRenderCount=window.holeCompletedRenders;requestAnimationFrame(tick);
  }requestAnimationFrame(tick);
 });
 const shots=[];
 for(let shot=0;shot<3;shot++){
  const choice={metrics:[
   {ballSpeed:167,launchAngle:12,launchDirection:0,spinRate:2700,spinAxis:0},
   {ballSpeed:94.6875,launchAngle:25,launchDirection:4.5,spinRate:6000,spinAxis:0},
   {ballSpeed:6.275,launchAngle:0,launchDirection:3.5,spinRate:0,spinAxis:0},
  ][shot]};
  if(!choice.metrics)throw Error('Replay did not finish in three strokes');
  await page.evaluate(()=>window.golf.aim.setTarget({x:window.golf.ball.cup.x,z:window.golf.ball.cup.z}));
  console.log('chosen',JSON.stringify(choice));
  const submitted=await page.evaluate(metrics=>{
   const g=window.golf,before=g.ball.position.toArray();
   Object.assign(window.holeTiming,{frames:[],invalidFrames:0,active:true,last:null,
    startedAt:performance.now(),firstCallbackLatencyMs:null});
   const result=g.launchMonitor.submit({...metrics,timestamp:Date.now()});
   const busy=g.launchMonitor.submit({...metrics,timestamp:Date.now()+1});
   return {before,result,busy,play:g.play.snapshot()};
  },choice.metrics);
  if(!submitted.result.accepted||submitted.busy.reason!=='shot-in-progress')throw Error('Invalid shot gate '+JSON.stringify(submitted));
  await page.waitForFunction(()=>window.golf.ball.state==='rest',{timeout:90000});
  const timing=await page.evaluate(()=>{
   const t=window.holeTiming;t.active=false;
   const frames=t.frames.sort((a,b)=>a-b);
   return {samples:frames.length,fps:1000/(frames.reduce((a,b)=>a+b,0)/frames.length),
    p95:frames[Math.ceil(frames.length*.95)-1],max:frames.at(-1),invalidFrames:t.invalidFrames,firstCallbackLatencyMs:t.firstCallbackLatencyMs,
    resolution:[window.golf.sm.renderer.domElement.width,window.golf.sm.renderer.domElement.height],quality:window.golf.quality.snapshot(),
    scenePass:window.golf.sm._scenePass.uuid,sceneTarget:window.golf.sm._scenePass.renderTarget.texture.uuid};
  });
  const result=await page.evaluate(()=>({play:window.golf.play.snapshot(),position:window.golf.ball.position.toArray(),aim:window.golf.aim.getState(),status:document.querySelector('.gs-shot-status')?.textContent,offline:document.querySelector('#gs-result-offline')?.textContent}));
  shots.push({choice,submitted,result,timing});
  console.log('timing',JSON.stringify({shot:shot+1,fps:timing.fps,p95:timing.p95,invalidFrames:timing.invalidFrames}));
  await page.screenshot({path:`${directory}/shot-${shot+1}.png`});
  await writeFile(`${directory}/report.json`,JSON.stringify({identity,shots,errors},null,2));
  console.log('result',JSON.stringify(result));
  if(result.play.complete){
   const audio=await page.evaluate(()=>window.golf.audio.snapshot());
   if(audio.eventCounts.holed!==1||audio.failedAssets.length||audio.recentEvents.filter(e=>e.group==='cup.drop').length!==1)throw Error('Cup audio failed '+JSON.stringify(audio));
   await page.evaluate(async()=>{
    const g=window.golf,c=g.ball.cup;
    g.evaluatorCamera.enter();
    g.evaluatorCamera.setPose({position:[c.x+.3,c.y+.45,c.z+.45],lookAt:[c.x,c.y-.04,c.z],fov:42});
    await g.evaluatorCamera.waitForFrames(12);
   });
   await page.screenshot({path:`${directory}/cup-close.png`});
   await page.evaluate(()=>window.golf.evaluatorCamera.restore());
   await clickBrowserElement(page,'.gs-play-continue');
   const next=await page.evaluate(()=>({play:window.golf.play.snapshot(),ball:window.golf.ball.position.toArray(),tee:window.golf.range.tee}));
   if(next.play.complete||next.play.strokes!==0||next.play.holeId===identity.initial.holeId)throw Error('Next hole failed');
   const gameplayCanvasCaptures=await page.evaluate(()=>window.gameplayCanvasCaptures);
   const performanceGate={minimumFps:30,maximumP95Ms:34,maximumFirstCallbackMs:34,
    passed:shots.every(s=>s.timing.samples>=2&&s.timing.fps>=30&&s.timing.p95<=34
      &&s.timing.firstCallbackLatencyMs!==null&&s.timing.firstCallbackLatencyMs<=34&&s.timing.invalidFrames===0)};
   await writeFile(`${directory}/report.json`,JSON.stringify({identity,shots,audio,next,gameplayCanvasCaptures,performanceGate,errors},null,2));
   if(shots.some(s=>s.timing.scenePass!==identity.scenePass||s.timing.sceneTarget!==identity.sceneTarget))throw Error('Weather adaptation replaced the shared scene pass');
   if(gameplayCanvasCaptures!==0)throw Error('Thumbnail canvas readback interrupted gameplay');
   if(errors.length)throw Error(JSON.stringify(errors));
   if(!performanceGate.passed)throw Error('Full-hole performance gate failed; gameplay and timing evidence saved in report.json');
   break;
  }
 }
 if(!shots.at(-1)?.result.play.complete)throw Error('Hole not completed within three synthetic launch packets');
 if(errors.length)throw Error(JSON.stringify(errors));

}finally{await browser.close();await rm(profile,{recursive:true,force:true});}
