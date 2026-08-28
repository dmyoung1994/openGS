import {
  Group, InstancedMesh, Object3D, CylinderGeometry, ConeGeometry, IcosahedronGeometry,
  MeshStandardMaterial, MeshBasicMaterial, Color, DoubleSide,
} from 'three';
import { createRng, deriveSeed } from '../util/random.js';

const ARCHETYPES = Object.freeze({
  'broadleaf-oak': { height: 17, trunk: 0.58, crown: [6.6, 4.9, 6.2], bark: 0x4a3828, leaf: 0x31582e, form: 'broadleaf' },
  'live-oak': { height: 15, trunk: 0.68, crown: [8.2, 4.4, 7.1], bark: 0x4b3a2b, leaf: 0x2d552f, form: 'broadleaf' },
  maple: { height: 18, trunk: 0.52, crown: [6.2, 6.3, 5.8], bark: 0x51443a, leaf: 0x376733, form: 'broadleaf' },
  'monterey-cypress': { height: 16, trunk: 0.58, crown: [5.8, 7.5, 4.8], bark: 0x50402f, leaf: 0x274b36, form: 'cypress' },
  'douglas-fir': { height: 23, trunk: 0.50, crown: [5.2, 15.5, 5.2], bark: 0x59402c, leaf: 0x244b38, form: 'conifer' },
  'loblolly-pine': { height: 24, trunk: 0.48, crown: [5.6, 12.5, 5.6], bark: 0x68462c, leaf: 0x31573b, form: 'conifer' },
});
const POLICY_DISTANCE = Object.freeze({ battery: 55, balanced: 75, quality: 100, ultra: 125 });

export function proceduralTreeCanopyRadius(record) {
  const spec = ARCHETYPES[record?.archetype];
  if (!spec) throw new Error(`Unsupported synthetic tree archetype: ${record?.archetype ?? 'missing'}`);
  return Math.max(spec.crown[0], spec.crown[2]) * record.scale;
}

// Explicit synthetic-tree source. It never participates in catalog resolution and
// therefore cannot silently replace a failed GLB. All surface variation is geometry
// or deterministic material colour; no photographic or generated texture is used.
export class ProceduralTreeForest {
  constructor({ placements, camera, terrain, seed = 1 } = {}) {
    if (!Array.isArray(placements) || !placements.length || !camera || !terrain) throw new Error('ProceduralTreeForest requires placements, camera, and terrain.');
    this.assetId = 'synthetic-tree'; this.camera = camera; this.seed = seed; this.records = placements.map((record) => ({
      ...record, y: terrain.heightAt(record.x, record.z), band: 'near',
    }));
    this.group = new Group(); this.group.name = 'synthetic-tree-beauty';
    this.shadowGroup = new Group(); this.shadowGroup.name = 'synthetic-tree-stable-shadow'; this.shadowGroup.layers.set(1);
    this.batches = []; this.policy = 'ultra';
    for (const archetype of Object.keys(ARCHETYPES)) {
      const records = this.records.filter((record) => record.archetype === archetype);
      if (records.length) this._buildBatch(archetype, records);
    }
    this.shadow = {
      mesh: this.shadowGroup,
      update() {},
      dispose: () => this._disposeShadow(),
    };
    this.update(camera, true);
  }

