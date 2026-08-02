import {
  BufferGeometry, BufferAttribute, Mesh, MeshStandardNodeMaterial,
  Vector2, Vector3, Color, DoubleSide, TextureLoader, RepeatWrapping, SRGBColorSpace,
} from 'three';
import {
  positionWorld, normalWorld, mx_noise_float, float, vec2, vec3, mix, texture,
  luminance, smoothstep, oneMinus,
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
    const { bounds, spacing = 2, heightFn, surfaceFn, zones } = config;
    this.bounds = bounds;
    this.spacing = spacing;
    this.heightFn = heightFn;
    this.surfaceFn = surfaceFn;
    // Geometric zone spec (greens/sands circles, fairway corridor, tee box) used
    // to classify the turf ANALYTICALLY in the shader — smooth-curve boundaries
    // instead of a rasterized splat's stair-stepped squares. See turfColorNode.
    this.zones = zones;

    this.nx = Math.floor((bounds.maxX - bounds.minX) / spacing) + 1;
    this.nz = Math.floor((bounds.maxZ - bounds.minZ) / spacing) + 1;
    this.heights = new Float32Array(this.nx * this.nz);

    this._bake();
    this.mesh = this._buildMesh();
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
    // Analytic per-zone tint (smooth-curve boundaries) relit by the lawn detail
    // texture. Bake the muted per-zone colors once; sand keeps its own tan (the
    // green-ward turfBase transform is only for grass).
    const grassCol = (name) => {
      const c = turfBase(name, new Color()).multiplyScalar(0.82);
      return vec3(c.r, c.g, c.b);
    };
    const sc = new Color(surface('sand').color).multiplyScalar(0.82);
    const palette = {
      fairway: grassCol('fairway'), rough: grassCol('rough'), deepRough: grassCol('deepRough'),
      green: grassCol('green'), fringe: grassCol('fringe'), tee: grassCol('tee'),
      sand: vec3(sc.r, sc.g, sc.b),
    };
    mat.colorNode = turfColorNode(maps.map, { ...this.zones, colors: palette });

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
function turfColorNode(diffTex, zones) {
  const wx = positionWorld.x;
  const wz = positionWorld.z;
  const C = zones.colors;                 // vec3 per zone
  const AA = 0.16;                        // edge softness (m): smooth curve, still crisp

  // ANALYTIC zone classification: boundaries are true smooth curves — greens and
  // bunkers are circles, the fairway is a z-widening corridor — so edges read as
  // smooth mowing lines, NOT the stair-stepped squares a rasterized splat gives.
  // A gentle low-frequency domain warp makes the curves organic (not machined
  // circles) while staying smooth. The same math mirrors Range._surface.
  const dwx = wx.add(mx_noise_float(vec3(wx.mul(0.09), wz.mul(0.09), 4.0)).mul(0.6));
  const dwz = wz.add(mx_noise_float(vec3(wx.mul(0.09), wz.mul(0.09), 8.0)).mul(0.6));

  const ax = dwx.abs();
  const half = float(zones.corridor.c0).add(dwz.negate().mul(zones.corridor.k));
  let baseCol = C.deepRough;
  baseCol = mix(baseCol, C.rough,
    oneMinus(smoothstep(half.add(zones.corridor.rough - AA), half.add(zones.corridor.rough + AA), ax)));
  baseCol = mix(baseCol, C.fairway, oneMinus(smoothstep(half.sub(AA), half.add(AA), ax)));
  let stripeMask = oneMinus(smoothstep(half.sub(AA), half.add(AA), ax));   // fairway stripes

  // Green complexes: fringe collar, then putting surface (both circles).
  for (const g of zones.greens) {
    const d = vec2(dwx.sub(g.x), dwz.sub(g.z)).length();
    const fr = oneMinus(smoothstep(g.r + zones.fringeW - AA, g.r + zones.fringeW + AA, d));
    const gr = oneMinus(smoothstep(g.r - AA, g.r + AA, d));
    baseCol = mix(baseCol, C.fringe, fr);
    baseCol = mix(baseCol, C.green, gr);
    stripeMask = stripeMask.mul(oneMinus(fr));       // no fairway stripes over a green
  }
  // Sand floors (mostly under the overlay disc; keeps the ground edge consistent).
  for (const s of zones.sands) {
    const d = vec2(dwx.sub(s.x), dwz.sub(s.z)).length();
    const sa = oneMinus(smoothstep(s.r - AA, s.r + AA, d));
    baseCol = mix(baseCol, C.sand, sa);
    stripeMask = stripeMask.mul(oneMinus(sa));
  }
  // Tee mat surround (a mown box).
  const tee = zones.tee;
  const teeM = oneMinus(smoothstep(tee.x - AA, tee.x + AA, ax))
    .mul(smoothstep(tee.z0 - AA, tee.z0 + AA, dwz))
    .mul(oneMinus(smoothstep(tee.z1 - AA, tee.z1 + AA, dwz)));
  baseCol = mix(baseCol, C.tee, teeM);
  stripeMask = stripeMask.max(teeM);

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

  // Revetted (stacked-sod) faces: the pot bunkers are the only near-vertical
  // terrain, so trigger on steepness alone. Replace the grass with horizontal
  // banded sod layers (constant world-Y bands = stacked turf courses) — the
  // classic links pot-bunker wall. A little noise breaks the ruler-straight
  // courses so they read as hand-stacked sod.
  const steep = smoothstep(0.62, 0.4, normalWorld.y);         // 1 only on near-vertical walls
  const yWarp = mx_noise_float(vec3(wx.mul(0.7), wz.mul(0.7), 2.0)).mul(0.03);
  const sod = positionWorld.y.add(yWarp).mul(42.0).sin().mul(0.5).add(0.5);
  // Warm, earthy sod courses (dark peat → tan-olive turf edge); the cool sky fill
  // in the shaded pit would otherwise read blue-grey.
  const revet = mix(vec3(0.075, 0.07, 0.045), vec3(0.185, 0.165, 0.11), sod);
  c = mix(c, revet, steep);

  // A gentle richening of steep faces (green shoulders, bunker walls): steep
  // grass is self-shadowed, so fold albedo down slightly with the slope.
  const slopeShade = smoothstep(0.35, 0.85, normalWorld.y);   // 0 vertical → 1 flat
  c = c.mul(mix(float(0.72), float(1.0), slopeShade));
  return c;
}
