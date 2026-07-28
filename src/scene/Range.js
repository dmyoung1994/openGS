import {
  Group, Mesh, SphereGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry,
  BoxGeometry, MeshStandardMaterial, MeshBasicMaterial, InstancedMesh,
  Object3D, Color, Vector3, DoubleSide, CanvasTexture,
} from 'three';
import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { loadTreePrototype, instanceTrees } from './Trees.js';
import { Noise } from '../util/noise.js';
import { YARD_TO_M } from '../util/units.js';

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

    this.terrain = new Terrain({
      bounds: { minX: -110, maxX: 110, minZ: -340, maxZ: 30 },
      spacing: 2,
      heightFn: (x, z) => this._height(x, z),
      surfaceFn: (x, z) => this._surface(x, z),
    });
    this.group.add(this.terrain.mesh);

    // Near-field grass where the camera lives at address — dense enough to read
    // as real turf. Beyond this the textured ground carries the distance.
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
    this._buildTreeLine();
    this._buildBall();
  }

  // ---- Terrain definition -------------------------------------------------

  _defineTargets() {
    // distance (yards), lateral offset (m), radius (m)
    return [
      { yards: 50, x: -6, r: 7 },
      { yards: 100, x: 10, r: 8 },
      { yards: 150, x: -14, r: 9 },
      { yards: 200, x: 8, r: 10 },
      { yards: 250, x: -4, r: 11 },
      { yards: 300, x: 16, r: 11 },
    ].map((t) => ({ ...t, z: -t.yards * YARD_TO_M }));
  }

  _height(x, z) {
    // Base rolling ground, calmer near the tee, more movement down range.
    const far = Math.min(1, Math.max(0, (-z) / 300));
    let h = this.noise.fbm(x * 0.006, z * 0.006, { octaves: 4 }) * (0.4 + 2.2 * far);
    h += this.noise.fbm(x * 0.02, z * 0.02, { octaves: 3 }) * 0.25 * far;

    // Gentle push-up green complexes, dished slightly in the middle.
    for (const t of this.targets) {
      const d = Math.hypot(x - t.x, z - t.z);
      if (d < t.r + 10) {
        const shoulder = Math.exp(-((d - t.r) * (d - t.r)) / 40) * 0.6;
        const crown = Math.max(0, 1 - (d / (t.r + 6)) ** 2) * 0.5;
        h += shoulder + crown;
      }
    }

    // Flat, level tee.
    const teeFlat = Math.exp(-((x * x) / 40 + ((z - 2) * (z - 2)) / 60));
    h = h * (1 - teeFlat) + 0.02 * teeFlat;
    return h;
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

    // The fairway fans out; beyond it is rough, then deep rough near the trees.
    const halfWidth = 32 + (-z) * 0.11; // widens down range
    const ax = Math.abs(x);
    if (ax > halfWidth + 26) return 'deepRough';
    if (ax > halfWidth) return 'rough';
    return 'fairway';
  }

  // ---- Props --------------------------------------------------------------

  _buildTee() {
    // A hitting mat and two tee markers.
    const mat = new Mesh(
      new BoxGeometry(6, 0.06, 3),
      new MeshStandardMaterial({ color: 0x2f5d2a, roughness: 1 }),
    );
    mat.position.set(0, this.terrain.heightAt(0, 2) + 0.03, 2);
    mat.receiveShadow = true;
    this.group.add(mat);

    for (const sx of [-2.6, 2.6]) {
      const marker = new Mesh(
        new SphereGeometry(0.12, 16, 12),
        new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
      );
      marker.position.set(sx, this.terrain.heightAt(sx, 3.4) + 0.12, 3.4);
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
    this.ballMesh = new Mesh(
      new SphereGeometry(0.02134, 24, 18),
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.0 }),
    );
    this.ballMesh.castShadow = true;
    this.group.add(this.ballMesh);
  }

  update(t) {
    this.grass.update(t);
  }
}
