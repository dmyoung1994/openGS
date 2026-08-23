import {
  BufferAttribute, IndirectStorageBufferAttribute, InstancedBufferGeometry,
  Mesh, MeshBasicNodeMaterial, StorageBufferAttribute, Vector3,
} from 'three';
import {
  Fn, cameraProjectionMatrix, cameraViewMatrix, float, instanceIndex,
  mix, oneMinus, positionGeometry, screenSize, smoothstep, storage, uint, uniform,
  varying, vec2, vec3, vec4,
} from 'three/tsl';
import {
  disposeComputeNodes, disposeWebGPUAttributes, disposeWebGPUGeometries,
} from './WebGPUResourceDisposal.js';

// The flight history lives in GPU storage. The CPU submits exactly one current ball
// position per rendered frame; a compute pass appends it and updates the indexed
// indirect instance count. Vertex shading reconstructs a smooth ribbon from four
// neighbouring samples, so no trajectory-sized vertex upload or BufferGeometry
// rebuild occurs while the ball is moving.
//
// Tracer history is deliberately bounded and overflow is fatal. Silently wrapping a
// ring while a shot is in progress would draw unrelated head/tail segments together,
// which is a corrupt renderer state rather than a useful lower-quality mode.
const SUBDIVISIONS = 8;

function createRibbonGeometry(drawArgsAttr, instanceCount) {
  const positions = [];
  for (let row = 0; row <= SUBDIVISIONS; row++) {
    const t = row / SUBDIVISIONS;
    positions.push(-1, t, 0, 1, t, 0);
  }
  const indices = [];
  for (let row = 0; row < SUBDIVISIONS; row++) {
    const a = row * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  geo.instanceCount = instanceCount;
  geo.setIndirect(drawArgsAttr);
  return geo;
}

function createRibbonMaterial({ points, pointCount, opacity, ribbonPixels, history = false }) {
  const segment = uint(instanceIndex);
  const finalPoint = pointCount.sub(uint(1)).max(uint(0));
  const i0 = segment.equal(uint(0)).select(uint(0), segment.sub(uint(1)));
  const i1 = segment;
  const i2 = segment.add(uint(1)).min(finalPoint);
  const i3 = segment.add(uint(2)).min(finalPoint);
  const p0 = points.element(i0).xyz;
  const p1 = points.element(i1).xyz;
  const p2 = points.element(i2).xyz;
  const p3 = points.element(i3).xyz;
  const t = positionGeometry.y;
  const t2 = t.mul(t);
  const t3 = t2.mul(t);

  // Uniform Catmull-Rom is used after distance-based CPU sampling, making the
  // parameterization effectively centripetal while keeping the GPU expression
  // compact. Endpoints duplicate their nearest real sample.
  const a = p1.mul(2.0);
  const b = p2.sub(p0);
  const c = p0.mul(2.0).sub(p1.mul(5.0)).add(p2.mul(4.0)).sub(p3);
  const d = p0.negate().add(p1.mul(3.0)).sub(p2.mul(3.0)).add(p3);
  const center = a.add(b.mul(t)).add(c.mul(t2)).add(d.mul(t3)).mul(0.5);
  const tangent = b.add(c.mul(t.mul(2.0))).add(d.mul(t2.mul(3.0))).mul(0.5);

  const viewCenter = cameraViewMatrix.mul(vec4(center, 1.0));
  const viewTangent = cameraViewMatrix.mul(vec4(tangent, 0.0)).xyz;
  const clip = cameraProjectionMatrix.mul(viewCenter);
  // A chase camera can look almost directly down the flight tangent. Normalizing
  // its near-zero screen projection produced unstable ribbon spikes. Fall back to
  // a horizontal screen-width basis for that end-on limit.
  const tangentScreen = viewTangent.xy;
  const tangentScreenLength = tangentScreen.dot(tangentScreen).sqrt();
  const perpendicular = tangentScreenLength.greaterThan(0.0001).select(
    vec2(tangentScreen.y.negate(), tangentScreen.x).div(tangentScreenLength),
    vec2(1.0, 0.0),
  );
  const along = float(segment).add(t).div(float(pointCount.sub(uint(1))).max(1.0));
  const tailTaper = smoothstep(0.0, 0.035, along);
  const headProfile = mix(1.0, 0.34, smoothstep(0.62, 0.96, along));
  const endpointTaper = tailTaper
    .mul(headProfile)
    .mul(oneMinus(smoothstep(0.985, 1.0, along)));
  const side = positionGeometry.x;
  // A clean broadcast ribbon keeps the trajectory readable over turf, trees, and
  // the sky. The completed-shot branch uses the same silhouette in white so it
  // remains a stable course-history mark instead of becoming a second effect.
  const halfWidthPx = ribbonPixels.mul(0.5).mul(endpointTaper.max(0.025));
  const ndcOffset = perpendicular.mul(side).mul(halfWidthPx.mul(2.0)).div(screenSize);
  const finalClip = vec4(clip.xy.add(ndcOffset.mul(clip.w)), clip.z, clip.w);

  const vSide = varying(side, 'vTracerSide');
  const vAlong = varying(along, 'vTracerAlong');
  const fragmentTaper = smoothstep(0.0, 0.035, vAlong)
    .mul(oneMinus(smoothstep(0.985, 1.0, vAlong)));
  const edge = float(1.0).sub(vSide.abs());
  // The reference has no luminous halo or pale centre. A saturated blue body
  // carries its contrast, with a roughly one-pixel analytic edge for clean TAA.
  const edgeCoverage = smoothstep(0.0, 0.30, edge);
  const deepBroadcastBlue = vec3(0.002, 0.052, 0.44);
  const flightBlue = vec3(0.0, 0.18, 0.78);
  const color = history
    ? vec3(1.0, 1.0, 1.0)
    : mix(deepBroadcastBlue, flightBlue, smoothstep(0.04, 0.86, vAlong));
  const alpha = edgeCoverage.mul(fragmentTaper).mul(opacity).clamp(0.0, 1.0);

  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  mat.vertexNode = finalClip;
  mat.colorNode = color;
  mat.opacityNode = alpha;
  return mat;
}

class HistoricalTracer {
  constructor(scene, renderer, points, serial) {
    this.renderer = renderer;
    this.pointsAttr = new StorageBufferAttribute(new Float32Array(points.length / 3 * 4), 4);
    for (let i = 0; i < points.length / 3; i++) {
      const source = i * 3;
      const target = i * 4;
      this.pointsAttr.array[target] = points[source];
      this.pointsAttr.array[target + 1] = points[source + 1];
      this.pointsAttr.array[target + 2] = points[source + 2];
      this.pointsAttr.array[target + 3] = 1;
    }
    this.points = storage(this.pointsAttr, 'vec4', points.length / 3).toReadOnly();
    this.pointCount = points.length / 3;
    this.uPointCount = uniform(this.pointCount, 'uint');
    this.uOpacity = uniform(0.82);
    this.uRibbonPixels = uniform(4.8);
    this.drawArgsAttr = new IndirectStorageBufferAttribute(new Uint32Array([
      SUBDIVISIONS * 6, this.pointCount - 1, 0, 0, 0,
    ]), 5);
    this.geo = createRibbonGeometry(this.drawArgsAttr, this.pointCount - 1);
    this.material = createRibbonMaterial({
      points: this.points,
      pointCount: this.uPointCount,
      opacity: this.uOpacity,
      ribbonPixels: this.uRibbonPixels,
      history: true,
    });
    this.line = new Mesh(this.geo, this.material);
    this.line.name = `shot-tracer-history-${serial}`;
    this.line.visible = true;
    this.line.frustumCulled = false;
    this.line.renderOrder = 4;
    scene.add(this.line);
  }

  dispose() {
    this.line.removeFromParent();
    this.material.dispose();
    disposeWebGPUGeometries(this.renderer, [this.geo]);
    disposeWebGPUAttributes(this.renderer, [this.pointsAttr, this.drawArgsAttr]);
  }
}

export class Tracer {
  constructor(scene, { renderer, max = 2048, maxHistory = 16 } = {}) {
    if (!renderer?.isWebGPURenderer) throw new Error('Tracer requires the strict WebGPU renderer.');
    if (!Number.isInteger(max) || max < 4) throw new Error('Tracer history capacity must be an integer >= 4.');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new Error('Tracer shot-history capacity must be an integer >= 1.');
    this.scene = scene;
    this.renderer = renderer;
    this.max = max;
    this.maxHistory = maxHistory;
    this.count = 0;
    this._point = new Vector3();
    this._cpuPoints = new Float32Array(max * 3);
    this._history = [];
    this._historySerial = 0;
    this._disposed = false;

    this._pointsAttr = new StorageBufferAttribute(new Float32Array(max * 4), 4);
    this._points = storage(this._pointsAttr, 'vec4', max);
    this._drawArgsAttr = new IndirectStorageBufferAttribute(new Uint32Array([
      SUBDIVISIONS * 6, 0, 0, 0, 0,
    ]), 5);
    this._drawArgs = storage(this._drawArgsAttr, 'uint', 5);
    this.uAppendIndex = uniform(0, 'uint');
    this.uPoint = uniform(this._point);
    this.uPointCount = uniform(0, 'uint');
    this.uOpacity = uniform(1);
    this.uRibbonPixels = uniform(6.4);

    this._appendCompute = Fn(() => {
      this._points.element(this.uAppendIndex).assign(vec4(this.uPoint, 1.0));
      this._drawArgs.element(uint(0)).assign(uint(SUBDIVISIONS * 6));
      this._drawArgs.element(uint(1)).assign(this.uAppendIndex);
      this._drawArgs.element(uint(2)).assign(uint(0));
      this._drawArgs.element(uint(3)).assign(uint(0));
      this._drawArgs.element(uint(4)).assign(uint(0));
    })().compute(1);
    this._appendCompute.name = 'Tracer GPU history append';

    this._resetCompute = Fn(() => {
      this._drawArgs.element(uint(0)).assign(uint(SUBDIVISIONS * 6));
      this._drawArgs.element(uint(1)).assign(uint(0));
      this._drawArgs.element(uint(2)).assign(uint(0));
      this._drawArgs.element(uint(3)).assign(uint(0));
      this._drawArgs.element(uint(4)).assign(uint(0));
    })().compute(1);
    this._resetCompute.name = 'Tracer GPU history reset';

    this.geo = createRibbonGeometry(this._drawArgsAttr, this.max - 1);
    this.line = new Mesh(this.geo, createRibbonMaterial({
      points: this._points,
      pointCount: this.uPointCount,
      opacity: this.uOpacity,
      ribbonPixels: this.uRibbonPixels,
    }));
    this.line.name = 'shot-tracer-gpu-indirect';
    this.line.visible = false;
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    scene.add(this.line);
  }

  get historyCount() {
    return this._history.length;
  }

  promoteActiveToWhite() {
    this._assertLive();
    if (this.count < 2) return false;
    const points = this._cpuPoints.slice(0, this.count * 3);
    this._history.push(new HistoricalTracer(
      this.scene, this.renderer, points, ++this._historySerial,
    ));
    while (this._history.length > this.maxHistory) {
      this._history.shift().dispose();
    }
    return true;
  }

  reset() {
    this._assertLive();
    this.count = 0;
    this.uPointCount.value = 0;
    this.uOpacity.value = 1.0;
    this.line.visible = false;
    this.renderer.compute(this._resetCompute);
  }

  clearHistory() {
    this._assertLive();
    for (const history of this._history) history.dispose();
    this._history.length = 0;
    this.reset();
  }

  push(p) {
    this._assertLive();
    if (this.count >= this.max) {
      this.line.visible = false;
      throw new Error(`Tracer GPU history overflow (${this.max} samples).`);
    }
    this._point.copy(p);
    const cpuIndex = this.count * 3;
    this._cpuPoints[cpuIndex] = this._point.x;
    this._cpuPoints[cpuIndex + 1] = this._point.y;
    this._cpuPoints[cpuIndex + 2] = this._point.z;
    this.uAppendIndex.value = this.count;
    this.count++;
    this.uPointCount.value = this.count;
    this.renderer.compute(this._appendCompute);
    this.line.visible = this.count >= 2;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const history of this._history) history.dispose();
    this._history.length = 0;
    this.line.removeFromParent();
    this.line.material.dispose();
    disposeWebGPUGeometries(this.renderer, [this.geo]);
    disposeComputeNodes([this._appendCompute, this._resetCompute]);
    disposeWebGPUAttributes(this.renderer, [this._pointsAttr, this._drawArgsAttr]);
  }

  _assertLive() {
    if (this._disposed) throw new Error('Tracer has been disposed.');
  }
}
