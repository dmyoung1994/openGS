import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyCourseMutations, compileActiveCourse } from '../src/course/CourseProject.js';
import { normalizeCourse } from '../src/course/course.js';
import { transformLocalPoint } from '../src/course/RouteGeometry.js';
import { semanticLandformHeight, greenGradeHeight } from '../src/course/SemanticLandforms.js';
const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url), 'utf8'));

test('green-owned contours survive semantic editing and transform with their hole', () => {
  const hole = project.holes[0], green = structuredClone(hole.greens[0]);
  green.contours = [{ kind:'plateau', points:[{x:green.x,z:green.z}], width:8, height:0.3, falloff:6 }];
  const changed = applyCourseMutations(project, [{op:'replace',entityType:'green',entityId:green.id,parentId:hole.id,value:green}]);
  assert.deepEqual(changed.holes[1], project.holes[1]);
  const { runtime, normalized } = compileActiveCourse(changed);
  const placement = project.site.routing.placements.find(p=>p.holeId===hole.id);
  const point = transformLocalPoint(green.contours[0].points[0], placement);
  assert.deepEqual(runtime.greens[0].contours[0].points[0], point);
  assert.equal(semanticLandformHeight(normalized.greens[0].contours,point.x,point.z),0.3);
  assert.equal(semanticLandformHeight(normalized.greens[0].contours,point.x+11,point.z),0);
  assert.deepEqual(normalizeCourse(runtime).greens[0].contours, normalized.greens[0].contours);
});

test('intricate green outlines remain smooth and reject invalid authoring inputs', () => {
  const { runtime } = compileActiveCourse(project);
  const g=runtime.greens[0];
  // Thirty-two controls and deep concave waists exceeded the old circular envelope.
  g.shape=Array.from({length:32},(_,i)=>{const a=i*Math.PI/16,r=g.r*(0.8+0.55*Math.cos(2*a));return {x:g.x+r*Math.cos(a),z:g.z+r*Math.sin(a)};});
  const normalized=normalizeCourse(runtime).greens[0];
  assert.equal(normalized.shape.length,384);
  const bad=structuredClone(runtime);[bad.greens[0].shape[3],bad.greens[0].shape[18]]=[bad.greens[0].shape[18],bad.greens[0].shape[3]];
  assert.throws(()=>normalizeCourse(bad),/self-intersect/);
  for(const contours of [Array(13).fill({}),[{kind:'plateau',points:[{x:g.x,z:g.z}],width:8,height:4,falloff:6}]]){
    const bad=structuredClone(runtime);bad.greens[0].contours=contours;
    assert.throws(()=>normalizeCourse(bad),/at most 12|height/);
  }
});

test('explicit green grade is a continuous plane, rotates with routing and rejects excessive slopes', () => {
  const green={x:0,z:0,r:10,grade:{slopeX:0.01,slopeZ:-0.005,blend:8}};
  assert.equal(greenGradeHeight(green,2,7,2,4),2);
  assert.equal(greenGradeHeight(green,2,7,20,0),7);
  const inside=greenGradeHeight(green,2,7,10-1e-5,0);
  const outside=greenGradeHeight(green,2,7,10+1e-5,0);
  assert.ok(Math.abs(inside-outside)<1e-5);
  const p=structuredClone(project),g=p.holes[0].greens[0];
  g.grade={slopeX:0.04,slopeZ:0.04,blend:8};
  const compiled=compileActiveCourse(p).runtime.greens[0];
  assert.ok(Math.abs(Math.hypot(compiled.grade.slopeX,compiled.grade.slopeZ)-Math.hypot(.04,.04))<1e-12);
  g.grade.slopeX=0.06;
  assert.throws(()=>compileActiveCourse(p),/total slope/);
});
