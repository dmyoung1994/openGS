import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, OrthographicCamera } from 'three';
import { TREE_PRESETS, createTreePreset } from '../src/trees/TreePresets.js';
import { normalizeTreeDefinition } from '../src/trees/TreeDefinition.js';
import { generateTreeSkeleton } from '../src/trees/TreeGenerator.js';
import { compileTreeGeometry, packTreeGeometry, unpackTreeGeometry } from '../src/trees/TreeGeometry.js';
import { ProceduralTreeForest } from '../src/scene/ProceduralTrees.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePlantAsset } from '../scripts/lib/plant-library.mjs';
import { png } from '../scripts/lib/png.mjs';
import { CourseAgentService } from '../scripts/course-agent-service.mjs';

test('all plant families produce finite bounded geometry and independent foliage seeds', () => {
  for (const name of TREE_PRESETS) {
    const definition = createTreePreset(name), skeleton = generateTreeSkeleton(definition);
    assert.deepEqual(skeleton, generateTreeSkeleton(definition));
    assert.equal(skeleton.diagnostics.limitsReached.length, 0, name);
    assert.ok(skeleton.segments.length > 10); assert.ok(skeleton.leaves.length > 10);
    const edited = structuredClone(definition); edited.parameters.leaves.count = 10;
    assert.deepEqual(generateTreeSkeleton(edited).segments, skeleton.segments, 'foliage cannot reshuffle structure');
    const parents = new Set(skeleton.segments.map(s => s.id));
    for (const segment of skeleton.segments) if (segment.parent) assert.ok(parents.has(segment.parent));
    const geometry = compileTreeGeometry(skeleton, { plant: definition.plant });
    const unpacked = unpackTreeGeometry(packTreeGeometry(geometry));
    for (const [part, mesh] of Object.entries(geometry)) {
      assert.deepEqual(unpacked[part].attributes.position.array, mesh.attributes.position.array);
      for (const attribute of Object.values(mesh.attributes)) assert.ok(attribute.array.every(Number.isFinite), `${name}/${part}`);
      if (mesh.index.count) assert.ok(mesh.index.array.every(i => i < mesh.attributes.position.count));
      mesh.dispose(); unpacked[part].dispose();
    }
    const winter = structuredClone(definition); winter.plant.life.deciduous = 1; winter.plant.life.season = 1;
    assert.equal(generateTreeSkeleton(winter).leaves.length, 0);
  }
});

test('plant profiles, settings, and versions reject invalid authoring input', () => {
  const d = structuredClone(createTreePreset()); d.plant.profiles.length = [[0, 1], [0, 2]];
  assert.throws(() => normalizeTreeDefinition(d), /profile/i);
  d.plant = { wind: { stiffness: NaN } }; assert.throws(() => normalizeTreeDefinition(d), /stiffness/);
  d.plant = {}; delete d.version; assert.throws(() => normalizeTreeDefinition(d), /version/);
});

test('mature pine retains substantial wood and crown within its mesh budget', () => {
  for (const seed of [1, 2, 3]) {
    const definition = createTreePreset('tall-pine', seed), skeleton = generateTreeSkeleton(definition);
    const trunk = skeleton.segments.find(s => s.level === 0 && s.role !== 'root');
    assert.ok(trunk.radius0 > 1, 'mature pine needs a substantial flared base');
    assert.ok(skeleton.bounds.size[0] > 14 && skeleton.bounds.size[2] > 14, 'crown must carry lateral mass');
    assert.equal(skeleton.stemCount, 235, 'fullness must not multiply branch topology');
    assert.ok(skeleton.leaves.length <= 3200);
    const geometry = compileTreeGeometry(skeleton, { plant: definition.plant });
    assert.ok(Object.values(geometry).reduce((n, mesh) => n + mesh.index.count / 3, 0) < 53000);
    for (const mesh of Object.values(geometry)) mesh.dispose();
  }
});

