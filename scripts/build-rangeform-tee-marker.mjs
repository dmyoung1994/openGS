import { readFile, writeFile } from 'node:fs/promises';
import {
  BufferAttribute, BufferGeometry, CircleGeometry, ExtrudeGeometry, Matrix4, Mesh,
  MeshStandardMaterial, Path, Shape, Vector3,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const ROOT = new URL('../', import.meta.url);
const PATHS_URL = new URL('public/assets/branding/rangeform-crest-paths.json', ROOT);
const SVG_URL = new URL('public/assets/branding/rangeform-crest.svg', ROOT);
const MONO_SVG_URL = new URL('public/assets/branding/rangeform-crest-mono.svg', ROOT);
const GLB_URL = new URL('public/assets/props/rangeform-tee-marker/rangeform-limestone-tee-marker.glb', ROOT);

const SPHERE_RADIUS = 0.105;
const SPHERE_BURIAL = 0.030;
const CUT_OFFSET = 0.050;
const CREST_RECESS = 0.002;
const FACE_RADIUS = Math.sqrt(SPHERE_RADIUS ** 2 - CUT_OFFSET ** 2);
const CREST_RADIUS = 0.076;
const SQRT_HALF = Math.SQRT1_2;
const FACE_TRANSFORM = new Matrix4().makeBasis(
  new Vector3(1, 0, 0),
  new Vector3(0, SQRT_HALF, -SQRT_HALF),
  new Vector3(0, SQRT_HALF, SQRT_HALF),
);
FACE_TRANSFORM.setPosition(0, SPHERE_RADIUS - SPHERE_BURIAL, 0);

class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
}
globalThis.FileReader ??= NodeFileReader;

function contourPath(points, scale = CREST_RADIUS) {
  const path = new Path();
  path.moveTo(points[0][0] * scale, points[0][1] * scale);
  for (let index = 1; index < points.length; index++) {
    path.lineTo(points[index][0] * scale, points[index][1] * scale);
  }
  path.closePath();
  return path;
}

function circleShape(radius) {
  const shape = new Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  return shape;
}

function applyFaceUv(geometry) {
  const position = geometry.attributes.position;
  const uv = new BufferAttribute(new Float32Array(position.count * 2), 2);
  for (let index = 0; index < position.count; index++) {
    uv.setXY(index, 0.5 + position.getX(index) / 1.2, 0.5 + position.getY(index) / 1.2);
  }
  geometry.setAttribute('uv', uv);
  geometry.setAttribute('uv1', new BufferAttribute(uv.array.slice(), 2));
  return geometry;
}

function applyColor(geometry, [r, g, b]) {
  const color = new BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3);
  for (let index = 0; index < color.count; index++) color.setXYZ(index, r, g, b);
  geometry.setAttribute('color', color);
  return geometry;
}

function faceExtrusion(shape) {
  const geometry = new ExtrudeGeometry(shape, {
    depth: CREST_RECESS,
    steps: 1,
    bevelEnabled: false,
    curveSegments: 96,
  });
  applyFaceUv(geometry);
  geometry.translate(0, 0, CUT_OFFSET - CREST_RECESS);
  geometry.applyMatrix4(FACE_TRANSFORM);
  const output = geometry.index ? geometry.toNonIndexed() : geometry;
  return applyColor(output, [1, 1, 1]);
}

