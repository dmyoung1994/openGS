import {
  InstancedMesh, Object3D, PlaneGeometry, MeshBasicMaterial,
  CanvasTexture, SRGBColorSpace, FrontSide, MathUtils, Color,
} from 'three';

// ---------------------------------------------------------------------------
// Billboard "imposter" trees.
//
// The real GLB / procedural trees carry geometry, so we only want a limited
// number of them up front. To make the tree line read as a DEEP, layered forest
// wall we back them with thousands of camera-facing billboard imposters: flat
// quads, each showing a baked, pre-shaded tree image. Two triangles apiece, so we
// can afford several thousand and still sit comfortably at 60fps.
//
// Everything here is self-contained: the tree images are painted onto a <canvas>
// at runtime (no external image files), the camera-facing behaviour is done in
// the vertex shader (no per-frame CPU work), and per-instance colour tinting
// (instanceColor) breaks up the "row of identical blobs" look.
// ---------------------------------------------------------------------------

// A natural spread of foliage tint colours. These MULTIPLY the (already green)
// tree texture / leaf albedo, so we bias around white with a hue push: deep
// forest green, olive, lush green, and the occasional yellow-green / early-autumn
// tree. `b` is an overall brightness so some trees read darker than others.
export function foliageTint(target = new Color()) {
  const b = 0.58 + Math.random() * 0.42;      // 0.58–1.0 overall brightness
  const t = Math.random();
  if (t < 0.12) return target.setRGB(b * 1.0, b * 0.88, b * 0.42);   // autumn yellow-green
  if (t < 0.42) return target.setRGB(b * 0.74, b * 0.9, b * 0.55);   // olive
  if (t < 0.75) return target.setRGB(b * 0.66, b * 0.96, b * 0.6);   // lush green
  return target.setRGB(b * 0.48, b * 0.78, b * 0.52);                // deep forest
}

