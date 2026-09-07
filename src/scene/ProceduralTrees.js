import {
  Box3, Color, DoubleSide, Group, InstancedMesh, Matrix4, Object3D,
  SRGBColorSpace, TextureLoader, Vector3, Frustum, Sphere, RepeatWrapping, InstancedBufferAttribute,
} from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { compileTreeGeometry, unpackTreeGeometry } from '../trees/TreeGeometry.js';
export { compileTreeGeometry } from '../trees/TreeGeometry.js';
import { yieldToRendering } from '../util/yieldToRendering.js';
import { MeshStandardNodeMaterial, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, uniform, attribute, storage, uint, sin, cos, vec3, vec4, modelWorldMatrix, mrt, materialColor, normalWorld, uv, mx_noise_float, normalView, positionView, textureLoad, ivec2, int, mix } from 'three/tsl';
import { deriveSeed } from '../util/random.js';
import { estimateTreeCanopyRadius, normalizeTreeDefinition } from '../trees/TreeDefinition.js';
import { generateTreeSkeleton } from '../trees/TreeGenerator.js';
import { prepareTree } from '../trees/TreePreparation.js';
import { disposeWebGPUAttributes } from './WebGPUResourceDisposal.js';

export function proceduralTreeCanopyRadius(record, definitions) {
  const definition = definitions instanceof Map ? definitions.get(record?.definitionId)
    : definitions?.find?.((candidate) => candidate.id === record?.definitionId);
  if (!definition) throw new Error(`Missing procedural tree definition: ${record?.definitionId ?? 'missing'}`);
  return estimateTreeCanopyRadius(definition) * record.scale;
}

// Ground footprint of the trunk flare and its surface roots, in world metres. Grass
// is excluded inside this so blades do not sprout through solid wood; it is derived
// from the same numbers that build the flare, so the two cannot drift.
export function proceduralTreeFlareRadius(record, definitions) {
  const definition = definitions instanceof Map ? definitions.get(record?.definitionId)
    : definitions?.find?.((candidate) => candidate.id === record?.definitionId);
  if (!definition) throw new Error(`Missing procedural tree definition: ${record?.definitionId ?? 'missing'}`);
  const parameters = definition.parameters ?? {};
  const trunkRadius = (parameters.gScale ?? 0) * (parameters.ratio ?? 0);
  if (!(trunkRadius > 0)) return 0;
  // Only the flare, deliberately not the root spread. Grass does grow between
  // surface roots - the photographed runners have weeds all around them - so
  // clearing out to the root tips leaves an unnaturally bare disc. What has to be
  // cleared is the dense wood at the base, where a blade would sprout from solid
  // trunk; past that the runners are thin and mostly buried, and turf belongs.
  return trunkRadius * (1 + (parameters.flare ?? 0)) * (record.scale ?? 1);
}

// A generated tree is an explicit authored source. It never participates in the
// catalog resolver and therefore cannot mask a failed Poly Haven asset load.
export class ProceduralTreeForest {
  static async create(options = {}) {
    const textures = await loadDefinitionTextures(options.definitions, options.renderer);
    const prepared = new Map();
    try {
      for (const { definition, variant, key } of plantBatches(options.definitions, options.placements)) {
        const seed = deriveSeed(options.seed ?? 1, `${definition.id}:${variant}`);
        const result = await prepareTree(definition, seed, { signal: options.signal });
        const geometryTiers = [];
        for (const packed of result.tiers) { geometryTiers.push(unpackTreeGeometry(packed)); await yieldToRendering(); }
        prepared.set(key, { ...result, geometryTiers });
        options.signal?.throwIfAborted();
        await yieldToRendering();
      }
      const forest = new ProceduralTreeForest({ ...options, textures, prepared, deferBuild: true });
      try {
        for (const { definition, variant, records, key } of plantBatches([...forest.definitions.values()], forest.records)) {
          options.signal?.throwIfAborted();
          forest._buildBatch(definition, variant, records, textures, key); await yieldToRendering();
        }
        forest.update(options.camera, true); return forest;
      } catch (error) { forest.dispose(); throw error; }
    } catch (error) {
      for (const result of prepared.values()) for (const tier of result.geometryTiers) for (const geometry of Object.values(tier)) geometry.dispose();
      for (const texture of textures.values()) texture.dispose(); throw error;
    }
  }

