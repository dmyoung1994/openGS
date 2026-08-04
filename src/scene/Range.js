import {
  Group, Mesh, SphereGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry,
  CircleGeometry, BoxGeometry, BufferGeometry, BufferAttribute,
  MeshStandardMaterial, MeshBasicMaterial, InstancedMesh,
  Object3D, Color, Vector2, Vector3, DoubleSide, CanvasTexture,
  TextureLoader, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { loadTreePrototype, instanceTrees, billboardTrees } from './Trees.js';
import { Noise } from '../util/noise.js';

const _tex = new TextureLoader();

// The driving range: a generous fairway fanning down range (-Z) with a set of
// target greens at marked yardages, framed by rough and a tree line. Also owns
// the ball mesh. Everything that scales (grass, trees) is GPU-instanced.
export class Range {
  // `course` is a normalized spec (see src/course/course.js) of FEATURES only —
  // greens, bunkers, ponds, the fairway corridor, the tee. The engine bakes the
  // terrain from these (heightFn/surfaceFn below); nothing here edits raw heights.
  // That is what lets the whole course be (re)built from a prompt-driven course.json
  // with no terrain-editing surface exposed to the user.
  constructor(scene, camera, course) {
    this.scene = scene;
    this.camera = camera;
    this.course = course;
    this.group = new Group();
    scene.add(this.group);

    this.noise = new Noise(7);
    // Feature arrays come straight from the course spec. Greens carry a named
    // internal contour; bunkers carve depressions (pot = deep steep revetted pit);
    // ponds are dished water basins. See _height/_surface for how they bake.
    this.targets = course.greens;
    this.bunkers = course.bunkers;
    this.ponds = course.ponds;
    this.tee = course.tee;
    this.corridor = course.corridor;
    this.fringeW = course.fringeW;

    this.terrain = new Terrain({
      bounds: course.bounds,
      spacing: 0.6,          // fine physics/collision grid (accurate ball roll)
      renderSpacing: 1.0,    // coarser render mesh + shadow pass (LOD; ~2.8x fewer verts)
      heightFn: (x, z) => this._height(x, z),
      surfaceFn: (x, z) => this._surface(x, z),
      // Geometric spec for the shader's analytic (smooth-curve) turf zones. Mirrors
      // the circles/corridor in _surface so the visual edges match gameplay zones.
      zones: {
        greens: this.targets.map((t) => ({ x: t.x, z: t.z, r: t.r })),
        sands: this.bunkers.map((b) => ({ x: b.x, z: b.z, r: this._bunkerSandR(b) })),
        corridor: this.corridor,                                     // halfWidth = c0 + (-z)*k, then rough band
        tee: { x: this.tee.boxHalfX, z0: this.tee.z0, z1: this.tee.z1 },
        fringeW: this.fringeW,
      },
    });
    this.group.add(this.terrain.mesh);

    // Camera-relative grass (WebGPU / TSL). A world-cell-anchored field of ~1M
    // blades follows the camera every frame, sampling terrain height + surface
    // from GPU textures, with density/height LOD falling off with distance. So
    // wherever you look — tee, mid-fairway, a green after a shot — there's turf.
    this.grass = new Grass({ terrain: this.terrain, camera: this.camera });
    this.group.add(this.grass.mesh);

    this._buildTee();
    this._buildTargets();
    this._buildBunkers();
    this._buildWater();
    this._buildTreeLine();
    this._buildBall();
  }

  // ---- Terrain definition -------------------------------------------------

  _height(x, z) {
    // Gently rolling ground so the fairway has real FORM (a flat billiard plane
    // reads as a prototype and casts no shadows). Broad long-wavelength swells
    // everywhere, plus finer rolls, ramping up down range. The tee is levelled
    // back out below.
    const far = Math.min(1, Math.max(0, (-z) / 300));
    let h = this.noise.fbm(x * 0.006, z * 0.006, { octaves: 4 }) * (2.2 + 2.4 * far);
    h += this.noise.fbm(x * 0.016, z * 0.016, { octaves: 3 }) * (0.9 + 0.7 * far);
    h += this.noise.fbm(x * 0.05, z * 0.05, { octaves: 2 }) * 0.2; // fine rolls

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

    // Carve each bunker as a depression CUT INTO the grade — never a raised rim.
    // Real bunkers sit BELOW the surrounding turf: a flat sand floor that would
    // drain to the low point, walls rising back to grade, and a rim that is FLUSH
    // with the surrounding ground. The old code added a Gaussian grass ridge just
    // OUTSIDE the rim (h += lip) — a ring of raised turf around the hole — which is
    // exactly what made every bunker read as a meteor crater. Framing, where wanted,
    // belongs to the landform / green shoulders, not a ring around the pit.
    //   • regular: a flashed face — sand sweeps up a moderate wall to a grade rim.
    //   • pot:     a deep, near-vertical REVETTED pit — a small flat floor and steep
    //              turf walls straight up to a flush rim (no lip). The stacked-sod
    //              wall look is added by the shader on steep faces; the sand stays on
    //              the floor (see _bunkerSandR).
    for (const b of this.bunkers) {
      const dx = x - b.x, dz = z - b.z;
      const d = Math.hypot(dx, dz);
      if (d >= b.r) continue;                              // outside the footprint → grade untouched
      const rFloor = b.r * (b.pot ? 0.70 : 0.42);
      let wall = smoothstep(rFloor, b.r, d);               // 0 on the flat floor → 1 at the rim
      // Pot walls are near-vertical: hold the floor flat, then rise steeply in the
      // last band (bias the ramp toward the rim). Regular walls stay a gentler flash.
      if (b.pot) wall = wall * wall;
      h += -b.depth * (1 - wall);                          // −depth on the floor, 0 (grade) at the rim
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

  // Radius of the visible sand (floor + wall face). Pot bunkers keep sand to the
  // small flat floor (≈ rFloor) so their steep turf walls rise revetted above it,
  // rather than draping sand up a near-vertical face.
  _bunkerSandR(b) {
    return b.pot ? b.r * 0.72 : b.r;
  }

  // Water surface elevation for a pond (the flat plane the water mesh sits at).
  _waterLevel(p) {
    return this.terrain
      ? this.terrain.heightAt(p.x, p.z) + p.depth * 0.55
      : -p.depth * 0.45;
  }

  _surface(x, z) {
    // Tee mat.
    if (Math.abs(x - this.tee.x) < this.tee.boxHalfX && z < this.tee.z1 && z > this.tee.z0) return 'tee';

    // Target greens with a fringe collar.
    for (const t of this.targets) {
      const d = Math.hypot(x - t.x, z - t.z);
      if (d < t.r) return 'green';
      if (d < t.r + this.fringeW) return 'fringe';
    }

    // Water hazards take priority over anything they sit in.
    for (const p of this.ponds) {
      if (Math.hypot(x - p.x, z - p.z) < p.r) return 'water';
    }

    // Sand bunkers — only the floor/wall reads as sand; the raised lip is grass.
    for (const b of this.bunkers) {
      if (Math.hypot(x - b.x, z - b.z) < this._bunkerSandR(b)) return 'sand';
    }

    // The fairway fans out; beyond it is rough, then deep rough near the trees.
    const halfWidth = this.corridor.c0 + (-z) * this.corridor.k; // widens down range
    const ax = Math.abs(x);
    if (ax > halfWidth + this.corridor.rough) return 'deepRough';
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
    // Sit the turf top PROUD of the rubber frame (top at y0+0.075 vs the frame's
    // y0+0.06). Previously both tops sat at y0+0.06 — coplanar faces that z-fought and
    // flickered light-green/dark under the temporal AA jitter.
    matTop.position.set(0, y0 + 0.05, 2);
    matTop.receiveShadow = true;
    matTop.castShadow = true;
    this.group.add(matTop);

    // Rubber mat surround — a lit dark-olive rubber, NOT a black void. Slight
    // spec so it catches the low sun instead of reading as an unlit hole.
    const frame = new Mesh(
      new BoxGeometry(2.7, 0.06, 1.9),
      new MeshStandardMaterial({ color: 0x3f463a, roughness: 0.7, metalness: 0.0 }),
    );
    frame.position.set(0, y0 + 0.03, 2);
    frame.receiveShadow = true;
    frame.castShadow = true;
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

  // A flat-in-plan disc whose vertices are pinned to the terrain height, so the
  // sand hugs the carved bunker bowl exactly. Built as a CONCENTRIC-RING polar grid
  // rather than CircleGeometry's single center-vertex fan: a fan makes every floor
  // triangle share the one center vertex, so draped over a bowl that vertex's
  // averaged normal pinwheels into the radial star artifact we were seeing. Multiple
  // rings distribute vertices across the radius → smooth, well-behaved normals that
  // follow the bowl. `jitter` roughens only the OUTER rings into a natural, irregular
  // sand edge while the interior stays smooth.
  _conformingDisc(cx, cz, r, yOffset, { radial = 96, rings = 14, jitter = 0 } = {}) {
    const pos = [cx, 0, cz];                       // center vertex (index 0)
    const uv = [0.5, 0.5];
    for (let ri = 1; ri <= rings; ri++) {
      const t = ri / rings;                        // 0..1 out to the rim
      for (let a = 0; a < radial; a++) {
        const ang = (a / radial) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        // Edge jitter scales with t, so it vanishes near the center and only the
        // rim reads irregular.
        const j = jitter > 0 ? jitter * t * this.noise.noise2(ca * 2.5, sa * 2.5) : 0;
        const rad = r * t * (1 + j);
        pos.push(cx + ca * rad, 0, cz + sa * rad);
        uv.push(ca * t * 0.5 + 0.5, sa * t * 0.5 + 0.5);
      }
    }
    const idx = [];
    for (let a = 0; a < radial; a++) {             // center → first ring
      const a2 = (a + 1) % radial;
      idx.push(0, 1 + a2, 1 + a);
    }
    for (let ri = 1; ri < rings; ri++) {           // ring ri → ring ri+1
      const b0 = 1 + (ri - 1) * radial, b1 = 1 + ri * radial;
      for (let a = 0; a < radial; a++) {
        const a2 = (a + 1) % radial;
        idx.push(b0 + a, b1 + a2, b1 + a, b0 + a, b0 + a2, b1 + a2);
      }
    }
    const p = new Float32Array(pos);
    for (let i = 0; i < p.length; i += 3) p[i + 1] = this.terrain.heightAt(p[i], p[i + 2]) + yOffset;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(p, 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // Async: AWAIT the sand textures before building the bunker overlays. Cloning a
  // texture that is still loading yields a clone with a null image/source, and the
  // WebGPU renderer throws (invalid pipeline) the moment it tries to bind it on the
  // first frame. Waiting for the load guarantees valid sources. Bunkers are cosmetic
  // overlays (the terrain already carries the sand surface), so the brief defer is
  // invisible. Fire-and-forget from the constructor, like the tree line.
  async _buildBunkers() {
    let diff, nor, rough;
    try {
      [diff, nor, rough] = await Promise.all([
        _tex.loadAsync('/assets/textures/sand_diff.jpg'),
        _tex.loadAsync('/assets/textures/sand_nor_gl.jpg'),
        _tex.loadAsync('/assets/textures/sand_rough.jpg'),
      ]);
    } catch (e) { console.warn('sand textures failed', e); return; }
    if (this._disposed) return;
    diff.colorSpace = SRGBColorSpace;
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
      const geo = this._conformingDisc(b.x, b.z, this._bunkerSandR(b), 0.04, { radial: 96, rings: 14, jitter: 0.08 });
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
    // An organic, layered tree line: the forest's INNER edge undulates in and out
    // (bays and points) via low-frequency noise instead of a straight setback, and
    // each flank is several rows deep — denser at the edge, thinning back — so the
    // wall reads as a real forest with depth, not a picket fence.
    // Hero (real-geometry) trees are kept to a MODERATE count for performance; the
    // billboard backdrop (added in instanceTrees) fills the forest depth cheaply.
    // The inner edge undulates so the hero front row already reads organic.
    const spots = [];
    const fbm = (a, b) => this.noise.fbm(a, b, { octaves: 2 });   // ~ -1..1
    for (let z = 22; z > -344; z -= 8 + Math.random() * 5) {
      const corridor = this.corridor.c0 + (-z) * this.corridor.k + 24;   // just past the deep-rough edge
      for (const side of [-1, 1]) {
        // Undulating inner edge: bays and points, seeded per side.
        const edge = corridor + 4 + (fbm(side * 40 + z * 0.03, z * 0.05) * 0.5 + 0.5) * 24;
        const rows = 1 + Math.floor(Math.random() * 2);
        for (let r = 0; r < rows; r++) {
          const depth = Math.pow(Math.random(), 0.6) * 44;       // biased toward the edge
          const x = side * (edge + depth) + (Math.random() - 0.5) * 7;
          const zj = z + (Math.random() - 0.5) * 6;
          spots.push({ x, y: this.terrain.heightAt(x, zj), z: zj,
            targetHeight: 6 + Math.random() * 7, rotY: Math.random() * Math.PI * 2 });
        }
      }
    }
    // Back wall closing off the range.
    for (let x = -170; x < 170; x += 9 + Math.random() * 5) {
      const z = -342 - Math.random() * 16;
      spots.push({ x: x + (Math.random() - 0.5) * 8, y: this.terrain.heightAt(x, z), z,
        targetHeight: 7 + Math.random() * 7, rotY: Math.random() * Math.PI * 2 });
    }
    return spots;
  }

  // Load processed CC0 tree GLBs and instance them along the tree line. Async;
  // the trees pop in when ready while the rest of the scene renders.
  async _buildTreeLine() {
    const placements = this._treePlacements();
    try {
      const proto = await loadTreePrototype('/assets/trees/island_tree_01.glb');
      // Tree LOD: real geometry (hero GLB + procedural pines) only for placements
      // near the play area; everything farther is a cheap billboard wall — the
      // forest is 100-340m out where a photoscan is indistinguishable from a card,
      // and this is where most of the tree cost was going.
      const near = [], far = [];
      for (const p of placements) {
        (Math.hypot(p.x, p.z) < 95 ? near : far).push(p);
      }
      this.trees = new Group();
      this.trees.name = 'trees';
      this.trees.add(instanceTrees(proto, near, { backdrop: false }));  // hero + pines (bucketed, culled)
      this.trees.add(billboardTrees(far));                              // distant billboard wall
      this.group.add(this.trees);
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
    if (this.grass) this.grass.update(t, this.camera);
  }

  // Tear the whole course out of the scene so a new one can be built from an edited
  // course spec (the live-rebuild path). Frees GPU resources so repeated agent
  // rebuilds don't leak geometries/materials/textures.
  dispose() {
    this._disposed = true;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose?.();
      }
    });
    this.grass = null;
    this.trees = null;
  }
}

// Smooth Hermite ramp: 0 below edge0, 1 above edge1, eased between. Used to give
// bunker walls a defined shoulder without a hard (non-differentiable) step.
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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
