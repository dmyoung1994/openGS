import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative} from 'node:path';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
const out=process.argv[2];
if(!out)throw Error('output directory required');
const api='https://api.polyhaven.com/files/jacaranda_tree';
const response=await fetch(api);if(!response.ok)throw Error(`API ${response.status}`);
const manifest=await response.json();const source=manifest.gltf['1k'].gltf;const alpha=manifest.leaves_alpha['1k'].png;
const files=[['jacaranda_tree_1k.gltf',source],...Object.entries(source.include),['textures/jacaranda_tree_leaves_alpha_1k.png',alpha]];
const hashes=[];
for(const [name,item] of files){
  const path=resolve(out,name);if(relative(resolve(out),path).startsWith('..'))throw Error('unsafe source path');
  if(new URL(item.url).hostname!=='dl.polyhaven.org')throw Error('unapproved source host');
  await mkdir(dirname(path),{recursive:true});
  let bytes;try{bytes=await readFile(path)}catch{}
  if(!bytes||createHash('md5').update(bytes).digest('hex')!==item.md5){const r=await fetch(item.url);if(!r.ok)throw Error(`${r.status} ${item.url}`);bytes=Buffer.from(await r.arrayBuffer());}
  if(createHash('md5').update(bytes).digest('hex')!==item.md5)throw Error(`hash mismatch ${name}`);
  await writeFile(path,bytes);hashes.push({name,url:item.url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});console.log('verified',name,bytes.length);
}
await writeFile(resolve(out,'source-provenance.json'),JSON.stringify({api,sourcePage:'https://polyhaven.com/a/jacaranda_tree',retrievedAt:new Date().toISOString(),hashes},null,2));
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);const doc=await io.read(resolve(out,'jacaranda_tree_1k.gltf'));
await io.write(resolve(out,'jacaranda-tree.glb'),doc);
console.log('EXACT_SOURCE_PACKED',out);