  constructor({ definitions, placements, camera, terrain, renderer = null, textures = new Map(), seed = 1, prepared = new Map(), deferBuild = false, environment = null, motionHistory = null } = {}) {
    if (!Array.isArray(definitions) || !definitions.length || !Array.isArray(placements) || !placements.length || !camera || !terrain) throw new Error('ProceduralTreeForest requires definitions, placements, camera, and terrain.');
    this.prepared = prepared; this.environment = environment; this.motionHistory = motionHistory; this.frustum = new Frustum(); this.projection = new Matrix4(); this.sphere = new Sphere();
    this.assetId = 'procedural-tree'; this.camera = camera; this.seed = seed; this.renderer = renderer;
    this.definitions = new Map(definitions.map((definition) => { const normalized = normalizeTreeDefinition(definition); return [normalized.id, normalized]; }));
    this.records = placements.map((record, windIndex) => {
      const definition = this.definitions.get(record.definitionId);
      if (!definition) throw new Error(`Procedural tree placement "${record.id}" references missing definition "${record.definitionId}".`);
      return { ...record, windIndex, lifeBaked: Boolean(definition.plant), y: terrain.heightAt(record.x, record.z), band: 'near', variant: deriveSeed(record.seed, record.definitionId) % definition.variantCount };
    });
    if (environment) {
      this.windBuffer = new StorageBufferAttribute(this.records.length * 2, 4);
      this.windSamples = storage(this.windBuffer, 'vec4', this.records.length * 2).toReadOnly();
      this.windPosition = new Vector3(); this.windValue = new Vector3();
      this.windActive = uniform(0);
      this.previousWindActive = uniform(0);
    }
    this.rootSeating = buildRootSeating(terrain);
    this.group = new Group(); this.group.name = 'procedural-tree-beauty';
    this.shadowGroup = new Group(); this.shadowGroup.name = 'procedural-tree-stable-shadow'; this.shadowGroup.layers.set(1);
    this.batches = []; this.textures = new Set(textures.values()); this.policy = 'ultra';
    if (!deferBuild) for (const { definition, variant, records, key } of plantBatches([...this.definitions.values()], this.records)) this._buildBatch(definition, variant, records, textures, key);
    this.shadow = { mesh: this.shadowGroup, update() {}, dispose: () => this._disposeShadow() };
    this.update(camera, true);
  }

