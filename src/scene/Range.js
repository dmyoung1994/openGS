import {
  Group, Mesh, SphereGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry,
  CircleGeometry, BoxGeometry, MeshStandardMaterial, MeshBasicMaterial, InstancedMesh,
  Object3D, Color, Vector2, Vector3, DoubleSide, CanvasTexture,
  TextureLoader, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { loadTreePrototype, instanceTrees } from './Trees.js';
import { Noise } from '../util/noise.js';
import { YARD_TO_M } from '../util/units.js';

const _tex = new TextureLoader();

// The driving range: a generous fairway fanning down range (-Z) with a set of
// target greens at marked yardages, framed by rough and a tree line. Also owns
// the ball mesh. Everything that scales (grass, trees) is GPU-instanced.
export class Range {
  constructor(scene) {
    this.scene = scene;
    this.group = new Group();
    scene.add(this.group);

    this.noise = new Noise(7);
    this.targets = this._defineTargets();
    // Greenside sand bunkers and a lateral water hazard. These are carved into
    // the heightfield (so the ball physically rolls into them and the surface
    // classifier returns 'sand'/'water'), then dressed with overlay meshes.
    this.bunkers = [
      { x: 20, z: -86, r: 5.0, depth: 0.9 },   // front-right of the 100 green
      { x: 1, z: -99, r: 4.2, depth: 0.8 },    // short-left of the 100 green
      { x: -25, z: -132, r: 5.4, depth: 1.0 }, // guarding the 150 green
      { x: 6, z: -190, r: 5.6, depth: 1.0 },   // fairway bunker ~205
    ];
    this.ponds = [
      { x: 55, z: -122, r: 15, depth: 1.6 },   // lateral water, right side
    ];

    this.terrain = new Terrain({
      bounds: { minX: -110, maxX: 110, minZ: -340, maxZ: 30 },
      spacing: 2,
      heightFn: (x, z) => this._height(x, z),
      surfaceFn: (x, z) => this._surface(x, z),
    });
    this.group.add(this.terrain.mesh);

    // Near-field grass (WebGPU / TSL NodeMaterial). Dense where the camera lives
    // at address; the textured ground carries the distance.
    this.grass = new Grass({
      terrain: this.terrain,
      region: { minX: -48, maxX: 48, minZ: -95, maxZ: 18 },
      count: 900000,
      allow: (s) => s === 'fairway' || s === 'tee' || s === 'rough' || s === 'fringe' || s === 'green',
      height: [0.055, 0.12],
    });
    this.group.add(this.grass.mesh);

    this._buildTee();
    this._buildTargets();
    this._buildBunkers();
    this._buildWater();
    this._buildTreeLine();
    this._buildBall();
  }

  // ---- Terrain definition -------------------------------------------------

  _defineTargets() {
    // distance (yards), lateral offset (m), radius (m), and a primary contour
    // idea. Per the authoring skill, each green gets ONE legible contour family
    // and they vary across the set — never the same dome repeated.
    return [
      { yards: 50, x: -6, r: 7, contour: 'tilt' },       // short: fall to front
      { yards: 100, x: 10, r: 8, contour: 'punchbowl' }, // gathering bowl
      { yards: 150, x: -14, r: 9, contour: 'spine' },    // ridge splits pins
      { yards: 200, x: 8, r: 10, contour: 'tier' },      // two shelves
      { yards: 250, x: -4, r: 11, contour: 'crown' },    // pushed-up turtleback
      { yards: 300, x: 16, r: 11, contour: 'saddle' },   // twin shoulders
    ].map((t) => ({ ...t, z: -t.yards * YARD_TO_M }));
  }

  _height(x, z) {
    // Base rolling ground, calmer near the tee, more movement down range.
    const far = Math.min(1, Math.max(0, (-z) / 300));
    let h = this.noise.fbm(x * 0.006, z * 0.006, { octaves: 4 }) * (0.4 + 2.2 * far);
    h += this.noise.fbm(x * 0.02, z * 0.02, { octaves: 3 }) * 0.25 * far;

    // Green complexes: a broad shoulder tie-in that carries the landform out of
    // the green into the surrounds (continuous, not a pasted disc), a gentle
    // push-up so the surface sits above grade, and ONE legible internal contour
    // per green (see greenContour). Amplitudes stay in a puttable range.
    for (const t of this.targets) {
      const dx = x - t.x, dz = z - t.z;
      const d = Math.hypot(dx, dz);
      if (d < t.r + 10) {
        const shoulder = Math.exp(-((d - t.r) * (d - t.r)) / 40) * 0.5;
        const pad = Math.max(0, 1 - (d / (t.r + 6)) ** 2) * 0.30;
        let gc = 0;
        if (d < t.r + 2) {
          const inside = Math.max(0, 1 - (d / (t.r + 2)) ** 2);
          gc = greenContour(t.contour, dx / t.r, dz / t.r) * inside;
        }
        h += shoulder + pad + gc;
      }
    }

    // Carve bunker dishes: a smooth bowl with a raised lip on the far side, so
    // the sand sits below grade and reads with a defined edge.
    for (const b of this.bunkers) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < b.r + 3) {
        const bowl = -b.depth * Math.max(0, 1 - (d / b.r) ** 2);
        const lip = Math.exp(-((d - b.r) * (d - b.r)) / 3.0) * 0.18;
        h += bowl + lip;
      }
    }

    // Water basins: dished well below the waterline so the pond has depth.
    for (const p of this.ponds) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r + 4) {
        h -= p.depth * Math.max(0, 1 - (d / (p.r + 2)) ** 2);
      }
    }

    // Flat, level tee.
    const teeFlat = Math.exp(-((x * x) / 40 + ((z - 2) * (z - 2)) / 60));
    h = h * (1 - teeFlat) + 0.02 * teeFlat;
    return h;
  }

  // Water surface elevation for a pond (the flat plane the water mesh sits at).
  _waterLevel(p) {
    return this.terrain
      ? this.terrain.heightAt(p.x, p.z) + p.depth * 0.55
      : -p.depth * 0.45;
  }

  _surface(x, z) {
    // Tee mat.
    if (Math.abs(x) < 3.2 && z < 6 && z > -2) return 'tee';

    // Target greens with a fringe collar.
    for (const t of this.targets) {
      const d = Math.hypot(x - t.x, z - t.z);
      if (d < t.r) return 'green';
      if (d < t.r + 2.2) return 'fringe';
    }

    // Water hazards take priority over anything they sit in.
    for (const p of this.ponds) {
      if (Math.hypot(x - p.x, z - p.z) < p.r) return 'water';
    }

    // Sand bunkers.
    for (const b of this.bunkers) {
      if (Math.hypot(x - b.x, z - b.z) < b.r + 0.4) return 'sand';
    }

    // The fairway fans out; beyond it is rough, then deep rough near the trees.
    const halfWidth = 32 + (-z) * 0.11; // widens down range
    const ax = Math.abs(x);
    if (ax > halfWidth + 26) return 'deepRough';
    if (ax > halfWidth) return 'rough';
    return 'fairway';
  }

  // ---- Props --------------------------------------------------------------

  _buildTee() {
    const y0 = this.terrain.heightAt(0, 2);

    // A realistic artificial hitting mat: a tufted-turf top with a darker rubber
    // frame, sitting flush on the tee. The canvas texture supplies the fine
    // synthetic-turf grain and a subtle mow band so it doesn't read as flat paint.
    const matTop = new Mesh(
      new BoxGeometry(2.4, 0.05, 1.6),
      new MeshStandardMaterial({ map: makeMatTexture(), roughness: 0.9, metalness: 0.0 }),
    );
    matTop.position.set(0, y0 + 0.035, 2);
    matTop.receiveShadow = true;
    matTop.castShadow = true;
    this.group.add(matTop);

    const frame = new Mesh(
      new BoxGeometry(2.7, 0.06, 1.9),
      new MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.85 }),
    );
    frame.position.set(0, y0 + 0.03, 2);
    frame.receiveShadow = true;
    this.group.add(frame);

    // Rubber tee peg under the ball (ball rests at x0,z2).
    const tee = new Mesh(
      new CylinderGeometry(0.006, 0.009, 0.05, 10),
      new MeshStandardMaterial({ color: 0xf3f3f3, roughness: 0.5 }),
    );
    tee.position.set(0, y0 + 0.06, 2);
    tee.castShadow = true;
    this.group.add(tee);

    // Two white tee markers, set just behind the ball line.
    for (const sx of [-1.8, 1.8]) {
      const marker = new Mesh(
        new SphereGeometry(0.11, 20, 14),
        new MeshStandardMaterial({ color: 0xfbfbfb, roughness: 0.5 }),
      );
      marker.position.set(sx, this.terrain.heightAt(sx, 3.2) + 0.11, 3.2);
      marker.castShadow = true;
      this.group.add(marker);
    }
  }

  _buildTargets() {
    for (const t of this.targets) {
      const y = this.terrain.heightAt(t.x, t.z);
      this.group.add(this._flag(t.x, y, t.z, t.yards));
      this.group.add(this._placard(t.x, y, t.z + t.r + 4, `${t.yards}`));
    }
  }

  _flag(x, y, z, yards) {
    const g = new Group();
    const pole = new Mesh(
      new CylinderGeometry(0.02, 0.02, 2.4, 8),
      new MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4 }),
    );
    pole.position.set(x, y + 1.2, z);
    pole.castShadow = true;
    g.add(pole);

    const hue = new Color().setHSL((yards / 360) % 1, 0.7, 0.5);
    const flag = new Mesh(
      new PlaneGeometry(0.7, 0.45),
      new MeshStandardMaterial({ color: hue, side: DoubleSide, roughness: 0.8 }),
    );
    flag.position.set(x + 0.36, y + 2.15, z);
    flag.castShadow = true;
    g.add(flag);

    // Cup ring.
    const cup = new Mesh(
      new CylinderGeometry(0.12, 0.12, 0.02, 16),
      new MeshStandardMaterial({ color: 0x111111 }),
    );
    cup.position.set(x, y + 0.02, z);
    g.add(cup);
    return g;
  }

  _placard(x, y, z, text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#12331b'; ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#eafff0';
    ctx.font = 'bold 78px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 68);
    ctx.font = '22px system-ui'; ctx.fillText('YARDS', 128, 116);
    const tex = new CanvasTexture(canvas);
    const sign = new Mesh(
      new PlaneGeometry(2, 1),
      new MeshBasicMaterial({ map: tex, side: DoubleSide }),
    );
    sign.position.set(x, y + 0.7, z);
    return sign;
  }

  // A flat disc whose vertices are pinned to the terrain height — used for the
  // sand surface so it hugs the carved bunker bowl exactly. `jitter` breaks the
  // perfect circle into a natural, irregular sand edge.
  _conformingDisc(cx, cz, r, yOffset, { segments = 64, jitter = 0 } = {}) {
    const geo = new CircleGeometry(r, segments);
    geo.rotateX(-Math.PI / 2);                    // lie flat in the XZ plane
    const pos = geo.attributes.position;
    if (jitter > 0) {
      for (let i = 1; i < pos.count; i++) {       // index 0 is the center vertex
        const lx = pos.getX(i), lz = pos.getZ(i);
        const ang = Math.atan2(lz, lx);
        const f = 1 + jitter * this.noise.noise2(Math.cos(ang) * 2.5, Math.sin(ang) * 2.5);
        pos.setX(i, lx * f); pos.setZ(i, lz * f);
      }
    }
    geo.translate(cx, 0, cz);
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.terrain.heightAt(pos.getX(i), pos.getZ(i)) + yOffset);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  _buildBunkers() {
    const diff = _tex.load('/assets/textures/sand_diff.jpg');
    diff.colorSpace = SRGBColorSpace;
    const nor = _tex.load('/assets/textures/sand_nor_gl.jpg');
    const rough = _tex.load('/assets/textures/sand_rough.jpg');
    for (const t of [diff, nor, rough]) {
      t.wrapS = t.wrapT = RepeatWrapping;
      t.anisotropy = 8;
    }
    const mat = new MeshStandardMaterial({
      map: diff, normalMap: nor, roughnessMap: rough,
      color: 0xe9dcbc, roughness: 1.0, metalness: 0.0,
      normalScale: new Vector2(0.7, 0.7),
    });

    for (const b of this.bunkers) {
      const rep = b.r / 2.6;
      // Per-bunker texture repeat via a cloned material keeps the sand grain at a
      // believable scale regardless of bunker size (UVs are shared 0..1).
      const m = mat.clone();
      m.map = diff.clone(); m.map.colorSpace = SRGBColorSpace;
      m.normalMap = nor.clone(); m.roughnessMap = rough.clone();
      for (const t of [m.map, m.normalMap, m.roughnessMap]) {
        t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 8; t.needsUpdate = true;
      }
      const geo = this._conformingDisc(b.x, b.z, b.r + 0.3, 0.04, { segments: 72, jitter: 0.14 });
      const mesh = new Mesh(geo, m);
      mesh.receiveShadow = true;
      mesh.name = 'bunker';
      this.group.add(mesh);
    }
  }

  _buildWater() {
    for (const p of this.ponds) {
      const level = this._waterLevel(p);
      const geo = new CircleGeometry(p.r + 1.2, 72);
      geo.rotateX(-Math.PI / 2);
      // Reflective, slightly translucent water. Roughness is low so it mirrors
      // the HDRI sky (scene.environment) for that bright pond-surface sheen.
      const mat = new MeshStandardMaterial({
        color: 0x35636e, roughness: 0.06, metalness: 0.0,
        transparent: true, opacity: 0.9, envMapIntensity: 1.5,
        side: DoubleSide,
      });
      const mesh = new Mesh(geo, mat);
      mesh.position.set(p.x, level, p.z);
      mesh.name = 'water';
      this.group.add(mesh);
      this._water = this._water || [];
      this._water.push({ mesh, mat, p });
    }
  }

  _treePlacements() {
    // Scatter along both flanks (widening down range) and across the back.
    const spots = [];
    for (let z = 20; z > -340; z -= 7 + Math.random() * 6) {
      const hw = 32 + (-z) * 0.11 + 28;
      for (const side of [-1, 1]) {
        const jitter = (Math.random() - 0.5) * 12;
        const x = side * (hw + Math.random() * 26);
        spots.push({ x, y: this.terrain.heightAt(x, z + jitter), z: z + jitter,
          targetHeight: 7 + Math.random() * 6, rotY: Math.random() * Math.PI * 2 });
      }
    }
    for (let x = -150; x < 150; x += 8 + Math.random() * 6) {
      const z = -338 - Math.random() * 16;
      spots.push({ x, y: this.terrain.heightAt(x, z), z,
        targetHeight: 8 + Math.random() * 6, rotY: Math.random() * Math.PI * 2 });
    }
    return spots;
  }

  // Load processed CC0 tree GLBs and instance them along the tree line. Async;
  // the trees pop in when ready while the rest of the scene renders.
  async _buildTreeLine() {
    const placements = this._treePlacements();
    try {
      const proto = await loadTreePrototype('/assets/trees/island_tree_01.glb');
      // Split placements across available prototypes for variety later.
      this.group.add(instanceTrees(proto, placements));
    } catch (e) {
      console.warn('tree load failed', e);
    }
  }

  _buildBall() {
    // Hero object: a clean urethane-white ball with a dimpled surface and a
    // faint clearcoat sheen so the sun catches a tight specular highlight in the
    // result close-ups. Dimples come from a procedurally generated normal map.
    this.ballMesh = new Mesh(
      new SphereGeometry(0.02134, 48, 36),
      new MeshStandardMaterial({
        color: 0xf6f7f4, roughness: 0.28, metalness: 0.0,
        normalMap: makeDimpleNormal(), normalScale: new Vector2(0.5, 0.5),
        envMapIntensity: 1.0,
      }),
    );
    this.ballMesh.castShadow = true;
    this.group.add(this.ballMesh);
  }

  update(t) {
    if (this.grass) this.grass.update(t);
  }
}

