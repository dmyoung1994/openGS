import {launch} from 'puppeteer-core';
import {fitBrowserViewport,clickBrowserElement} from './lib/browser-viewport.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
const profile=await mkdtemp('/tmp/minimap-pointer-profile-'),errors=[];
const browser=await launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,userDataDir:profile,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--window-position=8,40','--window-size=960,640'],defaultViewport:{width:1920,height:1080}});
try {
 const page=await browser.newPage();await fitBrowserViewport(page,1920,1080,{benchmark:true});
 page.on('pageerror',e=>{errors.push(String(e));console.error(e.stack)});
 page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
 page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
 page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));
 await page.goto(new URL('/play.html?course=current&start=1',process.env.VIEWER_URL??'http://127.0.0.1:4173').href,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.golfBootstrap?.stage==='failed'||(window.golfBootstrap?.ready&&window.golf),{timeout:180000});
 await page.evaluate(()=>{if(window.golfBootstrap.stage==='failed')throw Error(window.golfBootstrap.diagnostics.error)});
 await page.evaluate(async()=>{await window.golf.environmentReady;window.golf.quality.acquirePresentationLock({mode:'battery',renderScale:1});});
 const identity=await page.evaluate(()=>({url:location.href,title:document.title,ready:window.golfBootstrap.ready,course:window.golf.range.course.meta.name,webgpu:window.golf.sm.renderer.backend.isWebGPUBackend}));
 if(!identity.webgpu)throw Error('Strict WebGPU required');
 await page.evaluate(()=>{
  const {range,evaluatorCamera:c}=window.golf;c.enter();c.setPose({position:[-300,range.terrain.heightAt(-300,308)+2.1,308],lookAt:[-291,range.terrain.heightAt(-291,59)+1,59],fov:40});
 });
 await page.evaluate(async()=>{await document.fonts.ready;await window.golf.evaluatorCamera.settle(60);});
 await page.evaluate(()=>{window.pointerEvidence=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>window.pointerEvidence.push({type,target:e.target.tagName,cls:e.target.getAttribute('class'),x:e.clientX,y:e.clientY}),true)});
 const results=[];
 for(let i=0;i<4;i++){
  await page.screenshot({path:`/tmp/minimap-pointer-before-click-${i}.png`});
  const before=await page.$eval('.gm-map-size',e=>({expanded:e.getAttribute('aria-expanded'),rect:e.getBoundingClientRect().toJSON()}));
  await clickBrowserElement(page,'.gm-map-size');await page.evaluate(()=>window.golf.evaluatorCamera.settle(20));
  const after=await page.$eval('.gm-map-size',e=>({expanded:e.getAttribute('aria-expanded'),rect:e.getBoundingClientRect().toJSON()}));
  results.push({before,after});
 }
 const events=await page.evaluate(()=>window.pointerEvidence);
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,canvasWidth:window.golf.sm.renderer.domElement.width,canvasHeight:window.golf.sm.renderer.domElement.height}));
 await page.screenshot({path:'/tmp/minimap-pointer.png'});
 await writeFile('/tmp/minimap-pointer.json',JSON.stringify({identity,viewport,results,events,errors},null,2));
 if(viewport.width!==1920||viewport.height!==1080||viewport.canvasWidth!==1920||viewport.canvasHeight!==1080)throw Error('Benchmark pixels changed');
 if(errors.length||results.some(r=>r.before.expanded===r.after.expanded))throw Error('Pointer activation failed');
}finally{await browser.close();await rm(profile,{recursive:true,force:true});}
