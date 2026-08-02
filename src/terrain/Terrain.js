import {
  BufferGeometry, BufferAttribute, Mesh, MeshStandardNodeMaterial,
  Vector2, Vector3, Color, DoubleSide, TextureLoader, RepeatWrapping, SRGBColorSpace,
  DataTexture, RGBAFormat, UnsignedByteType, NearestFilter,
} from 'three';
import {
  positionWorld, normalWorld, mx_noise_float, float, vec2, vec3, mix, texture, luminance, smoothstep,
} from 'three/tsl';
import { surface } from '../physics/groundInteraction.js';

// Manicured-lawn PBR maps (ambientCG Grass004, CC0), loaded once. Mown surfaces
// (fairway/tee/green/fringe) are now rendered as this TEXTURED ground rather than
// short 3D blades (blades only cover the taller rough). The color map is used as
// a DETAIL texture: its luminance/grain relights the per-zone tint (so each zone
// keeps its correct color), sampled at two scales to hide tiling, with mowing
// stripes on top. Normal + roughness maps give real turf relief.
const _texLoader = new TextureLoader();
function loadTurfMaps(rx, ry) {
  const load = (p, srgb) => {
    const t = _texLoader.load(p);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = SRGBColorSpace;
    return t;
  };
  const map = load('/assets/textures/fairway_diff.jpg', true);  // sampled in colorNode
  const nor = load('/assets/textures/fairway_nor_gl.jpg', false); nor.repeat.set(rx, ry);
  // No roughness map: its low-roughness texels put a broad specular sheen on the
  // turf that blew out to white on sun-facing slopes (bunker walls). Grass is
  // matte — a flat roughness of 1 reads correctly and kills the hot faces.
  return { map, normalMap: nor };
}

// A heightfield that is simultaneously the physics collision surface and the
// rendered ground. Heights are baked into a grid once at construction (CPU) so
// heightAt/normalAt are O(1) bilinear lookups; all per-frame shading work lives
// in the GPU material (procedural grass color, mowing stripes, micro-detail).
//
// config:
//   bounds:      { minX, maxX, minZ, maxZ }
//   spacing:     meters between grid samples (default 2)
//   heightFn:    (x, z) => elevation meters
//   surfaceFn:   (x, z) => key into SURFACES
export class Terrain {
  constructor(config) {
    const { bounds, spacing = 2, heightFn, surfaceFn } = config;
    this.bounds = bounds;
    this.spacing = spacing;
    this.heightFn = heightFn;
    this.surfaceFn = surfaceFn;

    this.nx = Math.floor((bounds.maxX - bounds.minX) / spacing) + 1;
    this.nz = Math.floor((bounds.maxZ - bounds.minZ) / spacing) + 1;
    this.heights = new Float32Array(this.nx * this.nz);

    this._bake();
    // A high-resolution surface splat (per-zone base color + mow mask), baked
    // independently of the coarser physics/mesh grid so zone boundaries render
    // CRISP (sampled per-fragment, Nearest) instead of soft vertex-interpolated.
    this.splatTex = this._bakeSplat(0.2);
    this.mesh = this._buildMesh();
  }