// One legible internal green contour, returned as meters of relief. nx/nz are
// green-local coords (~-1..1; +nz is toward the player/front). Amplitudes are
// kept in a puttable range and fade to zero at the green edge via the caller's
// `inside` mask. Grammar per the authoring skill's green-design reference.
function greenContour(type, nx, nz) {
  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const r2 = nx * nx + nz * nz;
  switch (type) {
    case 'tilt':      return -nz * 0.40;                       // back-high, feeds to front
    case 'punchbowl': return (r2 - 0.5) * 0.50;                // edges high, gathers to center
    case 'spine':     return (1 - Math.abs(nx)) * 0.42 - 0.15; // central ridge splits L/R pins
    case 'tier':      return ss(-0.25, 0.25, nz) * 0.45;       // two shelves + broad ramp
    case 'crown':     return (1 - r2) * 0.42;                  // pushed-up turtleback
    case 'saddle':    return nx * nx * 0.50 - nz * nz * 0.12;  // twin shoulders, central pass
    default:          return 0;
  }
}

// Synthetic-turf texture for the hitting mat: a fine green tuft grain with a
// faint mow band, so the mat reads as real matting rather than flat plastic.
function makeMatTexture() {
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#2f5228'; ctx.fillRect(0, 0, N, N);
  // Fine tuft speckle.
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * N, y = Math.random() * N;
    const g = 60 + Math.random() * 90;
    ctx.fillStyle = `rgba(${Math.round(g * 0.5)},${Math.round(g)},${Math.round(g * 0.4)},0.5)`;
    ctx.fillRect(x, y, 1, 2);
  }
  // Subtle alternating mow bands.
  for (let b = 0; b < N; b += 32) {
    ctx.fillStyle = (b / 32) % 2 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, b, N, 32);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// Procedural dimple normal map for the golf ball. Concave spherical caps on a
