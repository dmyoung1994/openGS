import {
  InstancedBufferGeometry, BufferAttribute, Mesh, Group, MeshBasicNodeMaterial,
  DataTexture, RedFormat, RGBAFormat, FloatType, UnsignedByteType, NearestFilter,
  Color, Vector2, Vector3, DoubleSide, Sphere, Frustum, Matrix4, SRGBColorSpace,
} from 'three';
import {
  instanceIndex, positionLocal, cameraPosition, modelWorldMatrix, uniform, varying,
  textureLoad, vec2, vec3, vec4, float, int, ivec2, mix, smoothstep,
} from 'three/tsl';
import { surface } from '../physics/groundInteraction.js';

// Static, frustum-culled grass (WebGPU / TSL) in the Ghost-of-Tsushima /
// GodotGrass spirit. The play area is a fixed grid of ~8 m TILES, all sharing one
// blade geometry and one material. The engine frustum-culls each tile by its
// bounding sphere, and we distance-cull the rest each frame, so ONLY the tiles
// you're actually looking at ever reach the vertex shader — everything else
// costs nothing. Within a visible tile, blades are generated procedurally from
// the tile's world origin (modelWorldMatrix), sampling terrain HEIGHT and a baked
// TURF DATA texture (muted color + blade-height code) on the GPU. Density and
// height fall off with distance from the camera (LOD); off-turf cells collapse.
export class Grass {
  constructor({ terrain, camera, tileSize = 8, gridPerTile = 192, radius = 100 }) {
    this.terrain = terrain;
    this.camera = camera;
    this.tileSize = tileSize;
    this.radius = radius;

    const { heightTex, dataTex } = this._bakeTextures(terrain);

    this.uTime = uniform(0);
    this.uGust = uniform(0);
    this.uWindDir = uniform(new Vector2(0.8, 0.6).normalize());
    this.uWindStrength = uniform(0.11);
    const sun = new Color(0xffefd2).multiplyScalar(1.9);
    const amb = new Color(0x7c9db0).multiplyScalar(1.05);
    this.uSunDir = uniform(new Vector3(-0.62, 0.4, 0.3).normalize());
    this.uSunColor = uniform(new Vector3(sun.r, sun.g, sun.b));
    this.uAmbient = uniform(new Vector3(amb.r, amb.g, amb.b));

    this._const = {
      tileSize, gridPerTile, cell: tileSize / gridPerTile, radius,
      nx: terrain.nx, nz: terrain.nz,
      bMinX: terrain.bounds.minX, bMinZ: terrain.bounds.minZ,
      bSizeX: terrain.bounds.maxX - terrain.bounds.minX,
      bSizeZ: terrain.bounds.maxZ - terrain.bounds.minZ,
      heightTex, dataTex,
    };

    this._frustum = new Frustum();
    this._pm = new Matrix4();
    this.mesh = new Group();
    this.mesh.name = 'grass';
    this.tiles = [];
    this._buildTiles();
    // Cull once up front so the very FIRST rendered frame is already light
    // (otherwise every tile is visible-by-default and the first draw would try to
    // render the entire course of grass at once).
    this.update(0, camera);
  }

