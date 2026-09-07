import assert from 'node:assert/strict';
import {launch} from 'puppeteer-core';
import {fitBrowserViewport} from './lib/browser-viewport.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
const profile=await mkdtemp('/tmp/backdrop-edge-normal-profile-'),errors=[];
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
 const shaders=await page.evaluate(async()=>{
  const objects=window.golf.sm.renderer._objects,original=objects.get,shaders={};
  objects.get=function(...args){
   const result=original.apply(this,args),name=args[0]?.name;
   if(name?.startsWith('alpine-'))shaders[name]=result.getNodeBuilderState().fragmentShader;
   return result;
  };
  try {await window.golf.evaluatorCamera.waitForFrames(2);} finally {objects.get=original;}
  return shaders;
 });
 const checks=[];
 assert.ok(Object.keys(shaders).length,'No rendered alpine shaders captured');
 for(const [name,shader] of Object.entries(shaders)){
  const branch=/if\s*\(\s*\(\s*[^)]+<\s*24\.0\s*\)\s*\)\s*\{/.exec(shader);
  assert.ok(branch,`${name}: missing 24-metre normal branch`);
  const start=shader.indexOf('{',branch.index);let end=start+1,depth=1;
  while(depth&&end<shader.length){if(shader[end]==='{')depth++;if(shader[end]==='}')depth--;end++;}
  assert.equal(depth,0,'Unclosed shader branch');
  const body=shader.slice(start,end),loads=(body.match(/textureLoad\(/g)??[]).length;
  assert.equal(loads,16,`${name}: height reconstruction escaped its branch`);
  assert.equal((shader.match(/textureLoad\(/g)??[]).length,loads,`${name}: unconditional height loads remain`);
  assert.match(body,/smoothstep\( 0\.0, 24\.0,/,'Boundary blend changed');
  checks.push({name,heightLoadsInsideBranch:loads});
 }
 const boundaries=[];
 for(const side of ['minX','maxX','minZ','maxZ']){
  boundaries.push(await page.evaluate(async side=>{
   const g=window.golf,b=g.range.terrain.bounds,c=g.evaluatorCamera;
   const dx=side==='minX'?-1:side==='maxX'?1:0,dz=side==='minZ'?-1:side==='maxZ'?1:0;
   const x=dx?(dx<0?b.minX:b.maxX):(b.minX+b.maxX)/2;
   const z=dz?(dz<0?b.minZ:b.maxZ):(b.minZ+b.maxZ)/2;
   const ground=(x,z)=>g.range.backdrop.group.userData.authoringSampler(x,z).height;
   const pose=d=>{const px=x+dx*d,pz=z+dz*d;return {position:[px,ground(px,pz)+.9,pz],lookAt:[px+dx*12,ground(px+dx*12,pz+dz*12)+.3,pz+dz*12],fov:50}};
   c.setPose(pose(16));await c.settle(30);
   for(let i=0;i<60;i++){c.movePose(pose(16+i*16/59));await c.waitForFrames(1);}
   return {side,fromDistance:16,toDistance:32,pose:c.getState()};
  },side));
  await page.screenshot({path:`/tmp/backdrop-edge-normal-${side}.png`});
 }
 const resolution=await page.evaluate(()=>[window.golf.sm.renderer.domElement.width,window.golf.sm.renderer.domElement.height]);
 assert.deepEqual(resolution,[1920,1080]);assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/backdrop-edge-normal-check.png'});
 await writeFile('/tmp/backdrop-edge-normal-shaders.json',JSON.stringify(shaders,null,2));
 await writeFile('/tmp/backdrop-edge-normal-check.json',JSON.stringify({identity,resolution,checks,boundaries,errors},null,2));
 console.log('Passed: /tmp/backdrop-edge-normal-check.json');
}finally{await browser.close();await rm(profile,{recursive:true,force:true});}
