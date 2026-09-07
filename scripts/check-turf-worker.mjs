import {TURF_PACK_SOURCE_URLS} from '../src/terrain/TurfSources.js';
import {launch} from 'puppeteer-core';
import {fitBrowserViewport} from './lib/browser-viewport.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
const profile=await mkdtemp('/tmp/alpine-perimeter-profile-'),errors=[];
const browser=await launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,userDataDir:profile,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--window-position=8,40','--window-size=960,640'],defaultViewport:{width:1920,height:1080}});
try {
 const page=await browser.newPage();await fitBrowserViewport(page,1920,1080,{benchmark:true});
 page.on('pageerror',e=>{errors.push(String(e));console.error(e.stack)});
 page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
 page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
 page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));
 await page.goto('http://127.0.0.1:4173/play.html?course=current&start=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.golfBootstrap?.stage==='failed'||(window.golfBootstrap?.ready&&window.golf),{timeout:180000});
 await page.evaluate(()=>{if(window.golfBootstrap.stage==='failed')throw Error(window.golfBootstrap.diagnostics.error)});
 await page.evaluate(async()=>{await window.golf.environmentReady;window.golf.quality.acquirePresentationLock({mode:'battery',renderScale:1});});
 const identity=await page.evaluate(()=>({url:location.href,title:document.title,ready:window.golfBootstrap.ready,course:window.golf.range.course.meta.name,webgpu:window.golf.sm.renderer.backend.isWebGPUBackend}));
 if(!identity.webgpu)throw Error('Strict WebGPU required');
 const hashes=await page.evaluate(async urls=>{
  const maps=window.golf.range.terrain._turfMaps;await maps.ready;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=2048;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
  const results=[];
  for(let i=0;i<urls.length;i++){
   const source=new Image();source.src=urls[i];await source.decode();
   context.clearRect(0,0,2048,2048);context.drawImage(source,0,0,2048,2048);
   const reference=await hash(context.getImageData(0,0,2048,2048).data);
   const packed=(i%2?maps.nrhArray:maps.albedoArray).image.data;
   const bytes=2048*2048*4,start=Math.floor(i/2)*bytes;
   const actual=await hash(packed.subarray(start,start+bytes));
   if(actual!==reference)throw Error(`Turf pixels changed: ${urls[i]}`);
   results.push({url:urls[i],sha256:actual,bytes});
  }
  return results;
 },TURF_PACK_SOURCE_URLS);
 await page.screenshot({path:'/tmp/turf-worker-check.png'});
 await writeFile('/tmp/turf-worker-check.json',JSON.stringify({identity,hashes,errors},null,2));
 if(errors.length)throw Error(JSON.stringify(errors));
 console.log('Six 2048px turf layers match the original canvas packing byte-for-byte.');
}finally{await browser.close();await rm(profile,{recursive:true,force:true});}