  _buildBatch(definition, variant, records, textures, key) {
    const prepared = this.prepared.get(key);
    const skeleton = prepared?.skeleton ?? generateTreeSkeleton(definition, { seed: deriveSeed(this.seed, `${definition.id}:${variant}`) });
    const tiers = prepared ? prepared.geometryTiers : [0, 1, 2].map(tier => compileTreeGeometry(skeleton, { radialSegments: Math.max(3, (definition.plant?.quality.radialSegments ?? 9) - tier * 3), leafStride: [1, 4, 12][tier], plant: definition.plant, includeRoots: tier === 0, branchTolerance: tier === 0 ? 0 : skeleton.bounds.size[1] / (tier === 1 ? 1200 : 360) }));
    this.prepared.delete(key);
    const bark = materialFor(definition.materials.bark, textures);
    if (definition.plant && !definition.materials.bark.textureUrl) {
      const spec = definition.plant.bark, coords = uv();
      const noise = mx_noise_float(coords.mul(vec3(8, 0.7, 0).xy));
      const ridges = sin(coords.x.mul(spec.ridgeFrequency * Math.PI * 2).add(noise.mul(4))).mul(0.5).add(0.5);
      bark.colorNode = materialColor.mul(ridges.mul(spec.variation).add(1 - spec.variation));
      if (!definition.materials.bark.normalUrl) {
        const height = ridges.mul(spec.ridgeDepth);
        const dx = positionView.dFdx(), dy = positionView.dFdy(), n = normalView;
        const rx = dy.cross(n), ry = n.cross(dx), determinant = dx.dot(rx);
        const gradient = rx.mul(height.dFdx()).add(ry.mul(height.dFdy())).mul(determinant.sign());
        bark.normalNode = n.mul(determinant.abs()).sub(gradient).normalize();
      }
    }
    const leaves = materialFor(definition.materials.leaves, textures, true);
    if (definition.plant) { const life = definition.plant.life; leaves.color.lerp(new Color('#b48035'), Math.min(1, life.season * 2) * life.deciduous * 0.85); leaves.color.lerp(new Color('#806b46'), 1 - life.health); }
    const blossoms = materialFor(definition.materials.blossoms, textures, true);
    const capacity = records.length;
    const draws = {};
    tiers.forEach((geometry, tier) => {
      for (const [part, material] of [['branches', bark], ['leaves', leaves], ['blossoms', blossoms]]) {
        const draw = instance(geometry[part], material, capacity, `${definition.id}-${variant}-lod${tier}-${part}`);
        draw.userData.tier = tier; draw.castShadow = false; draw.receiveShadow = true; draw.frustumCulled = false;
        draw.onBeforeRender = (_renderer, _scene, camera) => this.update(camera);
        draws[`${tier}:${part}`] = draw; this.group.add(draw);
      }
    });
    const shadows = {};
    for (const [part, spec] of [['branches', definition.materials.bark], ['leaves', definition.materials.leaves], ['blossoms', definition.materials.blossoms]]) {
      if (!tiers[1][part].attributes.position.count) continue;
      const material = materialFor(spec, textures, part !== 'branches');
      const draw = instance(tiers[1][part].clone(), material, capacity, `${definition.id}-${variant}-shadow-${part}`);
      draw.layers.set(1); draw.castShadow = true; draw.frustumCulled = false;
      shadows[part] = draw; this.shadowGroup.add(draw);
    }
    if (definition.plant && this.environment) {
      for (const draw of [...Object.values(draws), ...Object.values(shadows)]) {
        // WebGPU caps a pipeline at eight vertex buffers. Wind exposure, wind index
        // and yaw are all per-instance scalars, so they travel as one vec3 rather
        // than burning three buffer slots between them.
        for (const [name, size] of [['treeInstance', 3], ['treeOrigin', 3], ['treeScale', 3]]) draw.geometry.setAttribute(name, new InstancedBufferAttribute(new Float32Array(capacity * size), size));
        const settings = definition.plant.wind;
        const height = Math.max(0.1, skeleton.bounds.size[1]);
        const raw = attribute('position'), local = raw.mul(attribute('treeScale'));
        const treeInstance = attribute('treeInstance');
        const yaw = treeInstance.z, c = cos(yaw), s = sin(yaw);
        const placed = vec3(local.x.mul(c).add(local.z.mul(s)), local.y, local.z.mul(c).sub(local.x.mul(s))).add(attribute('treeOrigin'));
        // One geometry serves placements standing on entirely different slopes, so the
        // roots are seated per vertex against the terrain rather than being modelled
        // into the mesh. `rootBlend` is 0 everywhere on the trunk and foliage, so only
        // root stations move, easing in from the trunk collar to the tip.
        const rootBlend = attribute('rootBlend');
        const base = this.rootSeating
          ? vec3(placed.x, this.rootSeating(placed, rootBlend.x, rootBlend.y.mul(attribute('treeScale').y)), placed.z)
          : placed;
        const weight = raw.y.max(0).div(height).pow(2).mul(treeInstance.x).mul(settings.strength * (1 - settings.stiffness * 0.8));
        const foliage = !draw.name.endsWith('branches');
        const motion = (time, previous = false) => Fn(() => {
          const offset = vec3(0).toVar();
          If((previous ? this.previousWindActive : this.windActive).greaterThan(0.5), () => {
            const flow = this.windSamples.element(uint(treeInstance.y).mul(2).add(previous ? 1 : 0)).xyz;
            const flutter = sin(time.mul(3).add(raw.x.mul(7)).add(raw.y.mul(5))).mul(foliage ? settings.flutter : 0).mul(weight);
            offset.assign(flow.mul(weight).add(vec3(flutter, 0, flutter)));
          });
          return offset;
        })();
        const current = base.add(motion(this.environment.time));
        draw.material.positionNode = current;
        if (this.motionHistory && !draw.name.includes('-shadow-')) {
          const mh = this.motionHistory;
          const now = mh.currentProjection.mul(mh.currentView).mul(modelWorldMatrix).mul(vec4(current, 1));
          const previous = mh.previousProjection.mul(mh.previousView).mul(modelWorldMatrix).mul(vec4(base.add(motion(this.environment.previousTime, true)), 1));
          draw.material.mrtNode = mrt({ velocity: now.xy.div(now.w).sub(previous.xy.div(previous.w)).toVarying('vProceduralTreeVelocity') });
        }
        if (foliage) {
          const amount = definition.materials.leaves.translucency ?? 0.2;
          const backlight = normalWorld.dot(this.environment.keyDirection).negate().max(0).mul(this.environment.keyIlluminanceScale).mul(amount).clamp(0, 0.15);
          draw.material.colorNode = materialColor.mul(backlight.add(1));
        }

      }
    }
    // Coverage-compensated distant sprays can extend beyond the source skeleton.
    // Visibility must enclose every rendered tier, including independent shadows.
    const bounds = new Box3(new Vector3(...skeleton.bounds.min), new Vector3(...skeleton.bounds.max));
    for (const tier of tiers) for (const geometry of Object.values(tier)) bounds.union(geometry.boundingBox);
    const cullingSphere = bounds.getBoundingSphere(new Sphere());
    const batch = { definition, variant, records, skeleton, cullingSphere, draws, shadows, tiers, shadowTier: 1, generationMs: prepared?.generationMs ?? 0, cacheHit: prepared?.cacheHit ?? false };
    for (const draw of Object.values(shadows)) {
      draw.onBeforeShadow = (_renderer, _object, _camera, shadowCamera) => this._writeStableShadows(batch, shadowCamera);
    }
    this._writeStableShadows(batch); this.batches.push(batch);
  }

