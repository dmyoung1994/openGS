import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage,
  Mesh,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, attribute, positionGeometry, positionPrevious } from 'three/tsl';

export const FLAG_WIDTH = 0.62;
export const FLAG_HEIGHT = 0.38;
export const FLAGSTICK_COLLISION_RADIUS = 0.0075;
export const FLAG_COLUMNS = 13;
export const FLAG_ROWS = 8;
export const FLAG_FIXED_STEP = 1 / 120;

export class FlagClothSystem {
  constructor({ anchors, environment, colors = [], width = FLAG_WIDTH, height = FLAG_HEIGHT }) {
    if (!Array.isArray(anchors) || anchors.length === 0) throw new TypeError('FlagClothSystem requires anchors.');
    if (!environment?.sampleWindCpu || !environment?.time) throw new TypeError('FlagClothSystem requires the authoritative CPU wind sampler and clock.');
    if (!(width > 0) || !(height > 0)) throw new TypeError('FlagClothSystem dimensions must be positive.');
    this.environment = environment;
    this.width = width;
    this.height = height;
    this.anchors = anchors.map((anchor) => ({ x: anchor.x, y: anchor.y, z: anchor.z }));
    this.vertexCountPerFlag = FLAG_COLUMNS * FLAG_ROWS;
    const count = this.vertexCountPerFlag * anchors.length;
    this.positions = new Float32Array(count * 3);
    this.previous = new Float32Array(count * 3);
    this._constraints = [];
    this._wind = { x: 0, y: 0, z: 0 };
    this._simulatedTime = environment.time.value;
    this._accumulator = 0;
    const vertexColors = new Float32Array(count * 3);
    const indices = [];
    for (let flag = 0; flag < anchors.length; flag++) {
      const anchor = anchors[flag];
      const color = new Color(colors[flag] ?? 0xf0eee5);
      const base = flag * this.vertexCountPerFlag;
      for (let row = 0; row < FLAG_ROWS; row++) for (let column = 0; column < FLAG_COLUMNS; column++) {
        const index = base + row * FLAG_COLUMNS + column;
        const u = column / (FLAG_COLUMNS - 1), v = row / (FLAG_ROWS - 1);
        this.positions[index * 3] = anchor.x + u * width;
        this.positions[index * 3 + 1] = anchor.y - v * height;
        this.positions[index * 3 + 2] = anchor.z + Math.sin(u * Math.PI) * 0.012;
        vertexColors[index * 3] = color.r; vertexColors[index * 3 + 1] = color.g; vertexColors[index * 3 + 2] = color.b;
        if (column < FLAG_COLUMNS - 1) this._constraint(index, index + 1, width / (FLAG_COLUMNS - 1));
        if (row < FLAG_ROWS - 1) this._constraint(index, index + FLAG_COLUMNS, height / (FLAG_ROWS - 1));
        if (column < FLAG_COLUMNS - 1 && row < FLAG_ROWS - 1) {
          const diagonal = Math.hypot(width / (FLAG_COLUMNS - 1), height / (FLAG_ROWS - 1));
          this._constraint(index, index + FLAG_COLUMNS + 1, diagonal);
          this._constraint(index + 1, index + FLAG_COLUMNS, diagonal);
        }
        if (column < FLAG_COLUMNS - 2) this._constraint(index, index + 2, width * 2 / (FLAG_COLUMNS - 1));
        if (row < FLAG_ROWS - 2) this._constraint(index, index + FLAG_COLUMNS * 2, height * 2 / (FLAG_ROWS - 1));
      }
      for (let row = 0; row < FLAG_ROWS - 1; row++) for (let column = 0; column < FLAG_COLUMNS - 1; column++) {
        const a = base + row * FLAG_COLUMNS + column;
        const b = a + 1, c = a + FLAG_COLUMNS, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    this.previous.set(this.positions);
    this.geometry = new BufferGeometry();
    const position = new BufferAttribute(this.positions, 3);
    position.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', position);
    // Verlet's previous[] is the previous 1/120s solver step, not the previous
    // presented shape. TRAA needs the latter to reproject waving cloth correctly.
    this.renderPrevious = new BufferAttribute(this.positions.slice(), 3).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('clothPreviousPosition', this.renderPrevious);
    this.geometry.setAttribute('color', new BufferAttribute(vertexColors, 3));
    this.geometry.setIndex(indices);
    this.geometry.computeVertexNormals();
    this.geometry.name = 'merged-fixed-step-target-flag-cloth';
    this.material = new MeshStandardNodeMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.88, metalness: 0 });
    this.material.positionNode = Fn(() => {
      positionPrevious.assign(attribute('clothPreviousPosition', 'vec3'));
      return positionGeometry;
    })();
    this.material.name = 'target-flag-cloth-pbr';
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'target-flag-cloth-merged';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.fixedStep = FLAG_FIXED_STEP;
  }

  _constraint(a, b, rest) { this._constraints.push({ a, b, rest }); }

