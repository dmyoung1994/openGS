import {
  BufferGeometry, BufferAttribute, Mesh, MeshStandardMaterial,
  Vector2, Vector3, Color, DoubleSide, TextureLoader, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { SURFACES, surface } from '../physics/groundInteraction.js';

const WHITE = new Color(0xffffff);

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

        // Per-vertex base color from the surface, with subtle variation so the
        // turf never looks flat. Interpolation across the grid softens the seams
        // between zones (fairway->rough->green) for free.
        // The photographic turf map carries the detail; the vertex color is a
        // gentle *tint* (pushed toward white) so zones read without darkening
        // the texture into mud.
        const surf = surface(this.surfaceFn(x, z));
        base.set(surf.color).lerp(WHITE, 0.08);
        const v = 0.90 + 0.12 * hash2(i * 0.37, j * 0.53);
        c.copy(base).multiplyScalar(v);
        colors[k * 3] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;
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
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Tile the turf photo so one repeat is ~5 m across the whole field.
    const tile = 5;
    const rx = (this.bounds.maxX - this.bounds.minX) / tile;
    const ry = (this.bounds.maxZ - this.bounds.minZ) / tile;
    const maps = loadTurfMaps(rx, ry);
    const mat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1.0,
      metalness: 0.0,
      side: DoubleSide,
      ...maps,
      normalScale: new Vector2(0.35, 0.35),
    });
    injectTurfShader(mat, spacing);

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

// Inject mowing stripes + fine procedural detail into a standard material,
// keeping PBR lighting and shadows. All of this runs in the fragment shader.
function injectTurfShader(mat, spacing) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStripeDir = { value: 22.0 }; // stripe width in meters-ish
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vWorldPos;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n varying vec3 vWorldPos;\n uniform float uStripeDir;
        float hnoise(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      `)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Subtle mowing stripes over the photographic turf. The texture already
        // supplies blade-scale detail, so this is just a faint mow pattern plus
        // large-scale color drift to break up tiling.
        float stripe = sin(vWorldPos.z / uStripeDir * 3.14159);
        float mow = 1.0 + 0.035 * sign(stripe) * smoothstep(0.0, 0.3, abs(stripe));
        float macro = 0.93 + 0.14 * hnoise(floor(vWorldPos.xz * 0.05));
        diffuseColor.rgb *= mow * macro;
        `,
      );
  };
  mat.userData.turf = true;
}
