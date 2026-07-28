import { InstancedMesh, Object3D, DoubleSide } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const _loader = new GLTFLoader();

// Load a processed tree GLB and extract an instanceable prototype (geometry +
// material, native height, base offset). Leaf materials are alpha-clipped and
// two-sided so the canopy reads correctly.
export async function loadTreePrototype(url) {
  const gltf = await _loader.loadAsync(url);
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('no mesh in ' + url);

  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;

  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    m.side = DoubleSide;
    if (m.map) { m.alphaTest = Math.max(m.alphaTest || 0, 0.4); m.transparent = false; }
  }

  return {
    geometry: mesh.geometry,
    material: mesh.material,
    height: bb.max.y - bb.min.y,
    baseY: bb.min.y,
  };
}

// Build an InstancedMesh of a tree prototype from placements
// [{x, y, z, targetHeight, rotY}]. Each instance is scaled so its native height
// matches targetHeight and its trunk base sits on the ground at y.
export function instanceTrees(proto, placements) {
  const inst = new InstancedMesh(proto.geometry, proto.material, placements.length);
  inst.castShadow = true;
  inst.receiveShadow = false;
  inst.frustumCulled = false; // the field spans a wide area
  const d = new Object3D();
  placements.forEach((p, i) => {
    const scale = p.targetHeight / proto.height;
    d.position.set(p.x, p.y - proto.baseY * scale, p.z);
    d.scale.setScalar(scale);
    d.rotation.set(0, p.rotY, 0);
    d.updateMatrix();
    inst.setMatrixAt(i, d.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}