function buildCutSphere() {
  const radialSegments = 96;
  const rings = 36;
  const cutPhi = Math.acos(CUT_OFFSET / SPHERE_RADIUS);
  const positions = [0, 0, -SPHERE_RADIUS];
  const normals = [0, 0, -1];
  const uvs = [0.5, 0];
  const indices = [];

  for (let ring = 1; ring <= rings; ring++) {
    const phi = Math.PI + (cutPhi - Math.PI) * (ring / rings);
    const radial = SPHERE_RADIUS * Math.sin(phi);
    const z = SPHERE_RADIUS * Math.cos(phi);
    for (let segment = 0; segment <= radialSegments; segment++) {
      const theta = Math.PI * 2 * segment / radialSegments;
      const x = radial * Math.cos(theta);
      const y = radial * Math.sin(theta);
      positions.push(x, y, z);
      normals.push(x / SPHERE_RADIUS, y / SPHERE_RADIUS, z / SPHERE_RADIUS);
      uvs.push(segment / radialSegments, ring / rings);
    }
  }

  const firstRing = 1;
  for (let segment = 0; segment < radialSegments; segment++) {
    indices.push(0, firstRing + segment + 1, firstRing + segment);
  }
  for (let ring = 0; ring < rings - 1; ring++) {
    const a = 1 + ring * (radialSegments + 1);
    const b = a + radialSegments + 1;
    for (let segment = 0; segment < radialSegments; segment++) {
      indices.push(a + segment, b + segment + 1, b + segment);
      indices.push(a + segment, a + segment + 1, b + segment + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('uv1', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.applyMatrix4(FACE_TRANSFORM);
  return applyColor(geometry.toNonIndexed(), [1, 1, 1]);
}

function buildGeometry(records) {
  const body = buildCutSphere();

  const byIndex = new Map(records.map((record) => [record.sourceIndex, record]));
  const stoneRegions = new Map();
  const topDisk = circleShape(FACE_RADIUS);
  stoneRegions.set(-1, topDisk);

  for (const record of records) {
    if (record.depth % 2 === 1) {
      stoneRegions.set(record.sourceIndex, new Shape(contourPath(record.points).getPoints()));
    }
  }
  for (const record of records) {
    if (record.depth % 2 !== 0) continue;
    const parent = byIndex.get(record.parent);
    const stoneParent = parent ? stoneRegions.get(parent.sourceIndex) : topDisk;
    if (!stoneParent) throw new Error(`Missing stone parent for crest contour ${record.sourceIndex}`);
    stoneParent.holes.push(contourPath(record.points));
  }

  const floor = applyFaceUv(new CircleGeometry(FACE_RADIUS, 96));
  floor.translate(0, 0, CUT_OFFSET - CREST_RECESS);
  floor.applyMatrix4(FACE_TRANSFORM);
  applyColor(floor, [0.38, 0.34, 0.29]);
  const top = [...stoneRegions.values()].map(faceExtrusion);
  const parts = [body, floor.toNonIndexed(), ...top];
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Rangeform tee-marker geometry could not be merged.');
  const geometry = mergeVertices(merged, 1e-6);
  merged.dispose();
  geometry.name = 'rangeform-carved-limestone-tee-marker';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = {
    sourceLogo: 'rangeform-crest-imagegen.png',
    form: 'partially-buried sphere with 45-degree player-facing planar cut',
    sphereRadiusMeters: SPHERE_RADIUS,
    burialMeters: SPHERE_BURIAL,
    faceAngleDegrees: 45,
    faceDiameterMeters: FACE_RADIUS * 2,
    crestRecessMeters: CREST_RECESS,
  };
  return geometry;
}

function svgDocument(records, fill) {
  const size = 1024;
  const radius = 460;
  const path = records.map(({ points }) => points.map(([x, y], index) => {
    const px = (size / 2 + x * radius).toFixed(2);
    const py = (size / 2 - y * radius).toFixed(2);
    return `${index ? 'L' : 'M'}${px} ${py}`;
  }).join(' ') + ' Z').join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-labelledby="title"><title id="title">Rangeform RF crest</title><path fill="${fill}" fill-rule="evenodd" d="${path}"/></svg>\n`;
}

async function exportGlb(geometry) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial({
    name: 'rangeform-warm-limestone-pbr',
    color: 0xeee2c8,
    roughness: 0.86,
    metalness: 0,
  }));
  mesh.name = 'rangeform-limestone-tee-marker';
  mesh.userData = { ...geometry.userData, materialSource: 'ambientCG Travertine009 1K-JPG' };
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => exporter.parse(mesh, resolve, reject, {
    binary: true,
    onlyVisible: true,
    trs: false,
  }));
}

const source = JSON.parse(await readFile(PATHS_URL, 'utf8'));
if (source.version !== 1 || !Array.isArray(source.contours) || source.contours.length < 1) {
  throw new Error('Unsupported Rangeform crest path source.');
}
const geometry = buildGeometry(source.contours);
const glb = await exportGlb(geometry);
await Promise.all([
  writeFile(SVG_URL, svgDocument(source.contours, '#0b4f36')),
  writeFile(MONO_SVG_URL, svgDocument(source.contours, '#111111')),
  writeFile(GLB_URL, Buffer.from(glb)),
]);
console.log(JSON.stringify({
  glb: GLB_URL.pathname,
  vertices: geometry.attributes.position.count,
  triangles: geometry.index.count / 3,
  bounds: geometry.boundingBox,
}));