test('plant LOD follows the camera and preserves offscreen shadow casters', () => {
  const definition = createTreePreset();
  const camera = new PerspectiveCamera(45, 1, 0.1, 2000); camera.position.set(0, 5, 25); camera.lookAt(0, 7, 0);
  const forest = new ProceduralTreeForest({ definitions: [definition], placements: [{ id: 'test-plant', definitionId: definition.id, x: 0, z: 0, rotationY: 0, scale: 1, age: 1, health: 1, windExposure: 0.5, seed: 1 }], camera, terrain: { heightAt: () => 0 } });
  const qualityShadows = forest.workloadDiagnostics().shadowTriangles;
  forest.setWorkloadPolicy('balanced'); const close = forest.workloadDiagnostics(); assert.equal(close.visible, 1);
  assert.equal(close.shadowTier, 2); assert.ok(close.shadowTriangles < qualityShadows);
  forest.setWorkloadPolicy('quality'); assert.equal(forest.workloadDiagnostics().shadowTriangles, qualityShadows);
  forest.setWorkloadPolicy('balanced');
  camera.position.set(0, 5, 500); camera.lookAt(0, 7, 0); forest.update(camera);
  assert.equal(forest.residencyEstimate().counts.lod2, 1); assert.ok(forest.workloadDiagnostics().triangles < close.triangles);
  camera.lookAt(0, 5, 1000); forest.update(camera); assert.equal(forest.workloadDiagnostics().visible, 0);
  assert.ok(forest.shadow.mesh.children.every(draw => draw.count === 1));
  const shadowCamera = new OrthographicCamera(-30, 30, 30, -30, 0.1, 200);
  shadowCamera.position.set(0, 60, 0); shadowCamera.lookAt(0, 0, 0); shadowCamera.updateMatrixWorld();
  const draw = forest.shadow.mesh.children[0];
  draw.onBeforeShadow(null, draw, camera, shadowCamera);
  assert.equal(draw.count, 1, 'offscreen beauty caster remains in the shadow camera');
  shadowCamera.position.x = 500; shadowCamera.lookAt(500, 0, 0); shadowCamera.updateMatrixWorld();
  draw.onBeforeShadow(null, draw, camera, shadowCamera);
  assert.equal(draw.count, 0, 'unrelated shadow region skips the caster');
  shadowCamera.position.x = 0; shadowCamera.lookAt(0, 0, 0); shadowCamera.updateMatrixWorld();
  draw.onBeforeShadow(null, draw, camera, shadowCamera);
  assert.equal(draw.count, 1, 'a later cascade restores its own caster list');
  const bounds = forest.batches[0].skeleton.bounds;
  const distance = bounds.size[1] * 1080 * Math.abs(camera.projectionMatrix.elements[5]) / (2 * 400);
  camera.position.set(bounds.center[0], bounds.center[1], bounds.center[2] + distance);
  camera.lookAt(...bounds.center);
  forest.setWorkloadPolicy('quality');
  assert.equal(forest.residencyEstimate().counts.lod0, 1);
  const detailedTriangles = forest.workloadDiagnostics().triangles;
  forest.setWorkloadPolicy('battery');
  assert.equal(forest.residencyEstimate().counts.lod1, 1);
  assert.ok(forest.workloadDiagnostics().triangles < detailedTriangles);
  assert.equal(forest.workloadDiagnostics().sourceCount, 1);
  forest.dispose();
});

