import { launch } from 'puppeteer-core';
import { fitBrowserViewport } from './lib/browser-viewport.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// Synthetic launch packets recorded against Pineglass; this is a workflow replay,
// not a claim that these packets came from physical launch-monitor hardware.
const directory=await mkdtemp('/tmp/play-hole-'),profile=await mkdtemp('/tmp/play-hole-chrome-'),errors=[];
console.log(`Evidence: ${directory}`);
const browser=await launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,userDataDir:profile,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--window-position=8,40','--window-size=960,640'],defaultViewport:null});
try {
 const page=await browser.newPage();await fitBrowserViewport(page,1280,720);
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));
 await page.goto(new URL('/play.html?course=current&start=1',process.env.VIEWER_URL||'http://localhost:5173').href,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.golfBootstrap?.ready&&window.golf,{timeout:180000});
 const identity=await page.evaluate(()=>({url:location.href,ready:window.golfBootstrap.ready,webgpu:window.golf.sm.renderer.backend.isWebGPUBackend,scene:window.golf.range.sceneKind,initial:window.golf.play.snapshot(),cup:window.golf.ball.cup}));
 if(!identity.webgpu||identity.scene!=='play')throw Error('Wrong production scene');
 await page.mouse.click(8,8);
 await page.evaluate(()=>window.golf.audio.ready);
 await page.waitForFunction(()=>window.golf.audio.snapshot().unlocked);
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
   const result=g.launchMonitor.submit({...metrics,timestamp:Date.now()});
   const busy=g.launchMonitor.submit({...metrics,timestamp:Date.now()+1});
   return {before,result,busy,play:g.play.snapshot()};
  },choice.metrics);
  if(!submitted.result.accepted||submitted.busy.reason!=='shot-in-progress')throw Error('Invalid shot gate '+JSON.stringify(submitted));
  await page.waitForFunction(()=>window.golf.ball.state==='rest',{timeout:90000});
  const result=await page.evaluate(()=>({play:window.golf.play.snapshot(),position:window.golf.ball.position.toArray(),aim:window.golf.aim.getState(),status:document.querySelector('.gs-shot-status')?.textContent,offline:document.querySelector('#gs-result-offline')?.textContent}));
  shots.push({choice,submitted,result});
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
   await page.click('.gs-play-continue');
   const next=await page.evaluate(()=>({play:window.golf.play.snapshot(),ball:window.golf.ball.position.toArray(),tee:window.golf.range.tee}));
   if(next.play.complete||next.play.strokes!==0||next.play.holeId===identity.initial.holeId)throw Error('Next hole failed');
   await writeFile(`${directory}/report.json`,JSON.stringify({identity,shots,audio,next,errors},null,2));
   break;
  }
 }
 if(!shots.at(-1)?.result.play.complete)throw Error('Hole not completed within three synthetic launch packets');
 if(errors.length)throw Error(JSON.stringify(errors));

}finally{await browser.close();await rm(profile,{recursive:true,force:true});}