  _bakeTextures(terrain) {
    const { nx, nz } = terrain;
    const heightTex = new DataTexture(terrain.heights, nx, nz, RedFormat, FloatType);
    heightTex.minFilter = heightTex.magFilter = NearestFilter;
    heightTex.generateMipmaps = false;
    heightTex.needsUpdate = true;

    const data = new Uint8Array(nx * nz * 4);
    const col = new Color();
    const { minX, minZ } = terrain.bounds;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = minX + i * terrain.spacing;
        const z = minZ + j * terrain.spacing;
        const name = terrain.surfaceAt(x, z);
        turfBase(name, col);
        const k = (j * nx + i) * 4;
        data[k] = Math.round(Math.min(1, col.r) * 255);
        data[k + 1] = Math.round(Math.min(1, col.g) * 255);
        data[k + 2] = Math.round(Math.min(1, col.b) * 255);
        data[k + 3] = Math.round((bladeHeight(name) / MAX_H) * 255);
      }
    }
    const dataTex = new DataTexture(data, nx, nz, RGBAFormat, UnsignedByteType);
    dataTex.minFilter = dataTex.magFilter = NearestFilter;
    dataTex.generateMipmaps = false;
    dataTex.needsUpdate = true;
    return { heightTex, dataTex };
  }

  // Shared blade geometry + one tile mesh per grid cell that actually contains
  // grass turf. Meshes share geometry/material; only their position differs.
  _buildTiles() {
    const C = this._const;
    const SEG = 3, rows = SEG + 1;
    const basePos = [];
    for (let r = 0; r < rows; r++) { const y = r / SEG; basePos.push(-0.5, y, 0, 0.5, y, 0); }
    const idx = [];
    for (let r = 0; r < SEG; r++) {
      const a = r * 2, b = r * 2 + 1, c = r * 2 + 2, d = r * 2 + 3;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(basePos), 3));
    geo.setIndex(idx);
    geo.instanceCount = C.gridPerTile * C.gridPerTile;
    // Local-space bounding sphere covering one tile's blades (X/Z in [0,tile],
    // Y ~ the tile's terrain height plus blades); transformed per mesh -> correct
    // per-tile world sphere for the engine's frustum cull.
    geo.boundingSphere = new Sphere(new Vector3(C.tileSize / 2, 2.5, C.tileSize / 2), C.tileSize * 0.71 + 6);
    this._geo = geo;

    const mat = this._material();
    const t = this.terrain;
    const { minX, maxX, minZ, maxZ } = t.bounds;
    const S = C.tileSize;
    for (let tz = minZ; tz < maxZ; tz += S) {
      for (let tx = minX; tx < maxX; tx += S) {
        // Keep a tile only if its area actually holds grass turf (sample a few
        // points), so we don't spawn thousands of empty tiles over sand/water.
        if (!this._tileHasGrass(tx, tz, S)) continue;
        const m = new Mesh(geo, mat);
        m.position.set(tx, 0, tz);
        m.frustumCulled = false;   // we cull manually (distance + frustum) in update()
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        m.updateMatrixWorld(true);
        m._sphere = new Sphere(new Vector3(tx + S / 2, 2.5, tz + S / 2), S * 0.71 + 6);
        this.mesh.add(m);
        this.tiles.push(m);
      }
    }
  }

  _tileHasGrass(tx, tz, S) {
    for (let a = 0.15; a < 1; a += 0.35) {
      for (let b = 0.15; b < 1; b += 0.35) {
        if (bladeHeight(this.terrain.surfaceAt(tx + a * S, tz + b * S)) > 0) return true;
      }
    }
    return false;
  }

  _material() {
    const C = this._const;
    const hash2 = (v, s) => v.x.mul(12.9898).add(v.y.mul(78.233)).add(s).sin().mul(43758.5453).fract();

    // Tile world origin from the model matrix (pure XZ translation; y = 0).
    const origin = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;

    // Per-blade cell within the tile, hashed by WORLD cell index (world-anchored,
    // so identical wherever it's rendered — no swim).
    const iidF = float(instanceIndex);
    const cxi = iidF.mod(C.gridPerTile);
    const czi = iidF.div(C.gridPerTile).floor();
    const wcx = origin.x.div(C.cell).add(cxi);   // integer world cell index
    const wcz = origin.z.div(C.cell).add(czi);
    const cellv = vec2(wcx, wcz);
    const hA = hash2(cellv, 0.0), hB = hash2(cellv, 1.7), hC = hash2(cellv, 3.3);
    const hD = hash2(cellv, 5.1), hE = hash2(cellv, 7.7), hF = hash2(cellv, 9.3);

    const worldX = wcx.add(0.5).mul(C.cell).add(hA.sub(0.5).mul(C.cell * 0.9));
    const worldZ = wcz.add(0.5).mul(C.cell).add(hB.sub(0.5).mul(C.cell * 0.9));

    // Sample terrain from GPU textures.
    const uvx = worldX.sub(C.bMinX).div(C.bSizeX);
    const uvz = worldZ.sub(C.bMinZ).div(C.bSizeZ);
    const inB = uvx.greaterThan(0.0).and(uvx.lessThan(1.0)).and(uvz.greaterThan(0.0)).and(uvz.lessThan(1.0));
    const groundY = this._sampleHeight(uvx, uvz);
    const data = this._sampleData(uvx, uvz);
    const baseColor = data.xyz;
    const hMax = data.w.mul(MAX_H);

    // Two-tier mown canopy. Short upright blades are 2D slivers you can see the
    // ground between; real mown turf interweaves. On mown surfaces (fairway / tee
    // / green, small hMax) ~half the blades become a WIDE, short, laid-over "mat"
    // layer (random orientation -> overlaps and closes the canopy), and the rest
    // are wider, gently laid-over uprights. Rough/deepRough keep tall wispy blades.
    const isMown = hMax.lessThan(0.07);
    const isMat = hF.lessThan(0.55);
    const matSel = isMown.and(isMat);
    const widthMul = matSel.select(3.4, isMown.select(1.6, 1.0));
    const heightMul = matSel.select(0.5, 1.0);
    const leanAmt = matSel.select(0.95, isMown.select(0.30, smoothstep(0.05, 0.25, hMax).mul(0.5)));

    // Distance LOD (from the actual camera) + liveness.
    const dx = worldX.sub(cameraPosition.x), dz = worldZ.sub(cameraPosition.z);
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();
    // Density feathers all the way to zero at the edge (not 25%) so the last
    // blades disappear gradually — no hard ring.
    const keepProb = float(1.0).sub(smoothstep(C.radius * 0.5, C.radius * 0.98, dist));
    const alive = inB.and(hMax.greaterThan(0.002)).and(dist.lessThan(C.radius)).and(hC.lessThan(keepProb));
    const aliveF = alive.select(float(1.0), float(0.0));

    const t = positionLocal.y;
    const side = positionLocal.x;
    // Height feathers down (blades lie lower) toward the edge as they thin out.
    const distShort = float(1.0).sub(smoothstep(C.radius * 0.45, C.radius, dist).mul(0.85));
    // Edge dissolve factor: blend blade color toward the (darker) ground tone so
    // the final blades melt into the color-matched terrain instead of standing out.
    const edgeFade = smoothstep(C.radius * 0.6, C.radius, dist);
    const H = hMax.mul(float(0.6).add(hD.mul(0.5))).mul(distShort).mul(aliveF).mul(heightMul);

    // Blade width taper + grazing-angle widening.
    const orient = hA.mul(6.2831853);
    const cA = orient.cos(), sA = orient.sin();
    const wInst = mix(0.008, 0.013, hE).mul(widthMul);
    const wBase = wInst.mul(float(1.0).sub(smoothstep(0.55, 1.0, t)));
    const facing = vec2(sA.negate(), cA);
    const viewDir = vec2(dx.negate(), dz.negate()).div(dist.max(0.001));
    const edge = float(1.0).sub(facing.dot(viewDir).abs());
    const w = wBase.mul(float(1.0).add(edge.mul(edge).mul(2.0)));

    // Lean + wind. (leanAmt lays mown blades over so they overlap/interweave.)
    const lean = leanAmt;
    const la = hB.mul(6.2831853);
    const leanV = vec2(la.cos(), la.sin()).mul(lean.mul(float(0.5).add(hD)));
    const stiff = float(0.7).add(hE.mul(0.6));
    const wave = this.uTime.mul(1.6)
      .add(worldX.mul(this.uWindDir.x).add(worldZ.mul(this.uWindDir.y)).mul(0.35))
      .add(orient).sin();
    const wind = this.uWindStrength.mul(float(0.6).add(this.uGust.mul(0.6))).mul(wave).div(stiff);
    const flow = leanV.add(this.uWindDir.mul(wind).mul(2.2));
    const bend = flow.mul(t.mul(t)).mul(H);

    // Local position (relative to the tile origin the model matrix will re-add).
    const localX = worldX.sub(origin.x);
    const localZ = worldZ.sub(origin.z);
    const px = side.mul(w);
    const py = t.mul(H);
    const outX = localX.add(px.mul(cA)).add(bend.x);
    const outZ = localZ.add(px.mul(sA)).add(bend.y);
    const localP = vec3(outX, groundY.add(py), outZ);

    // Rounded normal + lighting (matched to the HDRI-lit ground).
    const round = 0.7;
    const n0x = side.mul(2.0 * round);
    const nx = n0x.mul(cA).sub(sA);
    const nz = n0x.mul(sA).add(cA);
    const slope = flow.length().mul(t);
    const N = vec3(nx, slope.mul(1.4), nz).normalize();
    const ndl = N.dot(this.uSunDir).max(0.0);
    const wrap = ndl.mul(0.6).add(0.4);
    const trans = N.negate().dot(this.uSunDir).max(0.0).pow(2.0).mul(0.4);
    const ao = mix(0.78, 1.0, t);
    // Tighter per-blade color jitter (±10% vs ±17%) so dense grass reads as a
    // smooth mown mat, not salt-and-pepper noise. Dissolve toward the ground tone
    // near the LOD edge so far blades blend into the terrain.
    const colJit = float(0.90).add(hD.mul(0.20));
    const baseDis = mix(baseColor, baseColor.mul(0.82), edgeFade);
    const col = baseDis.mul(colJit);
    const lightN = this.uAmbient.add(this.uSunColor.mul(wrap)).add(this.uSunColor.mul(trans));
    let lit = col.mul(lightN).mul(ao);
    lit = lit.add(col.mul(t.pow(4.0).mul(0.06)));

    const mat = new MeshBasicNodeMaterial({ side: DoubleSide });
    mat.positionNode = localP;
    mat.colorNode = varying(lit);
    return mat;
  }

  // Bilinear terrain height via 4 texel fetches — smooth across the 2 m grid so
  // blades don't terrace/step on slopes. Affordable now that only visible tiles
  // (post-cull) run the shader.
  _sampleHeight(uvx, uvz) {
    const C = this._const;
    const gx = uvx.mul(C.nx - 1).clamp(0.0, C.nx - 1.001);
    const gz = uvz.mul(C.nz - 1).clamp(0.0, C.nz - 1.001);
    const ix = gx.floor(), iz = gz.floor();
    const fx = gx.sub(ix), fz = gz.sub(iz);
    const load = (a, b) => textureLoad(C.heightTex, ivec2(int(a), int(b))).x;
    const h00 = load(ix, iz), h10 = load(ix.add(1), iz);
    const h01 = load(ix, iz.add(1)), h11 = load(ix.add(1), iz.add(1));
    return mix(mix(h00, h10, fx), mix(h01, h11, fx), fz);
  }

  _sampleData(uvx, uvz) {
    const C = this._const;
    const tx = int(uvx.mul(C.nx - 1).add(0.5).clamp(0.0, C.nx - 1));
    const tz = int(uvz.mul(C.nz - 1).add(0.5).clamp(0.0, C.nz - 1));
    return textureLoad(C.dataTex, ivec2(tx, tz));
  }

  update(t, camera) {
    this.uTime.value = t;
    this.uGust.value = 0.5 + 0.5 * Math.sin(t * 0.35);
    // Cull manually = distance (LOD radius) AND view frustum. The engine's own
    // per-object cull wasn't reducing these tiles, so we own it: only tiles the
    // camera is actually looking at (and within range) stay visible.
    const cam = camera || this.camera;
    cam.updateMatrixWorld();
    this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pm);
    const cx = cam.position.x, cz = cam.position.z;
    const R = this.radius + this.tileSize;
    for (const m of this.tiles) {
      const dx = m._sphere.center.x - cx, dz = m._sphere.center.z - cz;
      m.visible = (dx * dx + dz * dz < R * R) && this._frustum.intersectsSphere(m._sphere);
    }
  }
}

const MAX_H = 0.30;
const _hsl = { h: 0, s: 0, l: 0 };

function turfBase(name, out) {
  out.set(surface(name).color);
  out.getHSL(_hsl, SRGBColorSpace);
  out.setHSL(_hsl.h + (0.31 - _hsl.h) * 0.32, _hsl.s * 0.68, _hsl.l * 0.82, SRGBColorSpace);
  return out;
}

function bladeHeight(name) {
  switch (name) {
    // Mown surfaces (fairway / tee / green / fringe) render as TEXTURED GROUND,
    // not 3D blades: short blades read as see-through slivers. Only the taller
    // rough gets geometry, where blades genuinely look good.
    case 'rough': return 0.20;
    case 'deepRough': return 0.32;
    default: return 0;
  }
}