  // Rasterize the surface classifier into an RGBA splat: RGB = the muted per-zone
  // turf base color (same transform as the grass canopy, so ground and blades
  // match), A = mow-stripe mask (fairway/tee=1, fringe~0.4, else 0). Sampled by
  // world XZ in turfColorNode. `res` is the texel size in meters.
  _bakeSplat(res) {
    const { minX, minZ, maxX, maxZ } = this.bounds;
    const sx = Math.max(2, Math.ceil((maxX - minX) / res));
    const sz = Math.max(2, Math.ceil((maxZ - minZ) / res));
    const data = new Uint8Array(sx * sz * 4);
    const base = new Color();
    for (let j = 0; j < sz; j++) {
      for (let i = 0; i < sx; i++) {
        const x = minX + (i + 0.5) * (maxX - minX) / sx;
        const z = minZ + (j + 0.5) * (maxZ - minZ) / sz;
        const name = this.surfaceFn(x, z);
        turfBase(name, base).multiplyScalar(0.82);   // matches old per-vertex base
        const k = (j * sx + i) * 4;
        data[k] = Math.round(Math.min(1, base.r) * 255);
        data[k + 1] = Math.round(Math.min(1, base.g) * 255);
        data[k + 2] = Math.round(Math.min(1, base.b) * 255);
        data[k + 3] = name === 'fairway' || name === 'tee' ? 255
                    : name === 'fringe' ? 102 : 0;
      }
    }
    const tex = new DataTexture(data, sx, sz, RGBAFormat, UnsignedByteType);
    tex.minFilter = tex.magFilter = NearestFilter;   // crisp, no bleed across zones
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  _idx(i, j) { return j * this.nx + i; }

  _bake() {
    const { minX, minZ } = this.bounds;
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = minX + i * this.spacing;
        const z = minZ + j * this.spacing;
        this.heights[this._idx(i, j)] = this.heightFn(x, z);
      }
    }
  }

  // Bilinear height lookup, clamped to bounds.
  heightAt(x, z) {
    const { minX, minZ, maxX, maxZ } = this.bounds;
    const fx = (Math.min(Math.max(x, minX), maxX) - minX) / this.spacing;
    const fz = (Math.min(Math.max(z, minZ), maxZ) - minZ) / this.spacing;
    const i = Math.min(Math.floor(fx), this.nx - 2);
    const j = Math.min(Math.floor(fz), this.nz - 2);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.heights[this._idx(i, j)];
    const h10 = this.heights[this._idx(i + 1, j)];
    const h01 = this.heights[this._idx(i, j + 1)];
    const h11 = this.heights[this._idx(i + 1, j + 1)];
    const a = h00 * (1 - tx) + h10 * tx;
    const b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - tz) + b * tz;
  }

  // Surface normal from central differences of the height field.
  normalAt(x, z, out = new Vector3()) {
    const e = this.spacing;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    out.set(hL - hR, 2 * e, hD - hU).normalize();
    return out;
  }

  surfaceAt(x, z) {
    return this.surfaceFn(x, z);
  }

  _buildMesh() {
    const { nx, nz, spacing } = this;
    const { minX, minZ } = this.bounds;
    const vcount = nx * nz;
    const positions = new Float32Array(vcount * 3);
    const uvs = new Float32Array(vcount * 2);

    // Only geometry here now — per-zone color and the mow mask moved to the
    // high-res splat (this.splatTex), sampled per-fragment for crisp zone edges.
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = this._idx(i, j);
        const x = minX + i * spacing;
        const z = minZ + j * spacing;
        positions[k * 3] = x;
        positions[k * 3 + 1] = this.heights[k];
        positions[k * 3 + 2] = z;
        uvs[k * 2] = i / (nx - 1);
        uvs[k * 2 + 1] = j / (nz - 1);
      }
    }

    // Two triangles per grid cell.
    const indices = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = this._idx(i, j);
        const b = this._idx(i + 1, j);
        const d = this._idx(i, j + 1);
        const e = this._idx(i + 1, j + 1);
        indices.push(a, d, b, b, d, e);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Normal/roughness tile every ~1.8 m (matching the colorNode's world-space
    // sampling of the diffuse detail texture).
    const tile = 1.8;
    const rx = (this.bounds.maxX - this.bounds.minX) / tile;
    const ry = (this.bounds.maxZ - this.bounds.minZ) / tile;
    const maps = loadTurfMaps(rx, ry);
    const mat = new MeshStandardNodeMaterial({
      roughness: 1.0,
      metalness: 0.0,
      side: DoubleSide,
      normalMap: maps.normalMap,
      normalScale: new Vector2(0.5, 0.5),
    });
    // Per-zone tint (crisp splat) relit by the lawn detail texture.
    mat.colorNode = turfColorNode(maps.map, this.splatTex, this.bounds);

    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;   // so the rolling terrain SELF-SHADOWS in raking light
    mesh.name = 'terrain';
    return mesh;
  }
}

// Mowing-stripe band width in meters. Shared conceptually with Grass.js so the
// ground bands and the blade lean line up in world Z.
const STRIPE_M = 6.0;
const _hsl = { h: 0, s: 0, l: 0 };

// Turn the gameplay surface colors into natural sun-lit turf: pull the hue
// toward true green (cooler, less lime), desaturate to kill the neon, and drop
// the value. Grass.js runs the IDENTICAL transform on the same SURFACES color,
// which is what keeps the ground color-matched to the blades on top of it.
function turfBase(name, out) {
  out.set(surface(name).color);
  out.getHSL(_hsl, SRGBColorSpace);
  out.setHSL(
    _hsl.h + (0.31 - _hsl.h) * 0.32,
    _hsl.s * 0.68,
    _hsl.l * 0.82,
    SRGBColorSpace,
  );
  return out;
}

