import { Vector3 } from 'three';
import { zoneAt } from '../terrain/ZoneMap.js';
import { yieldToRendering } from '../util/yieldToRendering.js';
import {
  MOW_STRIPE_ALBEDO_CONTRAST, mowingStripLay, turfBase,
} from '../terrain/turfColor.js';

const MAP_WIDTH = 320;
const MAP_HEIGHT = 430;
const COLOR_SCALE = 2.15;
const COLOR_LIFT = 22;
const YARDS_PER_METRE = 1.0936133;
const FOREST_FLOOR_COLOR = [0x70, 0x59, 0x3d];
const BIOME_COLORS = Object.freeze({
  strandGrass: [0x87, 0x91, 0x5e], dune: [0xae, 0xa4, 0x7d],
  drySand: [0xd0, 0xbd, 0x91], wetSand: [0xb0, 0x9b, 0x78],
  shallowShelf: [0x76, 0x84, 0x77], deepOcean: [0x29, 0x4a, 0x52],
  alpine: [0x63, 0x7b, 0x4e],
});
const BIOME_COLOR_ENTRIES = Object.entries(BIOME_COLORS);

function pointAlongRoute(points, distance) {
  let remaining = distance;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= length) {
      const t = length > 0 ? remaining / length : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    remaining -= length;
  }
  return { x: points.at(-1).x, z: points.at(-1).z };
}

export function createHoleShotPlan(hole, green) {
  const route = hole?.route?.points ?? [];
  if (route.length < 2 || !green) return [];
  let total = 0;
  for (let index = 1; index < route.length; index += 1) {
    total += Math.hypot(route[index].x - route[index - 1].x, route[index].z - route[index - 1].z);
  }
  const points = [{ ...route[0], role: 'tee' }];
  if ((hole.par ?? 4) === 4) {
    const landing = Math.max(total * .52, Math.min(215, total - 110));
    if (landing > 45 && landing < total - 45) points.push({ ...pointAlongRoute(route, landing), role: 'landing', label: '1' });
  } else if ((hole.par ?? 4) >= 5) {
    const first = Math.min(220, total * .46);
    const second = Math.max(first + 90, total - Math.min(135, total * .29));
    if (first > 45 && first < total - 90) points.push({ ...pointAlongRoute(route, first), role: 'landing', label: '1' });
    if (second > first + 55 && second < total - 45) points.push({ ...pointAlongRoute(route, second), role: 'layup', label: '2' });
  }
  const pin = green.pin ?? green;
  points.push({ x: pin.x, z: pin.z, role: 'green' });
  return points;
}

export function createHoleMapTransform(hole, width = MAP_WIDTH, height = MAP_HEIGHT) {
  const points = hole?.route?.points ?? [];
  if (points.length < 2) throw new Error('An active routed hole needs at least two route points.');
  const origin = points[0];
  const end = points.at(-1);
  const length = Math.hypot(end.x - origin.x, end.z - origin.z) || 1;
  const forward = { x: (end.x - origin.x) / length, z: (end.z - origin.z) / length };
  const right = { x: -forward.z, z: forward.x };
  const local = points.map((point) => {
    const dx = point.x - origin.x;
    const dz = point.z - origin.z;
    return { right: dx * right.x + dz * right.z, forward: dx * forward.x + dz * forward.z };
  });
  let routeLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    routeLength += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
  }
  const crossPadding = Math.max(22,
    (hole.route.c0 ?? hole.route.fairwayHalfWidth ?? 0)
      + (hole.route.rough ?? hole.route.roughWidth ?? 0)
      + Math.max(0, hole.route.k ?? 0) * routeLength + 10);
  const minRight = Math.min(...local.map((point) => point.right)) - crossPadding;
  const maxRight = Math.max(...local.map((point) => point.right)) + crossPadding;
  const minForward = Math.min(...local.map((point) => point.forward)) - 18;
  const maxForward = Math.max(...local.map((point) => point.forward)) + 18;
  const centerRight = (minRight + maxRight) * 0.5;
  const centerForward = (minForward + maxForward) * 0.5;
  const scale = Math.min((width - 24) / (maxRight - minRight), (height - 24) / (maxForward - minForward));

  const worldToMap = (point) => {
    const dx = point.x - origin.x;
    const dz = point.z - origin.z;
    const localRight = dx * right.x + dz * right.z;
    const localForward = dx * forward.x + dz * forward.z;
    return {
      x: width * 0.5 + (localRight - centerRight) * scale,
      y: height * 0.5 - (localForward - centerForward) * scale,
    };
  };
  const mapToWorld = (point) => {
    const localRight = (point.x - width * 0.5) / scale + centerRight;
    const localForward = (height * 0.5 - point.y) / scale + centerForward;
    return {
      x: origin.x + right.x * localRight + forward.x * localForward,
      z: origin.z + right.z * localRight + forward.z * localForward,
    };
  };
  return Object.freeze({ width, height, scale, forward, right, worldToMap, mapToWorld });
}

