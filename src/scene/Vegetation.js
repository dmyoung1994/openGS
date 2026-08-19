import {
  CanvasTexture, DataArrayTexture, SRGBColorSpace, Color, MathUtils,
  RGBAFormat, UnsignedByteType, LinearFilter, LinearMipmapLinearFilter,
} from 'three';

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
export function foliageTint(target = new Color(), random) {
  if (typeof random !== 'function') throw new Error('foliageTint requires a seeded RNG');
  const b = 0.56 + random() * 0.4;       // 0.56–0.96 overall brightness
  const t = random();
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
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

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

// Six isolated 256² array layers are the sole far-tree texture representation.
// Unlike a padded atlas, mip generation can never blend one silhouette/tint into a
// neighbour; WebGPU's texture-array sampling chooses the integer layer explicitly.
export function makeBillboardArray(deciduous, pine) {
  const tiles = [...deciduous, ...pine];
  if (tiles.length !== 6 || tiles.some((tile) => !tile?.image || tile.image.width !== 256 || tile.image.height !== 256)) {
    throw new Error('Tree billboard array requires six 256px canopy textures.');
  }
  const sourceSize = 256;
  const pixels = new Uint8Array(sourceSize * sourceSize * 4 * tiles.length);
  const canvas = document.createElement('canvas');
  canvas.width = sourceSize;
  canvas.height = sourceSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  tiles.forEach((tile, index) => {
    ctx.clearRect(0, 0, sourceSize, sourceSize);
    ctx.drawImage(tile.image, 0, 0, sourceSize, sourceSize);
    const layer = ctx.getImageData(0, 0, sourceSize, sourceSize).data;
    // RGB dilation into transparent texels prevents black/fringe colour from
    // contaminating averaged mip levels. Alpha is deliberately untouched, so
    // alpha-hash keeps the original statistical canopy coverage.
    for (let pass = 0; pass < 16; pass++) {
      const prev = new Uint8ClampedArray(layer);
      for (let y = 1; y < sourceSize - 1; y++) for (let x = 1; x < sourceSize - 1; x++) {
        const at = (y * sourceSize + x) * 4;
        if (prev[at + 3] !== 0) continue;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const near = ((y + oy) * sourceSize + x + ox) * 4;
          if (prev[near + 3] !== 0) { layer[at] = prev[near]; layer[at + 1] = prev[near + 1]; layer[at + 2] = prev[near + 2]; oy = 2; break; }
        }
      }
    }
    pixels.set(layer, index * sourceSize * sourceSize * 4);
  });
  const array = new DataArrayTexture(pixels, sourceSize, sourceSize, tiles.length);
  array.name = 'far-tree-billboard-array';
  array.format = RGBAFormat;
  array.type = UnsignedByteType;
  array.colorSpace = SRGBColorSpace;
  array.magFilter = LinearFilter;
  array.minFilter = LinearMipmapLinearFilter;
  array.anisotropy = 4;
  array.generateMipmaps = true;
  // CanvasTexture uploads source canvases flipped; preserve the same upright UV
  // convention for top-row-first getImageData array layers.
  array.flipY = true;
  array.needsUpdate = true;
  array.userData.billboardArray = { sourceSize, layers: tiles.length };
  return array;
}