// Paint a single lush tree onto a canvas and return an RGBA CanvasTexture.
// `kind` is 'deciduous' (rounded crown) or 'pine' (conical, tiered). The crown is
// drawn LOW so it overlaps the trunk (no "leaf-ball on a stick"), and a vertical
// light gradient is multiplied over it — bright/warm on top, shadowed underneath —
// so the unlit billboards still read as sunlit volumes, not flat cutouts.
export function makeCanopyBillboardTexture(kind = 'deciduous', seed = 1) {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');

  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  // Kept fairly neutral because per-instance instanceColor does the hue variety.
  const greens = kind === 'pine'
    ? { base: '#3d6b42', shadow: '#294a2e', hi: '#6e9a52' }
    : { base: '#4f8a40', shadow: '#345f2b', hi: '#93c25c' };

  const clump = (x, y, r, tone) => {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
    g.addColorStop(0, tone === 'hi' ? greens.hi : greens.base);
    g.addColorStop(0.6, greens.base);
    g.addColorStop(1, greens.shadow);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // Short trunk — the canopy is drawn low enough to bury most of it.
  ctx.fillStyle = kind === 'pine' ? '#4a3a28' : '#5c4530';
  const trunkW = S * (kind === 'pine' ? 0.04 : 0.055);
  const trunkTop = S * (kind === 'pine' ? 0.6 : 0.66);
  ctx.beginPath();
  ctx.moveTo(S / 2 - trunkW, S);
  ctx.lineTo(S / 2 - trunkW * 0.5, trunkTop);
  ctx.lineTo(S / 2 + trunkW * 0.5, trunkTop);
  ctx.lineTo(S / 2 + trunkW, S);
  ctx.closePath();
  ctx.fill();

  if (kind === 'pine') {
    // Stacked tiers, widest at the bottom, extending down over the trunk.
    const tiers = 7;
    for (let ti = 0; ti < tiers; ti++) {
      const f = ti / (tiers - 1);
      const cy = S * (0.12 + f * 0.78);
      const halfW = S * (0.06 + f * 0.4);
      const blobs = 5 + Math.round(f * 7);
      for (let bl = 0; bl < blobs; bl++) {
        const bx = S / 2 + MathUtils.lerp(-halfW, halfW, bl / (blobs - 1)) + (rnd() - 0.5) * 10;
        const by = cy + (rnd() - 0.5) * S * 0.09;
        clump(bx, by, S * 0.085 * (1 - f * 0.2), rnd() > 0.6 ? 'hi' : 'base');
      }
    }
  } else {
    // Rounded, billowing crown centred LOW so it overlaps the trunk top.
    const cx = S / 2;
    const cy = S * 0.44;
    const rx = S * 0.42;
    const ry = S * 0.4;
    for (let i = 0; i < 110; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd());
      const x = cx + Math.cos(a) * rx * rr;
      const y = cy + Math.sin(a) * ry * rr;
      const lit = (-Math.cos(a) - Math.sin(a)) * rr; // >0 toward the sunlit upper-left
      clump(x, y, S * (0.085 + rnd() * 0.05), lit > 0.5 && rnd() > 0.4 ? 'hi' : 'base');
    }
  }

  // Bake a top-lit / bottom-shadowed gradient over the foliage (source-atop keeps
  // the transparent surround) so tops read sunlit and undersides fall into shadow.
  ctx.globalCompositeOperation = 'source-atop';
  const grad = ctx.createLinearGradient(0, S * 0.08, 0, S);
  grad.addColorStop(0, 'rgba(255,250,225,0.35)');   // warm sun on top
  grad.addColorStop(0.4, 'rgba(255,255,255,0.0)');
  grad.addColorStop(1, 'rgba(20,35,20,0.72)');       // dark underside
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

// A reusable billboard material: an unlit MeshBasicMaterial (lighting is baked
// into the texture) whose vertex shader is patched so each instance's quad faces
// the camera. alphaTest gives a crisp cutout with no transparency sorting, and
// instanceColor (USE_INSTANCING_COLOR) multiplies a per-tree tint into the image.
export function createBillboardMaterial(texture) {
  const mat = new MeshBasicMaterial({
    map: texture,
    alphaTest: 0.4,
    transparent: false,
    side: FrontSide,
    fog: true,
    toneMapped: true,
  });

  mat.onBeforeCompile = (shader) => {
    // Rebuild the vertex position as a view-space (screen-facing) billboard.
    // instanceMatrix supplies world position (translation column) and width/height
    // (basis-column lengths); the quad's local x/y (x in [-0.5,0.5], y in [0,1])
    // are added in view space so the card faces the camera and its base stays
    // pinned to the ground.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */`
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        vec4 _center = instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        mvPosition = modelViewMatrix * _center;
        float _w = length( instanceMatrix[0].xyz );
        float _h = length( instanceMatrix[1].xyz );
        mvPosition.xy += transformed.xy * vec2( _w, _h );
      #else
        mvPosition = modelViewMatrix * mvPosition;
      #endif
      gl_Position = projectionMatrix * mvPosition;
      `,
    );
  };
  return mat;
}

// Bottom-centred unit quad shared by all billboards (pivot at the trunk base).
function billboardGeometry() {
  const g = new PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0); // pivot at bottom edge → y in [0,1]
  return g;
}

// Build an InstancedMesh of billboard trees from placements
// [{x, y, z, targetHeight, widthRatio?}]. Each card gets a per-instance foliage
// tint so the wall reads as many different trees, not one repeated blob.
export function instanceBillboards(placements, { texture, widthRatio = 0.78, tint = true } = {}) {
  const geom = billboardGeometry();
  const mat = createBillboardMaterial(texture);
  const inst = new InstancedMesh(geom, mat, placements.length);
  inst.castShadow = false;   // cheap backdrop; the real trees carry the shadows
  inst.receiveShadow = false;

  const d = new Object3D();
  const c = new Color();
  placements.forEach((p, i) => {
    const h = p.targetHeight;
    d.position.set(p.x, p.y, p.z);
    d.rotation.set(0, 0, 0);
    d.scale.set(h * (p.widthRatio || widthRatio), h, 1);
    d.updateMatrix();
    inst.setMatrixAt(i, d.matrix);
    if (tint) inst.setColorAt(i, foliageTint(c));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

  // Correct culling for a wide, spread-out field: the sphere spans all instances,
  // so the mesh is only culled when the whole line is off-screen.
  inst.computeBoundingSphere();
  return inst;
}