export function resolveAimTarget(origin, target, bounds) {
  if (![origin?.x, origin?.z, target?.x, target?.z].every(Number.isFinite)) {
    throw new TypeError('Aim origin and target must contain finite x and z coordinates.');
  }
  if (bounds && (target.x < bounds.minX || target.x > bounds.maxX || target.z < bounds.minZ || target.z > bounds.maxZ)) {
    throw new RangeError('Aim target must be inside the course terrain.');
  }
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.01) throw new RangeError('Aim target must be at least one centimetre from the ball.');
  return Object.freeze({
    target: Object.freeze({ x: target.x, z: target.z }),
    direction: Object.freeze({ x: dx / distance, z: dz / distance }),
    distance,
  });
}

export class Minimap {
  constructor({ enabled = true, onAimTarget = null } = {}) {
    this.enabled = enabled;
    this.onAimTarget = onAimTarget;
    this.range = null;
    this.terrain = null;
    this.hole = null;
    this.transform = null;
    this.shotPlan = [];
    this._course = null;
    this._lastState = {};
    this.available = false;
    this.opened = false;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this._build();
  }

  _build() {
    const style = document.createElement('style');
    style.textContent = `
      .gm-map-panel{position:fixed;top:68px;right:14px;z-index:58;display:none;box-sizing:border-box;width:184px;overflow:hidden;border:1px solid rgba(255,255,255,.3);border-radius:14px;background:rgba(9,15,14,.82);box-shadow:0 20px 48px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.12);backdrop-filter:blur(18px) saturate(1.08);font-family:Inter,ui-sans-serif,-apple-system,"Helvetica Neue",Arial,sans-serif;color:#f8f7f2;transition:width .22s cubic-bezier(.2,.7,.2,1),box-shadow .22s}
      body[data-view="practice"] .gm-map-panel{top:110px}
      body[data-view="creator"] .gm-map-panel{right:132px}
      body[data-view="practice"] .gm-map-panel.available,body[data-view="creator"] .gm-map-panel.available{display:block}
      .gm-map-panel.expanded{width:min(356px,calc(100vw - 24px));box-shadow:0 28px 70px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.12)}
      .gm-map-head{display:flex;align-items:center;gap:6px;min-height:48px;padding:7px 6px 7px 9px;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(13,20,19,.88)}
      .gm-map-title{min-width:0;flex:1}.gm-map-title strong,.gm-map-title span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gm-map-title strong{font:650 12px/1.15 inherit;letter-spacing:-.015em}.gm-map-title span{margin-top:3px;color:rgba(248,247,242,.72);font:450 9px/1.1 inherit}.expanded .gm-map-title strong{font-size:15px}.expanded .gm-map-title span{font-size:11px}
      .gm-map-stats{display:none;gap:2px;flex:0 0 auto;color:rgba(248,247,242,.72);font:600 10px/1.1 inherit;letter-spacing:.025em;text-align:right}.expanded .gm-map-stats{display:grid}
      .gm-map-size{display:grid;place-items:center;flex:0 0 25px;width:25px;height:25px;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:rgba(255,255,255,.055);color:#fff;cursor:pointer}.gm-map-size:hover,.gm-map-size:focus-visible{border-color:rgba(255,255,255,.42);background:rgba(255,255,255,.12);outline:none}.gm-map-size svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.gm-map-collapse-icon{display:none}.expanded .gm-map-expand-icon{display:none}.expanded .gm-map-collapse-icon{display:block}
      .gm-map-canvas{display:block;width:100%;height:auto;max-height:calc(100vh - 180px);background:#263425;cursor:zoom-in;touch-action:manipulation}.expanded .gm-map-canvas{cursor:crosshair}
      .gm-map-canvas.locked{cursor:not-allowed}
      .gm-map-help{display:none;min-height:32px;box-sizing:border-box;padding:9px 11px;border-top:1px solid rgba(255,255,255,.1);color:rgba(248,247,242,.68);font-size:10.5px;line-height:1.25}.expanded .gm-map-help{display:block}
      @media(max-width:560px){body[data-view="practice"] .gm-map-panel,body[data-view="creator"] .gm-map-panel{top:118px;right:12px}.gm-map-panel.expanded{width:calc(100vw - 24px)}.gm-map-canvas{max-height:calc(100vh - 230px)}}
      @media(max-height:650px){body[data-view="creator"] .gm-map-panel:not(.expanded){width:110px}.gm-map-panel:not(.expanded) .gm-map-canvas{max-height:150px}}
      @media(prefers-reduced-motion:reduce){.gm-map-panel{transition:none}}
    `;
    document.head.appendChild(style);

    this.panel = document.createElement('section');
    this.panel.id = 'gm-map-panel';
    this.panel.className = 'gm-map-panel';
    this.panel.setAttribute('aria-label', 'Active hole map');
    this.panel.innerHTML = `
      <div class="gm-map-head"><div class="gm-map-title"><strong></strong><span></span></div><div class="gm-map-stats"><span></span><span></span></div><button class="gm-map-size" type="button" aria-label="Enlarge map" aria-expanded="false"><svg class="gm-map-expand-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/></svg><svg class="gm-map-collapse-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6"/></svg></button></div>
      <canvas class="gm-map-canvas" aria-label="Click or tap the active hole to aim"></canvas>
      <div class="gm-map-help" aria-live="polite">Click the map to aim.</div>`;
    document.body.appendChild(this.panel);
    this.el = this.panel.querySelector('canvas');
    this.ctx = this.el.getContext('2d');
    this.title = this.panel.querySelector('strong');
    this.subtitle = this.panel.querySelector('.gm-map-title span');
    [this.par, this.length] = this.panel.querySelectorAll('.gm-map-stats span');
    this.help = this.panel.querySelector('.gm-map-help');
    this.sizeButton = this.panel.querySelector('.gm-map-size');

    this.sizeButton.addEventListener('click', () => this.toggle());
    this.el.addEventListener('click', (event) => this._aimFromPointer(event));
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && this.opened) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      } else if (event.code === 'KeyM' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? '')) {
        this.toggle();
      }
    });
  }

  attach(range) {
    this.range = range;
    this.terrain = range?.terrain ?? null;
    this.available = this.enabled && !!range?.routing && range.creatorCanvas !== true;
    this.panel.classList.toggle('available', this.available);
    if (!this.available) {
      this.hole = null;
      this.transform = null;
      this.shotPlan = [];
      this._course = null;
      this.close();
      return;
    }
    return this.setActiveHole(range.activeHole());
  }

  setActiveHole(hole) {
    if (!this.available || !hole) return;
    this.hole = hole;
    this.transform = createHoleMapTransform(hole);
    this.title.textContent = `Hole ${hole.number ?? ''}`.trim();
    this.subtitle.textContent = hole.name ?? 'Active hole';
    let length = 0;
    const points = hole.route.points;
    for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
    this.par.textContent = `PAR ${hole.par ?? '—'}`;
    this.length.textContent = `${Math.round(length * YARDS_PER_METRE)} YD`;
    this.shotPlan = createHoleShotPlan(hole, this.range?.targets?.[hole.greenStart]);
    return this._rasterise().then(() => this.update(this._lastState));
  }

  async _rasterise() {
    const map = this.terrain?._zoneMap;
    if (!map || !this.transform) { this._course = null; return; }
    const terrain = this.terrain, transform = this.transform;
    this._course = null;
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
    const offscreen = document.createElement('canvas');
    offscreen.width = MAP_WIDTH;
    offscreen.height = MAP_HEIGHT;
    const context = offscreen.getContext('2d');
    const image = context.createImageData(MAP_WIDTH, MAP_HEIGHT);
    const colours = {};
    const colourFor = (name) => {
      if (colours[name]) return colours[name];
      let rgb;
      if (name === 'sand') rgb = [0xd8, 0xc8, 0x9c];
      else {
        const colour = turfBase(name);
        rgb = [colour.r * 255 * COLOR_SCALE + COLOR_LIFT, colour.g * 255 * COLOR_SCALE + COLOR_LIFT, colour.b * 255 * COLOR_SCALE + COLOR_LIFT];
      }
      colours[name] = rgb.map((value) => Math.max(0, Math.min(255, value | 0)));
      return colours[name];
    };
    const bounds = map.bounds;
    const heightAt = this.terrain.heightAt.bind(this.terrain);
    let chunkStart = performance.now();
    for (let y = 0; y < MAP_HEIGHT; y += 1) {
      if (performance.now() - chunkStart >= 6) {
        await yieldToRendering();
        if (this.transform !== transform || this.terrain !== terrain) return;
        chunkStart = performance.now();
      }
      for (let x = 0; x < MAP_WIDTH; x += 1) {
        const world = this.transform.mapToWorld({ x: x + 0.5, y: y + 0.5 });
        const inside = world.x >= bounds.minX && world.x <= bounds.maxX && world.z >= bounds.minZ && world.z <= bounds.maxZ;
        const i = Math.max(0, Math.min(map.width - 1, Math.floor((world.x - bounds.minX) * map.texelsPerM)));
        const j = Math.max(0, Math.min(map.height - 1, Math.floor((world.z - bounds.minZ) * map.texelsPerM)));
        const zone = zoneAt(map, i, j, this.terrain.zones);
        const rgb = [...colourFor(zone)];
        if (inside) {
          const forestFloor = this.terrain.forestFloorWeightAt?.(world.x, world.z, zone) ?? 0;
          for (let channel = 0; channel < 3; channel += 1) {
            rgb[channel] = rgb[channel] * (1 - forestFloor) + FOREST_FLOOR_COLOR[channel] * forestFloor;
          }
          const transition = this.terrain.classifyBiomeAt?.(world.x, world.z)?.weights;
          if (transition) {
            const biomeWeight = Math.min(1, BIOME_COLOR_ENTRIES
              .reduce((sum, [name]) => sum + (transition[name] ?? 0), 0));
            for (let channel = 0; channel < 3; channel += 1) {
              const biomeColor = BIOME_COLOR_ENTRIES
                .reduce((sum, [name, color]) => sum + color[channel] * (transition[name] ?? 0), 0);
              rgb[channel] = rgb[channel] * (1 - biomeWeight) + biomeColor;
            }
          }
        }
        const step = 2.5;
        const slopeX = (heightAt(world.x + step, world.z) - heightAt(world.x - step, world.z)) / (step * 2);
        const slopeZ = (heightAt(world.x, world.z + step) - heightAt(world.x, world.z - step)) / (step * 2);
        let shade = Math.max(.82, Math.min(1.16, 1 - slopeX * .32 + slopeZ * .22));
        shade *= .985 + Math.sin(world.x * .13 + Math.sin(world.z * .041) * 2.2) * .007 + Math.sin(world.z * .29 + Math.sin(world.x * .071)) * .005;
        const grain = Math.sin(Math.floor(world.x * .8) * 12.9898 + Math.floor(world.z * .8) * 78.233) * 43758.5453;
        shade *= .985 + (grain - Math.floor(grain)) * .03;
        if (zone === 'fairway') {
          shade *= 1 + (mowingStripLay(world.x, world.z) - .5) * MOW_STRIPE_ALBEDO_CONTRAST;
        } else if (zone === 'deepRough') {
          shade *= .94 + Math.sin(world.x * .39 + world.z * .31) * .018;
        }
        if (!inside) shade *= .78;
        rgb[0] *= shade; rgb[1] *= shade; rgb[2] *= shade;
        const offset = (y * MAP_WIDTH + x) * 4;
        image.data[offset] = Math.max(0, Math.min(255, rgb[0]));
        image.data[offset + 1] = Math.max(0, Math.min(255, rgb[1]));
        image.data[offset + 2] = Math.max(0, Math.min(255, rgb[2]));
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    this._drawVegetation(context);
    this._course = offscreen;
    this.el.width = Math.round(MAP_WIDTH * this.dpr);
    this.el.height = Math.round(MAP_HEIGHT * this.dpr);
  }

  update(state = {}) {
    this._lastState = state;
    if (!this.available || !this._course || !this.transform) return;
    const { ball, camera, aimTarget, aimOrigin, canAim = false } = state;
    const context = this.ctx;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    context.drawImage(this._course, 0, 0);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const route = this.shotPlan.map(this.transform.worldToMap);
    context.beginPath();
    route.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = 'rgba(9,16,12,.66)';
    context.lineWidth = 3.5;
    context.setLineDash([5, 6]);
    context.stroke();
    context.beginPath();
    route.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = 'rgba(255,255,255,.72)';
    context.lineWidth = 1.5;
    context.setLineDash([5, 6]);
    context.stroke();
    context.setLineDash([]);

    for (const point of this.shotPlan.filter(({ role }) => role === 'landing' || role === 'layup')) {
      this._planMarker(point, point.label);
    }

    const green = this.range?.targets?.[this.hole.greenStart];
    if (green) this._marker(green.pin ?? green, 6, '#d9ef91', 'G');
    const tee = this.hole.tees?.[0];
    if (tee) this._marker(tee, 5, '#e8c98c', 'T');

    if (aimTarget && aimOrigin) {
      const start = this.transform.worldToMap(aimOrigin);
      const end = this.transform.worldToMap(aimTarget);
      context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y);
      context.strokeStyle = 'rgba(9,14,11,.7)'; context.lineWidth = 4; context.stroke();
      context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y);
      context.strokeStyle = '#f2d27e'; context.lineWidth = 2; context.stroke();
      context.beginPath(); context.arc(end.x, end.y, 6, 0, Math.PI * 2);
      context.fillStyle = '#f2d27e'; context.fill(); context.strokeStyle = '#182018'; context.lineWidth = 1.5; context.stroke();
      context.beginPath(); context.arc(end.x, end.y, 9, 0, Math.PI * 2);
      context.strokeStyle = 'rgba(255,255,255,.68)'; context.lineWidth = 1; context.stroke();
      const yards = Math.round(Math.hypot(aimTarget.x - aimOrigin.x, aimTarget.z - aimOrigin.z) * YARDS_PER_METRE);
      if (this.opened) {
        context.font = '600 11px Inter, sans-serif';
        context.textAlign = 'center'; context.textBaseline = 'bottom';
        const prefix = aimTarget.role === 'landing' ? 'Landing · '
          : aimTarget.role === 'layup' ? 'Layup · '
            : aimTarget.role === 'green' ? 'Green · ' : '';
        const label = `${prefix}${yards} yd`;
        const width = Math.ceil(context.measureText(label).width) + 12;
        const centerX = Math.max(width * .5 + 3, Math.min(MAP_WIDTH - width * .5 - 3, end.x));
        context.fillStyle = 'rgba(8,13,11,.88)'; context.fillRect(centerX - width * .5, end.y - 24, width, 16);
        context.fillStyle = '#fff'; context.fillText(label, centerX, end.y - 11);
      }
    }

    if (camera && this.opened) {
      const center = this.transform.worldToMap(camera.position);
      const direction = camera.getWorldDirection(_cameraDirection);
      const tip = this.transform.worldToMap({ x: camera.position.x + direction.x * 22, z: camera.position.z + direction.z * 22 });
      context.beginPath(); context.moveTo(center.x, center.y); context.lineTo(tip.x, tip.y);
      context.strokeStyle = 'rgba(255,255,255,.58)'; context.lineWidth = 2; context.stroke();
    }
    if (ball) this._marker(ball, 4.5, '#6590ff');
    if (this.opened && green && aimOrigin) this._drawGreenYardages(green, aimOrigin);
    if (this.opened) this._drawNorth();
    this.el.classList.toggle('locked', this.opened && !canAim);
    if (canAim && aimTarget && aimOrigin) {
      const feet = Math.round((this.terrain.heightAt(aimTarget.x, aimTarget.z) - this.terrain.heightAt(aimOrigin.x, aimOrigin.z)) * 3.28084);
      this.help.textContent = `Choose landing, layup, or green  ·  ${feet >= 0 ? '+' : '−'}${Math.abs(feet)} ft`;
    } else {
      this.help.textContent = canAim ? 'Click map to aim.' : 'Aim is locked while the ball is in flight.';
    }
  }

  _drawVegetation(context) {
    const trees = [
      ...(this.range?._treePlacements?.() ?? []),
      ...(this.range?._proceduralTreePlacements?.() ?? []),
    ];
    const visible = trees.map((tree) => ({ tree, point: this.transform.worldToMap(tree) })).filter(({ point }) => (
      point.x >= -10 && point.x <= MAP_WIDTH + 10 && point.y >= -10 && point.y <= MAP_HEIGHT + 10
    ));
    context.save();
    context.fillStyle = 'rgba(16,31,17,.2)';
    for (const { tree, point } of visible) {
      const radius = Math.max(1.6, Math.min(6, Math.max(1.4, tree.canopyRadius ?? 1.4) * this.transform.scale * .9));
      context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
    }
    for (const { tree, point } of visible) {
      if ((tree.canopyRadius ?? 0) < 1.25) continue;
      let seed = 0;
      for (const char of String(tree.id ?? tree.assetId)) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
      const radius = Math.max(3, Math.min(9, (tree.canopyRadius ?? 3.5) * this.transform.scale));
      context.fillStyle = 'rgba(7,15,9,.42)';
      context.beginPath(); context.ellipse(point.x + radius * .34, point.y + radius * .42, radius * 1.08, radius * .84, 0, 0, Math.PI * 2); context.fill();
      const gradient = context.createRadialGradient(
        point.x - radius * .28, point.y - radius * .32, radius * .08,
        point.x, point.y, radius,
      );
      gradient.addColorStop(0, seed % 2 ? '#667443' : '#5c6d3b');
      gradient.addColorStop(.52, seed % 3 === 0 ? '#3b512d' : '#33482a');
      gradient.addColorStop(1, '#1a2a1b');
      context.fillStyle = gradient;
      for (let lobe = 0; lobe < 4; lobe += 1) {
        const angle = lobe * Math.PI * .5 + (seed % 19) * .03;
        const lobeRadius = radius * (.55 + ((seed >> (lobe * 3)) & 3) * .045);
        context.beginPath();
        context.arc(point.x + Math.cos(angle) * radius * .28, point.y + Math.sin(angle) * radius * .28, lobeRadius, 0, Math.PI * 2);
        context.fill();
      }
      context.beginPath(); context.arc(point.x, point.y, radius * .7, 0, Math.PI * 2); context.fill();
    }
    context.restore();
  }

  _drawGreenYardages(green, origin) {
    const radius = green.r ?? 9;
    const samples = [
      { point: { x: green.x - this.transform.forward.x * radius, z: green.z - this.transform.forward.z * radius }, align: 'top' },
      { point: green, align: 'middle' },
      { point: { x: green.x + this.transform.forward.x * radius, z: green.z + this.transform.forward.z * radius }, align: 'bottom' },
    ];
    const context = this.ctx;
    context.font = '600 9px Inter, sans-serif';
    context.textAlign = 'left'; context.textBaseline = 'middle';
    for (const sample of samples) {
      const point = this.transform.worldToMap(sample.point);
      const yards = Math.round(Math.hypot(sample.point.x - origin.x, sample.point.z - origin.z) * YARDS_PER_METRE);
      const label = `${yards}`;
      const x = Math.min(MAP_WIDTH - 27, point.x + 13);
      context.fillStyle = 'rgba(8,13,11,.72)'; context.fillRect(x - 3, point.y - 7, 25, 14);
      context.fillStyle = 'rgba(255,255,255,.86)'; context.fillText(label, x, point.y + .5);
    }
  }

  _marker(world, radius, colour, label = '') {
    const point = this.transform.worldToMap(world);
    this.ctx.beginPath(); this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    this.ctx.fillStyle = colour; this.ctx.fill(); this.ctx.strokeStyle = 'rgba(0,0,0,.66)'; this.ctx.lineWidth = 1.3; this.ctx.stroke();
    if (label) {
      this.ctx.fillStyle = '#172018'; this.ctx.font = '700 8px Inter, sans-serif'; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(label, point.x, point.y + 0.5);
    }
  }

  _planMarker(world, label) {
    const point = this.transform.worldToMap(world);
    this.ctx.beginPath(); this.ctx.arc(point.x, point.y, this.opened ? 7 : 5, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(10,16,12,.82)'; this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(244,239,214,.86)'; this.ctx.lineWidth = 1.4; this.ctx.stroke();
    this.ctx.fillStyle = '#f4efd6'; this.ctx.font = `650 ${this.opened ? 9 : 7}px Inter, sans-serif`;
    this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(label, point.x, point.y + .5);
  }

  _drawNorth() {
    const base = { x: MAP_WIDTH - 22, y: 34 };
    const northRight = -this.transform.right.z;
    const northForward = -this.transform.forward.z;
    const magnitude = Math.hypot(northRight, northForward) || 1;
    const tip = { x: base.x + northRight / magnitude * 15, y: base.y - northForward / magnitude * 15 };
    this.ctx.beginPath(); this.ctx.moveTo(base.x, base.y); this.ctx.lineTo(tip.x, tip.y);
    this.ctx.strokeStyle = '#fff'; this.ctx.lineWidth = 2; this.ctx.stroke();
    this.ctx.fillStyle = '#fff'; this.ctx.font = '700 9px Inter, sans-serif'; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'bottom'; this.ctx.fillText('N', tip.x, tip.y - 2);
  }

  _aimFromPointer(event) {
    if (!this.opened) { this.open(); return; }
    if (!this._lastState.canAim || !this.transform || !this.onAimTarget) return;
    const rect = this.el.getBoundingClientRect();
    const mapPoint = {
      x: (event.clientX - rect.left) * MAP_WIDTH / rect.width,
      y: (event.clientY - rect.top) * MAP_HEIGHT / rect.height,
    };
    const snap = this.shotPlan.slice(1).find((candidate) => {
      const marker = this.transform.worldToMap(candidate);
      return Math.hypot(marker.x - mapPoint.x, marker.y - mapPoint.y) <= 14;
    });
    const point = snap ?? this.transform.mapToWorld(mapPoint);
    try {
      this.onAimTarget(point);
    } catch (error) {
      this.help.textContent = error?.message || String(error);
    }
  }

  open() {
    if (!this.available) return false;
    this.opened = true;
    this.panel.classList.add('expanded');
    this.sizeButton.setAttribute('aria-expanded', 'true');
    this.sizeButton.setAttribute('aria-label', 'Reduce map');
    this.update(this._lastState);
    return true;
  }

  close() {
    this.opened = false;
    this.panel.classList.remove('expanded');
    this.sizeButton.setAttribute('aria-expanded', 'false');
    this.sizeButton.setAttribute('aria-label', 'Enlarge map');
    this.update(this._lastState);
  }

  toggle() { return this.opened ? (this.close(), false) : this.open(); }
}

const _cameraDirection = new Vector3();
