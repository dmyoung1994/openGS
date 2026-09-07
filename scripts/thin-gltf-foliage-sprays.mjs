#!/usr/bin/env node

/**
 * Thin an indexed glTF foliage primitive by retaining complete connected
 * components. Geometry attributes and material/texture bindings are left
 * untouched; only the primitive's triangle index accessor is replaced.
 *
 * This is intentionally not mesh simplification. It is the Node-side equivalent
 * of the Blender pine baker's whole-spray retention and is suitable for tuning a
 * verified catalog derivative without requiring Blender on an authoring machine.
 */

import { readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const inputArg = option('input');
const outputArg = option('output');
const materialArg = option('material') ?? 'twig|needle|foliage';
// 'hash' keeps the existing pseudo-random whole-spray ordering, which matches
// process_pine_tree.py so a thinned derivative selects the same nested set as a
// fresh Blender bake. 'outer' instead spends the budget on the sprays that are
// actually visible: a crown occludes its own interior, so retaining the outer
// shell first yields a far fuller silhouette at the same face count.
// 'largest' keeps the biggest connected components first. Use it for structural
// limb geometry: a tree's core limbs are its largest components, and both of the
// other orderings delete them — 'outer' because limbs sit near the crown centre,
// 'hash' because it ignores size entirely. Thinning limbs with either produces a
// tree whose branch structure is visibly missing.
const retainArg = option('retain') ?? 'hash';
const targetArg = Number(option('target-faces'));
if (retainArg !== 'hash' && retainArg !== 'outer' && retainArg !== 'largest') {
  throw new Error("--retain must be 'hash' (default), 'outer' or 'largest'");
}
if (!inputArg || !outputArg || !Number.isInteger(targetArg) || targetArg < 1) {
  throw new Error('usage: node scripts/thin-gltf-foliage-sprays.mjs --input in.glb --output out.glb --target-faces 460000 [--material twig|needle|foliage] [--retain hash|outer|largest]');
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const temporary = `${output}.partial.glb`;
const materialPattern = new RegExp(materialArg, 'i');
// Bearing resolution for --retain outer. Fine enough that a crown keeps an even
// envelope, coarse enough that each bucket still holds several sprays to choose
// between at the face budgets these derivatives actually use.
const SHELL_AZIMUTH_BUCKETS = 24;
const SHELL_ELEVATION_BUCKETS = 12;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(input);
const inputSha256 = createHash('sha256').update(await readFile(input)).digest('hex');
let matched = 0;
let derivativeReport = null;

function root(parent, value) {
  let cursor = value;
  while (parent[cursor] !== cursor) cursor = parent[cursor];
  while (parent[value] !== value) {
    const next = parent[value];
    parent[value] = cursor;
    value = next;
  }
  return cursor;
}

function union(parent, left, right) {
  const leftRoot = root(parent, left);
  const rightRoot = root(parent, right);
  if (leftRoot === rightRoot) return;
  if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
  else parent[leftRoot] = rightRoot;
}

function rank(value) {
  // Match process_pine_tree.py's LOD0 ordering. Thinning an earlier LOD0
  // derivative therefore selects the same nested whole-spray set as a fresh
  // Blender bake at the lower target.
  value = (value ^ 0x9e3779b9) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

for (const mesh of document.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const materialName = primitive.getMaterial()?.getName() ?? '';
    if (!materialPattern.test(materialName)) continue;
    const indicesAccessor = primitive.getIndices();
    const positions = primitive.getAttribute('POSITION');
    if (!indicesAccessor || !positions || primitive.getMode() !== 4) {
      throw new Error(`matched primitive ${mesh.getName()}/${materialName} must be indexed TRIANGLES`);
    }
    const source = indicesAccessor.getArray();
    const beforeFaces = source.length / 3;
    if (beforeFaces <= targetArg) {
      console.log(`SPRAYS material=${materialName} faces=${beforeFaces}->${beforeFaces} target=${targetArg} unchanged=true`);
      matched++;
      continue;
    }

    const parent = new Uint32Array(positions.getCount());
    for (let index = 0; index < parent.length; index++) parent[index] = index;
    for (let index = 0; index < source.length; index += 3) {
      union(parent, source[index], source[index + 1]);
      union(parent, source[index + 1], source[index + 2]);
    }

    const faceCounts = new Map();
    for (let index = 0; index < source.length; index += 3) {
      const component = root(parent, source[index]);
      faceCounts.set(component, (faceCounts.get(component) ?? 0) + 1);
    }
    // Preserve every foliage component that owns an authored axis extremum.
    // Structural primitives are never modified; retaining these six foliage
    // extrema also keeps the real accessor-derived LOD bounds identical when a
    // lower tier is generated from the accepted LOD0 derivative.
    const positionArray = positions.getArray();
    const extremaVertices = new Set();
    for (let axis = 0; axis < 3; axis++) {
      let minVertex = 0;
      let maxVertex = 0;
      for (let vertex = 1; vertex < positions.getCount(); vertex++) {
        if (positionArray[vertex * 3 + axis] < positionArray[minVertex * 3 + axis]) minVertex = vertex;
        if (positionArray[vertex * 3 + axis] > positionArray[maxVertex * 3 + axis]) maxVertex = vertex;
      }
      extremaVertices.add(minVertex);
      extremaVertices.add(maxVertex);
    }
    const retained = new Set([...extremaVertices].map((vertex) => root(parent, vertex)));
    let retainedFaces = [...retained].reduce((sum, component) => sum + (faceCounts.get(component) ?? 0), 0);
    // Outer-shell ordering. Each spray is placed by the centroid of its own
    // vertices, and the crown by the centroid of every matched vertex. Sprays are
    // then taken furthest-first, so the retained set is the visible envelope
    // rather than a uniform sample that spends most of its budget on interior
    // foliage no camera outside the tree can see. Distance is measured in the
    // authored object space; no geometry is moved, scaled or regenerated.
    let componentOrder;
    if (retainArg === 'outer') {
      const sums = new Map();
      for (let vertex = 0; vertex < positions.getCount(); vertex++) {
        const component = root(parent, vertex);
        if (!faceCounts.has(component)) continue;
        let entry = sums.get(component);
        if (!entry) { entry = [0, 0, 0, 0]; sums.set(component, entry); }
        entry[0] += positionArray[vertex * 3];
        entry[1] += positionArray[vertex * 3 + 1];
        entry[2] += positionArray[vertex * 3 + 2];
        entry[3] += 1;
      }
      // Anchor on the bounding-box centre, not the vertex centroid. Once a tier has
      // been reduced to a shell the centroid no longer sits inside the crown — it
      // drifts toward whichever side kept more geometry, and each derived tier then
      // strips one side of the tree. The box centre stays put however hollow the
      // mesh becomes, so lower tiers keep shelling the same crown.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let vertex = 0; vertex < positions.getCount(); vertex++) {
        const x = positionArray[vertex * 3];
        const y = positionArray[vertex * 3 + 1];
        const z = positionArray[vertex * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      // Ordering by radius alone is NOT a shell: it spends the entire budget on the
      // handful of sprays sitting at the bounding radius and leaves the rest of the
      // crown bare. A canopy envelope needs the outermost spray in EVERY direction,
      // so bucket sprays by their bearing from the crown centre and walk the buckets
      // round-robin, taking each bucket's outermost remaining spray first. Interior
      // foliage is what falls off the end, which is exactly the geometry no camera
      // outside the tree can see.
      const buckets = new Map();
      const distance = new Map();
      for (const [component, entry] of sums) {
        const dx = entry[0] / entry[3] - cx;
        const dy = entry[1] / entry[3] - cy;
        const dz = entry[2] / entry[3] - cz;
        const radius = Math.hypot(dx, dy, dz);
        distance.set(component, radius);
        const azimuth = Math.min(SHELL_AZIMUTH_BUCKETS - 1, Math.max(0, Math.floor(
          (Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI) * SHELL_AZIMUTH_BUCKETS)));
        const elevation = Math.min(SHELL_ELEVATION_BUCKETS - 1, Math.max(0, Math.floor(
          (radius > 0 ? (dy / radius + 1) / 2 : 0.5) * SHELL_ELEVATION_BUCKETS)));
        const key = elevation * SHELL_AZIMUTH_BUCKETS + azimuth;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(component);
      }
      const bucketKeys = [...buckets.keys()].sort((a, b) => a - b);
      for (const key of bucketKeys) {
        buckets.get(key).sort((a, b) => distance.get(b) - distance.get(a) || a - b);
      }
      componentOrder = [];
      for (let depth = 0; componentOrder.length < faceCounts.size; depth++) {
        let advanced = false;
        for (const key of bucketKeys) {
          const bucket = buckets.get(key);
          if (depth >= bucket.length) continue;
          componentOrder.push([bucket[depth], faceCounts.get(bucket[depth])]);
          advanced = true;
        }
        if (!advanced) break;
      }
      console.log(`SHELL material=${materialName} centre=${cx.toFixed(3)},${cy.toFixed(3)},${cz.toFixed(3)} `
        + `maxRadius=${Math.max(...distance.values()).toFixed(3)} bearings=${bucketKeys.length}`);
    } else if (retainArg === 'largest') {
      componentOrder = [...faceCounts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    } else {
      componentOrder = [...faceCounts].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0] - b[0]);
    }
    for (const [component, count] of componentOrder) {
      if (retained.has(component)) continue;
      retained.add(component);
      retainedFaces += count;
      if (retainedFaces >= targetArg) break;
    }

    const retainedSourceIndices = new Uint32Array(retainedFaces * 3);
    let write = 0;
    for (let index = 0; index < source.length; index += 3) {
      if (!retained.has(root(parent, source[index]))) continue;
      retainedSourceIndices[write++] = source[index];
      retainedSourceIndices[write++] = source[index + 1];
      retainedSourceIndices[write++] = source[index + 2];
    }

    // Remove now-unreferenced vertices while copying each source attribute byte
    // value into the same typed component format. No normals, UVs, vertex colors,
    // or other authored attributes are regenerated or approximated.
    const remap = new Int32Array(positions.getCount());
    remap.fill(-1);
    let retainedVertices = 0;
    for (const sourceIndex of retainedSourceIndices) {
      if (remap[sourceIndex] === -1) remap[sourceIndex] = retainedVertices++;
    }
    const IndexArray = retainedVertices <= 65535 ? Uint16Array : Uint32Array;
    const nextIndices = new IndexArray(retainedSourceIndices.length);
    for (let index = 0; index < retainedSourceIndices.length; index++) {
      nextIndices[index] = remap[retainedSourceIndices[index]];
    }
    for (const semantic of primitive.listSemantics()) {
      const sourceAccessor = primitive.getAttribute(semantic);
      const sourceArray = sourceAccessor.getArray();
      const elementSize = sourceAccessor.getElementSize();
      const AttributeArray = sourceArray.constructor;
      const nextArray = new AttributeArray(retainedVertices * elementSize);
      for (let sourceIndex = 0; sourceIndex < remap.length; sourceIndex++) {
        const targetIndex = remap[sourceIndex];
        if (targetIndex === -1) continue;
        const sourceOffset = sourceIndex * elementSize;
        nextArray.set(sourceArray.subarray(sourceOffset, sourceOffset + elementSize), targetIndex * elementSize);
      }
      const nextAccessor = document.createAccessor(sourceAccessor.getName())
        .setType(sourceAccessor.getType())
        .setArray(nextArray)
        .setNormalized(sourceAccessor.getNormalized());
      primitive.setAttribute(semantic, nextAccessor);
      sourceAccessor.dispose();
    }
    primitive.setIndices(document.createAccessor(`${materialName}-whole-spray-indices`).setType('SCALAR').setArray(nextIndices));
    indicesAccessor.dispose();
    console.log(`SPRAYS retain=${retainArg} material=${materialName} components=${faceCounts.size} retained=${retained.size} faces=${beforeFaces}->${retainedFaces} target=${targetArg}`);
    console.log(`VERTICES material=${materialName} vertices=${positions.getCount()}->${retainedVertices}`);
    derivativeReport = {
      pipelineVersion: 'whole-authored-spray-thinner@2',
      inputSha256,
      material: materialName,
      targetFaces: targetArg,
      sourceFaces: beforeFaces,
      actualFaces: retainedFaces,
      sourceComponents: faceCounts.size,
      retainedComponents: retained.size,
      extremaComponentsRetained: new Set([...extremaVertices].map((vertex) => root(parent, vertex))).size,
    };
    matched++;
  }
}

if (matched !== 1) throw new Error(`expected exactly one foliage primitive, matched ${matched}`);
const boundsMin = [Infinity, Infinity, Infinity];
const boundsMax = [-Infinity, -Infinity, -Infinity];
let exportedVertices = 0;
for (const mesh of document.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const accessor = primitive.getAttribute('POSITION');
    if (!accessor) continue;
    exportedVertices += accessor.getCount();
    const array = accessor.getArray();
    for (let vertex = 0; vertex < accessor.getCount(); vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = array[vertex * 3 + axis];
        boundsMin[axis] = Math.min(boundsMin[axis], value);
        boundsMax[axis] = Math.max(boundsMax[axis], value);
      }
    }
  }
}
const inherited = { ...(document.getRoot().getExtras() ?? {}) };
for (const stale of ['selection', 'lod', 'vertices', 'roleVertices', 'boundsMin', 'boundsMax']) delete inherited[stale];
document.getRoot().setExtras({
  ...inherited,
  productionDerivative: true,
  selection: 'complete authored structural primitives; deterministic complete connected foliage sprays; axis-extrema components retained',
  lod: Number(output.match(/_lod([012])\.glb$/)?.[1] ?? -1),
  vertices: exportedVertices,
  boundsMin,
  boundsMax,
  coursePerformanceDerivative: derivativeReport,
});
await io.write(temporary, document);
await rename(temporary, output);
console.log(`GLB_DONE input=${input} output=${output}`);
