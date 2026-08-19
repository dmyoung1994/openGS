import {
  BufferAttribute, IndirectStorageBufferAttribute, InstancedBufferGeometry,
  Mesh, MeshBasicNodeMaterial, StorageBufferAttribute, Vector3,
} from 'three';
import {
  Fn, cameraProjectionMatrix, cameraViewMatrix, float, instanceIndex,
  mix, oneMinus, positionGeometry, screenSize, smoothstep, storage, uint, uniform,
  varying, vec2, vec3, vec4,
} from 'three/tsl';
import { disposeComputeNodes, disposeWebGPUAttributes } from './WebGPUResourceDisposal.js';

// The flight history lives in GPU storage. The CPU submits exactly one current ball
// position per rendered frame; a compute pass appends it and updates the indexed
// indirect instance count. Vertex shading reconstructs a centripetal-style smooth
// ribbon from four neighbouring samples, so no trajectory-sized vertex upload or
// BufferGeometry rebuild occurs while the ball is moving.
//
// Tracer history is deliberately bounded and overflow is fatal. Silently wrapping a
// ring while a shot is in progress would draw unrelated head/tail segments together,
// which is a corrupt renderer state rather than a useful lower-quality mode.
const SUBDIVISIONS = 6;

export class Tracer {
  constructor(scene, { renderer, max = 2048 } = {}) {
    if (!renderer?.isWebGPURenderer) throw new Error('Tracer requires the strict WebGPU renderer.');
    if (!Number.isInteger(max) || max < 4) throw new Error('Tracer history capacity must be an integer >= 4.');
    this.renderer = renderer;
    this.max = max;
    this.count = 0;
    this._point = new Vector3();

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
    this.uCorePixels = uniform(3.0);
    this.uHaloPixels = uniform(11.0);

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

    this.geo = this._geometry();
    this.line = new Mesh(this.geo, this._material());
    this.line.name = 'shot-tracer-gpu-indirect';
    this.line.visible = false;
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    scene.add(this.line);
  }

  _geometry() {
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
    geo.instanceCount = this.max - 1;
    geo.setIndirect(this._drawArgsAttr);
    return geo;
  }

  _material() {
    const segment = uint(instanceIndex);
    const finalPoint = this.uPointCount.sub(uint(1));
    const i0 = segment.equal(uint(0)).select(uint(0), segment.sub(uint(1)));
    const i1 = segment;
    const i2 = segment.add(uint(1)).min(finalPoint);
    const i3 = segment.add(uint(2)).min(finalPoint);
    const p0 = this._points.element(i0).xyz;
    const p1 = this._points.element(i1).xyz;
    const p2 = this._points.element(i2).xyz;
    const p3 = this._points.element(i3).xyz;
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
    const perpendicular = vec2(viewTangent.y.negate(), viewTangent.x).normalize();
    const along = float(segment).add(t).div(float(this.uPointCount.sub(uint(1))).max(1.0));
    const headTaper = smoothstep(0.0, 0.08, along).mul(smoothstep(1.0, 0.82, along));
    const side = positionGeometry.x;
    // Stable pixel width at every camera distance. The halo occupies the full
    // ribbon; a white-hot core is produced analytically in the fragment shader.
    const halfWidthPx = this.uHaloPixels.mul(0.5).mul(headTaper.max(0.15));
    const ndcOffset = perpendicular.mul(side).mul(halfWidthPx.mul(2.0)).div(screenSize);
    const finalClip = vec4(clip.xy.add(ndcOffset.mul(clip.w)), clip.z, clip.w);

    const vSide = varying(side, 'vTracerSide');
    const vAlong = varying(along, 'vTracerAlong');
    const edge = float(1.0).sub(vSide.abs());
    const coreFraction = this.uCorePixels.div(this.uHaloPixels).clamp(0.05, 0.95);
    // `edge` is 1 at the centre and 0 at the silhouette, so a three-pixel
    // core inside an eleven-pixel ribbon begins at 1 - 3/11, not at 3/11.
    const coreThreshold = oneMinus(coreFraction);
    const core = smoothstep(coreThreshold.sub(0.08), coreThreshold.add(0.08), edge);
    const halo = smoothstep(0.0, 0.92, edge);
    const tail = smoothstep(0.0, 0.06, vAlong);
    // A normal-composited ember silhouette survives a bright fair-weather sky;
    // additive orange immediately sums toward white and erases the tracer's hue.
    // The core warms toward the ball while the tail stays deep orange, matching a
    // broadcast tracer without pretending it is a physical light source.
    const ember = vec3(0.92, 0.055, 0.006);
    const amber = vec3(1.0, 0.44, 0.025);
    const hotCore = vec3(1.0, 0.94, 0.68);
    const flightColor = mix(ember, amber, smoothstep(0.05, 0.92, vAlong));
    const color = mix(flightColor, hotCore, core.pow(3.0).mul(0.72));
    const alpha = halo.mul(float(0.68).add(core.mul(0.32))).mul(tail).mul(this.uOpacity);

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

  reset() {
    this.count = 0;
    this.uPointCount.value = 0;
    this.uOpacity.value = 1.0;
    this.line.visible = false;
    this.renderer.compute(this._resetCompute);
  }

  push(p) {
    if (this.count >= this.max) {
      this.line.visible = false;
      throw new Error(`Tracer GPU history overflow (${this.max} samples).`);
    }
    this._point.copy(p);
    this.uAppendIndex.value = this.count;
    this.count++;
    this.uPointCount.value = this.count;
    this.renderer.compute(this._appendCompute);
    this.line.visible = this.count >= 2;
  }

  fade(dt) {
    if (this.uOpacity.value > 0) this.uOpacity.value = Math.max(0, this.uOpacity.value - dt / 3.0);
    if (this.uOpacity.value === 0) this.line.visible = false;
  }

  dispose() {
    this.line.removeFromParent();
    this.line.material.dispose();
    this.geo.dispose();
    disposeComputeNodes([this._appendCompute, this._resetCompute]);
    disposeWebGPUAttributes(this.renderer, [this._pointsAttr, this._drawArgsAttr]);
  }
}
