import {
  BufferAttribute, BufferGeometry, ClampToEdgeWrapping, DoubleSide, Group,
  InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, LinearMipmapLinearFilter, Matrix4, Mesh, NoColorSpace, Object3D, RepeatWrapping,
  SRGBColorSpace, TextureLoader, Vector3,
} from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import {
  EnvironmentNode, IndirectStorageBufferAttribute, MeshBasicNodeMaterial, MeshLambertNodeMaterial,
  MeshStandardNodeMaterial, PhongLightingModel, StorageBufferAttribute,
  StorageInstancedBufferAttribute,
} from 'three/webgpu';
import {
  atomicAdd, atomicStore, attribute, BRDF_Lambert, cameraPosition, diffuseColor, float, Fn, If, instanceIndex, mix,
  modelWorldMatrix, modelWorldMatrixInverse, mrt, normalLocal, positionGeometry, positionLocal, positionWorld,
  storage, texture, transformNormalToView, uint, uniform, vec3, vec4,
} from 'three/tsl';
import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';
import {
  disposeComputeNodes, disposeWebGPUAttributes, disposeWebGPUGeometries,
} from './WebGPUResourceDisposal.js';

const textureLoader = new TextureLoader();
const ktx2Loaders = new WeakMap();
const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);
const BROADLEAF_SPECIES = new Set(['valley-oak', 'sugar-maple', 'southern-live-oak']);
const OAK_SPECIES = new Set(['valley-oak', 'southern-live-oak']);

function isBroadleafSpecies(speciesId) { return BROADLEAF_SPECIES.has(speciesId); }
function isOakSpecies(speciesId) { return OAK_SPECIES.has(speciesId); }

// SceneManager publishes one shared PMREM through the node builder. Generated
// foliage must consume that same environment and the real scene lights; otherwise
// its cards cast convincing shadows while remaining visually self-lit.
class SharedEnvironmentGeneratedFoliageLambertLightingModel extends PhongLightingModel {
  constructor() {
    super(false);
  }

  indirect(builder) {
    super.indirect(builder);
    const { iblIrradiance, reflectedLight } = builder.context;
    reflectedLight.indirectDiffuse.addAssign(
      iblIrradiance.mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })),
    );
  }
}

class SharedEnvironmentGeneratedFoliageLambertMaterial extends MeshLambertNodeMaterial {
  setupOutput(builder, outputNode) {
    if (!this.treeEnvironment) return super.setupOutput(builder, outputNode);
    const toCamera = cameraPosition.sub(positionWorld);
    const aerialRgb = this.treeEnvironment.aerialPerspective(
      outputNode.rgb,
      toCamera,
      toCamera.length(),
    );
    return vec4(aerialRgb, outputNode.a);
  }

  setupEnvironment(builder) {
    return builder.environmentNode ? new EnvironmentNode(builder.environmentNode) : null;
  }

  setupLightingModel() {
    return new SharedEnvironmentGeneratedFoliageLambertLightingModel();
  }
}

class SharedEnvironmentGeneratedStructureMaterial extends MeshStandardNodeMaterial {
  setupOutput(builder, outputNode) {
    if (!this.treeEnvironment) return super.setupOutput(builder, outputNode);
    const toCamera = cameraPosition.sub(positionWorld);
    const aerialRgb = this.treeEnvironment.aerialPerspective(
      outputNode.rgb,
      toCamera,
      toCamera.length(),
    );
    return vec4(aerialRgb, outputNode.a);
  }

  setupEnvironment(builder) {
    return builder.environmentNode ? new EnvironmentNode(builder.environmentNode) : null;
  }
}

function fallbackHull() {
  return [[0, 0.16], [0.08, 0.04], [0.78, 0], [1, 0.18], [1, 0.80], [0.82, 1], [0.10, 0.95], [0, 0.76]];
}

function pushVec3(target, value) { target.push(value.x, value.y, value.z); }

function setFoliageHierarchyAttributes(geometry, builder) {
  const vertexCount = builder.anchors.length / 3;
  const packed = new Float32Array(vertexCount * 15);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * 3;
    const target = vertex * 15;
    for (let axis = 0; axis < 3; axis++) {
      packed[target + axis] = builder.anchors[source + axis];
      packed[target + 3 + axis] = builder.hierarchyAnchors[source + axis];
      packed[target + 6 + axis] = builder.foliageParams[source + axis];
      packed[target + 9 + axis] = builder.cardAxes[source + axis];
      packed[target + 12 + axis] = builder.cardUps[source + axis];
    }
  }
  const hierarchy = new InterleavedBuffer(packed, 15);
  geometry.setAttribute('foliageAnchor', new InterleavedBufferAttribute(hierarchy, 3, 0));
  geometry.setAttribute('hierarchyAnchor', new InterleavedBufferAttribute(hierarchy, 3, 3));
  geometry.setAttribute('foliageParams', new InterleavedBufferAttribute(hierarchy, 3, 6));
  geometry.setAttribute('foliageAxis', new InterleavedBufferAttribute(hierarchy, 3, 9));
  geometry.setAttribute('foliageCardUp', new InterleavedBufferAttribute(hierarchy, 3, 12));
}

function appendTaperedSegment(builder, start, end, startRadius, endRadius, bendBase, sides = 7) {
  const axis = end.clone().sub(start).normalize();
  const tangent = Math.abs(axis.y) < 0.92 ? axis.clone().cross(UP).normalize() : new Vector3(1, 0, 0);
  const bitangent = axis.clone().cross(tangent).normalize();
  // Adjacent crooked cylinders have differently oriented end-ring planes. Rings
  // that merely touch at the shared center leave visible wedge cracks and expose
  // the dark open interior. Radius-scaled axial overlap buries branch starts in
  // their parent and closes elbows without adding another joint draw or fake cap.
  const ringCenters = [
    start.clone().addScaledVector(axis, -Math.max(0.012, startRadius * 0.62)),
    end.clone().addScaledVector(axis, Math.max(0.010, endRadius * 0.72)),
  ];
  const base = builder.positions.length / 3;
  for (let ring = 0; ring < 2; ring++) {
    const center = ringCenters[ring];
    const radius = ring ? endRadius : startRadius;
    for (let side = 0; side < sides; side++) {
      const angle = side / sides * TAU;
      const radial = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
      pushVec3(builder.positions, center.clone().addScaledVector(radial, radius));
      pushVec3(builder.normals, radial);
      builder.uvs.push(side / sides * 2, ring * Math.max(0.35, start.distanceTo(end) * 0.55));
      builder.bend.push(ring ? Math.min(1, bendBase + 0.18) : bendBase);
    }
  }
  const startCap = builder.positions.length / 3;
  pushVec3(builder.positions, ringCenters[0]);
  pushVec3(builder.normals, axis.clone().negate());
  builder.uvs.push(0.5, 0);
  builder.bend.push(bendBase);
  const endCap = builder.positions.length / 3;
  pushVec3(builder.positions, ringCenters[1]);
  pushVec3(builder.normals, axis);
  builder.uvs.push(0.5, Math.max(0.35, start.distanceTo(end) * 0.55));
  builder.bend.push(Math.min(1, bendBase + 0.18));
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    const a = base + side, b = base + next, c = base + sides + side, d = base + sides + next;
    // Counter-clockwise from outside the tapered segment. The previous order was
    // inward-facing while the authored vertex normals pointed outward, so front-face
    // culling exposed the far interior wall and made bark read as an untextured dark
    // silhouette—most obvious on Monterey's open trunk and leaders.
    builder.indices.push(a, b, c, b, d, c);
    // Closed caps are normally buried inside the radius-scaled overlap. If a
    // thicker child joins a strongly tapered parent, they prevent the remaining
    // exposed ring from showing sky or the unlit cylinder interior.
    builder.indices.push(startCap, b, a, endCap, c, d);
  }
}

function appendTaperedTrunk(builder, points, radii, sides = 9) {
  if (points.length < 2 || points.length !== radii.length) {
    throw new Error('Continuous generated trunk requires matching point and radius arrays.');
  }
  const base = builder.positions.length / 3;
  const ringStride = sides + 1;
  let vDistance = 0;
  for (let ring = 0; ring < points.length; ring++) {
    if (ring > 0) vDistance += points[ring].distanceTo(points[ring - 1]);
    const previous = points[Math.max(0, ring - 1)];
    const next = points[Math.min(points.length - 1, ring + 1)];
    const axis = next.clone().sub(previous).normalize();
    const tangent = Math.abs(axis.y) < 0.92 ? axis.clone().cross(UP).normalize() : new Vector3(1, 0, 0);
    const bitangent = axis.clone().cross(tangent).normalize();
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * TAU;
      const radial = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
      pushVec3(builder.positions, points[ring].clone().addScaledVector(radial, radii[ring]));
      pushVec3(builder.normals, radial);
      builder.uvs.push(side / sides * 2, vDistance * 0.55);
      builder.bend.push(ring / (points.length - 1) * 0.18);
    }
  }
  for (let ring = 0; ring < points.length - 1; ring++) {
    const lower = base + ring * ringStride;
    const upper = lower + ringStride;
    for (let side = 0; side < sides; side++) {
      const a = lower + side, b = a + 1, c = upper + side, d = c + 1;
      builder.indices.push(a, b, c, b, d, c);
    }
  }
  // Only the exposed ends are capped. The old per-segment caps overlapped inside
  // the trunk and produced depth/lighting bands at every bend.
  const startAxis = points[1].clone().sub(points[0]).normalize();
  const endAxis = points.at(-1).clone().sub(points.at(-2)).normalize();
  const startCap = builder.positions.length / 3;
  pushVec3(builder.positions, points[0]); pushVec3(builder.normals, startAxis.negate());
  builder.uvs.push(0.5, 0); builder.bend.push(0);
  const endCap = builder.positions.length / 3;
  pushVec3(builder.positions, points.at(-1)); pushVec3(builder.normals, endAxis);
  builder.uvs.push(0.5, vDistance * 0.55); builder.bend.push(0.18);
  const lastRing = base + (points.length - 1) * ringStride;
  for (let side = 0; side < sides; side++) {
    builder.indices.push(startCap, base + side + 1, base + side);
    builder.indices.push(endCap, lastRing + side, lastRing + side + 1);
  }
}

// Broadleaf leaders and the visible trunk must be generated from one curve.  The
// old pair of implementations used the same broad shape but independent phase and
// lean values, which left a small sky slit between a fork and the trunk on some
// seeds.  Replaying the first deterministic random values keeps the authoring
// stream unchanged while giving structuralGeometry the exact skeleton curve.
function replayBroadleafTrunkParams(height, seed, speciesId) {
  const random = createRng(deriveSeed(seed, `${speciesId}-forked-broadleaf-crown`));
  random(); // phase
  random(); // spreadScale
  random(); // riseScale
  return {
    trunkHeight: height * (isOakSpecies(speciesId) ? 0.29 : 0.25),
    trunkLeanScaleX: 0.72 + random() * 0.62,
    trunkLeanScaleZ: 0.72 + random() * 0.62,
    trunkPhaseX: random() * 1.8,
    trunkPhaseZ: random() * 1.8,
  };
}

function broadleafTrunkCurve(height, speciesId, params) {
  return (y) => {
    const trunkHeight = params.trunkHeight;
    const t = Math.min(1, Math.max(0, y / trunkHeight));
    return new Vector3(
      Math.sin(t * 6.2 + 0.4 + params.trunkPhaseX) * 0.055 * t
        + Math.sin(t * 4.1 + 0.7 + params.trunkPhaseX)
          * (isOakSpecies(speciesId) ? 0.34 : 0.18) * params.trunkLeanScaleX * t,
      y,
      Math.sin(t * 4.7 + 1.7 + params.trunkPhaseZ) * 0.045 * t
        + Math.sin(t * 3.2 + 1.2 + params.trunkPhaseZ)
          * 0.16 * params.trunkLeanScaleZ * t,
    );
  };
}

