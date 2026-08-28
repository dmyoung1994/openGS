import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh,
  MeshStandardMaterial, Object3D,
} from 'three';
import { signedDistanceToFeature } from '../course/featureGeometry.js';
import { createRng, normalizeSeed } from '../util/random.js';

const ALONG_SPACING_M = 0.066;
const DEPTH_SPACING_M = 0.086;

function bladeGeometry() {
  // Two crossed, double-sided triangles give each 25--42 mm collar blade a readable
  // silhouette without building a rough-style multi-segment ribbon canopy.
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0, 1, 0,
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0,
  ]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0,
  ]), 3));
  return geometry;
}

export function createCreatorFringeGrass({ green, fringeWidth, heightAt, seed = 0 }) {
  if (!green?.shape?.length || typeof heightAt !== 'function') {
    throw new TypeError('Creator fringe grass requires an authored green and terrain sampler.');
  }
  const outline = green.shape;
  const signedArea = outline.reduce((area, point, index) => {
    const next = outline[(index + 1) % outline.length];
    return area + point.x * next.z - next.x * point.z;
  }, 0) * 0.5;
  const orientation = signedArea >= 0 ? 1 : -1;
  const rng = createRng(normalizeSeed(seed));
  const records = [];

  for (let segment = 0; segment < outline.length; segment += 1) {
    const a = outline[segment];
    const b = outline[(segment + 1) % outline.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-5) continue;
    // A CCW polygon owns a right-hand outward normal; reverse it for CW input.
    const outwardX = dz / length * orientation;
    const outwardZ = -dx / length * orientation;
    const alongCount = Math.max(1, Math.ceil(length / ALONG_SPACING_M));
    const depthCount = Math.max(1, Math.floor((fringeWidth - 0.055) / DEPTH_SPACING_M));
    for (let alongIndex = 0; alongIndex < alongCount; alongIndex += 1) {
      const along = (alongIndex + 0.18 + rng() * 0.64) / alongCount;
      const edgeX = a.x + dx * along;
      const edgeZ = a.z + dz * along;
      for (let depthIndex = 0; depthIndex < depthCount; depthIndex += 1) {
        if (rng() > 0.84) continue;
        const depth = 0.055 + (depthIndex + 0.18 + rng() * 0.64) * DEPTH_SPACING_M;
        const lateralJitter = (rng() - 0.5) * ALONG_SPACING_M * 0.72;
        const x = edgeX + outwardX * depth + dx / length * lateralJitter;
        const z = edgeZ + outwardZ * depth + dz / length * lateralJitter;
        const sd = signedDistanceToFeature(green, x, z);
        // Root ownership follows the exact same green outline as the hard material
        // cut. The small clearances keep crossed ribbons from bridging either edge.
        if (sd >= -0.035 || sd <= -fringeWidth + 0.035) continue;
        records.push({
          x, z,
          y: heightAt(x, z) + 0.002,
          width: 0.009 + rng() * 0.007,
          height: 0.030 + rng() * 0.020,
          rotation: rng() * Math.PI,
          leanX: (rng() - 0.5) * 0.24,
          leanZ: (rng() - 0.5) * 0.24,
          hue: 0.235 + (rng() - 0.5) * 0.025,
          lightness: 0.245 + rng() * 0.085,
        });
      }
    }
  }

  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0,
    side: DoubleSide,
  });
  const mesh = new InstancedMesh(bladeGeometry(), material, records.length);
  const transform = new Object3D();
  const color = new Color();
  records.forEach((record, index) => {
    transform.position.set(record.x, record.y, record.z);
    // A restrained whole-blade lean exposes real lit leaf area to the elevated
    // editor camera; perfectly vertical triangles have zero top-view footprint and
    // collapse back into isolated dots even at adequate population density.
    transform.rotation.set(record.leanX, record.rotation, record.leanZ);
    transform.scale.set(record.width, record.height, record.width);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    color.setHSL(record.hue, 0.48, record.lightness);
    mesh.setColorAt(index, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = 'creator-fringe-grass-canopy';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.userData.creatorFringeGrass = true;
  mesh.userData.bladeCount = records.length;
  mesh.userData.bladeHeightRangeM = Object.freeze([0.030, 0.050]);
  mesh.userData.rootClearanceM = 0.035;
  return mesh;
}