  _buildBatch(archetype, records) {
    const spec = ARCHETYPES[archetype]; const broadleaf = spec.form === 'broadleaf';
    const crownParts = broadleaf ? 3 : spec.form === 'cypress' ? 2 : 3;
    const trunkNearGeometry = barkGeometry(spec, deriveSeed(this.seed, `${archetype}:bark`), 16, 10);
    const trunkFarGeometry = barkGeometry(spec, deriveSeed(this.seed, `${archetype}:far-bark`), 8, 2);
    const crownNearGeometry = crownGeometry(spec, false); const crownFarGeometry = crownGeometry(spec, true);
    const barkMaterial = new MeshStandardMaterial({ color: spec.bark, roughness: 0.96, metalness: 0 });
    const barkFarMaterial = barkMaterial.clone(); barkFarMaterial.color.offsetHSL(0, -0.04, -0.025);
    const foliageMaterial = new MeshStandardMaterial({ color: spec.leaf, roughness: 0.91, metalness: 0, side: DoubleSide });
    const foliageFarMaterial = foliageMaterial.clone(); foliageFarMaterial.color.offsetHSL(0, -0.06, -0.02);
    const nearTrunks = mesh(trunkNearGeometry, barkMaterial, records.length, `${archetype}-synthetic-near-trunks`);
    const nearCrowns = mesh(crownNearGeometry, foliageMaterial, records.length * crownParts, `${archetype}-synthetic-near-crowns`);
    const farTrunks = mesh(trunkFarGeometry, barkFarMaterial, records.length, `${archetype}-synthetic-far-trunks`);
    const farCrowns = mesh(crownFarGeometry, foliageFarMaterial, records.length, `${archetype}-synthetic-far-crowns`);
    for (const draw of [nearTrunks, nearCrowns, farTrunks, farCrowns]) { draw.castShadow = false; draw.receiveShadow = true; draw.frustumCulled = false; this.group.add(draw); }

    // Stable shadow residency is intentionally camera-independent. A simplified
    // connected crown and trunk remain in the light-owned layer through all beauty
    // LOD transitions, eliminating camera/ball-flight shadow popping.
    const shadowMaterial = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
    const shadowTrunks = mesh(trunkFarGeometry.clone(), shadowMaterial, records.length, `${archetype}-synthetic-shadow-trunks`);
    const shadowCrowns = mesh(crownFarGeometry.clone(), shadowMaterial.clone(), records.length, `${archetype}-synthetic-shadow-crowns`);
    for (const draw of [shadowTrunks, shadowCrowns]) { draw.layers.set(1); draw.castShadow = true; draw.receiveShadow = false; draw.frustumCulled = false; this.shadowGroup.add(draw); }
    const batch = { archetype, spec, records, crownParts, nearTrunks, nearCrowns, farTrunks, farCrowns, shadowTrunks, shadowCrowns };
    this._writeStableShadows(batch); this.batches.push(batch);
  }

  _writeStableShadows(batch) {
    const dummy = new Object3D(); const { spec } = batch;
    batch.records.forEach((record, index) => {
      const dimensions = treeDimensions(spec, record);
      setTransform(dummy, record, [dimensions.trunkScale, dimensions.height, dimensions.trunkScale], dimensions.height * 0.5);
      batch.shadowTrunks.setMatrixAt(index, dummy.matrix);
      setTransform(dummy, record, dimensions.crownScale, dimensions.crownY);
      batch.shadowCrowns.setMatrixAt(index, dummy.matrix);
    });
    batch.shadowTrunks.instanceMatrix.needsUpdate = true; batch.shadowCrowns.instanceMatrix.needsUpdate = true;
  }

  update(camera = this.camera, force = false) {
    this.camera = camera; const threshold = POLICY_DISTANCE[this.policy] ?? POLICY_DISTANCE.ultra; const hysteresis = 10;
    for (const batch of this.batches) {
      let nearTree = 0, nearCrown = 0, farTree = 0; const dummy = new Object3D();
      for (const record of batch.records) {
        const distance = Math.hypot(record.x - camera.position.x, record.y - camera.position.y, record.z - camera.position.z);
        if (force || (record.band === 'near' ? distance > threshold + hysteresis : distance < threshold - hysteresis)) record.band = distance <= threshold ? 'near' : 'far';
        const dimensions = treeDimensions(batch.spec, record);
        if (record.band === 'near') {
          setTransform(dummy, record, [dimensions.trunkScale, dimensions.height, dimensions.trunkScale], dimensions.height * 0.5);
          batch.nearTrunks.setMatrixAt(nearTree++, dummy.matrix);
          for (let part = 0; part < batch.crownParts; part += 1) {
            const jitter = crownPart(batch.spec, record, part, batch.crownParts);
            setTransform(dummy, { ...record, x: record.x + jitter.x, z: record.z + jitter.z }, jitter.scale, dimensions.crownY + jitter.y);
            batch.nearCrowns.setMatrixAt(nearCrown++, dummy.matrix);
          }
        } else {
          setTransform(dummy, record, [dimensions.trunkScale, dimensions.height, dimensions.trunkScale], dimensions.height * 0.5);
          batch.farTrunks.setMatrixAt(farTree, dummy.matrix);
          setTransform(dummy, record, dimensions.crownScale, dimensions.crownY);
          batch.farCrowns.setMatrixAt(farTree++, dummy.matrix);
        }
      }
      batch.nearTrunks.count = nearTree; batch.nearCrowns.count = nearCrown; batch.farTrunks.count = farTree; batch.farCrowns.count = farTree;
      for (const draw of [batch.nearTrunks, batch.nearCrowns, batch.farTrunks, batch.farCrowns]) draw.instanceMatrix.needsUpdate = true;
    }
  }

