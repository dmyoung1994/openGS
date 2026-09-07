import { BufferAttribute, BufferGeometry, Line3, Vector3 } from 'three';

// Bark ridges are laid across the NORMALIZED circumference, so every tube gets the
// same ridge count regardless of girth: a thin root packs the trunk's whole count
// into a tiny perimeter and beats against its own segments as a zebra pattern.
// Wrapping a root proportionally to its actual radius makes ridge spacing constant
// in world units, which is both what bark does and what stops the aliasing. Bounded
// so a hair-thin tip still carries some texture rather than going plastic.
const ROOT_BARK_MIN_WRAP = 0.16;
// Scratch axes for the root section, which is built world-aligned rather than on the
// tube's own rolled frame so a flattened root always lies flat against the ground.
const ROOT_UP = new Vector3(0, 1, 0);

// A photographed root collar is knobbly: its ridges differ in width and depth and
// no two are alike. A single cosine gives a perfectly regular rosette, which is the
// machined look again in a different guise. Beating the lobe count against two
// neighbouring harmonics keeps the roots' own count dominant while breaking the
// regularity, and the phases come from the tree's seed so a stand is not clones.
function flutingPhases(seed) {
  let h = (seed >>> 0) || 1;
  const next = () => {
    h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
  return [next() * Math.PI * 2, next() * Math.PI * 2, 0.55 + next() * 0.35, 0.18 + next() * 0.22];
}
function fluting(azimuth, lobes, [phaseA, phaseB, weightA, weightB]) {
  const primary = 0.5 + 0.5 * Math.cos(azimuth * lobes + Math.PI);
  const secondary = 0.5 + 0.5 * Math.cos(azimuth * (lobes + 1) + phaseA);
  const tertiary = 0.5 + 0.5 * Math.cos(azimuth * Math.max(2, lobes - 2) + phaseB);
  const total = weightA + weightB;
  return primary * (1 - total) + secondary * weightA + tertiary * weightB;
}
const ROOT_ACROSS = new Vector3();
const ROOT_OVER = new Vector3();

function meshBuffer(positions, uvs, indices, rootBlend = null) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  // Always present, even on tiers carrying no roots and on foliage: the tiers share
  // one compiled material, so an attribute the shader reads cannot be conditional.
  geometry.setAttribute('rootBlend', new BufferAttribute(
    rootBlend ? new Float32Array(rootBlend) : new Float32Array(positions.length / 3 * 2), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

// Keep endpoints and any station whose centreline or taper exceeds the error
// budget. Every branch survives; only redundant intermediate tube rings go.
function simplifyStations(stations, tolerance) {
  if (!tolerance || stations.length < 3) return stations;
  const keep = new Set([0, stations.length - 1]);
  const line = new Line3(), point = new Vector3(), closest = new Vector3();
  let arc = 0;
  for (let i = 0; i < stations.length; i++) {
    if (i) arc += point.fromArray(stations[i].point).distanceTo(closest.fromArray(stations[i - 1].point));
    stations[i].arc = arc;
  }
  const split = (first, last) => {
    const a = stations[first], b = stations[last];
    line.start.fromArray(a.point); line.end.fromArray(b.point);
    let worst = tolerance, at = -1;
    for (let i = first + 1; i < last; i++) {
      const station = stations[i]; point.fromArray(station.point);
      const t = line.start.equals(line.end) ? 0 : line.closestPointToPointParameter(point, true);
      const error = point.distanceTo(line.at(t, closest)) + Math.abs(station.radius - (a.radius + (b.radius - a.radius) * t));
      if (error > worst) { worst = error; at = i; }
    }
    if (at < 0) return;
    keep.add(at); split(first, at); split(at, last);
  };
  split(0, stations.length - 1);
  return stations.filter((_, i) => keep.has(i));
}

// One shared ring per stem station: no interior cylinder caps or shading seams.
function woodGeometry(skeleton, radialSegments, plant, includeRoots = true, branchTolerance = 0) {
  const positions = [], uvs = [], indices = [], rootBlend = [], stems = new Map();
  const flutingPhase = flutingPhases(skeleton.seed ?? 1);
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
    const stations = simplifyStations([
      { point: segments[0].start, radius: segments[0].radius0, blend: segments[0].rootBlend0 ?? 0, surface: segments[0].rootSurface0 ?? 0 },
      ...segments.map(s => ({ point: s.end, radius: s.radius1, blend: s.rootBlend1 ?? 0, surface: s.rootSurface1 ?? 0 }))], segments[0].role === 'root' ? 0 : branchTolerance);
    // A rounded hump facets badly at trunk resolution. Roots are near-tier only and
    // few, so they can afford a denser ring than the wood they grow from.
    const ringCount = segments[0].role === 'root' ? radialSegments + 6 : radialSegments;
    const trunkRadius = skeleton.segments.find(
      (segment) => segment.level === 0 && segment.role !== 'root')?.radius0 ?? 0;
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
      if (stations[i].arc !== undefined) length = stations[i].arc;
      for (let j = 0; j <= ringCount; j++) {
        const angle = j / ringCount * Math.PI * 2;
        let radius = stations[i].radius;
        if (plant && segments[0].level === 0 && segments[0].role !== 'root') {
          // Swell toward the roots, not on an unrelated cosine. A root emerging from
          // a smooth cone leaves a hard intersection seam; emerging from the bulge
          // that grew it, the seam sits inside the swell where it belongs. The lobe
          // phase is taken in world azimuth so it matches where addRoots put them.
          const lobes = Math.round(plant.structure.rootCount) || Math.round(plant.structure.buttressCount);
          const dir = right.clone().multiplyScalar(Math.cos(angle)).addScaledVector(forward, Math.sin(angle));
          const azimuth = Math.atan2(dir.z, dir.x);
          // The flare zone is a property of the tree, not a fixed 1.5 m: that height
          // is the foot of a pine and the whole of a shrub. Scale it to the trunk the
          // lobes are actually fluting.
          const zone = Math.max(0.2, segments[0].radius0 * 5);
          radius *= 1 + plant.structure.buttress * Math.max(0, 1 - point.y / zone) ** 2
            * fluting(azimuth, lobes, flutingPhase);
        }
        if (plant && segments[0].parent && i === 0) radius *= 1 + plant.structure.collar;
        const p = point.clone();
        if (segments[0].role === 'root') {
          // The thickening is reported within the zone of rapid taper, so it is
          // strongest at the stump and relaxes to a round runner further out.
          const beam = 1 - stations[i].blend;
          // A T-beam is an internal structural section, not a silhouette. What shows
          // above ground is a broad mass spread against the soil: wide across, domed
          // over the top, flat beneath. Treating the reported depth as silhouette
          // depth produced knives standing on edge.
          const flatten = plant.structure.rootFlatten;
          const wide = 1 + (flatten - 1) * beam;
          const crown = 1 + (1 / Math.sqrt(flatten) - 1) * beam;
          const belly = 1 + (1 / flatten - 1) * beam;
          // A true ellipse on world-aligned axes, not an angular gauge blend: scaling
          // a circle's radius by direction leaves raised shoulders near 45 degrees
          // that stand higher than the pole, which is the knife edge coming back.
          const across = ROOT_ACROSS.crossVectors(tangent, ROOT_UP);
          if (across.lengthSq() < 1e-6) across.copy(right);
          across.normalize();
          const overIt = ROOT_OVER.crossVectors(across, tangent).normalize();
          const rise = Math.sin(angle);
          p.addScaledVector(across, Math.cos(angle) * radius * wide)
            .addScaledVector(overIt, rise * radius * (rise > 0 ? crown : belly));
        } else {
          p.addScaledVector(right, Math.cos(angle) * radius).addScaledVector(forward, Math.sin(angle) * radius);
        }
        positions.push(p.x, p.y, p.z);
        const wrap = segments[0].role === 'root' && trunkRadius > 0
          ? Math.max(ROOT_BARK_MIN_WRAP, Math.min(1, stations[i].radius / trunkRadius))
          : 1;
        uvs.push(j / ringCount * wrap, length);
        // Seating translates the station onto the soil; retain each vertex's
        // height around that station or the outer ring collapses into a flat fin.
        rootBlend.push(stations[i].blend, stations[i].surface
          + (segments[0].role === 'root' ? p.y - point.y : 0));
        if (i && j < ringCount) {
          const a = start + (i - 1) * (ringCount + 1) + j, b = a + ringCount + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    // End caps only, using existing perimeter vertices.
    for (const [ring, reverse] of [[start, true], [start + (stations.length - 1) * (ringCount + 1), false]]) {
      for (let j = 1; j < ringCount - 1; j++) indices.push(ring, ring + (reverse ? j + 1 : j), ring + (reverse ? j : j + 1));
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
export function compileTreeGeometry(skeleton, { radialSegments = 9, leafStride = 1, plant, includeRoots = true, branchTolerance = 0 } = {}) {
  if (!Number.isFinite(branchTolerance) || branchTolerance < 0) throw new RangeError('Branch tolerance must be finite and non-negative');
  radialSegments = Math.max(3, Math.round(radialSegments)); leafStride = Math.max(1, Math.round(leafStride));
  const foliageVertices = [...skeleton.leaves, ...skeleton.blossoms].reduce((n, leaf, i) => n + (i % leafStride ? 0 : 12 * (['compound', 'pinnate', 'spray', 'cluster'].includes(leaf.shape) ? leaf.leaflets ?? 9 : leaf.shape === 'flower' ? 5 : 1)), 0);
  if (foliageVertices + skeleton.segments.length * (radialSegments + 1) * 2 > 1000000) throw new RangeError('Plant geometry exceeds one million vertices; reduce foliage count, leaflets, or radial resolution');
  return { branches: woodGeometry(skeleton, radialSegments, plant, includeRoots, branchTolerance), leaves: foliageGeometry(skeleton.leaves, leafStride), blossoms: foliageGeometry(skeleton.blossoms, leafStride) };
}
export function packTreeGeometry(geometry) {
  return Object.fromEntries(Object.entries(geometry).map(([key, mesh]) => [key, { position: mesh.attributes.position.array, normal: mesh.attributes.normal.array, uv: mesh.attributes.uv.array, rootBlend: mesh.attributes.rootBlend.array, ...(mesh.attributes.color ? { color: mesh.attributes.color.array } : {}), index: mesh.index.array }]));
}
export function unpackTreeGeometry(packed) {
  return Object.fromEntries(Object.entries(packed).map(([key, mesh]) => {
    const geometry = new BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['rootBlend', 2]]) {
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
