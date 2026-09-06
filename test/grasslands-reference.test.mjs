import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildEnvironmentProps } from '../src/scene/EnvironmentProps.js';
import { compileActiveCourse } from '../src/course/CourseProject.js';
import { validateEnvironmentCatalog } from '../src/environment/EnvironmentCatalog.js';
import { Grass } from '../src/terrain/Grass.js';
import { BackdropTerrain } from '../src/scene/BackdropTerrain.js';
import { normalizeCourse } from '../src/course/course.js';
import { polylineLength, routeCorridorSignedDistance } from '../src/course/RouteGeometry.js';
import { BuilderPanel } from '../src/ui/BuilderPanel.js';

test('reference-study preview cannot read or mutate the global workspace through builder actions', async () => {
  const reason='Separate photo study is read-only';
  for (const method of ['_loadState','_submit','_submitQuestionAnswer','_submitRevision','_cardAction',
    '_applySelected','_historyAction','_newConversation','_executeAgentControl']) {
    const calls=[];
    await BuilderPanel.prototype[method].call({readOnlyReason:reason,_status:message=>calls.push(message)});
    assert.deepEqual(calls,[reason],method);
  }
});

test('indirect grass dispatch keeps complete tiles within hardware dimension limits', async () => {
  const source = await readFile(new URL('../src/terrain/Grass.js', import.meta.url), 'utf8');
  assert.match(source, /_candidateDispatch\.element\( uint\( 0 \) \)\.assign\( uint\( GROUPS_PER_TILE \) \)/);
  assert.match(source, /_candidateDispatch\.element\( uint\( 1 \) \)\.assign\( tiles \)/);
  assert.match(source, /const activeSlot = workgroupId\.y;/);
  assert.match(source, /const groupInTile = workgroupId\.x;/);
  assert.match(source, /Math\.max\( GROUPS_PER_TILE, this\._tileCount \) > this\._dispatchDimensionLimit/);
  const groupsPerTile = 192 * 192 / 64;
  for (const tiles of [0, 1, 113, 114, 267, 65535]) {
    assert.ok(groupsPerTile <= 65535 && tiles <= 65535);
    assert.equal(groupsPerTile * tiles * 64, tiles * 192 * 192);
  }
  assert.ok(267 * groupsPerTile > 65535, 'reproduce the invalid former flattened dispatch');
});

test('photo study compiles as an additive routed hole with three playable tees', async () => {
  const project = JSON.parse(await readFile(new URL('../courses/grasslands-reference.project.json', import.meta.url)));
  const {runtime} = compileActiveCourse(project);
  assert.equal(runtime.meta.schema, 4);
  assert.equal(runtime.groundCover, 'native-grasslands');
  assert.equal(runtime.routing.holes[0].tees.length, 3);
  assert.equal(runtime.environment.placements.filter(p=>p.assetId==='grasslands-clubhouse').length,1);
  assert.deepEqual(runtime, JSON.parse(await readFile(new URL('../public/courses/grasslands-reference.json', import.meta.url))));
  assert.equal(runtime.routing.holes[0].route.fairwayStartMeters,94);
  assert.ok(routeCorridorSignedDistance(runtime.routing.holes[0].route,0,8) < -4, 'native separator between back and middle tee');
});

test('maintained-corridor start validates both authoring and runtime boundaries', async () => {
  const project = JSON.parse(await readFile(new URL('../courses/grasslands-reference.project.json', import.meta.url)));
  const length = polylineLength(project.holes[0].route.points);
  for (const invalid of [-1, Infinity, NaN, length+1]) {
    const copy = structuredClone(project);
    copy.holes[0].route.fairwayStartMeters = invalid;
    assert.throws(()=>compileActiveCourse(copy), /fairwayStartMeters/);
    const runtime = compileActiveCourse(project).runtime;
    runtime.routing.holes[0].route.fairwayStartMeters = invalid;
    assert.throws(()=>normalizeCourse(runtime), /fairwayStartMeters/);
  }
});

test('local editable-source provenance is scoped and cannot escape the asset tree', async () => {
  const catalog=JSON.parse(await readFile(new URL('../public/assets/environment/catalog.json',import.meta.url)));
  const building=catalog.assets.find(a=>a.id==='grasslands-clubhouse');
  assert.doesNotThrow(()=>validateEnvironmentCatalog(catalog));
  for (const bad of ['/assets/environment/../../secret.blend','/tmp/source.blend','file:///tmp/source.blend']) {
    building.derivativeLineage.sourceUrl=bad;
    assert.throws(()=>validateEnvironmentCatalog(catalog));
  }
});

test('architectural props retain authored PBR and cast real shadows', async () => {
  const source = new Group();
  const authored = new MeshStandardMaterial({color:0x778899,roughness:.13,metalness:.7,emissive:0xffa044,emissiveIntensity:2});
  source.add(new Mesh(new BoxGeometry(1,1,1),authored));
  const original = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async () => ({scene:source});
  try {
    const group = await buildEnvironmentProps({
      catalog:{byId:new Map([['test-building',{id:'test-building',category:'building',dimensions:{width:1,height:1,depth:1},lods:[{url:'/unit-test.glb'}]}]])},
      placements:[{assetId:'test-building',sourceId:'test-placement',normalX:0,normalY:1,normalZ:0,rotationX:0,rotationY:0,rotationZ:0,x:0,y:0,z:0,scale:1}],environmentSeed:1,
    });
    const mesh=group.children[0];
    assert.equal(mesh.material.roughness,.13);
    assert.equal(mesh.material.metalness,.7);
    assert.equal(mesh.material.emissiveIntensity,2);
    assert.deepEqual(Array.from(mesh.instanceColor.array),[1,1,1]);
    assert.equal(mesh.castShadow,true);
    assert.equal(mesh.receiveShadow,true);
    mesh.geometry.dispose(); mesh.material.dispose();
  } finally { GLTFLoader.prototype.loadAsync=original; }
});

test('native grass tile bounds enclose the tall tips and buried roots', () => {
  const metadata=Grass.prototype._makeTileOrigins.call({
    terrain:{bounds:{minX:0,maxX:8,minZ:0,maxZ:8},heights:new Float32Array([2]),spacing:8},
    _const:{nx:1,nz:1,dataTex:{image:{data:new Uint8Array([128])}}},
    _bladeHeight:{rough:.12,deepRough:1.15},
  });
  const [low,high]=metadata.heightBounds.value.array;
  assert.ok(low<=2-.115+1e-6);
  assert.ok(high>=2+1.15);
});

test('inland grasslands retain exact terrain-boundary height without adding an ocean', () => {
  const bounds={minX:-100,maxX:100,minZ:-300,maxZ:40};
  const terrain={groundCover:'native-grasslands',heightAt:(x,z)=>x*.01+z*.002};
  const backdrop=new BackdropTerrain({terrain,bounds,seed:91842});
  assert.equal(backdrop.group.userData.backdropSource,'inland-native-grasslands');
  assert.ok(backdrop.group.children.every(mesh=>!mesh.name.includes('ocean')));
  const sample=backdrop.group.userData.authoringSampler;
  for(const [x,z] of [[-100,-80],[100,-80],[0,-300],[0,40]]) {
    assert.equal(sample(x,z).height,terrain.heightAt(x,z));
  }
  backdrop.dispose();
});

test('authored sidecar leaf coverage uses the same unflipped UV origin as glTF PBR maps', async () => {
  const source=await readFile(new URL('../src/scene/Trees.js',import.meta.url),'utf8');
  assert.match(source,/loadAsync\(alphaMap\.url\)[\s\S]*?textureMap\.flipY = false/);
});
