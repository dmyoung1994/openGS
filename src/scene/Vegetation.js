import {
  InstancedMesh, InstancedBufferAttribute, PlaneGeometry, MeshBasicMaterial,
  CanvasTexture, SRGBColorSpace, DoubleSide, Color, MathUtils,
} from 'three';
import {
  texture, vec4, positionLocal, modelWorldMatrix,
  cameraViewMatrix, cameraProjectionMatrix, attribute,
} from 'three/tsl';

// ---------------------------------------------------------------------------
// Billboard "imposter" trees  (WebGPU / TSL).
//
// The real GLB / procedural trees carry geometry, so we only want a limited
// number of them up front. To make the tree line read as a DEEP, layered forest
// wall we back them with thousands of camera-facing billboard imposters: flat
// quads, each showing a baked, pre-shaded tree image. Two triangles apiece, so we
// can afford several thousand and still sit comfortably at 60fps.
//
// Self-contained: the tree images are painted onto a <canvas> at runtime (no
// external files) with a NOISE-ERODED alpha edge so the silhouettes read broken
// and organic, not as clean hard-edged cones. Camera-facing + per-instance tint
// are done with TSL nodes (onBeforeCompile GLSL does NOT run under WebGPU).
// ---------------------------------------------------------------------------

// A natural spread of foliage tint colours. These MULTIPLY the (already green)
// tree texture / leaf albedo. Biased toward warm olive / forest greens (NOT
// radioactive lime): deep forest, olive, muted green, and the odd early-autumn
// tree. `b` is an overall brightness so some trees read darker than others.
export function foliageTint(target = new Color()) {
  const b = 0.56 + Math.random() * 0.4;       // 0.56–0.96 overall brightness
  const t = Math.random();
  if (t < 0.12) return target.setRGB(b * 0.98, b * 0.86, b * 0.44);  // autumn yellow-green
  if (t < 0.44) return target.setRGB(b * 0.68, b * 0.78, b * 0.5);   // olive
  if (t < 0.76) return target.setRGB(b * 0.6, b * 0.82, b * 0.55);   // muted green
  return target.setRGB(b * 0.45, b * 0.66, b * 0.5);                 // deep forest
}