// TSL colorNode: the per-zone tint (`color`) relit by a manicured-lawn detail
// texture (`diffTex`). The texture's luminance carries the blade grain while the
// zone tint sets the actual color of each surface (fairway/rough/green), so it's
// photographic AND correctly colored. Sampled at two world scales to break
// tiling, with soft-edged mowing stripes and a large-scale drift on top.
function turfColorNode(diffTex, splatTex, bounds) {
  const wx = positionWorld.x;
  const wz = positionWorld.z;
  // Per-zone base color + mow mask from the high-res splat, sampled per-fragment
  // (Nearest) so zone boundaries — the green collar, the fairway/rough line —
  // land CRISP instead of the soft vertex-interpolated blend they were before.
  // Warp the sample point with a little world-space noise so the crisp zone
  // edges read as organic collars/lines (not perfect circles) and the texel
  // stair-steps of the Nearest splat dissolve into a natural wander.
  const wox = mx_noise_float(vec3(wx.mul(0.16), wz.mul(0.16), 11.0)).mul(0.7);
  const woz = mx_noise_float(vec3(wx.mul(0.16), wz.mul(0.16), 23.0)).mul(0.7);
  const su = wx.add(wox).sub(bounds.minX).div(bounds.maxX - bounds.minX);
  const sv = wz.add(woz).sub(bounds.minZ).div(bounds.maxZ - bounds.minZ);
  const splat = texture(splatTex, vec2(su, sv));
  const baseCol = splat.rgb;
  const stripeMask = splat.a;

  // Two-scale sample of the lawn texture — mixing 1.8 m and 5.5 m repeats hides
  // the obvious tiling you'd get from a single scale down a long fairway.
  const uv1 = vec2(wx, wz).mul(1 / 1.8);
  const uv2 = vec2(wx, wz).mul(1 / 5.5);
  const tex = mix(texture(diffTex, uv1), texture(diffTex, uv2), float(0.4));
  const texLum = luminance(tex.rgb).max(0.001);

  // Relight the zone tint by the texture luminance (grain), plus a hint of the
  // texture's own hue variation (yellow/olive flecks) for richness.
  const detail = texLum.div(0.09).clamp(0.55, 1.6);
  const chroma = mix(vec3(1.0), tex.rgb.div(texLum), 0.30);
  let c = baseCol.mul(detail).mul(chroma);

  // Mowing stripes — clear alternating light/dark bands down world Z on the
  // mown turf (fairway/tee via stripeMask). The classic "that's a real course"
  // cue; stronger than before, soft-edged, with a faint cool/warm tone shift so
  // the light and dark bands read as different mow directions.
  // A slow noise offset bends the bands with the ground so they read as mower
  // arcs / terrain-warped stripes, not a perfect ruler grid; softened contrast.
  const stripeWarp = mx_noise_float(vec3(wx.mul(0.02), wz.mul(0.02), 5.0)).mul(1.6);
  const sp = wz.add(stripeWarp).mul(Math.PI / STRIPE_M).sin();
  const band = sp.sign().mul(smoothstep(0.0, 0.6, sp.abs())).mul(stripeMask);
  const mow = float(1.0).add(band.mul(0.18));
  const stripeTint = mix(vec3(1.0), vec3(1.03, 1.0, 0.96), band.mul(0.5).add(0.5));
  c = c.mul(mow).mul(stripeTint);

  // Two-scale MaterialX drift (brightness + slow hue) to kill the tile repeat
  // that marches to the horizon.
  const m1 = mx_noise_float(vec3(wx.mul(0.03), wz.mul(0.03), 0.0)).mul(0.5).add(0.5);
  const m2 = mx_noise_float(vec3(wx.mul(0.007), wz.mul(0.007), 3.0)).mul(0.5).add(0.5);
  c = c.mul(m1.mul(0.16).add(0.88)).mul(m2.mul(0.12).add(0.94));

  // Slightly desaturate + warm so the fairway is muted olive, not radioactive.
  const lum = luminance(c);
  c = mix(vec3(lum), c, 0.9).mul(vec3(1.03, 1.0, 0.95));

  // A gentle richening of steep faces (bunker walls, green shoulders): steep
  // grass is self-shadowed, so fold albedo down slightly with the slope. Subtle
  // now that the specular blowout is fixed (no roughness map) — this is polish.
  const slopeShade = smoothstep(0.35, 0.85, normalWorld.y);   // 0 vertical → 1 flat
  c = c.mul(mix(float(0.7), float(1.0), slopeShade));
  return c;
}