test('plant library round-trips editable definitions and preserves originals', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plant-library-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public/assets/procedural-trees'), { recursive: true });
  await writeFile(join(root, 'public/assets/procedural-trees/catalog.json'), JSON.stringify({ version: 1, catalogId: 'claude-golfsim-procedural-trees', assets: [] }));
  const definition = createTreePreset('palm');
  const thumbnail = `data:image/png;base64,${png(2, 2, 4, Buffer.alloc(16, 255)).toString('base64')}`;
  await savePlantAsset(root, { definition, thumbnail });
  const changed = structuredClone(definition); changed.seed++;
  const revisedThumbnail = `data:image/png;base64,${png(2, 2, 4, Buffer.alloc(16, 128)).toString('base64')}`;
  const saved = await savePlantAsset(root, { definition: changed, thumbnail: revisedThumbnail });
  const directory = join(root, 'public/assets/procedural-trees/palm');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'definition.json'))), changed);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'definition.original.json'))), definition);
  assert.equal((await readFile(join(directory, 'reference.png'))).toString('base64'), thumbnail.split(',')[1]);
  assert.equal((await readFile(join(directory, 'thumbnail.png'))).toString('base64'), revisedThumbnail.split(',')[1]);
  assert.match(saved.thumbnailUrl, /palm\/thumbnail.png$/);
  await assert.rejects(savePlantAsset(root, { definition, thumbnail: 'data:image/png;base64,AAAA' }), /dimensions/);
});

test('forest shares current and previous wind samples across draws', () => {
  let samples = 0;
  const environment = { time: { value: 2 }, previousTime: { value: 1 },
    sampleWindCpu: (p, time, out) => { samples++; return out.set(p.x + time, p.y, p.z); } };
  const definition = createTreePreset('tall-pine');
  const forest = new ProceduralTreeForest({ definitions: [definition],
    placements: [{ definitionId: definition.id, x: 3, z: 4, seed: 1 }],
    camera: new PerspectiveCamera(), terrain: { heightAt: () => 5 }, environment, deferBuild: true });
  forest.update(); forest.update();
  assert.equal(samples, 2);
  assert.deepEqual([...forest.windBuffer.array], [5, 5, 4, 0, 4, 5, 4, 0]);
  environment.time.value = 3; environment.previousTime.value = 2;
  forest.update();
  assert.equal(samples, 4);
  assert.deepEqual([...forest.windBuffer.array], [6, 5, 4, 0, 5, 5, 4, 0]);
});

test('needle geometry retains length, width and bend with two nondegenerate triangles', () => {
  const geometry = compileTreeGeometry({ segments: [], blossoms: [], leaves: [{
    position: [0, 0, 0], direction: [0, 1, 0], scale: 1, scaleX: 0.2,
    bend: 0.3, shape: 'needle',
  }] }).leaves;
  assert.equal(geometry.attributes.position.count, 4);
  assert.equal(geometry.index.count, 6);
  const p = geometry.attributes.position;
  assert.ok(Math.abs(p.getY(3) - p.getY(0) - 2) < 1e-6);
  assert.ok(Math.abs(Math.hypot(p.getX(1) - p.getX(2), p.getZ(1) - p.getZ(2)) - 0.3) < 1e-6);
  assert.ok(Math.abs(Math.hypot(p.getX(3), p.getZ(3)) - 0.6) < 1e-6);
  for (let i = 0; i < 4; i++) {
    const n = geometry.attributes.normal;
    assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-6);
  }
});

test('geometry budgets fail before allocating an oversized plant', () => {
  const d = structuredClone(createTreePreset()); d.parameters.leaves.count = 24000; d.parameters.leaves.shape = 'pinnate'; d.plant.foliage.leaflets = 24;
  assert.throws(() => compileTreeGeometry(generateTreeSkeleton(d)), /million vertices/);
});

test('plant placement uses course history and rejects stale revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plant-placement-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = JSON.parse(await readFile(new URL('../course.project.json', import.meta.url)));
  await writeFile(join(root, 'course.project.json'), JSON.stringify(project));
  const service = new CourseAgentService({ root });
  const before = await service.state();
  const bounds = before.project.site.bounds;
  const body = { definition: createTreePreset('multi-stem-shrub'), x: bounds.minX + 20, z: bounds.minZ + 20, baseRevision: before.revision };
  await service.plantAction('place', body);
  const placed = await service.state();
  assert.equal(placed.project.site.environment.proceduralTrees.length, before.project.site.environment.proceduralTrees.length + 1);
  await assert.rejects(service.plantAction('place', body), /changed/);
  await service.undo();
  assert.deepEqual((await service.state()).project, before.project);
});
