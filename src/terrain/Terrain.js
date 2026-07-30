import {
  BufferGeometry, BufferAttribute, Mesh, MeshStandardNodeMaterial,
  Vector2, Vector3, Color, DoubleSide, TextureLoader, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { attribute, positionWorld, mx_noise_float, float, vec3, smoothstep } from 'three/tsl';
import { surface } from '../physics/groundInteraction.js';

// Shared, tiled PBR turf maps (loaded once). Vertex colors still tint each
// zone (fairway vs rough vs green), multiplied over this photographic detail.
const _texLoader = new TextureLoader();
// Only a faint normal map for lighting relief — NOT a diffuse map. A tiled
// photographic ground reads as blotchy repetition at golf scale; the mown
// surface colour comes from clean vertex-zone tint + noise, and the visible
// texture of the turf comes from the instanced grass blades on top.
function loadTurfMaps(rx, ry) {
  const nor = _texLoader.load('/assets/textures/grass_nor_gl.jpg');
  nor.wrapS = nor.wrapT = RepeatWrapping;
  nor.repeat.set(rx, ry);
  nor.anisotropy = 8;
  return { normalMap: nor };
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
    const colors = new Float32Array(vcount * 3);
    const uvs = new Float32Array(vcount * 2);
    // Per-vertex "how mown is this" mask: 1 on fairway/tee, partial on fringe,
    // 0 on green/rough/hazards. Drives where the shader paints mow stripes so
    // the rough and greens don't get striped like a fairway.
    const stripeMask = new Float32Array(vcount);

    const c = new Color();
    const base = new Color();
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = this._idx(i, j);
        const x = minX + i * spacing;
        const z = minZ + j * spacing;
        const y = this.heights[k];
        positions[k * 3] = x;
        positions[k * 3 + 1] = y;
        positions[k * 3 + 2] = z;
        uvs[k * 2] = i / (nx - 1);
        uvs[k * 2 + 1] = j / (nz - 1);

        // Per-vertex base color, muted from the gameplay surface color the exact
        // same way the grass blades are (see turfBase). This is what makes the
        // ground and the canopy one continuous turf instead of a bright carpet
        // showing through darker blades. Interpolation across the grid softens
        // the zone seams (fairway->rough->green) for free.
        const surfName = this.surfaceFn(x, z);
        // Slightly darkened so the IBL/sun-lit ground meets the analytically-lit
        // grass canopy at the same luminance — otherwise the brighter ground
        // shows through the blades as a mismatched pale patch.
        turfBase(surfName, base).multiplyScalar(0.82);
        const v = 0.92 + 0.10 * hash2(i * 0.37, j * 0.53);
        c.copy(base).multiplyScalar(v);
        colors[k * 3] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;

        stripeMask[k] = surfName === 'fairway' || surfName === 'tee' ? 1.0
                      : surfName === 'fringe' ? 0.4 : 0.0;
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
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setAttribute('stripeMask', new BufferAttribute(stripeMask, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Tile the turf photo so one repeat is ~5 m across the whole field.
    const tile = 5;
    const rx = (this.bounds.maxX - this.bounds.minX) / tile;
    const ry = (this.bounds.maxZ - this.bounds.minZ) / tile;
    const maps = loadTurfMaps(rx, ry);
    const mat = new MeshStandardNodeMaterial({
      roughness: 1.0,
      metalness: 0.0,
      side: DoubleSide,
      ...maps,
      normalScale: new Vector2(0.35, 0.35),
    });
    // The zone tint (vertex `color`) times the procedural mow/detail node.
    mat.colorNode = turfColorNode();

    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'terrain';
    return mesh;
  }
}

// Cheap deterministic hash for per-vertex jitter.
function hash2(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
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

// TSL colorNode: the per-vertex zone tint (`color`) multiplied by soft-edged
// mowing stripes plus multi-scale procedural detail, so the GROUND itself reads
// as tight mown turf even where the blades thin out (not flat paint). Ported
// from the old GLSL onBeforeCompile injection to run natively under WebGPU.
function turfColorNode() {
  const wx = positionWorld.x;
  const wz = positionWorld.z;
  const stripeMask = attribute('stripeMask', 'float');
  const baseCol = attribute('color', 'vec3');

  // Soft-edged mow bands alternating down world Z, only where the turf is mown.
  const sp = wz.mul(Math.PI / STRIPE_M).sin();
  const band = sp.sign().mul(smoothstep(0.0, 0.5, sp.abs()));
  const mow = float(1.0).add(band.mul(0.16).mul(stripeMask));

  // Smooth MaterialX noise sampled at several scales, remapped to [0,1].
  const n = (f) => mx_noise_float(vec3(wx.mul(f), wz.mul(f), 0.0)).mul(0.5).add(0.5);
  const micro = n(16.0).mul(0.20).add(0.90);   // blade-scale grain
  const mottle = n(1.6).mul(0.24).add(0.88);   // turf color unevenness
  const clump = n(0.7).mul(0.14).add(0.93);    // tufts/clumps
  const wear = float(1.0).sub(smoothstep(0.5, 1.0, n(0.3)).mul(0.10));
  const divot = float(1.0).sub(smoothstep(0.92, 1.0, n(1.3)).mul(0.14));
  const macro = n(0.045).mul(0.16).add(0.92);  // large drift, hides tiling

  const detail = mow.mul(micro).mul(mottle).mul(clump).mul(wear).mul(divot).mul(macro);
  return baseCol.mul(detail);
}