// Seeded value-noise sampler in [0,1]^2 → [0,1], used to erode the canopy alpha
// edge. Two octaves off a small random grid so the fringe reads organic.
function makeNoise(rnd) {
  const G = 48;
  const grid = new Float32Array((G + 1) * (G + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const g = (x, y) => grid[Math.min(G, y) * (G + 1) + Math.min(G, x)];
  const sample = (u, v) => {
    const fx = u * G;
    const fy = v * G;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = g(x0, y0);
    const b = g(x0 + 1, y0);
    const c = g(x0, y0 + 1);
    const d = g(x0 + 1, y0 + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
  return (u, v) => 0.6 * sample(u, v) + 0.4 * sample((u * 2) % 1, (v * 2) % 1);
}

// Paint a single lush tree onto a canvas and return an RGBA CanvasTexture.
// `kind` is 'deciduous' (rounded crown) or 'pine' (conical, tiered). The crown is
// drawn LOW so it overlaps the trunk, a vertical light gradient is multiplied over
// it (warm/bright on top, cool/dark underneath), and finally the alpha edge is
// eroded with noise so the silhouette is broken rather than a clean cone.
export function makeCanopyBillboardTexture(kind = 'deciduous', seed = 1) {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');

  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  const greens = kind === 'pine'
    ? { base: '#3d6b42', shadow: '#294a2e', hi: '#6e9a52' }
    : { base: '#4f8a40', shadow: '#345f2b', hi: '#8fb85a' };

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
    const tiers = 7;
    for (let ti = 0; ti < tiers; ti++) {
      const f = ti / (tiers - 1);
      const cy = S * (0.12 + f * 0.78);
      const halfW = S * (0.06 + f * 0.4);
      const blobs = 5 + Math.round(f * 7);
      for (let bl = 0; bl < blobs; bl++) {
        const bx = S / 2 + MathUtils.lerp(-halfW, halfW, bl / (blobs - 1)) + (rnd() - 0.5) * 12;
        const by = cy + (rnd() - 0.5) * S * 0.09;
        clump(bx, by, S * 0.085 * (1 - f * 0.2), rnd() > 0.6 ? 'hi' : 'base');
      }
    }
  } else {
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
  // the transparent surround) so tops read warm/sunlit and undersides fall dark.
  ctx.globalCompositeOperation = 'source-atop';
  const grad = ctx.createLinearGradient(0, S * 0.08, 0, S);
  grad.addColorStop(0, 'rgba(255,247,214,0.4)');    // warm sun on top
  grad.addColorStop(0.4, 'rgba(255,255,255,0.0)');
  grad.addColorStop(1, 'rgba(16,30,18,0.78)');       // dark cool underside
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';

  // Erode the alpha with noise: pushes the soft canopy edge raggedly under the
  // alphaTest cutoff (broken silhouette) and opens a few interior sky gaps.
  const noise = makeNoise(rnd);
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = (y * S + x) * 4;
      const a = d[idx + 3];
      if (a === 0 || y > trunkTop) continue;         // leave the trunk intact
      const f = 0.42 + 1.0 * noise(x / S, y / S);     // 0.42–1.42
      d[idx + 3] = Math.min(255, a * f);
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

// A reusable billboard material (unlit — lighting is baked into the texture).
// The camera-facing behaviour and per-instance tint are set per InstancedMesh in
// instanceBillboards(); this helper just carries the shared material config.
export function createBillboardMaterial(map) {
  return new MeshBasicMaterial({
    map,
    alphaTest: 0.42,
    transparent: false,
    side: DoubleSide,
    fog: true,
    toneMapped: true,
  });
}

// Build an InstancedMesh of billboard trees from placements
// [{x, y, z, targetHeight, widthRatio?}]. Each card faces the camera (TSL
// vertexNode) and gets a per-instance foliage tint (TSL colorNode) so the wall
// reads as many different trees, not one repeated blob.
export function instanceBillboards(placements, { texture: map, widthRatio = 0.78, tint = true } = {}) {
  const N = placements.length;
  // Bottom-centred unit quad (pivot at the trunk base): x∈[-0.5,0.5], y∈[0,1].
  const geom = new PlaneGeometry(1, 1);
  geom.translate(0, 0.5, 0);

  // Per-instance data fed to the shader as instanced attributes.
  const centerArr = new Float32Array(N * 3);  // world base position
  const sizeArr = new Float32Array(N * 2);    // (width, height)
  const tintArr = new Float32Array(N * 3);    // foliage tint
  const c = new Color();
  for (let i = 0; i < N; i++) {
    const p = placements[i];
    centerArr[i * 3] = p.x; centerArr[i * 3 + 1] = p.y; centerArr[i * 3 + 2] = p.z;
    sizeArr[i * 2] = p.targetHeight * (p.widthRatio || widthRatio);
    sizeArr[i * 2 + 1] = p.targetHeight;
    if (tint) foliageTint(c);
    else c.setRGB(1, 1, 1);
    tintArr[i * 3] = c.r; tintArr[i * 3 + 1] = c.g; tintArr[i * 3 + 2] = c.b;
  }
  // Per-instance data as InstancedBufferAttributes read via the attribute() node
  // (steps once per instance under WebGPU).
  geom.setAttribute('bCenter', new InstancedBufferAttribute(centerArr, 3));
  geom.setAttribute('bSize', new InstancedBufferAttribute(sizeArr, 2));
  geom.setAttribute('bTint', new InstancedBufferAttribute(tintArr, 3));
  const centerN = attribute('bCenter', 'vec3');
  const sizeN = attribute('bSize', 'vec2');
  const tintN = attribute('bTint', 'vec3');

  const mat = createBillboardMaterial(map);

  // Camera-facing (view-plane billboard): place the instance's world centre in
  // view space, then add the quad's local x/y scaled by (width,height). The card
  // always faces the camera and its base stays pinned to the ground.
  const worldCenter = modelWorldMatrix.mul(vec4(centerN, 1.0));
  const viewCenter = cameraViewMatrix.mul(worldCenter);
  const off = positionLocal.xy.mul(sizeN);
  const viewPos = vec4(viewCenter.x.add(off.x), viewCenter.y.add(off.y), viewCenter.z, viewCenter.w);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // Albedo = baked texture × per-tree tint; keep the texture alpha for alphaTest.
  const tex = texture(map);
  mat.colorNode = vec4(tex.rgb.mul(tintN), tex.a);

  const inst = new InstancedMesh(geom, mat, N);
  inst.castShadow = false;        // cheap backdrop; the real trees carry the shadows
  inst.receiveShadow = false;
  // Positions come from the vertexNode, not instanceMatrix, so the auto bounding
  // sphere is meaningless here — keep the whole wall unculled (it's always on).
  inst.frustumCulled = false;
  return inst;
}
