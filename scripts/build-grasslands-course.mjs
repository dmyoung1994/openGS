// Reproducible, additive photo-study project; never writes the active workspace.
import { mkdir, writeFile } from 'node:fs/promises';
import { compileActiveCourse } from '../src/course/CourseProject.js';
import { DEFAULT_SURFACE_MATERIALS } from '../src/course/course.js';

const point = (x, z) => ({ x, z });
const landform = (id, kind, x, z, width, height, falloff) => ({
  id, kind, points: [point(x,z)], width, height, falloff,
});
const project = {
  meta: { id: 'grasslands-reference-project', name: 'Grasslands', mode: 'realistic', schema: 5,
    notes: 'User-photo interpretation, not a survey. Three descending tee shelves frame a left wetland and a right hipped-roof clubhouse. The unseen par-4 routing, dimensions and green contours are inferred. Left water affects a pulled opening shot; a generous dry right line trades a longer approach for safety. A left landing bunker rewards a challenged inside line with a clear running approach to a tilted green. No existing course is replaced.' },
  activeHoleId: 'evening-walk-hole',
  site: {
    bounds: { minX:-145,maxX:155,minZ:-410,maxZ:65 }, catalogVersion:2, placementAlgorithmVersion:1,
    biome:'temperate-maritime', groundCover:'native-grasslands', forestFloorAreas:[], biomeTransitions:[], environmentSeed:91842,
    surfaceMaterials: { ...structuredClone(DEFAULT_SURFACE_MATERIALS), turf:{...DEFAULT_SURFACE_MATERIALS.turf,saturation:.86,value:.86,roughnessBase:.82,specular:.38} },
    atmosphere:{climate:'temperate-maritime',season:'summer',localTime:'19:00',weather:'partly-cloudy',cloudCoverage:.14,windSpeedMph:4,windDirectionDegrees:250},
    routing:{clubhouse:point(48,-78),placements:[{holeId:'evening-walk-hole',origin:point(0,0),bearingDegrees:0}],transitions:[]},
    environment:{objectBudget:700, placements:[
      {id:'evening-walk-clubhouse',assetId:'grasslands-clubhouse',x:48,z:-78,rotationY:-.18,scale:1},
      ...[[-54,-140,.78],[46,-135,.8],[70,-153,.85]].map(([x,z,scale],i)=>({id:`evening-canopy-anchor-${i}`,assetId:'polyhaven-jacaranda-tree',x,z,scale,rotationY:i*1.731})),
      ...[[-78,-210,1],[-92,-265,.9],[79,-230,1.1],[-48,-344,1.1],[41,-367,1],[-106,-370,1],[110,-345,.9]].map(([x,z,scale],i)=>({id:`evening-broadleaf-${i}`,assetId:i%3===0?'polyhaven-island-tree-02':'polyhaven-island-tree-01',x,z,scale,rotationY:i*1.731})),
      ...[[-126,-374],[-115,-386],[-101,-390],[-88,-379],[-79,-393],[-64,-387],[-53,-396],[-39,-388],
        [42,-388],[54,-396],[66,-386],[77,-394],[88,-380],[100,-391],[116,-382],[128,-394]]
        .map(([x,z],i)=>({id:`evening-distant-copse-${i}`,assetId:i%3===0?'polyhaven-island-tree-02':'polyhaven-island-tree-01',x,z,scale:.92+(i%3)*.04,rotationY:i*1.731})),
    ],scatter:[],assembly:[],edgeDressing:[],exclusions:[],proceduralTreeDefinitions:[],proceduralTrees:[]},
  },
  holes:[{
    id:'evening-walk-hole',name:'Evening Walk',number:1,kind:'hole',par:4,seed:91842,
    route:{id:'evening-walk-route',points:[point(0,10),point(3,-70),point(-5,-170),point(12,-270),point(5,-340)],fairwayHalfWidth:6,roughWidth:4,fairwayStartMeters:94},
    tees:[
      {id:'evening-back-tee',label:'Back',x:0,z:10,boxHalfX:8,z0:0,z1:22},
      {id:'evening-middle-tee',label:'Middle',x:2,z:-26,boxHalfX:7,z0:-34,z1:-18},
      {id:'evening-forward-tee',label:'Forward',x:4,z:-60,boxHalfX:6,z0:-68,z1:-52},
    ],fringeWidth:1.7,
    greens:[{id:'evening-green',x:5,z:-340,yards:386,r:12,contour:'tilt',shape:[point(-8,-332),point(-7,-344),point(0,-352),point(12,-351),point(18,-342),point(15,-331),point(5,-327)]}],
    bunkers:[
      {id:'evening-drive-left',x:-19,z:-205,r:7,depth:.85,pot:false,shape:[point(-25,-199),point(-25,-205),point(-23,-210),point(-17,-213),point(-12,-205),point(-15,-199)]},
      {id:'evening-green-right',x:23,z:-337,r:6,depth:.8,pot:false,shape:[point(19,-330),point(18,-335),point(19,-339),point(25,-344),point(29,-339),point(28,-331)]},
    ],
    ponds:[{id:'evening-left-wetland',x:-47,z:-69,r:28,depth:1.5,shape:[point(-74,-41),point(-59,-48),point(-40,-45),point(-24,-60),point(-27,-86),point(-42,-101),point(-65,-95),point(-81,-70)]}],
    landforms:[
      landform('evening-broad-tee-ridge','shelf',0,14,32,3.2,20),
      landform('evening-middle-shelf','plateau',2,-26,12,1.3,13),
      landform('evening-front-shelf','plateau',4,-60,10,.5,11),
      landform('evening-clubhouse-pad','plateau',48,-78,27,.6,18),
      landform('evening-wetland-swale','swale',-49,-68,30,-1.2,38),
      landform('evening-left-ridge','ridge',-66,-220,38,2.4,70),
      landform('evening-approach-shoulder','shoulder',21,-311,26,1.1,48),
      landform('evening-far-left-copse-ridge','shelf',-95,-385,90,7,65),
      landform('evening-far-right-copse-ridge','shelf',90,-388,85,6,70),
    ],runtime:{corridor:{c0:6,k:.035,rough:4}},
  }],
};
// Hole-local coordinates keep the reference's right/left authoring frame. Turn
// the site 180 degrees in world space so its actual western evening sun appears
// on the viewer's right. This orientation/clock is inferred, not photo metadata.
project.site.bounds = {minX:-155,maxX:145,minZ:-65,maxZ:410};
project.site.routing.placements[0].bearingDegrees = 180;
project.site.routing.clubhouse = point(-48,78);
for (const placement of project.site.environment.placements) {
  placement.x *= -1;
  placement.z *= -1;
  placement.rotationY += Math.PI;
}
const { runtime, normalized } = compileActiveCourse(project);
await mkdir('courses', {recursive:true});
await mkdir('public/courses', {recursive:true});
await writeFile('courses/grasslands-reference.project.json',JSON.stringify(project,null,2)+'\n');
await writeFile('public/courses/grasslands-reference.json',JSON.stringify(runtime,null,2)+'\n');
console.log(JSON.stringify({name:runtime.meta.name, schema:runtime.meta.schema,objects:normalized.environment.objectCount}));
