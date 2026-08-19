import {
  Box3, Color, DoubleSide, Euler, Group, InstancedMesh, Matrix4,
  Quaternion, SRGBColorSpace, StaticDrawUsage, Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createRng, deriveSeed } from '../util/random.js';
import { getCatalogAsset } from '../environment/EnvironmentCatalog.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const foliageName = /leaf|leaves|fern|frond|needle|foliage|canopy|branch|twig/i;

// Static catalog props share one geometry/material draw bucket per source mesh and
// asset ID. Trees with baked impostors retain the specialized GPU LOD path; this
// renderer owns hero trees without impostors, shrubs, groundcover, rocks, and
// deadwood. It never creates substitute geometry when a source asset is missing.
export async function buildEnvironmentProps({ catalog, placements, environmentSeed }) {
  const group = new Group();
  group.name = 'environment-props';
  const byAsset = new Map();
  for (const placement of placements) {
    const asset = getCatalogAsset(catalog, placement.assetId);
    if (asset.category === 'tree' && asset.impostor.kind === 'baked-atlas') continue;
    if (!byAsset.has(asset.id)) byAsset.set(asset.id, []);
    byAsset.get(asset.id).push(placement);
  }

  let drawBucketCount = 0;
  await Promise.all([...byAsset].map(async ([assetId, assetPlacements]) => {
    const asset = getCatalogAsset(catalog, assetId);
    const source = await loader.loadAsync(asset.lods[0].url);
    source.scene.updateWorldMatrix(true, true);
    validateBounds(source.scene, asset);

    let partIndex = 0;
    source.scene.traverse((object) => {
      if (!object.isMesh || !object.geometry || !object.material) return;
      const geometry = object.geometry.clone();
      geometry.applyMatrix4(object.matrixWorld);
      const partName = `${object.name} ${Array.isArray(object.material) ? object.material.map((value) => value.name).join(' ') : object.material.name}`;
      const materials = (Array.isArray(object.material) ? object.material : [object.material])
        .map((material) => prepareMaterial(material, asset.category, `${object.name} ${material.name}`));
      const material = Array.isArray(object.material) ? materials : materials[0];
      const mesh = new InstancedMesh(geometry, material, assetPlacements.length);
      mesh.name = `environment-prop:${assetId}:${partIndex}`;
      mesh.instanceMatrix.setUsage(StaticDrawUsage);
      mesh.castShadow = asset.category === 'rock' || asset.category === 'deadwood' || asset.category === 'tree';
      mesh.receiveShadow = true;
      // Layer 2 marks solid geometry eligible for the selective contact-depth
      // pass; layer 0 remains enabled for normal beauty rendering. Thin alpha-cut
      // foliage stays out so its cards cannot stamp AO rectangles onto the turf.
      if (isSolidContactDepthPart(asset.category, partName)) mesh.layers.enable(2);

      const matrix = new Matrix4();
      const quaternion = new Quaternion();
      const alignQuaternion = new Quaternion();
      const yawQuaternion = new Quaternion();
      const variationQuaternion = new Quaternion();
      const scale = new Vector3();
      const position = new Vector3();
      const euler = new Euler();
      const surfaceNormal = new Vector3();
      const up = new Vector3(0, 1, 0);
      const tint = new Color();
      assetPlacements.forEach((placement, index) => {
        surfaceNormal.set(placement.normalX, placement.normalY, placement.normalZ).normalize();
        alignQuaternion.setFromUnitVectors(up, surfaceNormal);
        yawQuaternion.setFromAxisAngle(surfaceNormal, placement.rotationY);
        euler.set(placement.rotationX, 0, placement.rotationZ, 'XYZ');
        variationQuaternion.setFromEuler(euler);
        quaternion.multiplyQuaternions(yawQuaternion, alignQuaternion).multiply(variationQuaternion);
        position.set(placement.x, placement.y, placement.z);
        scale.setScalar(placement.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, placementTint(tint, asset.category, environmentSeed, placement.sourceId));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      group.add(mesh);
      partIndex++;
      drawBucketCount++;
    });

    // The instanced buckets own cloned geometry/materials. Release the loader's
    // source wrappers while retaining textures shared by the material clones.
    source.scene.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material?.dispose();
    });
  }));

  group.userData.environmentObjectCount = [...byAsset.values()].reduce((sum, values) => sum + values.length, 0);
  group.userData.environmentDrawBucketCount = drawBucketCount;
  return group;
}

