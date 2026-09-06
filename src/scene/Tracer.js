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
const LIVE_TRACER_OPACITY = 1.0;
const LIVE_TRACER_WIDTH_PIXELS = 5.2;
const HISTORY_TRACER_OPACITY = 1.0;
const HISTORY_TRACER_WIDTH_PIXELS = 2.2;
// Rasterized margin each side of the drawn width, so the analytic coverage ramp is
// always interior to the geometry. One pixel is exactly the box filter's support.
const COVERAGE_SKIRT_PIXELS = 1.0;

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

function createRibbonMaterial({
  points, pointCount, opacity, ribbonPixels, ribbonColor = null, alongFade = null,
}) {
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
  const clipTangent = cameraProjectionMatrix.mul(vec4(viewTangent, 0.0));
  // A chase camera can look almost directly down the flight tangent. Normalizing
  // its near-zero screen projection produced unstable ribbon spikes. Derive the
  // direction after perspective projection (including clip-w change), then fall
  // back to a horizontal screen-width basis only for the true end-on limit.
  const tangentScreen = clipTangent.xy.mul(clip.w).sub(clip.xy.mul(clipTangent.w));
  const tangentScreenLength = tangentScreen.dot(tangentScreen).sqrt();
  const perpendicular = tangentScreenLength.greaterThan(0.0001).select(
    vec2(tangentScreen.y.negate(), tangentScreen.x).div(tangentScreenLength),
    vec2(1.0, 0.0),
  );
  const along = float(segment).add(t).div(float(pointCount.sub(uint(1))).max(1.0));
  const tailTaper = smoothstep(0.0, 0.035, along);
  // Keep the leading flight section substantial enough to follow the ball from
  // wide broadcast cameras. It still tapers cleanly into the terminal sample,
  // but no longer collapses the last third into a sub-two-pixel thread.
  const headProfile = mix(1.0, 0.52, smoothstep(0.62, 0.96, along));
  const endpointTaper = tailTaper
    .mul(headProfile)
    .mul(oneMinus(smoothstep(0.985, 1.0, along)));
  const side = positionGeometry.x;
  // A clean broadcast ribbon keeps the trajectory readable over turf, trees, and
  // sky. The body is solid white; only pixel coverage and endpoints are feathered.
  const visualHalfPx = ribbonPixels.mul(0.5).mul(endpointTaper.max(0.025));
  // Rasterize a skirt beyond the width actually drawn. When the quad edge coincides
  // with the end of the coverage ramp, the shader can only ever subtract coverage
  // from inside the quad: a pixel straddling the true edge is never shaded at all, so
  // the silhouette is a hard rasterized staircase and the line's brightness swims with
  // wherever pixel centres happen to fall. With the skirt the whole ramp lives inside
  // the geometry and every partially covered pixel gets shaded.
  const geometryHalfPx = visualHalfPx.add(COVERAGE_SKIRT_PIXELS);
  const ndcOffset = perpendicular.mul(side).mul(geometryHalfPx.mul(2.0)).div(screenSize);
  const finalClip = vec4(clip.xy.add(ndcOffset.mul(clip.w)), clip.z, clip.w);

  // These are screen-space coverage coordinates, so linear (no-perspective)
  // centroid interpolation avoids rotation-dependent warping and samples from
  // outside a thin oblique triangle. Carrying the offset in pixels makes coverage
  // exactly rotation-invariant rather than an estimate from screen derivatives.
  const vOffsetPx = varying(side.mul(geometryHalfPx), 'vTracerOffsetPx')
    .setInterpolation('linear', 'centroid');
  const vHalfPx = varying(visualHalfPx, 'vTracerHalfPx').setInterpolation('linear', 'centroid');
  const vAlong = varying(along, 'vTracerAlong').setInterpolation('linear', 'centroid');
  const alongFootprint = vAlong.fwidth().abs();
  const tailFeather = alongFootprint.mul(1.25).max(0.035).min(0.12);
  const headFeather = alongFootprint.mul(1.25).max(0.015).min(0.08);
  const fragmentTaper = smoothstep(0.0, tailFeather, vAlong)
    .mul(oneMinus(smoothstep(oneMinus(headFeather), 1.0, vAlong)));
  // Box-filtered coverage of a band of half-width h at pixel distance d: solid
  // through the body, ramping across exactly one pixel at the boundary. The 2h cap
  // is what lets a sub-pixel ribbon dim smoothly instead of dropping in and out of
  // the raster as it tapers, so no separate minimum width is needed.
  const edgeCoverage = vHalfPx.add(0.5).sub(vOffsetPx.abs())
    .min(vHalfPx.mul(2.0))
    .clamp(0.0, 1.0);
  // Shot tracers are always the solid white body above. `ribbonColor` exists only
  // for the loading green's putt mural, which tints each holed line to build a
  // legible overlay; nothing on the play path supplies it.
  const color = ribbonColor ?? vec3(1.0, 1.0, 1.0);
  // Optional length gradient, faint where the stroke began and full at its head.
  // A shot tracer is uniformly solid along the flight; only the loading green's
  // mural asks for direction, so the play path keeps the undivided expression.
  const coverage = alongFade
    ? edgeCoverage.mul(fragmentTaper).mul(mix(alongFade, float(1.0), vAlong.clamp(0.0, 1.0)))
    : edgeCoverage.mul(fragmentTaper);
  const alpha = coverage.mul(opacity).clamp(0.0, 1.0);

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

// Uniform arc-length resample. `storage(attribute, 'vec4', count)` bakes the array
// length into the generated WGSL, so promoted lines of varying length each force a
// fresh pipeline compile. Callers that promote repeatedly (the loading green, once
// per holed putt) pin one length and pay that compile exactly once.
function resamplePolyline(points, count) {
  const source = points.length / 3;
  if (!Number.isInteger(count) || count < 2) throw new Error('Tracer history resampling needs at least two samples.');
  if (source < 2) throw new Error('Tracer history resampling needs at least two source samples.');
  const lengths = new Float64Array(source);
  for (let i = 1; i < source; i++) {
    lengths[i] = lengths[i - 1] + Math.hypot(
      points[i * 3] - points[(i - 1) * 3],
      points[i * 3 + 1] - points[(i - 1) * 3 + 1],
      points[i * 3 + 2] - points[(i - 1) * 3 + 2]);
  }
  const total = lengths[source - 1];
  const out = new Float32Array(count * 3);
  let segment = 0;
  for (let sample = 0; sample < count; sample++) {
    const target = total * sample / (count - 1);
    while (segment < source - 2 && lengths[segment + 1] < target) segment++;
    const span = lengths[segment + 1] - lengths[segment];
    const amount = span > 0 ? (target - lengths[segment]) / span : 0;
    for (let axis = 0; axis < 3; axis++) {
      const a = points[segment * 3 + axis], b = points[(segment + 1) * 3 + axis];
      out[sample * 3 + axis] = a + (b - a) * amount;
    }
  }
  return out;
}

class HistoricalTracer {
  constructor(scene, renderer, points, serial,
    { ribbonPixels, color = null, alongFade = null } = {}) {
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
    this.uOpacity = uniform(HISTORY_TRACER_OPACITY);
    this.uRibbonPixels = uniform(ribbonPixels ?? HISTORY_TRACER_WIDTH_PIXELS);
    this.uColor = color ? uniform(color.clone()) : null;
    this.drawArgsAttr = new IndirectStorageBufferAttribute(new Uint32Array([
      SUBDIVISIONS * 6, this.pointCount - 1, 0, 0, 0,
    ]), 5);
    this.geo = createRibbonGeometry(this.drawArgsAttr, this.pointCount - 1);
    this.material = createRibbonMaterial({
      points: this.points,
      pointCount: this.uPointCount,
      opacity: this.uOpacity,
      ribbonPixels: this.uRibbonPixels,
      ribbonColor: this.uColor,
      alongFade,
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
  constructor(scene, {
    renderer, max = 2048, maxHistory = 16, liveWidthPixels = LIVE_TRACER_WIDTH_PIXELS,
    historyWidthPixels = HISTORY_TRACER_WIDTH_PIXELS, historySamples = null, liveColor = null,
    alongFade = null,
  } = {}) {
    if (!renderer?.isWebGPURenderer) throw new Error('Tracer requires the strict WebGPU renderer.');
    if (!Number.isInteger(max) || max < 4) throw new Error('Tracer history capacity must be an integer >= 4.');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new Error('Tracer shot-history capacity must be an integer >= 1.');
    if (historySamples !== null && (!Number.isInteger(historySamples) || historySamples < 2)) {
      throw new Error('Tracer history sample count must be null or an integer >= 2.');
    }
    this.scene = scene;
    this.renderer = renderer;
    this.max = max;
    this.maxHistory = maxHistory;
    this.historyWidthPixels = historyWidthPixels;
    this.alongFade = alongFade;
    this.historySamples = historySamples;
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
    this.uOpacity = uniform(LIVE_TRACER_OPACITY);
    this.uRibbonPixels = uniform(liveWidthPixels);
    // Left null on the play path so the shot ribbon keeps its literal white body.
    this.uColor = liveColor ? uniform(liveColor.clone()) : null;

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
      ribbonColor: this.uColor,
      alongFade,
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
    return this.promoteActiveToHistory();
  }

  promoteActiveToHistory({ color = null } = {}) {
    this._assertLive();
    if (this.count < 2) return false;
    const captured = this._cpuPoints.slice(0, this.count * 3);
    const points = this.historySamples === null
      ? captured
      : resamplePolyline(captured, this.historySamples);
    this._history.push(new HistoricalTracer(
      this.scene, this.renderer, points, ++this._historySerial,
      { ribbonPixels: this.historyWidthPixels, color, alongFade: this.alongFade },
    ));
    while (this._history.length > this.maxHistory) {
      this._history.shift().dispose();
    }
    return true;
  }

  // Re-tunes every retained line from newest to oldest. The mural uses this to keep
  // one hero stroke and let the rest recede, which is what stops a dozen equally
  // loud lines from reading as noise. `style(age, total)` sees age 0 as the newest.
  restyleHistory(style) {
    this._assertLive();
    const total = this._history.length;
    for (let index = 0; index < total; index++) {
      const line = this._history[index];
      const applied = style(total - 1 - index, total);
      if (applied?.opacity !== undefined) line.uOpacity.value = applied.opacity;
      if (applied?.color) {
        if (!line.uColor) throw new Error('Tracer history line was not created with a colour.');
        line.uColor.value.copy(applied.color);
      }
    }
  }

  setLiveColor(color) {
    this._assertLive();
    if (!this.uColor) throw new Error('Tracer was not constructed with a live ribbon colour.');
    this.uColor.value.copy(color);
  }

  reset() {
    this._assertLive();
    this.count = 0;
    this.uPointCount.value = 0;
    // Keep the white body opaque across launch/result; edge coverage remains AA.
    this.uOpacity.value = LIVE_TRACER_OPACITY;
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
