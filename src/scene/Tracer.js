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
const SUBDIVISIONS = 8;

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
    // A chase camera can look almost directly down the flight tangent. Normalizing
    // its near-zero screen projection produced unstable ribbon spikes. Fall back to
    // a horizontal screen-width basis for that end-on limit.
    const tangentScreen = viewTangent.xy;
    const tangentScreenLength = tangentScreen.dot(tangentScreen).sqrt();
    const perpendicular = tangentScreenLength.greaterThan(0.0001).select(
      vec2(tangentScreen.y.negate(), tangentScreen.x).div(tangentScreenLength),
      vec2(1.0, 0.0),
    );
    const along = float(segment).add(t).div(float(this.uPointCount.sub(uint(1))).max(1.0));
    const tailTaper = smoothstep(0.0, 0.035, along);
    const headProfile = mix(1.0, 0.34, smoothstep(0.62, 0.96, along));
    const endpointTaper = tailTaper
      .mul(headProfile)
      .mul(oneMinus(smoothstep(0.985, 1.0, along)));
    const side = positionGeometry.x;
    // Foresight-style broadcast ribbon: a solid, restrained line that gradually
    // narrows toward the ball. Only its final endpoint collapses completely.
    const halfWidthPx = this.uRibbonPixels.mul(0.5).mul(endpointTaper.max(0.025));
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
    const color = mix(deepBroadcastBlue, flightBlue, smoothstep(0.04, 0.86, vAlong));
    const alpha = edgeCoverage.mul(fragmentTaper).mul(this.uOpacity).clamp(0.0, 1.0);

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

  dispose() {
    this.line.removeFromParent();
    this.line.material.dispose();
    this.geo.dispose();
    disposeComputeNodes([this._appendCompute, this._resetCompute]);
    disposeWebGPUAttributes(this.renderer, [this._pointsAttr, this._drawArgsAttr]);
  }
}