  update() {
    this.renderPrevious.array.set(this.positions);
    this.renderPrevious.needsUpdate = true;
    const now = this.environment.time.value;
    // Each launch starts a new environment clock. Keep the cloth shape, but do
    // not carry fractional solver time from the previous shot into the new one.
    if (now < this._simulatedTime) this._accumulator = 0;
    const elapsed = Math.max(0, Math.min(0.25, now - this._simulatedTime));
    this._simulatedTime = now;
    this._accumulator += elapsed;
    while (this._accumulator >= FLAG_FIXED_STEP) {
      this._step(FLAG_FIXED_STEP, now - this._accumulator);
      this._accumulator -= FLAG_FIXED_STEP;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.attributes.normal.needsUpdate = true;
  }

  _step(dt, time) {
    const dt2 = dt * dt;
    for (let flag = 0; flag < this.anchors.length; flag++) {
      const anchor = this.anchors[flag];
      this.environment.sampleWindCpu({ x: anchor.x + this.width * 0.5, y: anchor.y, z: anchor.z }, time, this._wind);
      const base = flag * this.vertexCountPerFlag;
      for (let row = 0; row < FLAG_ROWS; row++) for (let column = 1; column < FLAG_COLUMNS; column++) {
        const vertex = base + row * FLAG_COLUMNS + column;
        const k = vertex * 3;
        const vx = (this.positions[k] - this.previous[k]) * 0.985;
        const vy = (this.positions[k + 1] - this.previous[k + 1]) * 0.985;
        const vz = (this.positions[k + 2] - this.previous[k + 2]) * 0.985;
        this.previous[k] = this.positions[k]; this.previous[k + 1] = this.positions[k + 1]; this.previous[k + 2] = this.positions[k + 2];
        this.positions[k] += vx + (this._wind.x - vx / dt) * 0.085 * dt2;
        this.positions[k + 1] += vy + (-9.81 + (this._wind.y - vy / dt) * 0.055) * dt2;
        this.positions[k + 2] += vz + (this._wind.z - vz / dt) * 0.085 * dt2;
      }
    }
    for (let iteration = 0; iteration < 5; iteration++) {
      for (const constraint of this._constraints) this._solveConstraint(constraint);
      this._pinAndCollide();
    }
  }

  _solveConstraint({ a, b, rest }) {
    const ak = a * 3, bk = b * 3;
    const dx = this.positions[bk] - this.positions[ak];
    const dy = this.positions[bk + 1] - this.positions[ak + 1];
    const dz = this.positions[bk + 2] - this.positions[ak + 2];
    const length = Math.hypot(dx, dy, dz) || 1;
    const correction = (length - rest) / length * 0.5;
    const aPinned = a % this.vertexCountPerFlag % FLAG_COLUMNS === 0;
    const bPinned = b % this.vertexCountPerFlag % FLAG_COLUMNS === 0;
    const aWeight = aPinned ? 0 : bPinned ? 1 : 0.5;
    const bWeight = bPinned ? 0 : aPinned ? 1 : 0.5;
    this.positions[ak] += dx * correction * aWeight; this.positions[ak + 1] += dy * correction * aWeight; this.positions[ak + 2] += dz * correction * aWeight;
    this.positions[bk] -= dx * correction * bWeight; this.positions[bk + 1] -= dy * correction * bWeight; this.positions[bk + 2] -= dz * correction * bWeight;
  }

  _pinAndCollide() {
    const poleRadius = FLAGSTICK_COLLISION_RADIUS;
    for (let flag = 0; flag < this.anchors.length; flag++) {
      const anchor = this.anchors[flag], base = flag * this.vertexCountPerFlag;
      for (let row = 0; row < FLAG_ROWS; row++) {
        const pin = base + row * FLAG_COLUMNS, pk = pin * 3;
        this.positions[pk] = anchor.x;
        this.positions[pk + 1] = anchor.y - row / (FLAG_ROWS - 1) * this.height;
        this.positions[pk + 2] = anchor.z;
        this.previous[pk] = this.positions[pk]; this.previous[pk + 1] = this.positions[pk + 1]; this.previous[pk + 2] = this.positions[pk + 2];
      }
      for (let local = 0; local < this.vertexCountPerFlag; local++) {
        const vertex = base + local, k = vertex * 3;
        const dx = this.positions[k] - anchor.x, dz = this.positions[k + 2] - anchor.z;
        const radius = Math.hypot(dx, dz);
        if (radius < poleRadius && local % FLAG_COLUMNS !== 0) {
          const inverse = poleRadius / (radius || 1);
          this.positions[k] = anchor.x + (radius ? dx * inverse : poleRadius);
          this.positions[k + 2] = anchor.z + (radius ? dz * inverse : 0);
        }
      }
    }
  }

  diagnostics() {
    let finite = true, pinnedDrift = 0, maxStretch = 1;
    for (const value of this.positions) finite &&= Number.isFinite(value);
    for (let flag = 0; flag < this.anchors.length; flag++) for (let row = 0; row < FLAG_ROWS; row++) {
      const index = (flag * this.vertexCountPerFlag + row * FLAG_COLUMNS) * 3;
      const anchor = this.anchors[flag];
      pinnedDrift = Math.max(pinnedDrift, Math.hypot(this.positions[index] - anchor.x, this.positions[index + 2] - anchor.z));
    }
    for (const { a, b, rest } of this._constraints) {
      const ak = a * 3, bk = b * 3;
      maxStretch = Math.max(maxStretch, Math.hypot(this.positions[bk] - this.positions[ak], this.positions[bk + 1] - this.positions[ak + 1], this.positions[bk + 2] - this.positions[ak + 2]) / rest);
    }
    return Object.freeze({ finite, pinnedDrift, maxStretch, flags: this.anchors.length, verticesPerFlag: this.vertexCountPerFlag, fixedStep: FLAG_FIXED_STEP, width: this.width, height: this.height });
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
