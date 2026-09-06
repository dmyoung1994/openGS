import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

const ROOT_BARK_WRAP = 0.3;

function meshBuffer(positions, uvs, indices, rootBlend = null) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  // Always present, even on tiers carrying no roots and on foliage: the tiers share
  // one compiled material, so an attribute the shader reads cannot be conditional.
  geometry.setAttribute('rootBlend', new BufferAttribute(
    rootBlend ? new Float32Array(rootBlend) : new Float32Array(positions.length / 3), 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

// One shared ring per stem station: no interior cylinder caps or shading seams.
function woodGeometry(skeleton, radialSegments, plant, includeRoots = true) {
  const positions = [], uvs = [], indices = [], rootBlend = [], stems = new Map();
  for (const segment of skeleton.segments) {
    // Roots are near-field only. Dropping them from the reduced tiers also keeps them
    // out of the shadow pass, which draws from tier 1.
    if (segment.role === 'root' && !includeRoots) continue;
    let list = stems.get(segment.stem);
    // L-system pen lifts can make a stem discontinuous; start a new run there.
    if (!list || new Vector3(...list.at(-1).end).distanceTo(new Vector3(...segment.start)) > 1e-5) {
      list = []; stems.set(`${segment.stem}:${stems.size}`, list); stems.set(segment.stem, list);
    }
    list.push(segment);
  }
  for (const segments of new Set(stems.values())) {
    const stations = [{ point: segments[0].start, radius: segments[0].radius0, blend: segments[0].rootBlend0 ?? 0 },
      ...segments.map(s => ({ point: s.end, radius: s.radius1, blend: s.rootBlend1 ?? 0 }))];
    const start = positions.length / 3;
    let right = null, length = 0;
    for (let i = 0; i < stations.length; i++) {
      const point = new Vector3(...stations[i].point);
      const before = new Vector3(...stations[Math.max(0, i - 1)].point);
      const after = new Vector3(...stations[Math.min(stations.length - 1, i + 1)].point);
      const tangent = after.sub(before).normalize();
      if (right) right.addScaledVector(tangent, -right.dot(tangent)).normalize();
      if (!right || right.lengthSq() < 0.1) right = new Vector3().crossVectors(tangent, Math.abs(tangent.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
      const forward = new Vector3().crossVectors(right, tangent).normalize();
      if (i) length += point.distanceTo(new Vector3(...stations[i - 1].point));
      for (let j = 0; j <= radialSegments; j++) {
        const angle = j / radialSegments * Math.PI * 2;
        let radius = stations[i].radius;
        if (plant && segments[0].level === 0 && segments[0].role !== 'root') radius *= 1 + plant.structure.buttress * Math.max(0, 1 - point.y / 1.5) ** 2 * (0.5 + 0.5 * Math.cos(angle * Math.round(plant.structure.buttressCount)));
        if (plant && segments[0].parent && i === 0) radius *= 1 + plant.structure.collar;
        // Structural roots are not tubes. Excavations of pine report I-beam and
        // T-beam cross sections through the zone of rapid taper - secondary
        // thickening about the vertical axis - so the section is a vertically
        // deepened blade, narrow across and tall through. Building it in world axes
        // keeps the blade upright however the tube's frame happens to be rolled.
        const p = point.clone();
        if (segments[0].role === 'root') {
          // The thickening is reported within the zone of rapid taper, so it is
          // strongest at the stump and relaxes to a round runner further out.
          const beam = 1 - stations[i].blend;
          // One control: the section deepens by `rootBlade` and narrows by its
          // reciprocal, so the blade changes shape without gaining bulk.
          const blade = plant.structure.rootBlade;
          const wide = 1 + (1 / blade - 1) * beam;
          const tall = 1 + (blade - 1) * beam;
          const gauge = (axis) => wide + (tall - wide) * Math.abs(axis.y);
          p.addScaledVector(right, Math.cos(angle) * radius * gauge(right))
            .addScaledVector(forward, Math.sin(angle) * radius * gauge(forward));
        } else {
          p.addScaledVector(right, Math.cos(angle) * radius).addScaledVector(forward, Math.sin(angle) * radius);
        }
        positions.push(p.x, p.y, p.z);
        // Bark ridges are laid out across the normalized circumference, so a thin tube
        // packs the same ridge count into far fewer radial segments and beats against
        // them. Roots wrap a proportionally shorter span of bark instead of aliasing.
        uvs.push(j / radialSegments * (segments[0].role === 'root' ? ROOT_BARK_WRAP : 1), length);
        rootBlend.push(stations[i].blend);
        if (i && j < radialSegments) {
          const a = start + (i - 1) * (radialSegments + 1) + j, b = a + radialSegments + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    // End caps only, using existing perimeter vertices.
    for (const [ring, reverse] of [[start, true], [start + (stations.length - 1) * (radialSegments + 1), false]]) {
      for (let j = 1; j < radialSegments - 1; j++) indices.push(ring, ring + (reverse ? j + 1 : j), ring + (reverse ? j : j + 1));
    }
  }
  return meshBuffer(positions, uvs, indices, rootBlend);
}

function foliageGeometry(records, stride) {
  const positions = [], uvs = [], indices = [], colors = [];
  const blade = (center, axis, right, normal, height, width, bend, shape, roll) => {
    const base = positions.length / 3, steps = shape === 'needle' ? 2 : 5;
    const r = right.clone().multiplyScalar(Math.cos(roll)).addScaledVector(normal, Math.sin(roll));
    const n = new Vector3().crossVectors(r, axis).normalize();
    // A needle tapers to points: share those tips instead of making two almost
    // zero-width end edges. The middle ridge retains its bend and full width.
    if (shape === 'needle') {
      for (const [t, side] of [[0, 0], [0.5, -1], [0.5, 1], [1, 0]]) {
        const p = center.clone().addScaledVector(axis, (t - 0.15) * height)
          .addScaledVector(r, side * width * 0.75).addScaledVector(n, bend * height * t * t);
        positions.push(p.x, p.y, p.z); uvs.push((side + 1) / 2, t);
      }
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      return;
    }
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let profile = shape === 'fan' ? Math.sin(t * Math.PI / 2) : Math.sin(Math.PI * t);
      if (shape === 'lanceolate' || shape === 'needle') profile = Math.pow(profile, 0.6) * (1 - t * 0.5);
      for (const side of [-1, 1]) {
        const p = center.clone().addScaledVector(axis, (t - 0.15) * height).addScaledVector(r, side * width * Math.max(0.015, profile)).addScaledVector(n, bend * height * t * t);
        positions.push(p.x, p.y, p.z); uvs.push((side + 1) / 2, t);
      }
      if (i < steps) { const a = base + i * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
  };
  records.forEach((record, index) => {
    if (index % stride) return;
    const firstVertex = positions.length / 3;
    const axis = new Vector3(...record.direction).normalize();
    const right = new Vector3().crossVectors(axis, Math.abs(axis.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
    const normal = new Vector3().crossVectors(right, axis).normalize(), center = new Vector3(...record.position);
    const coverage = Math.sqrt(stride);
    const height = record.scale * 2 * coverage, width = record.scale * record.scaleX * coverage;
    const compound = ['compound', 'pinnate', 'spray', 'cluster', 'flower'].includes(record.shape);
    if (!compound) blade(center, axis, right, normal, height, width, record.bend, record.shape, record.roll ?? 0);
    else {
      const count = record.shape === 'flower' ? 5 : record.leaflets ?? 9;
      for (let j = 0; j < count; j++) {
        const t = (j + 1) / (count + 1), side = j % 2 ? -1 : 1;
        const flower = record.shape === 'flower';
        const angle = j / count * Math.PI * 2;
        const direction = flower ? right.clone().multiplyScalar(Math.cos(angle)).addScaledVector(axis, Math.sin(angle)) : axis.clone().multiplyScalar(0.4).addScaledVector(right, side).normalize();
        const origin = flower ? center : center.clone().addScaledVector(axis, t * height);
        blade(origin, direction, flower ? normal : axis, normal, flower ? height * 0.5 : height * 0.45 * Math.sin(Math.PI * t), width * (record.shape === 'spray' ? 0.1 : 0.25), record.bend, record.shape === 'spray' ? 'needle' : 'lanceolate', record.roll ?? 0);
      }
    }
    const variation = record.colorVariation ?? 0;
    const tint = 1 - variation * 0.5 + Math.sin(index * 2.399963 + record.position[0]) * variation * 0.5;
    for (let i = firstVertex; i < positions.length / 3; i++) colors.push(tint, 1 - (1 - tint) * 0.5, tint);
  });
  const geometry = meshBuffer(positions, uvs, indices);
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  return geometry;
}
export function compileTreeGeometry(skeleton, { radialSegments = 9, leafStride = 1, plant, includeRoots = true } = {}) {
  radialSegments = Math.max(3, Math.round(radialSegments)); leafStride = Math.max(1, Math.round(leafStride));
  const foliageVertices = [...skeleton.leaves, ...skeleton.blossoms].reduce((n, leaf, i) => n + (i % leafStride ? 0 : 12 * (['compound', 'pinnate', 'spray', 'cluster'].includes(leaf.shape) ? leaf.leaflets ?? 9 : leaf.shape === 'flower' ? 5 : 1)), 0);
  if (foliageVertices + skeleton.segments.length * (radialSegments + 1) * 2 > 1000000) throw new RangeError('Plant geometry exceeds one million vertices; reduce foliage count, leaflets, or radial resolution');
  return { branches: woodGeometry(skeleton, radialSegments, plant, includeRoots), leaves: foliageGeometry(skeleton.leaves, leafStride), blossoms: foliageGeometry(skeleton.blossoms, leafStride) };
}
export function packTreeGeometry(geometry) {
  return Object.fromEntries(Object.entries(geometry).map(([key, mesh]) => [key, { position: mesh.attributes.position.array, normal: mesh.attributes.normal.array, uv: mesh.attributes.uv.array, rootBlend: mesh.attributes.rootBlend.array, ...(mesh.attributes.color ? { color: mesh.attributes.color.array } : {}), index: mesh.index.array }]));
}
export function unpackTreeGeometry(packed) {
  return Object.fromEntries(Object.entries(packed).map(([key, mesh]) => {
    const geometry = new BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['rootBlend', 1]]) {
      // A missing array here becomes an attribute whose `array` is undefined, which
      // only fails much later inside BufferGeometry.clone(). Reject it at the seam.
      if (!mesh[name]) throw new Error(`Packed tree geometry is missing its ${name} attribute.`);
      geometry.setAttribute(name, new BufferAttribute(mesh[name], size));
    }
    if (mesh.color) geometry.setAttribute('color', new BufferAttribute(mesh.color, 3));
    geometry.setIndex(new BufferAttribute(mesh.index, 1)); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return [key, geometry];
  }));
}