  _writeStableShadows(batch, camera = null) {
    const windMargin = (batch.definition.plant?.wind.strength ?? 0) * ((this.environment?.baseWind.value.length() ?? 0) * 3 + 4);
    const projection = camera && new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const signature = camera ? `${camera.uuid}:${projection.elements.join(',')}:${windMargin}` : '';
    if (camera && signature === batch.shadowSignature) return;
    batch.shadowSignature = signature;
    const frustum = camera && new Frustum().setFromProjectionMatrix(projection, camera.coordinateSystem);
    const sphere = new Sphere();
    const dummy = new Object3D();
    let count = 0;
    // ponytail: scan resident source records; use a spatial chunk index when
    // large-course streaming makes this CPU scan measurable.
    for (const record of batch.records) {
      setTreeTransform(dummy, record);
      sphere.copy(batch.cullingSphere).applyMatrix4(dummy.matrix);
      sphere.radius += windMargin;
      if (frustum && !frustum.intersectsSphere(sphere)) continue;
      for (const draw of Object.values(batch.shadows)) {
        draw.setMatrixAt(count, dummy.matrix);
        writePlantAttributes(draw, count, record, dummy);
      }
      count++;
    }
    for (const draw of Object.values(batch.shadows)) {
      draw.count = count; draw.instanceMatrix.needsUpdate = true;
      for (const [name, attribute] of Object.entries(draw.geometry.attributes)) if (name.startsWith('tree')) attribute.needsUpdate = true;
    }
  }