// jittered grid: each dimple tilts the surface normal toward its center, so the
// sun rakes across the dimpling in close-ups. Generated once on a canvas.
function makeDimpleNormal() {
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N);
  const GRID = 14;                 // dimples across the texture
  const cell = N / GRID;
  const rad = cell * 0.46;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Nearest dimple center on the jittered grid (check the 3x3 neighborhood
      // and wrap so the map tiles seamlessly around the ball).
      let best = 1e9, cx = 0, cy = 0;
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const jx = (gx + ox + GRID) % GRID, jy = (gy + oy + GRID) % GRID;
        const h = Math.sin(jx * 12.9 + jy * 78.2) * 43758.5;
        const jitx = (h - Math.floor(h)) - 0.5;
        const h2 = Math.sin(jx * 39.3 + jy * 11.1) * 24634.6;
        const jity = (h2 - Math.floor(h2)) - 0.5;
        let px = (jx + 0.5 + jitx * 0.5) * cell;
        let py = (jy + 0.5 + jity * 0.5) * cell;
        let dx = x - px, dy = y - py;
        // wrap distance
        if (dx > N / 2) dx -= N; if (dx < -N / 2) dx += N;
        if (dy > N / 2) dy -= N; if (dy < -N / 2) dy += N;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; cx = dx; cy = dy; }
      }
      const dist = Math.sqrt(best);
      let nx = 0, ny = 0, nz = 1;
      if (dist < rad && dist > 0.001) {
        const t = dist / rad;
        const slope = Math.sin(Math.PI * t) * 0.8; // 0 at center & rim, peak mid
        nx = -(cx / dist) * slope;                 // tilt toward center (concave)
        ny = -(cy / dist) * slope;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;
      }
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}
