import {
  BufferAttribute, BufferGeometry, DataTexture, LinearFilter,
  LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, RepeatWrapping,
  SRGBColorSpace, TextureLoader, Vector2,
} from 'three';

const _frameTextureLoader = new TextureLoader();
const FRAME_MATERIAL_WIDTH_M = 2.0;

function loadFrameMaterial() {
  if (typeof document === 'undefined') {
    const albedo = new DataTexture(new Uint8Array([112, 79, 53, 255]), 1, 1);
    const normal = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    const roughness = new DataTexture(new Uint8Array([235, 235, 235, 255]), 1, 1);
    albedo.colorSpace = SRGBColorSpace;
    for (const texture of [albedo, normal, roughness]) texture.needsUpdate = true;
    return { albedo, normal, roughness, ready: Promise.resolve() };
  }
  const load = (path, srgb = false) => {
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const texture = _frameTextureLoader.load(
      path,
      () => resolveReady(),
      undefined,
      (error) => rejectReady(error || new Error(`Failed to load ${path}`)),
    );
    if (srgb) texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 8;
    return { texture, ready };
  };
  const albedo = load(
    '/assets/materials/dirt/dirt_diff_1k.jpg', true,
  );
  const normal = load(
    '/assets/materials/dirt/dirt_nor_gl_1k.jpg',
  );
  const roughness = load(
    '/assets/materials/dirt/dirt_rough_1k.jpg',
  );
  return {
    albedo: albedo.texture,
    normal: normal.texture,
    roughness: roughness.texture,
    ready: Promise.all([albedo.ready, normal.ready, roughness.ready]),
  };
}

// Presentation-only depth cue for the disposable opening green. The live Terrain
// remains the authoritative top/collision surface; this tapered earthen skirt follows
// its exact fringe outline and starts just below grade, with no hidden top cap.
export function createCreatorCanvasFrame({
  outline,
  heightAt,
  thickness = 1.2,
  taper = 0.35,
}) {
  if (!Array.isArray(outline) || outline.length < 3) {
    throw new TypeError('Creator canvas frame requires an organic outline.');
  }
  if (typeof heightAt !== 'function') {
    throw new TypeError('Creator canvas frame requires the authoritative terrain height sampler.');
  }
  const signedArea = outline.reduce((area, point, index) => {
    const next = outline[(index + 1) % outline.length];
    return area + point.x * next.z - next.x * point.z;
  }, 0) * 0.5;
  const boundary = signedArea >= 0 ? outline : [...outline].reverse();
  const center = boundary.reduce((sum, point) => ({
    x: sum.x + point.x / boundary.length,
    z: sum.z + point.z / boundary.length,
  }), { x: 0, z: 0 });
  const verticalSegments = 4;
  const rows = verticalSegments + 1;
  // Duplicate the first outline column at the UV seam. Sharing that vertex would
  // interpolate from the full perimeter U back to zero across the closing segment,
  // smearing every texture repeat into one visibly stretched patch.
  const columns = boundary.length + 1;
  const positions = new Float32Array(columns * rows * 3);
  const colors = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  const perimeterDistance = new Float32Array(columns);
  for (let index = 1; index < columns; index += 1) {
    const previous = boundary[index - 1];
    const point = boundary[index % boundary.length];
    perimeterDistance[index] = perimeterDistance[index - 1]
      + Math.hypot(point.x - previous.x, point.z - previous.z);
  }
  for (let index = 0; index < columns; index += 1) {
    const point = boundary[index % boundary.length];
    const dx = center.x - point.x;
    const dz = center.z - point.z;
    const distance = Math.hypot(dx, dz) || 1;
    // A two-centimetre overlap closes the antialiased sky seam at the shared edge.
    // The skirt has no horizontal cap, so this cannot z-fight the terrain top.
    const topY = heightAt(point.x, point.z) + 0.02;
    for (let row = 0; row < rows; row += 1) {
      const amount = row / verticalSegments;
      // A rounded undercut at the sod/root layer reads as a cut turf profile rather
      // than a perfectly extruded polygon. The bottom still tapers inward so no soil
      // silhouette can extend beyond the authoritative fringe boundary.
      const inset = taper * (amount * 0.20 + amount * amount * 0.80);
      const vertex = index * rows + row;
      positions[vertex * 3] = point.x + dx / distance * inset;
      positions[vertex * 3 + 1] = topY - thickness * amount;
      positions[vertex * 3 + 2] = point.z + dz / distance * inset;
      uvs[vertex * 2] = perimeterDistance[index] / FRAME_MATERIAL_WIDTH_M;
      uvs[vertex * 2 + 1] = amount * thickness / FRAME_MATERIAL_WIDTH_M;

      // Deterministic mineral/root variation at two metre-scale frequencies. Vertex
      // interpolation keeps it filtered and stable—there is no screen-space noise or
      // generated texture competing with the production turf maps above it.
      const coarse = Math.sin(point.x * 1.17 + point.z * 0.73) * 0.5
        + Math.sin(point.x * 2.91 - point.z * 1.83) * 0.28;
      const aggregate = Math.sin(point.x * 6.31 + point.z * 4.77 + row * 1.91) * 0.10;
      const value = 1 + coarse * 0.22 + aggregate;
      const depthShade = 1 - amount * 0.18;
      const neutralShade = Math.max(0.68, Math.min(1.12, value * depthShade));
      colors[vertex * 3] = neutralShade;
      colors[vertex * 3 + 1] = neutralShade;
      colors[vertex * 3 + 2] = neutralShade;
    }
  }
  const indices = new Uint32Array(boundary.length * verticalSegments * 6);
  for (let index = 0; index < boundary.length; index += 1) {
    const next = index + 1;
    for (let row = 0; row < verticalSegments; row += 1) {
      const currentTop = index * rows + row;
      const currentBottom = currentTop + 1;
      const nextTop = next * rows + row;
      const nextBottom = nextTop + 1;
      const offset = (index * verticalSegments + row) * 6;
      indices.set([currentTop, nextTop, currentBottom,
        nextTop, nextBottom, currentBottom], offset);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const frameMaterial = loadFrameMaterial();
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: frameMaterial.albedo,
    normalMap: frameMaterial.normal,
    normalScale: new Vector2(0.62, 0.62),
    roughnessMap: frameMaterial.roughness,
    roughness: 0.94,
    metalness: 0,
    // The isolated maquette has no surrounding ground to return diffuse skylight
    // into its downward-facing cut wall. A restrained texture-registered presentation
    // fill keeps the real dirt albedo legible without flattening its normal response.
    emissive: 0x765038,
    emissiveMap: frameMaterial.albedo,
    emissiveIntensity: 0.62,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'creator-canvas-earth-frame';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.creatorCanvasFrame = true;
  mesh.userData.organicOutline = true;
  mesh.userData.thickness = thickness;
  mesh.userData.verticalSegments = verticalSegments;
  mesh.userData.materialSource = 'polyhaven:dirt';
  mesh.userData.materialWidthM = FRAME_MATERIAL_WIDTH_M;
  mesh.userData.assetsReady = frameMaterial.ready;
  return mesh;
}