  update(camera = this.camera, force = false) {
    // Wind at the tree origin is identical for every vertex and shadow pass.
    // Reuse the existing CPU equivalent, retaining both times for motion vectors.
    if (this.windBuffer) {
      const signature = `${this.environment.time.value}:${this.environment.previousTime.value}`;
      if (force || signature !== this._windSignature || this._windState !== this.environment._frameState) {
        this._windSignature = signature;
        this._windState = this.environment._frameState;
        let active = false, previousActive = false;
        for (const record of this.records) {
          this.windPosition.set(record.x, record.y, record.z);
          for (let previous = 0; previous < 2; previous++) {
            this.environment.sampleWindCpu(this.windPosition, previous ? this.environment.previousTime.value : this.environment.time.value, this.windValue);
            if (previous) previousActive ||= this.windValue.lengthSq() > 0;
            else active ||= this.windValue.lengthSq() > 0;
            this.windBuffer.setXYZ(record.windIndex * 2 + previous, this.windValue.x, this.windValue.y, this.windValue.z);
          }
        }
        this.windBuffer.needsUpdate = true;
        // Gate each history sample independently so starting/stopping flutter
        // contributes to motion vectors.
        this.windActive.value = active ? 1 : 0;
        this.previousWindActive.value = previousActive ? 1 : 0;
      }
    }
    this.camera = camera;
    camera.updateMatrixWorld();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection, camera.coordinateSystem);
    const signature = `${this.projection.elements.join(',')}:${this.policy}:${this.renderer?.domElement?.height ?? 1080}`;
    if (!force && signature === this._signature) return;
    this._signature = signature;
    const dummy = new Object3D(), cameraPosition = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const viewportHeight = this.renderer?.domElement?.height ?? 1080;
    for (const batch of this.batches) {
      const counts = [0, 0, 0];
      for (const record of batch.records) {
        setTreeTransform(dummy, record);
        this.sphere.copy(batch.cullingSphere).applyMatrix4(dummy.matrix);
        this.sphere.radius += (batch.definition.plant?.wind.strength ?? 0) * ((this.environment?.baseWind.value.length() ?? 0) * 3 + 4);
        const distance = Math.max(0.1, cameraPosition.distanceTo(this.sphere.center));
        const pixels = batch.skeleton.bounds.size[1] * record.scale * viewportHeight * Math.abs(camera.projectionMatrix.elements[5]) / (camera.isOrthographicCamera ? 2 : 2 * distance);
        const quality = batch.definition.plant?.quality ?? { nearPixels: 300, farPixels: 90 };
        const detailScale = this.policy === 'battery' ? 2.5 : this.policy === 'balanced' ? 1.75 : 1;
        const nearPixels = quality.nearPixels * detailScale, farPixels = quality.farPixels * detailScale;
        let tier = this.policy === 'ultra' ? 0 : pixels >= nearPixels ? 0 : pixels >= farPixels ? 1 : 2;
        const previous = force ? tier : record.tier ?? tier;
        const boundary = tier > previous ? (previous === 0 ? nearPixels : farPixels) : (tier === 0 ? nearPixels : farPixels);
        if (tier !== previous && Math.abs(pixels - boundary) < boundary * 0.12) tier = previous;
        record.tier = tier; record.band = ['near', 'mid', 'far'][tier]; record.visible = this.frustum.intersectsSphere(this.sphere); record.pixels = pixels;
        if (!record.visible) continue;
        const target = counts[tier]++;
        for (const part of ['branches', 'leaves', 'blossoms']) {
          const draw = batch.draws[`${tier}:${part}`]; draw.setMatrixAt(target, dummy.matrix);
          writePlantAttributes(draw, target, record, dummy);
        }
      }
      for (const draw of Object.values(batch.draws)) { draw.count = counts[draw.userData.tier]; draw.instanceMatrix.needsUpdate = true; for (const [name, attribute] of Object.entries(draw.geometry.attributes)) if (name.startsWith('tree')) attribute.needsUpdate = true; }
    }
  }

  setWorkloadPolicy(policy = 'ultra') {
    this.policy = policy;
    const tier = policy === 'battery' || policy === 'balanced' ? 2 : 1;
    for (const batch of this.batches) {
      if (batch.shadowTier === tier) continue;
      for (const [part, draw] of Object.entries(batch.shadows)) {
        const previous = draw.geometry, next = batch.tiers[tier][part].clone();
        // Keep the complete, independently animated caster list when switching
        // topology; beauty-camera visibility never controls these instances.
        for (const [name, attribute] of Object.entries(previous.attributes)) {
          if (name.startsWith('tree')) next.setAttribute(name, attribute);
        }
        draw.geometry = next;
        previous.dispose();
      }
      batch.shadowTier = tier;
    }
    this.update(this.camera, true);
    return this.workloadDiagnostics();
  }
  workloadDiagnostics() {
    const draws = this.batches.flatMap(batch => Object.values(batch.draws));
    return {
      generatedSource: true, proceduralMaterials: true, sourceCount: this.records.length,
      windActive: Boolean(this.windActive?.value),
      near: this.records.filter(r => r.tier === 0).length, far: this.records.filter(r => r.tier > 0).length,
      visible: this.records.filter(r => r.visible).length, identities: this.batches.length,
      definitions: this.definitions.size, variants: this.batches.length,
      branches: this.batches.reduce((sum, b) => sum + b.skeleton.segments.length, 0), leaves: this.batches.reduce((sum, b) => sum + b.skeleton.leaves.length, 0),
      triangles: draws.reduce((sum, draw) => sum + geometryTriangles(draw.geometry) * draw.count, 0),
      bufferBytes: draws.reduce((sum, draw) => sum + Object.values(draw.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0) + (draw.geometry.index?.array.byteLength ?? 0), 0),
      generationMs: this.batches.reduce((sum, b) => sum + b.generationMs, 0),
      cacheHits: this.batches.filter(b => b.cacheHit).length,
      limitsReached: this.batches.flatMap(b => b.skeleton.diagnostics.limitsReached ?? []),
      drawCalls: draws.filter(d => d.count && d.geometry.attributes.position.count).length,
      shadowTriangles: this.batches.reduce((sum, batch) => sum + Object.values(batch.shadows).reduce((n, draw) => n + geometryTriangles(draw.geometry) * draw.count, 0), 0),
      shadowTier: this.batches[0]?.shadowTier ?? null,
      shadowDrawCalls: this.batches.reduce((n, b) => n + Object.keys(b.shadows).length, 0),
      reductionSupported: true, sourceRecordsKept: true, completeTreeResidency: true,
    };
  }
  residencyEstimate() {
    return { assetId: this.assetId, ...this.workloadDiagnostics(), counts: { lod0: this.records.filter(r => r.tier === 0).length, lod1: this.records.filter(r => r.tier === 1).length, lod2: this.records.filter(r => r.tier === 2).length, impostor: 0, rejected: 0 }, projectedHeights: this.records.map(r => r.pixels), forcedFullLod: this.policy === 'ultra', transitionCount: 0, classificationComplete: true };
  }

  async readDiagnostics() { return this.workloadDiagnostics(); }
  dispose() {
    if (this._disposed) return; this._disposed = true;
    const materials = new Set();
    for (const batch of this.batches) for (const draw of Object.values(batch.draws)) { draw.geometry.dispose(); materials.add(draw.material); }
    for (const material of materials) { for (const texture of material.userData.ownedTextures ?? []) texture.dispose(); material.dispose(); }
    this._disposeShadow(); for (const texture of this.textures) texture.dispose();
    if (this.windBuffer) disposeWebGPUAttributes(this.renderer, [this.windBuffer]);
  }
  _disposeShadow() { if (this._shadowDisposed) return; this._shadowDisposed = true; for (const batch of this.batches) for (const draw of Object.values(batch.shadows)) { draw.geometry.dispose(); for (const texture of draw.material.userData.ownedTextures ?? []) texture.dispose(); draw.material.dispose(); } }
}