function isSolidContactDepthPart(category, name) {
  if (category === 'groundcover' || category === 'shrub') return false;
  if (category === 'tree') return !foliageName.test(name);
  return category === 'rock' || category === 'deadwood' || category === 'wall' || category === 'building';
}

function prepareMaterial(source, category, name) {
  const material = source.clone();
  for (const value of Object.values(material)) {
    if (!value?.isTexture) continue;
    value.anisotropy = Math.max(value.anisotropy || 1, 8);
    value.needsUpdate = true;
  }
  if (material.map) material.map.colorSpace = SRGBColorSpace;
  material.metalness = 0;
  const roughnessFloor = category === 'rock' ? 0.86
    : category === 'deadwood' ? 0.9
      : category === 'groundcover' || category === 'shrub' ? 0.82 : 0.78;
  if (typeof material.roughness === 'number') material.roughness = Math.max(material.roughness, roughnessFloor);
  if (typeof material.envMapIntensity === 'number') {
    material.envMapIntensity = category === 'rock' ? 0.82 : category === 'deadwood' ? 0.68 : 0.76;
  }
  if (typeof material.aoMapIntensity === 'number') material.aoMapIntensity = Math.min(material.aoMapIntensity, 0.78);
  if (typeof material.clearcoat === 'number') material.clearcoat = 0;
  if (typeof material.sheen === 'number') material.sheen = 0;
  if (category === 'groundcover' || category === 'shrub' || (category === 'tree' && foliageName.test(name))) {
    material.side = DoubleSide;
    // Preserve the authored leaf/needle fringe.  A 0.24 cutoff was deleting the
    // thin outer crown pixels from the licensed source and leaving branch-shaped
    // holes, which made the non-impostor trees read like clipped cards.  The
    // lower cutoff is still binary/depth-writing (never blended foliage), while
    // retaining the source's real alpha coverage at the perception-sensitive edge.
    material.alphaTest = Math.max(material.alphaTest || 0, category === 'tree' ? 0.12 : 0.18);
    material.transparent = false;
    material.depthWrite = true;
    material.alphaHash = false;
    // Catalog foliage participates in the same sun and sky lighting as terrain.
    // Any imported emissive value would preserve the source asset's studio light
    // and make the prop look pasted into this environment.
    if (material.emissive?.isColor) {
      material.emissive.setRGB(0, 0, 0);
      material.emissiveIntensity = 0;
    }
  }
  return material;
}

function placementTint(target, category, seed, sourceId) {
  const random = createRng(deriveSeed(seed, `${sourceId}:prop-tint`));
  const brightness = 0.95 + random() * 0.07;
  if (category === 'groundcover' || category === 'shrub' || category === 'tree') {
    return target.setRGB(brightness * (0.965 + random() * 0.025), brightness, brightness * (0.93 + random() * 0.035));
  }
  if (category === 'rock') {
    return target.setRGB(brightness * 0.99, brightness, brightness * (0.975 + random() * 0.015));
  }
  return target.setRGB(brightness, brightness * 0.985, brightness * 0.955);
}

function validateBounds(scene, asset) {
  const bounds = new Box3().setFromObject(scene);
  const size = bounds.getSize(new Vector3());
  const expected = asset.dimensions;
  for (const [key, actual] of [['width', size.x], ['height', size.y], ['depth', size.z]]) {
    const error = Math.abs(actual - expected[key]) / expected[key];
    if (error > 0.08) {
      throw new Error(`${asset.id} runtime ${key} ${actual.toFixed(3)}m does not match catalog ${expected[key].toFixed(3)}m`);
    }
  }
}