  setWorkloadPolicy(policy = 'ultra') { this.policy = typeof policy === 'string' && POLICY_DISTANCE[policy] ? policy : 'ultra'; this.update(this.camera, true); return this.workloadDiagnostics(); }
  workloadDiagnostics() {
    const near = this.records.filter((record) => record.band === 'near').length;
    return { generatedSource: true, proceduralMaterials: true, sourceCount: this.records.length, near, far: this.records.length - near, identities: this.batches.length, drawCalls: this.batches.length * 4, shadowDrawCalls: this.batches.length * 2, reductionSupported: true, sourceRecordsKept: true, lodHysteresisMeters: 10 };
  }
  residencyEstimate() { const diagnostics = this.workloadDiagnostics(); return { assetId: this.assetId, sourceCount: diagnostics.sourceCount, counts: { lod0: diagnostics.near, lod1: diagnostics.far, impostor: 0, rejected: 0 }, projectedHeights: [], forcedFullLod: false, transitionCount: 0, classificationComplete: true }; }
  async readDiagnostics() { return this.workloadDiagnostics(); }
  dispose() { for (const batch of this.batches) for (const draw of [batch.nearTrunks, batch.nearCrowns, batch.farTrunks, batch.farCrowns]) { draw.geometry.dispose(); draw.material.dispose(); } this._disposeShadow(); }
  _disposeShadow() { if (this._shadowDisposed) return; this._shadowDisposed = true; for (const batch of this.batches) for (const draw of [batch.shadowTrunks, batch.shadowCrowns]) { draw.geometry.dispose(); draw.material.dispose(); } }
}

function mesh(geometry, material, count, name) { const value = new InstancedMesh(geometry, material, Math.max(1, count)); value.name = name; value.count = 0; return value; }
function treeDimensions(spec, record) { const maturity = 0.62 + record.age * 0.38; const health = 0.82 + record.health * 0.18; const height = spec.height * record.scale * maturity; return { height, trunkScale: spec.trunk * record.scale * (0.76 + record.age * 0.24), crownY: height * (spec.form === 'conifer' ? 0.61 : 0.72), crownScale: [spec.crown[0] * record.scale * health, spec.crown[1] * record.scale * maturity, spec.crown[2] * record.scale * health] }; }
function setTransform(dummy, record, scale, y) { dummy.position.set(record.x, record.y + y, record.z); dummy.rotation.set(0, record.rotationY, 0); dummy.scale.set(scale[0], scale[1], scale[2]); dummy.updateMatrix(); }
function crownPart(spec, record, part, count) { const rng = createRng(deriveSeed(record.seed, `crown:${part}`)); const angle = record.rotationY + part * Math.PI * 2 / count + (rng() - .5) * .55; const radius = spec.crown[0] * record.scale * (count === 3 ? .18 : .10); return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius, y: (rng() - .46) * spec.crown[1] * record.scale * .17, scale: [spec.crown[0] * record.scale * .63, spec.crown[1] * record.scale * .66, spec.crown[2] * record.scale * .63] }; }
function crownGeometry(spec, far) { if (spec.form === 'conifer') return new ConeGeometry(1, 1, far ? 7 : 12, far ? 2 : 5); const geometry = new IcosahedronGeometry(1, far ? 1 : 2); const position = geometry.attributes.position; for (let index = 0; index < position.count; index += 1) { const x = position.getX(index), y = position.getY(index), z = position.getZ(index); const warp = 1 + Math.sin(x * 7.1 + y * 4.3 + z * 5.7) * (far ? .035 : .075); position.setXYZ(index, x * warp, y * (1 + Math.cos(x * 5.2 + z * 4.7) * .055), z * warp); } position.needsUpdate = true; geometry.computeVertexNormals(); return geometry; }
function barkGeometry(spec, seed, radialSegments, heightSegments) { const geometry = new CylinderGeometry(1, .72, 1, radialSegments, heightSegments, false); const position = geometry.attributes.position; const color = new Color(spec.bark); const rng = createRng(seed); const phase = rng() * Math.PI * 2; for (let index = 0; index < position.count; index += 1) { const x = position.getX(index), y = position.getY(index), z = position.getZ(index); const angle = Math.atan2(z, x); const ridge = 1 + .045 * Math.sin(angle * 11 + y * 13 + phase) + .018 * Math.sin(angle * 23 - y * 7); position.setXYZ(index, x * ridge, y, z * ridge); } position.needsUpdate = true; geometry.computeVertexNormals(); geometry.userData.proceduralBark = { geometricRelief: true, textureDependency: false, baseColor: `#${color.getHexString()}` }; return geometry; }
