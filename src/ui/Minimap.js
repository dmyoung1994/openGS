import { Vector3 } from 'three';
import { zoneAt } from '../terrain/ZoneMap.js';
import { turfBase } from '../terrain/turfColor.js';

// Hole minimap, drawn from the SAME baked zone field the turf shader reads.
//
// That shared source is the point. A minimap drawn from its own copy of the course
// spec drifts from the ground the moment either side changes — you end up with a map
// that quietly lies about where the fairway is. Here `zoneAt()` decodes exactly the
// texels the shader samples, in the same compositing order, so the two cannot disagree.
//
// Toggle with M. Costs nothing per frame: the zone field is static, so the course is
// rasterised to an offscreen canvas ONCE and only the ball/camera markers redraw.
// Turf ALBEDO is dark (it's meant to be lit); a minimap is unlit, so it needs a
// substantial lift plus a floor or the whole map reads as near-black.
const SCALE = 2.5;
const LIFT = 26;

export class Minimap {
  constructor({ size = 190 } = {}) {
    this.size = size;
    this.terrain = null;
    this._course = null;      // pre-rendered course canvas
    this._sx = 1; this._sy = 1;

    this.el = document.createElement('canvas');
    this.el.style.cssText = `
      position:fixed; right:12px; bottom:12px; z-index:55; display:none;
      border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,.45);
      background:rgba(12,16,12,.85); backdrop-filter:blur(6px);`;
    document.body.appendChild(this.el);
    this.ctx = this.el.getContext('2d');

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) this.toggle();
    });
  }

  // Rasterise the course once from the baked zone field.
  attach(terrain) {
    this.terrain = terrain;
    const map = terrain?._zoneMap;
    if (!map) { this._course = null; return; }

    // Preserve the hole's aspect ratio — a squashed minimap misreads distances, which
    // is the one thing a minimap has to get right.
    const aspect = map.width / map.height;
    const w = Math.round(aspect >= 1 ? this.size : this.size * aspect);
    const h = Math.round(aspect >= 1 ? this.size / aspect : this.size);
    this.el.width = w; this.el.height = h;
    this.el.style.width = `${w}px`; this.el.style.height = `${h}px`;

    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d');
    const img = c.createImageData(w, h);

    // Zone colours come from the same turfBase() transform the 3D turf uses, so the
    // map reads as the course rather than as an unrelated palette.
    const cache = {};
    const colFor = (name) => {
      if (cache[name]) return cache[name];
      let rgb;
      if (name === 'sand') rgb = [0xd8, 0xc8, 0x9c];
      else {
        const col = turfBase(name);
        rgb = [col.r * 255 * SCALE + LIFT, col.g * 255 * SCALE + LIFT, col.b * 255 * SCALE + LIFT];
      }
      cache[name] = rgb.map((v) => Math.max(0, Math.min(255, v | 0)));
      return cache[name];
    };

    for (let y = 0; y < h; y++) {
      // NO flip: the course runs toward -Z, which is minZ, which is row 0 — so
      // drawing rows in order already puts the TARGET end at the top of the map,
      // which is the convention every golf yardage book uses.
      const j = Math.min(map.height - 1, Math.round(((y + 0.5) / h) * (map.height - 1)));
      for (let x = 0; x < w; x++) {
        const i = Math.min(map.width - 1, Math.round(((x + 0.5) / w) * (map.width - 1)));
        const [r, g, b] = colFor(zoneAt(map, i, j, terrain.zones));
        const k = (y * w + x) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    this._course = off;

    const bd = map.bounds;
    this._sx = (x) => ((x - bd.minX) / (bd.maxX - bd.minX)) * w;
    this._sy = (z) => ((z - bd.minZ) / (bd.maxZ - bd.minZ)) * h;
  }

  // Redraw markers over the pre-rendered course.
  update(ball, camera) {
    if (this.el.style.display === 'none' || !this._course) return;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    ctx.drawImage(this._course, 0, 0);

    // Camera facing: a short wedge so you can tell which way you're looking.
    if (camera) {
      const cx = this._sx(camera.position.x), cy = this._sy(camera.position.z);
      const d = camera.getWorldDirection(_tmp);
      const a = Math.atan2(d.x, d.z);
      ctx.fillStyle = 'rgba(255,255,255,.20)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, 26, a - Math.PI / 2 - 0.35, a - Math.PI / 2 + 0.35);
      ctx.closePath();
      ctx.fill();
    }

    if (ball) {
      const bx = this._sx(ball.x), by = this._sy(ball.z);
      ctx.beginPath();
      ctx.arc(bx, by, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1.2;
      ctx.fill(); ctx.stroke();
    }
  }

  toggle() { this.el.style.display = this.el.style.display === 'none' ? 'block' : 'none'; }
}

const _tmp = new Vector3();