async function loadDefinitionTextures(definitions = [], renderer) {
  const urls = [...new Set(definitions.flatMap((definition) => Object.values(definition.materials ?? {}).flatMap(spec => ['textureUrl', 'normalUrl', 'roughnessUrl', 'aoUrl'].map(key => spec[key]))).filter(Boolean))];
  if (!urls.length) return new Map();
  const pngLoader = new TextureLoader();
  const ktxLoader = new KTX2Loader().setTranscoderPath('/assets/transcoders/basis/');
  if (urls.some((url) => url.endsWith('.ktx2'))) {
    if (!renderer) throw new Error('KTX2 procedural leaf textures require the production renderer.');
    ktxLoader.detectSupport(renderer);
  }
  try {
    const results = await Promise.allSettled(urls.map(async (url) => {
      const texture = url.endsWith('.ktx2') ? await ktxLoader.loadAsync(url) : await pngLoader.loadAsync(url);
      texture.colorSpace = definitions.some(d => Object.values(d.materials).some(m => m.textureUrl === url)) ? SRGBColorSpace : ''; texture.name = `procedural-tree:${url}`; return [url, texture];
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) { for (const result of results) if (result.status === 'fulfilled') result.value[1].dispose(); throw failure.reason; }
    return new Map(results.map(result => result.value));
  } finally { ktxLoader.dispose(); }
}

function materialFor(spec, textures, alpha = false) {
  const material = new MeshStandardNodeMaterial({ color: new Color(spec.color), roughness: spec.roughness, metalness: 0, vertexColors: alpha, ...(alpha && spec.doubleSided !== false ? { side: DoubleSide } : {}) });
  const texture = textures.get(spec.textureUrl); if (texture) material.map = texture;
  if (alpha && texture) { material.transparent = false; material.alphaTest = spec.alphaCutoff ?? 0.32; }
  for (const [key, slot] of [['normalUrl', 'normalMap'], ['roughnessUrl', 'roughnessMap'], ['aoUrl', 'aoMap']]) if (textures.has(spec[key])) material[slot] = textures.get(spec[key]);
  if (spec.textureScale) {
    material.userData.ownedTextures = [];
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap']) if (material[slot]) {
      const copy = material[slot].clone(); copy.wrapS = copy.wrapT = RepeatWrapping; copy.repeat.setScalar(spec.textureScale);
      material[slot] = copy; material.userData.ownedTextures.push(copy);
    }
  }
  return material;
}

// Roots have to lie on the surface each tree actually stands on, and one shared
// geometry cannot be modelled for every slope. Terrain owns the authoritative GPU
// height image (Grass samples the same one), so the seat is resolved per vertex here
// with the bilinear filter that matches the CPU heightfield used by physics.
const ROOT_EMBED_M = 0.04;
function buildRootSeating(terrain) {
  const heightTex = terrain?.heightTexture;
  if (!heightTex || !terrain.nx || !terrain.nz) return null;
  const { minX, minZ, maxX, maxZ } = terrain.bounds;
  const sizeX = maxX - minX, sizeZ = maxZ - minZ;
  const load = (x, z) => textureLoad(heightTex, ivec2(int(x), int(z))).x;
  return (world, blend, surface) => {
    const gx = world.x.sub(minX).div(sizeX).mul(terrain.nx - 1).clamp(0, terrain.nx - 1.001);
    const gz = world.z.sub(minZ).div(sizeZ).mul(terrain.nz - 1).clamp(0, terrain.nz - 1.001);
    const ix = gx.floor(), iz = gz.floor();
    const fx = gx.sub(ix), fz = gz.sub(iz);
    const ground = mix(
      mix(load(ix, iz), load(ix.add(1), iz), fx),
      mix(load(ix, iz.add(1)), load(ix.add(1), iz.add(1)), fx), fz);
    // Seat to the surface plus the station's own emergence offset, so a root is
    // buried for stretches and breaks through between them instead of being laid
    // whole on top of the turf.
    return mix(world.y, ground.sub(ROOT_EMBED_M).add(surface), blend.clamp(0, 1));
  };
}

function instance(geometry, material, capacity, name) { const mesh = new InstancedMesh(geometry, material, Math.max(1, capacity)); mesh.name = name; mesh.count = 0; mesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0; return mesh; }
function setTreeTransform(dummy, record) { const maturity = record.lifeBaked ? 1 : 0.62 + record.age * 0.38, health = record.lifeBaked ? 1 : 0.82 + record.health * 0.18; dummy.position.set(record.x, record.y, record.z); dummy.rotation.set(0, record.rotationY, 0); dummy.scale.set(record.scale * health, record.scale * maturity, record.scale * health); dummy.updateMatrix(); }
function geometryTriangles(geometry) { return geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count ?? 0) / 3; }