// Shadow casters use a connected, opaque canopy hull rather than the sparse alpha
// cards used for beauty.  This keeps projected shadows organic and continuous while
// avoiding the large pixelated shadow islands produced when every far card is a
// separate hard alpha silhouette.  The hull is deliberately low-poly: it exists on
// the shadow layer only and does not compete with the authored foliage geometry.
function connectedShadowGeometry(speciesId) {
  const broadleaf = isBroadleafSpecies(speciesId);
  const oak = isOakSpecies(speciesId);
  const pine = speciesId === 'loblolly-pine';
  const profile = oak
    ? [[0.00, 0.055], [0.10, 0.065], [0.22, 0.15], [0.40, 0.34], [0.60, 0.48], [0.77, 0.41], [0.91, 0.25], [1.00, 0.045]]
    : pine
      ? [[0.00, 0.070], [0.08, 0.13], [0.20, 0.28], [0.42, 0.25], [0.64, 0.19], [0.82, 0.12], [0.95, 0.06], [1.00, 0.018]]
      : broadleaf
        ? [[0.00, 0.055], [0.12, 0.08], [0.30, 0.20], [0.52, 0.31], [0.73, 0.27], [0.90, 0.16], [1.00, 0.035]]
        : [[0.00, 0.060], [0.10, 0.12], [0.24, 0.25], [0.44, 0.24], [0.66, 0.18], [0.84, 0.11], [1.00, 0.025]];
  const sides = 10;
  const positions = [];
  const indices = [];
  for (const [y, radius] of profile) {
    for (let side = 0; side < sides; side++) {
      const angle = side / sides * TAU;
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, profile[0][0], 0);
  const top = positions.length / 3;
  positions.push(0, profile.at(-1)[0], 0);
  for (let ring = 0; ring < profile.length - 1; ring++) {
    const lower = ring * sides;
    const upper = lower + sides;
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      indices.push(lower + side, lower + next, upper + side,
        lower + next, upper + next, upper + side);
    }
  }
  const first = 0;
  const last = (profile.length - 1) * sides;
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    indices.push(bottom, first + next, first + side, top, last + side, last + next);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function connectedShadowWidth(speciesId) {
  if (isOakSpecies(speciesId)) return 0.50;
  if (speciesId === 'loblolly-pine') return 0.34;
  if (isBroadleafSpecies(speciesId)) return 0.37;
  return 0.31;
}

function structuralGeometry({ height, seed, branches, speciesId = 'douglas-fir' }) {
  const builder = { positions: [], normals: [], uvs: [], bend: [], indices: [] };
  const random = createRng(deriveSeed(seed, 'structural-skeleton'));
  const broadleaf = isBroadleafSpecies(speciesId);
  const oak = isOakSpecies(speciesId);
  const trunkSegments = speciesId === 'monterey-cypress' ? 10 : broadleaf ? 9 : 11;
  // Monterey cypress commonly resolves its main stem into broad, persistent
  // leaders well below the crown top. Continuing one procedural pole through
  // 80% of the tree made the exposed architecture read as pollarded topiary.
  const broadleafParams = broadleaf ? replayBroadleafTrunkParams(height, seed, speciesId) : null;
  const trunkHeight = broadleaf ? broadleafParams.trunkHeight : speciesId === 'monterey-cypress' ? height * 0.54
    : oak ? height * 0.29
      : speciesId === 'sugar-maple' ? height * 0.25 : height;
  const trunkPointAt = (t) => {
    if (broadleaf) return broadleafTrunkCurve(height, speciesId, broadleafParams)(
      t === 0 ? -0.22 : trunkHeight * t,
    );
    const montereyLean = speciesId === 'monterey-cypress' ? Math.pow(t, 1.35) * 1.05 : 0;
    const italianLean = speciesId === 'italian-cypress' ? Math.sin(t * 3.4) * 0.08 * t : 0;
    const broadleafLean = broadleaf ? Math.sin(t * 4.1 + 0.7) * (oak ? 0.34 : 0.18) * t : 0;
    return new Vector3(
      Math.sin(t * 6.2 + 0.4) * 0.055 * t + montereyLean + italianLean + broadleafLean,
      t === 0 ? -0.22 : trunkHeight * t,
      Math.sin(t * 4.7 + 1.7) * 0.045 * t
        + (speciesId === 'monterey-cypress' ? Math.sin(t * 2.7) * 0.34 * t : 0)
        + (broadleaf ? Math.sin(t * 3.2 + 1.2) * 0.16 * t : 0),
    );
  };
  const trunkScale = speciesId === 'monterey-cypress' ? 1.38 : speciesId === 'italian-cypress' ? 0.78
    : oak ? 2.05 : speciesId === 'sugar-maple' ? 1.48 : 1;
  const trunkRadiusAt = (t) => oak ? 0.42 + 0.46 * Math.pow(1 - t, 1.35)
    : speciesId === 'sugar-maple' ? 0.27 + 0.35 * Math.pow(1 - t, 1.35)
      : (0.055 + 0.34 * Math.pow(1 - t, 1.45)) * trunkScale;
  const trunkPoints = [];
  const trunkRadii = [];
  for (let segment = 0; segment <= trunkSegments; segment++) {
    const t = segment / trunkSegments;
    trunkPoints.push(trunkPointAt(t));
    trunkRadii.push(trunkRadiusAt(t));
  }
  appendTaperedTrunk(builder, trunkPoints, trunkRadii, 9);
  const rootCount = speciesId === 'monterey-cypress' ? 9 : speciesId === 'italian-cypress' ? 5 : broadleaf ? 8 : 7;
  for (let root = 0; root < rootCount; root++) {
    const angle = root / rootCount * TAU + random() * 0.3;
    const length = (1.05 + random() * 0.8) * (speciesId === 'monterey-cypress' ? 1.3
      : speciesId === 'italian-cypress' ? 0.66 : oak ? 1.55 : broadleaf ? 1.2 : 1);
    appendTaperedSegment(builder, new Vector3(0, 0.12, 0), new Vector3(
      Math.cos(angle) * length, -0.10 - random() * 0.16, Math.sin(angle) * length,
    ), broadleaf ? (oak ? 0.42 : 0.31) + random() * 0.06
      : 0.22 + random() * 0.05, 0.035, 0, 7);
  }
  for (const branch of branches) {
    appendTaperedSegment(builder, branch.start, branch.mid, branch.radius, branch.radius * 0.58, branch.heightFraction * 0.52, 6);
    appendTaperedSegment(builder, branch.mid, branch.end, branch.radius * 0.58, branch.radius * 0.12, branch.heightFraction * 0.68, 6);
    for (const secondary of branch.secondaries) {
      appendTaperedSegment(builder, secondary.start, secondary.end, branch.radius * 0.24, 0.018, branch.heightFraction * 0.76, 5);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(builder.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(builder.uvs), 2));
  geometry.setAttribute('treeBend', new BufferAttribute(new Float32Array(builder.bend), 1));
  geometry.setIndex(builder.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function appendHullCard(builder, { base, direction, width, length, roll, cluster, hierarchyAnchor, hierarchyRadius, lodBand, bendStrength }) {
  const forward = direction.clone().normalize();
  const tangent = Math.abs(forward.y) < 0.94 ? forward.clone().cross(UP).normalize() : new Vector3(1, 0, 0);
  const vertical = tangent.clone().cross(forward).normalize();
  const cardUp = vertical.multiplyScalar(Math.cos(roll)).addScaledVector(tangent, Math.sin(roll)).normalize();
  const cardNormal = forward.clone().cross(cardUp).normalize();
  const hull = cluster.supportHullUv ?? fallbackHull();
  const vertexBase = builder.positions.length / 3;
  for (const [hullU, hullV] of hull) {
    let branchU;
    let lateral;
    if (cluster.attachmentFrame) {
      const { baseUv, axisUv, growthExtent, lateralHalfExtent } = cluster.attachmentFrame;
      const du = hullU - baseUv[0];
      const dv = hullV - baseUv[1];
      branchU = (du * axisUv[0] + dv * axisUv[1]) / growthExtent;
      lateral = (du * -axisUv[1] + dv * axisUv[0]) / (lateralHalfExtent * 2);
    } else {
      branchU = cluster.baseEdge === 'right' ? 1 - hullU
        : cluster.baseEdge === 'bottom' ? hullV
          : cluster.baseEdge === 'top' ? 1 - hullV : hullU;
      lateral = cluster.baseEdge === 'bottom' || cluster.baseEdge === 'top' ? hullU - 0.5 : hullV - 0.5;
    }
    const point = base.clone().addScaledVector(forward, branchU * length)
      .addScaledVector(cardUp, lateral * width);
    pushVec3(builder.positions, point);
    pushVec3(builder.normals, cardNormal);
    builder.uvs.push(
      cluster.uv.u0 + (cluster.uv.u1 - cluster.uv.u0) * hullU,
      cluster.uv.v0 + (cluster.uv.v1 - cluster.uv.v0) * hullV,
    );
    pushVec3(builder.anchors, base);
    pushVec3(builder.hierarchyAnchors, hierarchyAnchor);
    pushVec3(builder.cardAxes, forward);
    pushVec3(builder.cardUps, cardUp);
    builder.foliageParams.push(hierarchyRadius, lodBand, branchU * bendStrength);
  }
  for (let vertex = 1; vertex < hull.length - 1; vertex++) {
    builder.indices.push(vertexBase, vertexBase + vertex, vertexBase + vertex + 1);
  }
  builder.cards++;
  builder.cardsByBand[lodBand]++;
}

function crownProfile(t, phase) {
  const taper = 4.35 * Math.pow(Math.max(0, 1 - t), 0.72);
  const irregularity = 0.88 + Math.sin(t * 17.3 + phase) * 0.16 + Math.sin(t * 41.1 + phase * 0.7) * 0.075;
  return Math.max(0.32, taper * irregularity);
}

function buildDouglasBranchSkeleton(height, seed) {
  const random = createRng(deriveSeed(seed, 'douglas-fir-branch-whorls'));
  const branches = [];
  // More, smaller growth intervals avoid the stacked 1 m shelf cadence of the
  // earlier 17-whorl prototype without inflating the primary branch budget.
  const levels = 23;
  const crownPhase = random() * TAU;
  const prevailingSide = random() * TAU;
  for (let level = 0; level < levels; level++) {
    const t = level / (levels - 1);
    const y = 1.35 + t * (height - 1.95) + (random() - 0.5) * 0.30;
    const radius = crownProfile(t, crownPhase);
    const count = level < 9 ? 6 : level < 18 ? 5 : 4;
    const whorlOffset = level * 1.731 + random() * 0.48;
    for (let branchIndex = 0; branchIndex < count; branchIndex++) {
      if ((level * 5 + branchIndex * 3) % 11 === 0 || (level === 6 && branchIndex === 2)) continue;
      const azimuth = whorlOffset + branchIndex / count * TAU + (random() - 0.5) * 0.20;
      const directionalBias = 0.92 + Math.cos(azimuth - prevailingSide) * 0.16;
      const length = radius * (0.68 + random() * 0.42) * directionalBias;
      const branchY = y + (random() - 0.5) * 0.96;
      const start = new Vector3(Math.cos(azimuth) * 0.10, branchY, Math.sin(azimuth) * 0.10);
      const mid = new Vector3(Math.cos(azimuth) * length * 0.54, branchY + length * (0.02 + random() * 0.035), Math.sin(azimuth) * length * 0.54);
      const end = new Vector3(Math.cos(azimuth) * length, branchY - length * (0.035 + t * 0.018), Math.sin(azimuth) * length);
      const direction = end.clone().sub(start).normalize();
      const tangent = direction.clone().cross(UP).normalize();
      const secondaries = [];
      for (const side of [-1, 1]) {
        const secondaryStart = start.clone().lerp(end, 0.55 + random() * 0.18);
        const secondaryLength = length * (0.20 + random() * 0.10);
        const secondaryDirection = direction.clone().multiplyScalar(0.66)
          .addScaledVector(tangent, side * (0.55 + random() * 0.18)).normalize();
        secondaries.push({ start: secondaryStart, end: secondaryStart.clone().addScaledVector(secondaryDirection, secondaryLength) });
      }
      branches.push({ level, t, heightFraction: y / height, start, mid, end, direction, secondaries,
        radius: 0.10 + 0.15 * Math.pow(1 - t, 1.4), length, azimuth });
    }
  }
  // A small asymmetric leader crown closes the top without continuing the pole.
  for (let leader = 0; leader < 7; leader++) {
    const t = 0.92 + leader / 7 * 0.07;
    const y = height * t;
    const azimuth = leader * 2.39 + crownPhase;
    const length = 0.42 + (1 - t) * 6.5;
    const start = new Vector3(0, y, 0);
    const end = new Vector3(Math.cos(azimuth) * length, y + 0.12 + leader * 0.05, Math.sin(azimuth) * length);
    branches.push({ level: levels + leader, t, heightFraction: t, start, mid: start.clone().lerp(end, 0.55), end,
      direction: end.clone().sub(start).normalize(), secondaries: [], radius: 0.07, length, azimuth });
  }
  return branches;
}

function buildLoblollyPineSkeleton(height, seed) {
  const random = createRng(deriveSeed(seed, 'loblolly-pine-open-layered-whorls'));
  const branches = [];
  const levels = 18;
  const crownPhase = random() * TAU;
  const prevailingSide = random() * TAU;
  for (let level = 0; level < levels; level++) {
    const t = level / (levels - 1);
    const y = 2.0 + t * (height - 3.2) + (random() - 0.5) * 0.34;
    const irregularity = 0.88 + Math.sin(t * 13.7 + crownPhase) * 0.12 + Math.sin(t * 29.1) * 0.06;
    const radius = Math.max(0.62, 5.8 * Math.pow(Math.max(0, 1 - t), 0.52) * irregularity);
    const count = t > 0.82 ? 3 : t > 0.52 ? 4 : 5;
    const whorlOffset = level * 1.47 + random() * 0.52;
    for (let branchIndex = 0; branchIndex < count; branchIndex++) {
      if ((level * 7 + branchIndex * 5) % 17 === 0) continue;
      const azimuth = whorlOffset + branchIndex / count * TAU + (random() - 0.5) * 0.26;
      const directionalBias = 0.90 + Math.cos(azimuth - prevailingSide) * 0.18;
      const length = radius * (0.74 + random() * 0.42) * directionalBias;
      const branchY = y + (random() - 0.5) * 0.80;
      const start = new Vector3(Math.cos(azimuth) * 0.09, branchY, Math.sin(azimuth) * 0.09);
      const radial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
      const tangent = radial.clone().cross(UP).normalize();
      const curve = (random() - 0.5) * Math.min(1.5, length * 0.18);
      const mid = start.clone().addScaledVector(radial, length * 0.52)
        .addScaledVector(tangent, curve * 0.50)
        .addScaledVector(UP, length * (0.005 + random() * 0.035));
      const end = start.clone().addScaledVector(radial, length)
        .addScaledVector(tangent, curve)
        .addScaledVector(UP, length * (-0.04 + random() * 0.10));
      const direction = end.clone().sub(start).normalize();
      const secondaries = [];
      for (const side of [-1, 1]) {
        const secondaryStart = start.clone().lerp(end, 0.48 + random() * 0.22);
        const secondaryLength = length * (0.24 + random() * 0.12);
        const secondaryDirection = direction.clone().multiplyScalar(0.60)
          .addScaledVector(tangent, side * (0.50 + random() * 0.20))
          .addScaledVector(UP, 0.10 + random() * 0.20).normalize();
        secondaries.push({
          start: secondaryStart,
          end: secondaryStart.clone().addScaledVector(secondaryDirection, secondaryLength),
        });
      }
      branches.push({ level, t, heightFraction: branchY / height, start, mid, end, direction, secondaries,
        radius: 0.095 + 0.14 * Math.pow(1 - t, 1.35), length, azimuth });
    }
  }
  // Loblolly tips form a loose candle crown rather than a dense Douglas-fir pole.
  for (let leader = 0; leader < 6; leader++) {
    const t = 0.91 + leader / 6 * 0.08;
    const y = height * t;
    const azimuth = crownPhase + leader * 2.31;
    const length = 0.55 + (1 - t) * 3.0 + random() * 0.24;
    const start = new Vector3(0, y, 0);
    const radial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const end = start.clone().addScaledVector(radial, length).addScaledVector(UP, 0.16 + random() * 0.20);
    branches.push({ level: levels + leader, t, heightFraction: t, start, mid: start.clone().lerp(end, 0.52), end,
      direction: end.clone().sub(start).normalize(), secondaries: [], radius: 0.065, length, azimuth });
  }
  return branches;
}

function buildItalianCypressSkeleton(height, seed) {
  const random = createRng(deriveSeed(seed, 'italian-cypress-ascending-scaffolds'));
  const branches = [];
  const levels = 26;
  const phase = random() * TAU;
  for (let level = 0; level < levels; level++) {
    const t = level / (levels - 1);
    const y = 2.8 + t * (height - 3.5) + (random() - 0.5) * 0.24;
    const crownRadius = Math.max(0.34, (1.52 * Math.pow(1 - t, 0.44) + 0.16) * (0.90 + Math.sin(t * 19 + phase) * 0.08));
    const count = t > 0.82 ? 3 : 4;
    for (let index = 0; index < count; index++) {
      if ((level * 3 + index) % 17 === 0) continue;
      const azimuth = phase + level * 1.89 + index / count * TAU + (random() - 0.5) * 0.22;
      const radial = crownRadius * (0.72 + random() * 0.30);
      const rise = 1.15 + (1 - t) * 0.72 + random() * 0.36;
      const start = new Vector3(Math.sin(y * 0.15) * 0.06, y, 0);
      const mid = start.clone().add(new Vector3(Math.cos(azimuth) * radial * 0.42, rise * 0.48, Math.sin(azimuth) * radial * 0.42));
      const end = start.clone().add(new Vector3(Math.cos(azimuth) * radial, rise, Math.sin(azimuth) * radial));
      const direction = end.clone().sub(start).normalize();
      branches.push({ level, t, heightFraction: y / height, start, mid, end, direction, secondaries: [],
        radius: 0.055 + 0.095 * Math.pow(1 - t, 1.25), length: start.distanceTo(end), azimuth });
    }
  }
  return branches;
}

function buildMontereyCypressSkeleton(height, seed) {
  const random = createRng(deriveSeed(seed, 'monterey-cypress-coastal-scaffolds'));
  const branches = [];
  const phase = random() * TAU;
  const windward = phase + 0.35;
  let level = 0;
  const trunkPoint = (y) => new Vector3(
    Math.pow(y / height, 1.35) * 1.05,
    y,
    Math.sin(y / height * 2.7) * 0.34 * y / height,
  );

  // Three crooked leaders replace the old seven-spoke crown. Each leader forks
  // from the lower trunk, then owns two or three canopy scaffolds. That preserves
  // an exposed base while making the crown read as a hierarchy instead of a wheel.
  const leaderSpecs = [
    { attach: 0.235, azimuth: phase + 0.08, reach: 1.55, rise: 5.45 },
    { attach: 0.292, azimuth: phase + 2.18, reach: 2.15, rise: 5.90 },
    { attach: 0.338, azimuth: phase + 4.34, reach: 1.78, rise: 4.85 },
  ];
  const leaders = leaderSpecs.map((spec, leaderIndex) => {
    const start = trunkPoint(height * spec.attach);
    const radial = new Vector3(Math.cos(spec.azimuth), 0, Math.sin(spec.azimuth));
    const lateral = new Vector3(-radial.z, 0, radial.x);
    const bend = (leaderIndex - 1) * 0.42 + (random() - 0.5) * 0.34;
    const mid = start.clone().addScaledVector(radial, spec.reach * 0.46)
      .addScaledVector(lateral, bend).addScaledVector(UP, spec.rise * 0.42);
    const end = start.clone().addScaledVector(radial, spec.reach)
      .addScaledVector(lateral, bend * 0.55).addScaledVector(UP, spec.rise);
    branches.push({
      level: level++, t: spec.attach, heightFraction: spec.attach,
      start, mid, end, direction: end.clone().sub(start).normalize(), secondaries: [],
      radius: 0.29 - leaderIndex * 0.025, length: start.distanceTo(end),
      azimuth: spec.azimuth, foliage: false,
    });
    return { ...spec, start, mid, end };
  });

  const scaffoldSpecs = [
    { leader: 0, fraction: 0.54, offset: -0.72, scale: 1.02 },
    { leader: 0, fraction: 0.82, offset: 0.42, scale: 0.82 },
    { leader: 1, fraction: 0.48, offset: -0.48, scale: 1.12 },
    { leader: 1, fraction: 0.70, offset: 0.34, scale: 0.92 },
    { leader: 1, fraction: 0.90, offset: 1.02, scale: 0.72 },
    { leader: 2, fraction: 0.55, offset: -0.34, scale: 0.96 },
    { leader: 2, fraction: 0.84, offset: 0.76, scale: 0.84 },
  ];
  for (let scaffoldIndex = 0; scaffoldIndex < scaffoldSpecs.length; scaffoldIndex++) {
    const spec = scaffoldSpecs[scaffoldIndex];
    const leader = leaders[spec.leader];
    const azimuth = leader.azimuth + spec.offset + (random() - 0.5) * 0.28;
    const leewardExposure = Math.cos(azimuth - windward) * 0.5 + 0.5;
    const sideBias = 0.64 + leewardExposure * 0.58;
    const length = (4.35 + random() * 2.1) * sideBias * spec.scale;
    const start = spec.fraction < 0.5
      ? leader.start.clone().lerp(leader.mid, spec.fraction * 2)
      : leader.mid.clone().lerp(leader.end, (spec.fraction - 0.5) * 2);
    const rise = -0.25 + random() * 2.15 + leewardExposure * 0.50;
    const curve = (random() - 0.5) * (0.72 + length * 0.08);
    const radial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const lateral = new Vector3(-radial.z, 0, radial.x);
    const mid = start.clone().addScaledVector(radial, length * 0.48)
      .addScaledVector(lateral, curve).addScaledVector(UP, rise * (0.24 + random() * 0.18));
    const end = start.clone().addScaledVector(radial, length)
      .addScaledVector(lateral, curve * 0.42).addScaledVector(UP, rise);
    const direction = end.clone().sub(start).normalize();
    const scaffold = { level: level++, t: start.y / height, heightFraction: start.y / height, start, mid, end, direction,
      secondaries: [], radius: 0.15 + (scaffoldSpecs.length - scaffoldIndex) * 0.014,
      length: start.distanceTo(end), azimuth, foliage: false };
    branches.push(scaffold);
    const tangent = direction.clone().cross(UP).normalize();
    const sprays = 6 + (scaffoldIndex % 3);
    for (let spray = 0; spray < sprays; spray++) {
      const fraction = 0.26 + spray / Math.max(1, sprays - 1) * 0.68;
      const sprayStart = fraction < 0.52
        ? start.clone().lerp(mid, fraction / 0.52)
        : mid.clone().lerp(end, (fraction - 0.52) / 0.48);
      const side = spray % 2 ? 1 : -1;
      // Wind-sculpted branchlets run along and across the scaffold before their
      // tips turn upward. Alternating flatter and rising sprays create layered
      // pads without forcing every source stem into the same vertical fan.
      const upward = spray % 3 === 0 ? 0.10 + random() * 0.15 : 0.26 + random() * 0.30;
      const sprayDirection = direction.clone().multiplyScalar(0.58 + random() * 0.20)
        .addScaledVector(tangent, side * (0.24 + random() * 0.40))
        .addScaledVector(UP, upward).normalize();
      const sprayLength = 1.75 + random() * 1.75 + fraction * 0.72;
      const sprayEnd = sprayStart.clone().addScaledVector(sprayDirection, sprayLength);
      const secondaries = [];
      for (const twigSide of [-1, 1]) {
        const twigStart = sprayStart.clone().lerp(sprayEnd, 0.52 + random() * 0.20);
        const twigDirection = sprayDirection.clone().multiplyScalar(0.62)
          .addScaledVector(tangent, twigSide * (0.44 + random() * 0.18)).addScaledVector(UP, 0.16).normalize();
        secondaries.push({ start: twigStart, end: twigStart.clone().addScaledVector(twigDirection, sprayLength * (0.28 + random() * 0.12)) });
      }
      const t = Math.min(1, sprayStart.y / height);
      branches.push({ level: level++, t, heightFraction: t, start: sprayStart,
        mid: sprayStart.clone().lerp(sprayEnd, 0.52), end: sprayEnd, direction: sprayDirection, secondaries,
        radius: 0.075 + (1 - fraction) * 0.075, length: sprayLength, azimuth });
    }
  }
  return branches;
}

function pointOnBentBranch(branch, fraction) {
  return fraction < 0.5
    ? branch.start.clone().lerp(branch.mid, fraction * 2)
    : branch.mid.clone().lerp(branch.end, (fraction - 0.5) * 2);
}

function buildBroadleafSkeleton(height, seed, speciesId) {
  const oak = isOakSpecies(speciesId);
  const random = createRng(deriveSeed(seed, `${speciesId}-forked-broadleaf-crown`));
  const branches = [];
  const phase = random() * TAU;
  const spreadScale = oak ? 0.82 + random() * 0.38 : 0.86 + random() * 0.28;
  const riseScale = oak ? 0.86 + random() * 0.28 : 0.90 + random() * 0.22;
  const trunkLeanScaleX = 0.72 + random() * 0.62;
  const trunkLeanScaleZ = 0.72 + random() * 0.62;
  const trunkPhaseX = random() * 1.8;
  const trunkPhaseZ = random() * 1.8;
  const trunkHeight = height * (oak ? 0.29 : 0.25);
  // This is the exact broadleaf trunk curve used by structuralGeometry. Leader
  // starts must sample it rather than approximate a straight line to the top;
  // otherwise a fork can miss the crooked trunk centerline and expose a sky gap.
  const trunkPoint = broadleafTrunkCurve(height, speciesId, {
    trunkHeight,
    trunkLeanScaleX,
    trunkLeanScaleZ,
    trunkPhaseX,
    trunkPhaseZ,
  });
  let level = 0;
  const leaderSpecs = oak
    ? [
      { attach: 0.58, azimuth: phase + 0.12, reach: 5.2, rise: 6.6 },
      { attach: 0.72, azimuth: phase + 2.18, reach: 5.8, rise: 7.5 },
      { attach: 0.86, azimuth: phase + 4.42, reach: 4.6, rise: 8.7 },
    ]
    : [
      { attach: 0.62, azimuth: phase + 0.05, reach: 3.3, rise: 6.8 },
      { attach: 0.76, azimuth: phase + 2.30, reach: 4.0, rise: 7.5 },
      { attach: 0.90, azimuth: phase + 4.35, reach: 3.4, rise: 8.0 },
    ];
  const leaders = leaderSpecs.map((spec, index) => {
    const start = trunkPoint(trunkHeight * spec.attach);
    const azimuth = spec.azimuth + (random() - 0.5) * (oak ? 0.52 : 0.38);
    const reach = spec.reach * spreadScale * (0.88 + random() * 0.24);
    const rise = spec.rise * riseScale * (0.90 + random() * 0.20);
    const radial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const lateral = new Vector3(-radial.z, 0, radial.x);
    const curve = (random() - 0.5) * (oak ? 1.15 : 0.68);
    const mid = start.clone().addScaledVector(radial, reach * 0.48)
      .addScaledVector(lateral, curve).addScaledVector(UP, rise * (oak ? 0.40 : 0.46));
    const end = start.clone().addScaledVector(radial, reach)
      .addScaledVector(lateral, curve * 0.35).addScaledVector(UP, rise);
    const branch = {
      level: level++, t: start.y / height, heightFraction: start.y / height,
      start, mid, end, direction: end.clone().sub(start).normalize(), secondaries: [],
      radius: (oak ? 0.43 : 0.32) - index * 0.035, length: start.distanceTo(end),
      azimuth, foliage: true,
    };
    branches.push(branch);
    return branch;
  });

  // An open-grown mature valley oak needs several generations of persistent
  // lateral structure. Ten evenly separated limbs read as a young landscape
  // tree; sixteen uneven scaffolds create the broad old dome while preserving
  // deliberate windows through the crown.
  const scaffoldCount = oak ? 13 + Math.floor(random() * 7) : 12 + Math.floor(random() * 6);
  const foliageGapPhase = Math.floor(random() * 3);
  for (let scaffoldIndex = 0; scaffoldIndex < scaffoldCount; scaffoldIndex++) {
    const leader = leaders[scaffoldIndex % leaders.length];
    const generation = Math.floor(scaffoldIndex / leaders.length);
    const baseFraction = oak
      ? Math.min(0.88, 0.25 + generation * 0.125 + (scaffoldIndex % 2) * 0.035)
      : Math.min(0.90, 0.25 + generation * 0.14 + (scaffoldIndex % 2) * 0.045);
    const fraction = Math.min(0.92, Math.max(0.18, baseFraction + (random() - 0.5) * 0.075));
    const side = scaffoldIndex % 2 ? 1 : -1;
    const azimuth = leader.azimuth + side * (oak ? 0.56 + generation * 0.11 : 0.55)
      + (random() - 0.5) * (oak ? 0.56 : 0.40);
    const radial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const lateral = new Vector3(-radial.z, 0, radial.x);
    const start = pointOnBentBranch(leader, Math.min(0.92, fraction));
    const length = (oak ? 7.0 : 4.75) + random() * (oak ? 3.0 : 1.65)
      - (oak ? generation * 0.24 : 0);
    const lowerOakLimb = oak && generation < 2;
    const rise = oak ? (lowerOakLimb ? -1.35 + random() * 2.75
      : 0.25 + random() * (2.8 + generation * 0.48))
      : -0.20 + random() * (2.75 + generation * 0.16);
    const curve = (random() - 0.5) * (oak ? 1.75 : 0.72);
    const mid = start.clone().addScaledVector(radial, length * 0.48)
      .addScaledVector(lateral, curve).addScaledVector(UP, rise * 0.40);
    const end = start.clone().addScaledVector(radial, length)
      .addScaledVector(lateral, curve * 0.42).addScaledVector(UP, rise);
    const scaffold = {
      level: level++, t: start.y / height, heightFraction: start.y / height,
      start, mid, end, direction: end.clone().sub(start).normalize(), secondaries: [],
      radius: (oak ? 0.22 : 0.17) * (1.08 - fraction * 0.35), length: start.distanceTo(end),
      azimuth, foliage: (scaffoldIndex + foliageGapPhase) % 3 === 0,
    };
    branches.push(scaffold);

    const shoots = oak ? 7 + Math.floor(random() * 4) : 6 + Math.floor(random() * 4);
    for (let shootIndex = 0; shootIndex < shoots; shootIndex++) {
      const shootFraction = 0.14 + shootIndex / Math.max(1, shoots - 1) * 0.82;
      const shootStart = pointOnBentBranch(scaffold, shootFraction);
      const shootSide = shootIndex % 2 ? 1 : -1;
      const tangent = scaffold.direction.clone().cross(UP).normalize();
      const shootDirection = scaffold.direction.clone().multiplyScalar(oak ? 0.58 : 0.44)
        .addScaledVector(tangent, shootSide * (0.32 + random() * (oak ? 0.44 : 0.34)))
        .addScaledVector(UP, (oak ? 0.16 : 0.60) + random() * (oak ? 0.34 : 0.34)).normalize();
      const shootLength = (oak ? 2.15 : 1.55) + random() * (oak ? 1.9 : 1.35);
      const shootEnd = shootStart.clone().addScaledVector(shootDirection, shootLength);
      const secondaries = [];
      for (const twigSide of [-1, 1]) {
        const twigStart = shootStart.clone().lerp(shootEnd, 0.48 + random() * 0.24);
        const twigDirection = shootDirection.clone().multiplyScalar(0.66)
          .addScaledVector(tangent, twigSide * (0.36 + random() * 0.22))
          .addScaledVector(UP, 0.18 + random() * 0.15).normalize();
        secondaries.push({ start: twigStart,
          end: twigStart.clone().addScaledVector(twigDirection, shootLength * (0.27 + random() * 0.13)) });
      }
      const t = Math.min(1, shootStart.y / height);
      branches.push({
        level: level++, t, heightFraction: t, start: shootStart,
        mid: shootStart.clone().lerp(shootEnd, 0.52), end: shootEnd,
        direction: shootDirection, secondaries,
        radius: (oak ? 0.072 : 0.058) + (1 - shootFraction) * (oak ? 0.045 : 0.034),
        length: shootLength, azimuth,
      });
    }
  }
  return branches;
}

function buildBranchSkeleton(height, seed, speciesId = 'douglas-fir') {
  if (speciesId === 'loblolly-pine') return buildLoblollyPineSkeleton(height, seed);
  if (speciesId === 'italian-cypress') return buildItalianCypressSkeleton(height, seed);
  if (speciesId === 'monterey-cypress') return buildMontereyCypressSkeleton(height, seed);
  if (isBroadleafSpecies(speciesId)) {
    return buildBroadleafSkeleton(height, seed, speciesId);
  }
  return buildDouglasBranchSkeleton(height, seed);
}

function cypressFoliageGeometry(metadata, branches, seed) {
  const builder = { positions: [], normals: [], uvs: [], anchors: [], hierarchyAnchors: [], foliageParams: [], cardAxes: [], cardUps: [],
    indices: [], cards: 0, cardsByBand: [0, 0, 0] };
  const branchCards = [];
  const random = createRng(deriveSeed(seed, `${metadata.species}-foliage-hierarchy`));
  const italian = metadata.species === 'italian-cypress';
  const clusters = metadata.clusters;
  for (const branch of branches) {
    if (branch.foliage === false) continue;
    const bandStart = [...builder.cardsByBand];
    const hierarchyAnchor = branch.start.clone().lerp(branch.end, 0.56);
    const hierarchyRadius = Math.max(0.48, branch.length * (italian ? 0.66 : 0.72));
    const layouts = italian
      ? [
        { band: 0, fractions: [0.04, 0.38, 0.72], planes: 2, scale: 0.62 },
        { band: 1, fractions: [0.12, 0.58], planes: 2, scale: 0.82 },
        { band: 2, fractions: [0.20, 0.62], planes: 2, scale: 0.98 },
      ]
      : [
        { band: 0, fractions: [0.24, 0.52, 0.78], planes: 2, scale: 1.04 },
        { band: 1, fractions: [0.32, 0.68], planes: 2, scale: 1.18 },
        // The production range sees most Monterey crowns through the forced far
        // parent. Three smaller stations retain the rooted pad mass and negative
        // spaces that two oversized tip cards collapsed into a pruned silhouette.
        { band: 2, fractions: [0.20, 0.52, 0.82], planes: 2, scale: 1.16 },
      ];
    for (const layout of layouts) for (const [station, fraction] of layout.fractions.entries()) {
      const clusterIndex = italian
        ? (branch.level * 3 + station + layout.band * 2) % clusters.length
        : (branch.level * 5 + station * 3 + layout.band) % clusters.length;
      const cluster = clusters[clusterIndex];
      const base = branch.start.clone().lerp(branch.end, fraction);
      const remaining = branch.length * Math.max(0.25, 1 - fraction);
      const authored = cluster.recommendedScaleMeters ?? remaining;
      const length = Math.max(italian ? 0.58 : 1.35,
        Math.min(authored * layout.scale, remaining * (italian ? 1.04 : 1.72)) * (0.88 + random() * 0.24));
      const width = italian
        ? Math.max(0.30, Math.min(0.72, length * (0.34 + random() * 0.10)))
        : Math.max(0.82, length / Math.max(0.8, cluster.aspect) * (0.94 + random() * 0.22));
      for (let plane = 0; plane < layout.planes; plane++) {
        const direction = italian
          ? branch.direction.clone().multiplyScalar(0.84).addScaledVector(UP, 0.16).normalize()
          : branch.direction;
        appendHullCard(builder, {
          base, direction, width, length,
          roll: plane * Math.PI * (italian ? 0.49 : 0.54) + (random() - 0.5) * (italian ? 0.28 : 0.48),
          cluster, hierarchyAnchor, hierarchyRadius, lodBand: layout.band,
          bendStrength: italian ? 0.16 + branch.t * 0.08 : 0.23 + branch.t * 0.12,
        });
      }
    }
    if (!italian) for (const [index, secondary] of branch.secondaries.entries()) {
      const cluster = clusters[(branch.level + index * 4 + 3) % clusters.length];
      appendHullCard(builder, {
        base: secondary.start, direction: secondary.end.clone().sub(secondary.start).normalize(),
        width: Math.max(0.54, branch.length * 0.15), length: Math.max(0.86, branch.length * 0.34),
        roll: (random() - 0.5) * 0.54, cluster, hierarchyAnchor, hierarchyRadius,
        lodBand: 0, bendStrength: 0.31,
      });
    }
    branchCards.push({
      anchor: hierarchyAnchor.clone(), radius: hierarchyRadius,
      cardsByBand: builder.cardsByBand.map((count, band) => count - bandStart[band]),
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(builder.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(builder.uvs), 2));
  setFoliageHierarchyAttributes(geometry, builder);
  geometry.setIndex(builder.indices);
  geometry.computeBoundingSphere();
  return { geometry, cards: builder.cards, cardsByBand: builder.cardsByBand, branchCards };
}

function foliageGeometry(metadata, branches, seed) {
  if (metadata.species === 'italian-cypress' || metadata.species === 'monterey-cypress') {
    return cypressFoliageGeometry(metadata, branches, seed);
  }
  if (isBroadleafSpecies(metadata.species)) {
    return broadleafFoliageGeometry(metadata, branches, seed);
  }
  const builder = { positions: [], normals: [], uvs: [], anchors: [], hierarchyAnchors: [], foliageParams: [],
    cardAxes: [], cardUps: [], indices: [], cards: 0, cardsByBand: [0, 0, 0] };
  const branchCards = [];
  const random = createRng(deriveSeed(seed, 'foliage-hierarchy'));
  const clusters = metadata.clusters;
  const collarLevels = new Set();
  const chooseCluster = (branch, outer, offset = 0) => {
    if (outer) return clusters[(branch.level + offset) % 3 === 0 ? 7 : 0];
    if (branch.t < 0.28) return clusters[(branch.level + offset) % 2 ? 3 : 5];
    if (branch.t > 0.74) return clusters[(branch.level + offset) % 3 === 0 ? 4 : 1];
    return clusters[[1, 2, 3, 5][(branch.level + offset) % 4]];
  };
  for (const branch of branches) {
    const bandStart = [...builder.cardsByBand];
    const hierarchyAnchor = branch.start.clone().lerp(branch.end, 0.60);
    const hierarchyRadius = Math.max(0.45, branch.length * 0.62);
    if (!collarLevels.has(branch.level)) {
      collarLevels.add(branch.level);
      const collarCluster = clusters[branch.t > 0.78 ? 5 : 3];
      const collarDirection = branch.direction.clone().multiplyScalar(0.28).addScaledVector(UP, 0.72).normalize();
      for (const lodBand of [0, 1, 2]) for (let plane = 0; plane < 3; plane++) {
        appendHullCard(builder, {
          base: branch.start.clone().add(new Vector3(0, -0.12 + random() * 0.24, 0)),
          direction: collarDirection.clone().applyAxisAngle(UP, plane / 3 * TAU + random() * 0.22),
          width: (0.94 + (1 - branch.t) * 0.42) * (lodBand === 2 ? 1.08 : 1),
          length: (1.16 + (1 - branch.t) * 1.22) * (lodBand === 2 ? 1.08 : 1),
          roll: plane / 3 * Math.PI + (random() - 0.5) * 0.24,
          cluster: collarCluster, hierarchyAnchor, hierarchyRadius, lodBand, bendStrength: 0.18,
        });
      }
    }
    const appendBand = (lodBand, fractions, scale, crossed) => {
      for (let index = 0; index < fractions.length; index++) {
        const fraction = fractions[index];
        const base = branch.start.clone().lerp(branch.end, fraction);
        const outer = fraction > 0.70;
        const cluster = chooseCluster(branch, outer, index + lodBand);
        // A station may reach the structural tip, but it must not extend another
        // half-branch beyond it. The old broad allowance made sun-facing outer
        // cards read as long horizontal shelves in tree-edge-close.
        const remaining = branch.length * Math.max(0.18, 1 - fraction + lodBand * 0.04);
        const scaleVariation = 0.86 + random() * 0.28;
        const length = Math.min(cluster.recommendedScaleMeters ?? remaining, remaining) * scale * scaleVariation;
        const width = Math.max(0.34, length / Math.max(0.85, cluster.aspect) * (outer ? 0.50 : 0.68));
        const planes = crossed ? 2 : 1;
        for (let plane = 0; plane < planes; plane++) {
          const roll = (plane ? Math.PI * 0.53 : 0) + (random() - 0.5) * 0.36;
          appendHullCard(builder, { base, direction: branch.direction, width, length, roll, cluster,
            hierarchyAnchor, hierarchyRadius, lodBand, bendStrength: 0.25 + (1 - branch.t) * 0.12 });
        }
      }
    };
    appendBand(0, [0.20, 0.52, 0.82], 0.86, true);
    // Parent nodes retain enough independently oriented support to represent the
    // children's negative space. Two distant stations are the minimum that avoids
    // collapsing a branch into one planar spear at 100–200 m.
    appendBand(1, [0.18, 0.52, 0.82], 1.18, true);
    appendBand(2, [0.32, 0.72], 1.30, true);
    // Dense core sprays begin at the branch collar and fan around the primary
    // direction. They hide neither trunk nor negative space uniformly: only the
    // two close hierarchy bands receive them, and seeded whorl gaps remain open.
    for (const lodBand of [0, 1]) {
      const core = chooseCluster(branch, false, lodBand + 3);
      for (const side of [-1, 1]) {
        const direction = branch.direction.clone().applyAxisAngle(UP, side * (0.46 + random() * 0.18));
        appendHullCard(builder, {
          base: branch.start.clone().lerp(branch.end, 0.025), direction,
          width: Math.max(0.78, branch.length * (lodBand ? 0.34 : 0.28)),
          length: Math.max(1.05, Math.min(2.55, branch.length * (lodBand ? 0.58 : 0.46))),
          roll: side * 0.68 + (random() - 0.5) * 0.30, cluster: core,
          hierarchyAnchor, hierarchyRadius, lodBand, bendStrength: 0.20,
        });
      }
    }
    // One compact, upward-biased inner spray follows each branch collar. This is
    // targeted trunk-adjacent crown mass, not uniform outer density: it breaks the
    // pole read while leaving the irregular outline and seeded whorl gaps intact.
    const inner = chooseCluster(branch, false, branch.level + 7);
    const innerDirection = branch.direction.clone().multiplyScalar(0.38).addScaledVector(UP, 0.62).normalize();
    for (const lodBand of [0, 2]) appendHullCard(builder, {
      base: branch.start.clone().add(new Vector3(0, (random() - 0.5) * 0.26, 0)),
      direction: innerDirection,
      width: (0.62 + (1 - branch.t) * 0.30) * (lodBand === 2 ? 1.12 : 1),
      length: (0.92 + (1 - branch.t) * 0.72) * (lodBand === 2 ? 1.12 : 1),
      roll: (random() - 0.5) * 0.46, cluster: inner,
      hierarchyAnchor, hierarchyRadius, lodBand, bendStrength: 0.18,
    });
    // LOD0 alone keeps the authored secondary sprays. Their oblique directions
    // turn flat radial shelves into real crown volume at close and front views.
    for (const [secondaryIndex, secondary] of branch.secondaries.entries()) {
      const secondaryDirection = secondary.end.clone().sub(secondary.start).normalize();
      const cluster = chooseCluster(branch, true, secondaryIndex + 5);
      for (let plane = 0; plane < 1; plane++) {
        appendHullCard(builder, {
          base: secondary.start, direction: secondaryDirection,
          width: Math.max(0.38, branch.length * 0.13),
          length: Math.max(0.62, branch.length * 0.30),
          roll: plane * Math.PI * 0.52 + (random() - 0.5) * 0.30,
          cluster, hierarchyAnchor, hierarchyRadius, lodBand: 0, bendStrength: 0.30,
        });
      }
    }
    branchCards.push({
      anchor: hierarchyAnchor.clone(), radius: hierarchyRadius,
      cardsByBand: builder.cardsByBand.map((count, band) => count - bandStart[band]),
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(builder.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(builder.uvs), 2));
  setFoliageHierarchyAttributes(geometry, builder);
  geometry.setIndex(builder.indices);
  geometry.computeBoundingSphere();
  return { geometry, cards: builder.cards, cardsByBand: builder.cardsByBand, branchCards };
}

function broadleafFoliageGeometry(metadata, branches, seed) {
  const builder = { positions: [], normals: [], uvs: [], anchors: [], hierarchyAnchors: [], foliageParams: [], cardAxes: [], cardUps: [],
    indices: [], cards: 0, cardsByBand: [0, 0, 0] };
  const branchCards = [];
  const oak = isOakSpecies(metadata.species);
  const random = createRng(deriveSeed(seed, `${metadata.species}-foliage-hierarchy`));
  const clusters = metadata.clusters;
  const foliageBranches = branches.filter((branch) => branch.foliage !== false);
  for (const branch of foliageBranches) {
    const bandStart = [...builder.cardsByBand];
    const hierarchyAnchor = branch.start.clone().lerp(branch.end, 0.58);
    const hierarchyRadius = Math.max(0.62, branch.length * 0.78);
    const layouts = [
      { band: 0, fractions: [0.08, 0.56], planes: 2, scale: oak ? 0.82 : 0.76 },
      { band: 1, fractions: [0.18, 0.64], planes: 1, scale: oak ? 1.02 : 0.96 },
      { band: 2, fractions: [0.22, 0.68], planes: 1, scale: oak ? 1.16 : 1.10 },
    ];
    for (const layout of layouts) for (const [station, fraction] of layout.fractions.entries()) {
      const outer = fraction > 0.52;
      const clusterIndex = outer
        ? [0, 2, 4, 7][(branch.level + station + layout.band) % 4]
        : [1, 3, 5, 6][(branch.level * 3 + station + layout.band) % 4];
      const cluster = clusters[clusterIndex];
      const base = branch.start.clone().lerp(branch.end, fraction);
      const remaining = branch.length * Math.max(0.30, 1 - fraction);
      const authored = cluster.recommendedScaleMeters ?? remaining;
      const length = Math.max(0.82, Math.min(authored * layout.scale, remaining * 1.55))
        * (0.88 + random() * 0.22);
      const width = Math.max(0.72, length / Math.max(0.58, cluster.aspect) * (oak ? 0.78 : 0.70));
      for (let plane = 0; plane < layout.planes; plane++) appendHullCard(builder, {
        base, direction: branch.direction, width, length,
        roll: plane * Math.PI * 0.54 + (random() - 0.5) * 0.48,
        cluster, hierarchyAnchor, hierarchyRadius, lodBand: layout.band,
        bendStrength: 0.27 + branch.t * 0.10,
      });
    }
    for (const [index, secondary] of branch.secondaries.entries()) {
      const cluster = clusters[[0, 2, 4, 7][(branch.level + index) % 4]];
      const direction = secondary.end.clone().sub(secondary.start).normalize();
      appendHullCard(builder, {
        base: secondary.start, direction,
        width: Math.max(0.62, branch.length * (oak ? 0.27 : 0.24)),
        length: Math.max(0.78, branch.length * (oak ? 0.48 : 0.43)),
        roll: (index ? 0.72 : -0.72) + (random() - 0.5) * 0.34,
        cluster, hierarchyAnchor, hierarchyRadius, lodBand: 0, bendStrength: 0.34,
      });
    }
    branchCards.push({
      anchor: hierarchyAnchor.clone(), radius: hierarchyRadius,
      cardsByBand: builder.cardsByBand.map((count, band) => count - bandStart[band]),
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(builder.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(builder.uvs), 2));
  setFoliageHierarchyAttributes(geometry, builder);
  geometry.setIndex(builder.indices);
  geometry.computeBoundingSphere();
  return { geometry, cards: builder.cards, cardsByBand: builder.cardsByBand, branchCards };
}

function structuralMaterial(environment, bark, {
  instanced = false, motionHistory = null, placementNode = null, yawNode = null, speciesId = 'douglas-fir',
} = {}) {
  // Pine Tree 01's bark scan is deliberately dark for its dense source canopy.
  // Monterey exposes broad leaders to blue sky-shadow, where that calibration
  // otherwise collapses the real fissure pattern into a near-black silhouette.
  // This bounded linear diffuse gain preserves standard PBR lighting and shadows.
  const material = new SharedEnvironmentGeneratedStructureMaterial({
    roughness: 0.94, metalness: 0,
  });
  material.treeEnvironment = environment;
  material.fog = false;
  const barkAlbedo = texture(bark.albedo).rgb;
  // Source-normalize the measured scans to one matte bark reflectance target.
  // Oak/maple average 112/102/92 sRGB while Monterey averages 63/55/50; these
  // bounded linear gains compensate that capture exposure difference without
  // changing the shared light or reintroducing per-placement highlights.
  const normalizedBark = speciesId === 'monterey-cypress'
    ? barkAlbedo.mul(vec3(4.40, 4.10, 3.80))
    : barkAlbedo.mul(vec3(1.55, 1.50, 1.45));
  // Sparse pale fissures in the broadleaf scan reach 205 sRGB. Exposure
  // normalization pushed those texels close to linear white, drawing false bright
  // contours along grazing branch silhouettes even under a 0.94-roughness BRDF.
  // Bound source reflectance—not lighting—at a warm bark ceiling so direct sun,
  // PMREM fill, canopy shadow, and aerial perspective remain authoritative.
  material.colorNode = normalizedBark.min(vec3(0.46, 0.40, 0.34));
  const bend = attribute('treeBend', 'float');
  const placement = instanced ? (placementNode ?? attribute('treePlacement', 'vec4')) : null;
  const yaw = instanced ? (yawNode ?? attribute('treeYaw', 'float')) : null;
  const rotateYaw = (v) => instanced ? vec3(
    v.x.mul(yaw.cos()).add(v.z.mul(yaw.sin())), v.y,
    v.x.mul(yaw.sin()).negate().add(v.z.mul(yaw.cos())),
  ) : v;
  // Placement yaw is authored in the storage transform rather than Object3D's
  // model matrix, so NodeMaterial cannot rotate the normal automatically. Using an
  // unrotated tangent-space normal map made otherwise identical trunks alternate
  // between black and polished as their placement yaw changed. Keep the continuous
  // geometry normal in the exact same frame as position until a yaw-aware TBN is
  // available for the scanned detail normal.
  const structureNormalWorld = rotateYaw(normalLocal).normalize();
  material.normalNode = transformNormalToView(structureNormalWorld)
    .toVarying('vGeneratedStructureViewNormal').normalize();
  const rootWorld = instanced ? placement.xyz : modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
  const wind = environment.windAt(rootWorld, environment.time);
  const previousWind = environment.windAt(rootWorld, environment.previousTime);
  const sourcePosition = instanced ? positionGeometry : positionLocal;
  const heightWeight = sourcePosition.y.max(0).mul(0.006).mul(bend).mul(instanced ? placement.w : float(1));
  const staticPosition = instanced
    ? rotateYaw(sourcePosition.mul(placement.w)).add(placement.xyz)
    : sourcePosition;
  const currentLocal = staticPosition.add(vec3(wind.x, 0, wind.z).mul(heightWeight));
  const previousLocal = staticPosition.add(vec3(previousWind.x, 0, previousWind.z).mul(heightWeight));
  material.positionNode = currentLocal;
  if (motionHistory) {
    const currentWorld = modelWorldMatrix.mul(vec4(currentLocal, 1)).xyz;
    const previousWorld = modelWorldMatrix.mul(vec4(previousLocal, 1)).xyz;
    const currentClip = motionHistory.currentProjection.mul(motionHistory.currentView.mul(vec4(currentWorld, 1)));
    const previousClip = motionHistory.previousProjection.mul(motionHistory.previousView.mul(vec4(previousWorld, 1)));
    material.mrtNode = mrt({ velocity: currentClip.xy.div(currentClip.w).sub(previousClip.xy.div(previousClip.w))
      .toVarying('vGeneratedStructureVelocity') });
  }
  material.needsUpdate = true;
  return material;
}

function foliageMaterial(atlas, materialMask, environment, projectionScale, motionHistory, {
  instanced = false, placementNode = null, yawNode = null, forceBand = null, debugMode = 'beauty',
  labControls = null, speciesId = 'douglas-fir', currentCameraNode = cameraPosition,
  previousCameraNode = currentCameraNode,
} = {}) {
  const alphaTest = labControls?.alphaTest ?? 0.20;
  const roughnessStrength = labControls?.roughnessStrength ?? 1;
  const normalShaping = labControls?.normalShaping ?? 0;
  const transmissionStrength = labControls?.transmissionStrength ?? 1;
  const farParent = forceBand === 2;
  const material = debugMode === 'beauty'
    ? new SharedEnvironmentGeneratedFoliageLambertMaterial({ side: DoubleSide })
    : new MeshBasicNodeMaterial({ side: DoubleSide });
  if (debugMode === 'beauty') {
    material.treeEnvironment = environment;
    material.fog = false;
  }
  const albedo = texture(atlas);
  const mask = texture(materialMask);
  const placement = instanced ? (placementNode ?? attribute('treePlacement', 'vec4')) : null;
  const yaw = instanced ? (yawNode ?? attribute('treeYaw', 'float')) : null;
  const rotateYaw = (v) => instanced ? vec3(
    v.x.mul(yaw.cos()).add(v.z.mul(yaw.sin())), v.y,
    v.x.mul(yaw.sin()).negate().add(v.z.mul(yaw.cos())),
  ) : v;
  const cameraInPositionSpace = (cameraNode) => instanced
    ? cameraNode : modelWorldMatrixInverse.mul(vec4(cameraNode, 1)).xyz;
  const localCamera = cameraInPositionSpace(currentCameraNode);
  const hierarchyAnchor = attribute('hierarchyAnchor', 'vec3');
  const foliageParams = attribute('foliageParams', 'vec3');
  const hierarchyRadius = foliageParams.x;
  const lodBand = foliageParams.y;
  const hierarchyPosition = instanced
    ? rotateYaw(hierarchyAnchor.mul(placement.w)).add(placement.xyz)
    : hierarchyAnchor;
  const projectedError = hierarchyRadius.mul(instanced ? placement.w : float(1)).mul(projectionScale)
    .div(localCamera.sub(hierarchyPosition).length().max(0.5));
  const lod0 = lodBand.lessThan(0.5).and(projectedError.greaterThan(0.036));
  const lod1 = lodBand.greaterThanEqual(0.5).and(lodBand.lessThan(1.5))
    .and(projectedError.lessThanEqual(0.036)).and(projectedError.greaterThan(0.010));
  const lod2 = lodBand.greaterThanEqual(1.5).and(projectedError.lessThanEqual(0.010));
  const visible = forceBand === 2 ? lodBand.greaterThanEqual(1.5) : lod0.or(lod1).or(lod2);
  const anchor = attribute('foliageAnchor', 'vec3');
  const bend = foliageParams.z;
  const anchorWorld = instanced
    ? rotateYaw(anchor.mul(placement.w)).add(placement.xyz)
    : modelWorldMatrix.mul(vec4(anchor, 1)).xyz;
  const wind = environment.windAt(anchorWorld, environment.time);
  const previousWind = environment.windAt(anchorWorld, environment.previousTime);
  const sourcePosition = instanced ? positionGeometry : positionLocal;
  const sourceRelative = instanced
    ? rotateYaw(sourcePosition.sub(anchor).mul(placement.w))
    : sourcePosition.sub(anchor);
  const cardAxis = instanced
    ? rotateYaw(attribute('foliageAxis', 'vec3')).normalize()
    : attribute('foliageAxis', 'vec3').normalize();
  const authoredCardUp = instanced
    ? rotateYaw(attribute('foliageCardUp', 'vec3')).normalize()
    : attribute('foliageCardUp', 'vec3').normalize();
  const staticAnchor = instanced
    ? rotateYaw(anchor.mul(placement.w)).add(placement.xyz)
    : anchor;
  const axialOffset = cardAxis.mul(sourceRelative.dot(cardAxis));
  const lateralAmount = sourceRelative.dot(authoredCardUp);
  // A card is rooted along its authored branch axis. Bias only its lateral axis
  // toward the camera so it cannot collapse into a one-pixel hanging strip at an
  // oblique view. Retaining a small authored component keeps crossed sprays from
  // becoming coplanar and avoids screen-facing cardboard motion.
  const cameraFacingStrength = isBroadleafSpecies(speciesId) ? 0.88 : 0.76;
  const resolveFrame = (cameraNode) => {
    const view = cameraInPositionSpace(cameraNode).sub(staticAnchor);
    const projectedView = view.sub(cardAxis.mul(view.dot(cardAxis)));
    const targetUp = projectedView.length().greaterThan(0.0001).select(
      projectedView.normalize().cross(cardAxis).normalize(), authoredCardUp,
    );
    const up = mix(authoredCardUp, targetUp, float(cameraFacingStrength)).normalize();
    return {
      position: staticAnchor.add(axialOffset).add(up.mul(lateralAmount)),
      normal: cardAxis.cross(up).normalize(),
    };
  };
  const currentFrame = resolveFrame(currentCameraNode);
  const previousFrame = resolveFrame(previousCameraNode);
  const windScale = bend.mul(sourceRelative.length()).mul(0.035);
  const windOffset = vec3(wind.x, 0, wind.z).mul(windScale);
  const previousWindOffset = vec3(previousWind.x, 0, previousWind.z).mul(windScale);
  const currentLocal = currentFrame.position.add(windOffset);
  const previousLocal = previousFrame.position.add(previousWindOffset);
  material.positionNode = visible.select(currentLocal, vec3(1000000));
  // These are compile-time lab overrides. Their defaults reproduce the shipping
  // graph exactly; the isolated viewer reloads when a control changes so the
  // range never pays for extra uniforms or branches.
  const shapedNormalWorld = mix(currentFrame.normal,
    currentFrame.normal.add(vec3(0, 0.72, 0)).normalize(), float(normalShaping)).normalize();
  if (debugMode === 'beauty') {
    material.normalNode = transformNormalToView(shapedNormalWorld)
      .toVarying(farParent ? 'vGeneratedFarViewNormal' : 'vGeneratedFoliageViewNormal').normalize();
  }
  // The cross-polarized source is intentionally low exposure (needle texels sit
  // around 0.05–0.08 linear). Normalize that measured reflectance before the real
  // daylight BRDF instead of adding emission or a painted/backlight highlight.
  const neutralized = mix(albedo.rgb, albedo.rgb.mul(vec3(1.08, 1.12, 1.02)), 0.48)
    .mul(vec3(1.22, 1.28, 1.14));
  // The shared Phong path now owns direct sun, sky/PMREM response, and view-facing
  // normal shading. The aligned roughness mask only grades the scanned albedo;
  // thickness stays available to the lab but may not pre-light production albedo;
  // direct sun, shadowing, sky and PMREM are the only production light authorities.
  const roughnessMask = mix(float(0.5), mask.r, float(roughnessStrength));
  const roughnessResponse = mix(float(1.02), float(0.90), roughnessMask);
  const productionAlbedo = neutralized.mul(roughnessResponse);
  material.colorNode = productionAlbedo;
  if (labControls) {
    // Isolated viewer control only. Shipping forests never receive this pre-lit
    // term; the lab retains it solely for inspecting the aligned thickness mask.
    const labBacklight = shapedNormalWorld.dot(environment.sunDirection).negate().clamp(0, 1)
      .mul(mask.g).mul(environment.sunIlluminanceScale.max(0)).mul(0.10 * transmissionStrength);
    material.colorNode = productionAlbedo.mul(float(1).add(labBacklight));
  }
  if (debugMode === 'alpha') material.colorNode = vec3(albedo.a);
  else if (debugMode === 'material') material.colorNode = vec3(mask.r, mask.g, mask.b);
  else if (debugMode === 'normal') material.colorNode = shapedNormalWorld.mul(0.5).add(0.5);
  else if (debugMode === 'lod') material.colorNode = lodBand.lessThan(0.5).select(
    vec3(0.95, 0.18, 0.10), lodBand.lessThan(1.5).select(vec3(0.15, 0.85, 0.22), vec3(0.12, 0.34, 1)),
  );
  else if (debugMode === 'hull' || debugMode === 'overdraw') {
    material.colorNode = debugMode === 'hull' ? vec3(1, 0.62, 0.08) : vec3(albedo.a, albedo.a.mul(0.22), 0.04);
  }
  const showSupportGeometry = debugMode === 'hull' || debugMode === 'overdraw';
  material.opacityNode = (showSupportGeometry ? float(1) : albedo.a).mul(visible.select(float(1), float(0)));
  material.alphaTest = showSupportGeometry ? 0 : alphaTest;
  material.wireframe = debugMode === 'hull';
  material.alphaHash = false;
  material.transparent = false;
  material.depthWrite = true;
  material.forceSinglePass = true;
  const currentWorld = modelWorldMatrix.mul(vec4(currentLocal, 1));
  const previousWorld = modelWorldMatrix.mul(vec4(previousLocal, 1));
  const currentClip = motionHistory.currentProjection.mul(motionHistory.currentView.mul(currentWorld));
  const previousClip = motionHistory.previousProjection.mul(motionHistory.previousView.mul(previousWorld));
  material.mrtNode = mrt({ velocity: currentClip.xy.div(currentClip.w).sub(previousClip.xy.div(previousClip.w))
    .toVarying('vGeneratedFoliageVelocity') });
  material.needsUpdate = true;
  return material;
}

function foliageBandGeometry(source, band) {
  const geometry = source.clone();
  const params = source.getAttribute('foliageParams');
  const sourceIndex = source.index.array;
  const indices = [];
  for (let index = 0; index < sourceIndex.length; index += 3) {
    const vertex = sourceIndex[index];
    if (Math.round(params.getY(vertex)) === band) indices.push(sourceIndex[index], sourceIndex[index + 1], sourceIndex[index + 2]);
  }
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export async function loadGeneratedFoliagePack(rootUrl, { renderer, textureMode = 'ktx2' } = {}) {
  if (!['ktx2', 'png'].includes(textureMode)) {
    throw new Error(`Unsupported generated foliage texture mode: ${textureMode}`);
  }
  if (textureMode === 'ktx2' && !renderer) {
    throw new Error('KTX2 generated foliage loading requires a renderer for GPU format detection.');
  }
  let ktx2Loader = null;
  if (textureMode === 'ktx2') {
    ktx2Loader = ktx2Loaders.get(renderer);
    if (!ktx2Loader) {
      ktx2Loader = new KTX2Loader().setTranscoderPath('/assets/transcoders/basis/').detectSupport(renderer);
      ktx2Loaders.set(renderer, ktx2Loader);
    }
  }
  const loader = ktx2Loader ?? textureLoader;
  let atlas;
  let materialMask;
  let metadata;
  let manifest;
  let barkAlbedo;
  let barkNormal;
  let barkArm;
  try {
    manifest = await fetch(`${rootUrl}/foliage-pack.json`).then((response) => {
      if (!response.ok) throw new Error(`Generated foliage pack failed: ${response.status}`);
      return response.json();
    });
    const runtime = manifest.runtime;
    [atlas, materialMask, metadata, barkAlbedo, barkNormal, barkArm] = await Promise.all([
      loader.loadAsync(`${rootUrl}/${runtime.albedo[textureMode]}`),
      loader.loadAsync(`${rootUrl}/${runtime.materialMask[textureMode]}`),
      fetch(`${rootUrl}/${runtime.metadata}`).then((response) => {
        if (!response.ok) throw new Error(`Generated foliage metadata failed: ${response.status}`);
        return response.json();
      }),
      textureLoader.loadAsync(`${rootUrl}/${runtime.bark.albedo}`),
      textureLoader.loadAsync(`${rootUrl}/${runtime.bark.normal}`),
      textureLoader.loadAsync(`${rootUrl}/${runtime.bark.arm}`),
    ]);
  } catch (error) {
    atlas?.dispose();
    materialMask?.dispose();
    barkAlbedo?.dispose(); barkNormal?.dispose(); barkArm?.dispose();
    throw error;
  }
  const validationState = manifest.validation?.state;
  if (manifest.foliageAlias !== metadata.foliageAlias || !['candidate', 'approved'].includes(validationState)
    || manifest.candidateOnly !== (validationState === 'candidate')) {
    atlas.dispose(); materialMask.dispose();
    throw new Error('Generated foliage pack metadata is inconsistent or not candidate-validated.');
  }
  atlas.name = `${metadata.foliageAlias}-albedo-${textureMode}`;
  atlas.colorSpace = SRGBColorSpace;
  materialMask.name = `${metadata.foliageAlias}-material-mask-${textureMode}`;
  materialMask.colorSpace = NoColorSpace;
  for (const map of [atlas, materialMask]) {
    map.wrapS = map.wrapT = ClampToEdgeWrapping;
    map.minFilter = LinearMipmapLinearFilter;
    map.anisotropy = 8;
    map.generateMipmaps = textureMode === 'png';
    map.needsUpdate = true;
  }
  barkAlbedo.name = `${metadata.foliageAlias}-cc0-bark-albedo`;
  barkAlbedo.colorSpace = SRGBColorSpace;
  barkNormal.name = `${metadata.foliageAlias}-cc0-bark-normal`;
  barkNormal.colorSpace = NoColorSpace;
  barkArm.name = `${metadata.foliageAlias}-cc0-bark-arm`;
  barkArm.colorSpace = NoColorSpace;
  for (const map of [barkAlbedo, barkNormal, barkArm]) {
    map.wrapS = map.wrapT = RepeatWrapping; map.anisotropy = 8; map.needsUpdate = true;
  }
  return { atlas, materialMask, bark: { albedo: barkAlbedo, normal: barkNormal, arm: barkArm }, metadata, manifest, textureMode };
}

export class GeneratedFoliageTree {
  constructor({
    pack, environment, camera, motionHistory, seed = 0x51a7e5d, height = 19.5,
    debugMode = 'beauty', forceBand = null, labControls = null,
  }) {
    if (!pack?.metadata?.clusters?.length || !environment || !camera || !motionHistory) {
      throw new Error('GeneratedFoliageTree requires pack, environment, camera, and motionHistory.');
    }
    this.pack = pack;
    this.camera = camera;
    this.height = height;
    this.seed = normalizeSeed(seed);
    this.forceBand = forceBand;
    this.branches = [];
    this.projectionScale = uniform(camera.projectionMatrix.elements[5]);
    this.uCameraPosition = uniform(camera.position.clone());
    this.uPreviousCameraPosition = uniform(camera.position.clone());
    this.group = new Group();
    this.group.name = `generated-foliage-tree:${pack.metadata.foliageAlias}`;
    const speciesId = pack.metadata.species;
    const branches = buildBranchSkeleton(height, this.seed, speciesId);
    const structure = structuralGeometry({ height, seed: this.seed, branches, speciesId });
    const foliage = foliageGeometry(pack.metadata, branches, this.seed);
    this.branches = foliage.branchCards;
    this.structureMaterial = structuralMaterial(environment, pack.bark, { motionHistory, speciesId });
    const normalizedLabControls = Object.freeze({
      alphaTest: Math.min(0.95, Math.max(0, Number(labControls?.alphaTest ?? 0.20))),
      roughnessStrength: Math.min(1, Math.max(0, Number(labControls?.roughnessStrength ?? 1))),
      normalShaping: Math.min(1, Math.max(0, Number(labControls?.normalShaping ?? 0))),
      transmissionStrength: Math.min(2, Math.max(0, Number(labControls?.transmissionStrength ?? 1))),
      alphaToCoverage: false,
    });
    if (!Object.values(normalizedLabControls).every((value) => typeof value === 'boolean' || Number.isFinite(value))) {
      throw new TypeError('Generated foliage lab controls must be finite numbers.');
    }
    this.labControls = normalizedLabControls;
    this.foliageMaterial = foliageMaterial(pack.atlas, pack.materialMask, environment, this.projectionScale, motionHistory,
      { debugMode, forceBand, labControls: normalizedLabControls, speciesId,
        currentCameraNode: this.uCameraPosition, previousCameraNode: this.uPreviousCameraPosition });
    this.structure = new Mesh(structure, this.structureMaterial);
    this.structure.name = `generated-${speciesId}-opaque-structure`;
    this.structure.castShadow = true;
    // The lab uses the same receiver contract as production so bark judgments are
    // made under the real shared sun and canopy shadow field.
    this.structure.receiveShadow = true;
    this.foliage = new Mesh(foliage.geometry, this.foliageMaterial);
    this.foliage.name = `generated-${speciesId}-hierarchical-foliage`;
    // Beauty cards are alpha-cut surfaces; asking every card to populate the
    // directional map creates a jagged, disconnected shadow at range distance.
    // The connected hull below owns the lab tree's shadow instead.
    this.foliage.castShadow = false;
    this.foliage.receiveShadow = true;
    this.structure.castShadow = false;
    this.shadowProxy = new Mesh(
      connectedShadowGeometry(speciesId),
      new MeshBasicNodeMaterial({ color: 0xffffff, side: DoubleSide }),
    );
    this.shadowProxy.name = `generated-${speciesId}-connected-shadow`;
    this.shadowProxy.scale.set(
      height * connectedShadowWidth(speciesId), height, height * connectedShadowWidth(speciesId),
    );
    this.shadowProxy.layers.set(1);
    this.shadowProxy.castShadow = true;
    this.shadowProxy.receiveShadow = false;
    this.group.add(this.structure, this.foliage, this.shadowProxy);
    this.metrics = Object.freeze({ branches: branches.length, cardsAllLods: foliage.cards,
      cardsByBand: foliage.cardsByBand,
      structuralTriangles: structure.index.count / 3, foliageTrianglesAllLods: foliage.geometry.index.count / 3,
      hierarchyLevels: 3, drawCalls: 2, textureMode: pack.textureMode, debugMode, forceBand,
      candidateOnly: pack.manifest.candidateOnly, validationState: pack.manifest.validation.state,
      labControls: normalizedLabControls });
  }

  update(camera = this.camera) {
    this.uPreviousCameraPosition.value.copy(this.uCameraPosition.value);
    this.uCameraPosition.value.copy(camera.position);
    this.projectionScale.value = camera.projectionMatrix.elements[5];
  }

  diagnostics(camera = this.camera) {
    const world = new Vector3();
    this.group.getWorldPosition(world);
    const distance = camera.position.distanceTo(world.add(new Vector3(0, this.height * 0.5, 0)));
    const inverseWorld = this.group.matrixWorld.clone().invert();
    const localCamera = camera.position.clone().applyMatrix4(inverseWorld);
    const projectionScale = camera.projectionMatrix.elements[5];
    const selectedBranches = [0, 0, 0];
    const selectedCards = [0, 0, 0];
    for (const branch of this.branches) {
      const projectedError = branch.radius * projectionScale / Math.max(0.5, localCamera.distanceTo(branch.anchor));
      const band = this.forceBand ?? (projectedError > 0.036 ? 0 : projectedError > 0.010 ? 1 : 2);
      selectedBranches[band]++;
      selectedCards[band] += branch.cardsByBand[band];
    }
    return { generatedSource: true, foliageAlias: this.pack.metadata.foliageAlias,
      distance: Number(distance.toFixed(3)), selectedBranches, selectedCards,
      selectedCardTotal: selectedCards.reduce((sum, count) => sum + count, 0),
      ...this.metrics, atlasMetrics: this.pack.metadata.metrics };
  }

  dispose() {
    this.structure.geometry.dispose();
    this.foliage.geometry.dispose();
    this.shadowProxy.geometry.dispose();
    this.structureMaterial.dispose();
    this.foliageMaterial.dispose();
    this.shadowProxy.material.dispose();
    this.pack.atlas.dispose();
    this.pack.materialMask.dispose();
    this.pack.bark.albedo.dispose();
    this.pack.bark.normal.dispose();
    this.pack.bark.arm.dispose();
  }
}

// Production forest form. Up to five seeded identities break crown repetition while
// every identity remains one structural and one foliage instance draw. Local
// branch hierarchy selection stays in the foliage shader; no whole tree is
// replaced or hidden merely because its root crosses a distance ring.
export class GeneratedFoliageForest {
  constructor({ pack, placements, environment, camera, motionHistory, renderer, seed = 0x51a7e5d, identityCount = 3 }) {
    if (!pack?.metadata?.clusters?.length || !Array.isArray(placements) || !placements.length) {
      throw new Error('GeneratedFoliageForest requires a loaded pack and non-empty placements.');
    }
    if (!environment || !camera || !motionHistory || !renderer?.isWebGPURenderer) {
      throw new Error('GeneratedFoliageForest requires WebGPU, environment, camera, and motion history.');
    }
    this.pack = pack; this.camera = camera; this.renderer = renderer;
    this.speciesId = pack.metadata.species;
    this.projectionScale = uniform(camera.projectionMatrix.elements[5]);
    this.uCameraPosition = uniform(camera.position.clone());
    this.uPreviousCameraPosition = uniform(camera.position.clone());
    this.uViewProjection = uniform(new Matrix4());
    this.group = new Group();
    this.group.name = `generated-foliage-forest:${pack.metadata.foliageAlias}`;
    this.meshes = []; this.beautyMeshes = []; this.shadowMeshes = []; this.materials = []; this.batches = [];
    const count = Math.max(1, Math.min(5, Math.floor(identityCount)));
    const placementBatches = Array.from({ length: count }, () => []);
    placements.forEach((placement, index) => placementBatches[index % count].push(placement));
    for (let identity = 0; identity < count; identity++) {
      const records = placementBatches[identity];
      if (!records.length) continue;
      this._addIdentity(identity, records, environment, motionHistory, seed);
    }
    this.metrics = Object.freeze({ sourceCount: placements.length, identities: this.batches.length,
      drawCalls: this.beautyMeshes.length, shadowDrawCalls: this.shadowMeshes.length,
      farProjectedHeightThreshold: 0.30, candidateOnly: pack.manifest.candidateOnly,
      validationState: pack.manifest.validation.state });
  }

  _addIdentity(identity, records, environment, motionHistory, seed) {
    const identitySeed = deriveSeed(seed, `generated-forest-identity:${identity}`);
    const speciesId = this.pack.metadata.species;
    const baseHeight = this.pack.manifest.species?.nativeHeightMeters
      ?? (speciesId === 'italian-cypress' ? 18 : speciesId === 'monterey-cypress' ? 16.5
        : speciesId === 'valley-oak' || speciesId === 'southern-live-oak' ? 17
          : speciesId === 'sugar-maple' ? 18.5 : speciesId === 'loblolly-pine' ? 23.5 : 19.5);
    const height = baseHeight * (0.94 + identity * 0.035);
    const branches = buildBranchSkeleton(height, identitySeed, speciesId);
    const structure = structuralGeometry({ height, seed: identitySeed, branches, speciesId });
    const foliage = foliageGeometry(this.pack.metadata, branches, identitySeed);
    const farFoliage = foliageBandGeometry(foliage.geometry, 2);
    const transformArray = new Float32Array(records.length * 4);
    const yawArray = new Float32Array(records.length);
    records.forEach((record, index) => {
      transformArray.set([record.x, record.y ?? 0, record.z, record.scale ?? 1], index * 4);
      yawArray[index] = record.rotY ?? record.rotationY ?? 0;
    });
    const sourceTransform = storage(new StorageBufferAttribute(transformArray, 4), 'vec4', records.length).toReadOnly();
    const sourceYaw = storage(new StorageBufferAttribute(yawArray, 1), 'float', records.length).toReadOnly();
    const visibleAll = storage(new StorageInstancedBufferAttribute(new Uint32Array(records.length), 1, Uint32Array), 'uint', records.length);
    const visibleNear = storage(new StorageInstancedBufferAttribute(new Uint32Array(records.length), 1, Uint32Array), 'uint', records.length);
    const visibleFar = storage(new StorageInstancedBufferAttribute(new Uint32Array(records.length), 1, Uint32Array), 'uint', records.length);
    const drawArgsAttr = new IndirectStorageBufferAttribute(new Uint32Array(20), 5);
    const drawArgs = storage(drawArgsAttr, 'uint', 20).toAtomic();
    const counts = [structure.index.count, foliage.geometry.index.count, farFoliage.index.count];
    const clearCompute = Fn(() => {
      for (let word = 0; word < 20; word++) atomicStore(drawArgs.element(uint(word)), uint(0));
      for (let command = 0; command < counts.length; command++) atomicStore(drawArgs.element(uint(command * 5)), uint(counts[command]));
    })().compute(1);
    const compactCompute = Fn(() => {
      const id = uint(instanceIndex);
      const transform = sourceTransform.element(id);
      const centreY = transform.y.add(float(height * 0.5).mul(transform.w));
      const centre = this.uViewProjection.mul(vec4(transform.x, centreY, transform.z, 1));
      const radius = float(height * 0.58).mul(transform.w);
      const pad = radius.mul(this.projectionScale).add(centre.w.mul(0.003));
      const inFrustum = centre.w.greaterThan(0).and(centre.x.abs().lessThanEqual(centre.w.add(pad)))
        .and(centre.y.abs().lessThanEqual(centre.w.add(pad)))
        .and(centre.z.greaterThanEqual(pad.negate())).and(centre.z.lessThanEqual(centre.w.add(pad)));
      If(inFrustum, () => {
        const allDst = atomicAdd(drawArgs.element(uint(1)), uint(1));
        visibleAll.element(allDst).assign(id);
        const distance = this.uCameraPosition.sub(vec3(transform.x, centreY, transform.z)).length().max(1);
        const projectedHeight = float(height).mul(transform.w).mul(this.projectionScale).div(distance);
        If(projectedHeight.lessThan(0.30), () => {
          const farDst = atomicAdd(drawArgs.element(uint(11)), uint(1)); visibleFar.element(farDst).assign(id);
        }).Else(() => {
          const nearDst = atomicAdd(drawArgs.element(uint(6)), uint(1)); visibleNear.element(nearDst).assign(id);
        });
      });
    })().compute(records.length);
    clearCompute.name = `Generated foliage identity ${identity} reset`;
    compactCompute.name = `Tree beauty generated foliage identity ${identity} compact`;
    const nodesFor = (visible) => {
      const sourceId = visible.toAttribute();
      return { placementNode: sourceTransform.element(sourceId), yawNode: sourceYaw.element(sourceId) };
    };
    const structureMaterial = structuralMaterial(environment, this.pack.bark,
      { instanced: true, motionHistory, speciesId: this.speciesId, ...nodesFor(visibleAll) });
    const nearMaterial = foliageMaterial(this.pack.atlas, this.pack.materialMask, environment,
      this.projectionScale, motionHistory, { instanced: true, speciesId: this.speciesId,
        currentCameraNode: this.uCameraPosition, previousCameraNode: this.uPreviousCameraPosition,
        ...nodesFor(visibleNear) });
    const farMaterial = foliageMaterial(this.pack.atlas, this.pack.materialMask, environment,
      this.projectionScale, motionHistory, { instanced: true, forceBand: 2, speciesId: this.speciesId,
        currentCameraNode: this.uCameraPosition, previousCameraNode: this.uPreviousCameraPosition,
        ...nodesFor(visibleFar) });
    const geometries = [structure, foliage.geometry, farFoliage];
    const materials = [structureMaterial, nearMaterial, farMaterial];
    geometries.forEach((geometry, command) => geometry.setIndirect(drawArgsAttr, command * 20));
    geometries.forEach((geometry, command) => {
      const mesh = new Mesh(geometry, materials[command]);
      mesh.name = `generated-${speciesId}-${['structure', 'local-hierarchy', 'far-parent', 'shadow-parent'][command]}-identity-${identity}`;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      // Keep all beauty draws in the shared shadow field. The connected hull
      // below is the only caster; alpha cards no longer pollute the shadow map.
      mesh.receiveShadow = command !== 3;
      this.beautyMeshes.push(mesh);
      this.group.add(mesh); this.meshes.push(mesh);
    });
    this.materials.push(...materials);

    // One connected opaque hull per identity supplies stable directional shadows.
    // It is intentionally separate from the beauty indirect draws: alpha foliage
    // cards still own the visible silhouette, while the shadow layer gets a clean
    // continuous canopy instead of a collection of hard card islands.
    const shadow = new InstancedMesh(
      connectedShadowGeometry(speciesId),
      new MeshBasicNodeMaterial({ color: 0xffffff, side: DoubleSide }),
      records.length,
    );
    shadow.name = `generated-${speciesId}-connected-shadow-identity-${identity}`;
    shadow.frustumCulled = false;
    shadow.layers.set(1);
    shadow.castShadow = true;
    shadow.receiveShadow = false;
    const dummy = new Object3D();
    const width = connectedShadowWidth(speciesId);
    records.forEach((record, index) => {
      const scale = record.scale ?? 1;
      dummy.position.set(record.x, record.y ?? 0, record.z);
      dummy.rotation.set(0, record.rotY ?? record.rotationY ?? 0, 0);
      dummy.scale.set(height * width * scale, height * scale, height * width * scale);
      dummy.updateMatrix();
      shadow.setMatrixAt(index, dummy.matrix);
    });
    shadow.instanceMatrix.needsUpdate = true;
    this.group.add(shadow); this.meshes.push(shadow); this.shadowMeshes.push(shadow);
    this.materials.push(shadow.material);
    this.batches.push({ records, height, drawArgsAttr, sourceTransform, sourceYaw, visibleAll, visibleNear, visibleFar,
      clearCompute, compactCompute, triangles: counts.map((value) => value / 3) });
  }

  update(camera = this.camera) {
    camera.updateMatrixWorld();
    this.projectionScale.value = camera.projectionMatrix.elements[5];
    this.uPreviousCameraPosition.value.copy(this.uCameraPosition.value);
    this.uCameraPosition.value.copy(camera.position);
    this.uViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (const batch of this.batches) {
      this.renderer.compute(batch.clearCompute); this.renderer.compute(batch.compactCompute);
    }
  }

  residencyEstimate(camera = this.camera) {
    const counts = { visible: 0, near: 0, far: 0 };
    const projectionScale = camera.projectionMatrix.elements[5];
    for (const batch of this.batches) for (const record of batch.records) {
      const distance = Math.hypot(record.x - camera.position.x,
        (record.y ?? 0) + batch.height * (record.scale ?? 1) * 0.5 - camera.position.y,
        record.z - camera.position.z);
      counts.visible++;
      if (batch.height * (record.scale ?? 1) * projectionScale / Math.max(1, distance) < 0.30) counts.far++;
      else counts.near++;
    }
    return { generatedSource: true, foliageAlias: this.pack.metadata.foliageAlias,
      textureMode: this.pack.textureMode, counts, ...this.metrics };
  }

  async readDiagnostics() {
    const words = await Promise.all(this.batches.map(async (batch) => new Uint32Array(
      await this.renderer.getArrayBufferAsync(batch.drawArgsAttr))));
    const counts = words.reduce((sum, args) => ({ visible: sum.visible + args[1], near: sum.near + args[6], far: sum.far + args[11] }),
      { visible: 0, near: 0, far: 0 });
    return { ...this.residencyEstimate(), counts, classificationComplete: counts.visible === counts.near + counts.far };
  }

  dispose() {
    disposeComputeNodes(this.batches.flatMap((batch) => [batch.clearCompute, batch.compactCompute]));
    disposeWebGPUGeometries(this.renderer, this.meshes.map((mesh) => mesh.geometry));
    for (const material of new Set(this.materials)) material.dispose();
    disposeWebGPUAttributes(this.renderer, this.batches.flatMap((batch) => [batch.drawArgsAttr,
      batch.sourceTransform.value, batch.sourceYaw.value, batch.visibleAll.value, batch.visibleNear.value, batch.visibleFar.value]));
    this.pack.atlas.dispose(); this.pack.materialMask.dispose();
    for (const texture of Object.values(this.pack.bark)) texture.dispose();
  }
}