function writePlantAttributes(draw, index, record, dummy) {
  const a = draw.geometry.attributes; if (!a.treeInstance) return;
  a.treeInstance.setXYZ(index, record.windExposure, record.windIndex, record.rotationY);
  a.treeOrigin.setXYZ(index, record.x, record.y, record.z); a.treeScale.setXYZ(index, dummy.scale.x, dummy.scale.y, dummy.scale.z);
}

// Three authored ages and two health states, shared across all placements.
// Seeds stay independent of life stage so a sapling retains its branch identity.
function plantBatches(definitions, placements) {
  const groups = new Map(), byId = new Map(definitions.map(d => [d.id, d]));
  for (const record of placements) {
    const source = byId.get(record.definitionId);
    if (!source) throw new Error(`Missing plant definition ${record.definitionId}`);
    const variant = deriveSeed(record.seed, record.definitionId) % source.variantCount;
    const age = source.plant ? Math.round(record.age * 2) / 2 : 1;
    const health = source.plant && record.health < 0.7 ? 0.5 : 1;
    const key = `${source.id}:${variant}:${age}:${health}`;
    if (!groups.has(key)) {
      const definition = structuredClone(source);
      if (definition.plant) { definition.plant.life.age *= age; definition.plant.life.health *= health; }
      groups.set(key, { key, definition, variant, records: [] });
    }
    groups.get(key).records.push(record);
  }
  return groups.values();
}
