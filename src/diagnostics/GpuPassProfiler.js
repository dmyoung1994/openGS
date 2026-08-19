import { InspectorBase, TimestampQuery } from 'three/webgpu';

const MAX_CAPTURE_FRAMES = 30;
const QUERY_CAPACITY = 2048;
const QUERY_INDICES_PER_PASS = 2;
const QUERY_HEADROOM = 64;

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

export function summarizeTimestampIntervals(intervals) {
  if (intervals.length === 0) {
    return { unionMs: 0, envelopeMs: 0, nonAdditiveSumMs: 0, overlapFactor: 1 };
  }
  const sorted = [...intervals].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let union = 0n;
  let rangeStart = sorted[0].start;
  let rangeEnd = sorted[0].end;
  let sum = 0n;
  for (const interval of sorted) {
    sum += interval.end - interval.start;
    if (interval.start > rangeEnd) {
      union += rangeEnd - rangeStart;
      rangeStart = interval.start;
      rangeEnd = interval.end;
    } else if (interval.end > rangeEnd) {
      rangeEnd = interval.end;
    }
  }
  union += rangeEnd - rangeStart;
  const envelope = sorted.reduce((end, interval) => interval.end > end ? interval.end : end, sorted[0].end)
    - sorted.reduce((start, interval) => interval.start < start ? interval.start : start, sorted[0].start);
  const unionMs = Number(union) / 1e6;
  const nonAdditiveSumMs = Number(sum) / 1e6;
  return {
    unionMs,
    envelopeMs: Number(envelope) / 1e6,
    nonAdditiveSumMs,
    overlapFactor: unionMs > 0 ? nonAdditiveSumMs / unionMs : 1,
  };
}

// A deliberately small inspector that only records Three's pass-level timestamp
// contexts. Three owns the query pools and query sets; this never creates WebGPU
// query objects itself, nor does it measure CPU time as a stand-in for GPU work.
export class GpuPassProfiler extends InspectorBase {
  constructor() {
    super();
    this._capture = null;
    this._resolving = null;
    this.lastCapture = null;
  }

  availability() {
    const renderer = this.getRenderer();
    if (!renderer?.hasInitialized?.()) {
      return { available: false, reason: 'Renderer is not initialized.' };
    }
    if (renderer.backend?.isWebGPUBackend !== true) {
      return { available: false, reason: 'WebGPU backend is required.' };
    }
    if (renderer.hasFeature('timestamp-query') !== true) {
      return { available: false, reason: 'WebGPU timestamp-query is not available on this device.' };
    }
    return { available: true };
  }

  capture(frames = MAX_CAPTURE_FRAMES) {
    if (this._capture || this._resolving) {
      return Promise.resolve({ available: false, reason: 'A GPU timestamp capture is already in progress.' });
    }

    const availability = this.availability();
    if (!availability.available) return Promise.resolve(availability);

    const requestedFrames = Math.min(MAX_CAPTURE_FRAMES, Math.max(1, Math.floor(Number(frames) || 1)));
    const renderer = this.getRenderer();
    const maxPasses = Math.max(
      1,
      renderer.info.render.frameCalls || 0,
      renderer.info.compute.frameCalls || 0,
    );
    const safeFrames = Math.floor((QUERY_CAPACITY - QUERY_HEADROOM)
      / (QUERY_INDICES_PER_PASS * maxPasses));
    const captureFrames = Math.min(requestedFrames, safeFrames);
    if (captureFrames < 1) {
      return Promise.resolve({
        available: false,
        reason: `Current ${maxPasses}-pass frame exceeds timestamp-query pool capacity.`,
      });
    }

    return new Promise((resolve) => {
      this._capture = {
        requestedFrames,
        captureFrames,
        frames: [],
        currentFrame: null,
        resolve,
      };
      renderer.backend.trackTimestamp = true;
    });
  }

  begin() {
    const capture = this._capture;
    if (!capture || capture.frames.length >= capture.captureFrames) return;

    const frame = { index: capture.frames.length, passes: [] };
    capture.frames.push(frame);
    capture.currentFrame = frame;
  }

  finish() {
    const capture = this._capture;
    if (!capture?.currentFrame) return;

    capture.currentFrame = null;
    if (capture.frames.length === capture.captureFrames) this._resolveCapture(capture);
  }

  beginRender(uid, scene, camera, renderTarget) {
    this._recordPass('render', uid, this._renderLabel(scene, renderTarget));
  }

  beginCompute(uid, computeNode) {
    const name = computeNode?.name || computeNode?.label || `Compute ${computeNode?.id ?? 'pass'}`;
    this._recordPass('compute', uid, name);
  }

  _recordPass(type, uid, label) {
    const frame = this._capture?.currentFrame;
    if (frame) frame.passes.push({ type, uid, label });
  }

  _renderLabel(scene, renderTarget) {
    // SceneManager explicitly names the MRT beauty pass. GTAONode's reusable quad
    // is named "AO" by Three; its material is the stable discriminator here.
    if (scene?.material?.name === 'GTAO') return 'GTAO composite';
    if (scene?.name === 'Render Pipeline') return 'Final output pass';
    if (scene?.name) return scene.name;
    if (renderTarget?.texture?.name) return renderTarget.texture.name;
    return 'Render pass';
  }

  _resolveCapture(capture) {
    if (this._resolving) return;

    const renderer = this.getRenderer();
    this._capture = null;

    // Three's WebGPU resolver exposes only a SUM of pass durations. On Metal/WebGPU
    // those timestamp intervals overlap substantially, so that sum is not frame time.
    // Snapshot the UID->query offsets before Three clears them; after its normal resolve
    // completes we remap the same readback buffers and reconstruct interval unions.
    const pools = renderer.backend.timestampQueryPool;
    const snapshots = {
      render: this._snapshotPool(pools.render),
      compute: this._snapshotPool(pools.compute),
    };

    // Start both whole-pool resolves before disabling tracking. The backend snapshots
    // the bounded window synchronously; later frames therefore cannot append queries.
    const renderResolve = renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
    const computeResolve = renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
    renderer.backend.trackTimestamp = false;

    this._resolving = Promise.all([renderResolve, computeResolve])
      .then(async ([renderMs, computeMs]) => {
        const [renderIntervals, computeIntervals] = await Promise.all([
          this._readIntervals(pools.render, snapshots.render),
          this._readIntervals(pools.compute, snapshots.compute),
        ]);
        return this._report(capture, { render: renderIntervals, compute: computeIntervals }, {
          render: renderMs,
          compute: computeMs,
        });
      })
      .catch((error) => ({
        available: false,
        complete: false,
        reason: `Timestamp-query resolve failed: ${error?.message || String(error)}`,
        framesRequested: capture.requestedFrames,
        framesPlanned: capture.captureFrames,
        framesCaptured: capture.frames.length,
      }))
      .then((result) => {
        this.lastCapture = result;
        capture.resolve(result);
        return result;
      })
      .finally(() => { this._resolving = null; });
  }

  _snapshotPool(pool) {
    if (!pool || pool.currentQueryIndex < 1) return null;
    return {
      queryCount: pool.currentQueryIndex,
      offsets: new Map(pool.queryOffsets),
    };
  }

  async _readIntervals(pool, snapshot) {
    const intervals = new Map();
    if (!pool || !snapshot) return intervals;
    const bytes = snapshot.queryCount * 8;
    await pool.resultBuffer.mapAsync(GPUMapMode.READ, 0, bytes);
    try {
      const mapped = new BigUint64Array(pool.resultBuffer.getMappedRange(0, bytes));
      for (const [uid, offset] of snapshot.offsets) {
        const start = mapped[offset];
        const end = mapped[offset + 1];
        if (end >= start) intervals.set(uid, { start, end });
      }
    } finally {
      pool.resultBuffer.unmap();
    }
    return intervals;
  }

  _report(capture, intervalMaps, threeResolvedMs) {
    const byLabel = new Map();
    const frames = capture.frames.map((frame) => {
      let activePassCount = 0;
      let unavailablePassCount = 0;
      let renderPassCount = 0;
      let computePassCount = 0;
      const passLabels = [];
      const passDurations = [];
      const frameIntervals = [];
      const renderIntervals = [];
      const computeIntervals = [];

      for (const pass of frame.passes) {
        const interval = intervalMaps[pass.type].get(pass.uid);
        if (!interval) {
          unavailablePassCount++;
          continue;
        }

        const durationMs = Number(interval.end - interval.start) / 1e6;
        if (!Number.isFinite(durationMs) || durationMs < 0) {
          unavailablePassCount++;
          continue;
        }
        activePassCount++;
        frameIntervals.push(interval);
        if (pass.type === 'render') {
          renderPassCount++;
          renderIntervals.push(interval);
        } else {
          computePassCount++;
          computeIntervals.push(interval);
        }
        passLabels.push(pass.label);
        passDurations.push({ label: pass.label, type: pass.type, durationMs, ...interval });

        const key = `${pass.type}:${pass.label}`;
        if (!byLabel.has(key)) byLabel.set(key, { label: pass.label, type: pass.type, values: [] });
        byLabel.get(key).values.push(durationMs);
      }

      const origin = frameIntervals.reduce(
        (start, interval) => start === null || interval.start < start ? interval.start : start,
        null,
      );
      const serializablePassDurations = passDurations.map(({ start, end, ...pass }) => ({
        ...pass,
        startMs: Number(start - origin) / 1e6,
        endMs: Number(end - origin) / 1e6,
      }));
      const total = summarizeTimestampIntervals(frameIntervals);
      const render = summarizeTimestampIntervals(renderIntervals);
      const compute = summarizeTimestampIntervals(computeIntervals);

      return {
        index: frame.index,
        gpuUnionMs: total.unionMs,
        gpuEnvelopeMs: total.envelopeMs,
        nonAdditivePassSumMs: total.nonAdditiveSumMs,
        overlapFactor: total.overlapFactor,
        renderUnionMs: render.unionMs,
        computeUnionMs: compute.unionMs,
        activePassCount,
        renderPassCount,
        computePassCount,
        passLabels,
        passDurations: serializablePassDurations,
        unavailablePassCount,
        _firstTimestamp: frameIntervals.reduce(
          (start, interval) => start === null || interval.start < start ? interval.start : start,
          null,
        ),
        _lastTimestamp: frameIntervals.reduce(
          (end, interval) => end === null || interval.end > end ? interval.end : end,
          null,
        ),
      };
    });

    const timestampedFrames = frames.filter((frame) => frame._firstTimestamp !== null && frame._lastTimestamp !== null);
    const completionDeltasMs = timestampedFrames.slice(1).map((frame, index) =>
      Number(frame._lastTimestamp - timestampedFrames[index]._lastTimestamp) / 1e6);
    const trackedGpuMsPerFrame = timestampedFrames.length > 0
      ? Number(timestampedFrames.at(-1)._lastTimestamp - timestampedFrames[0]._firstTimestamp)
        / 1e6 / timestampedFrames.length
      : null;
    for (const frame of frames) {
      delete frame._firstTimestamp;
      delete frame._lastTimestamp;
    }

    const passes = [...byLabel.values()].map(({ label, type, values }) => ({
      label,
      type,
      samples: values.length,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50: quantile(values, 0.50),
      p95: quantile(values, 0.95),
      max: Math.max(...values),
    })).sort((a, b) => b.mean - a.mean || a.label.localeCompare(b.label));

    const unavailablePassCount = frames.reduce((sum, frame) => sum + frame.unavailablePassCount, 0);
    const renderMs = Number.isFinite(threeResolvedMs.render) ? threeResolvedMs.render : 0;
    const computeMs = Number.isFinite(threeResolvedMs.compute) ? threeResolvedMs.compute : 0;
    const lastFrame = frames.at(-1);
    return {
      available: true,
      framesRequested: capture.requestedFrames,
      framesPlanned: capture.captureFrames,
      framesCaptured: capture.frames.length,
      complete: capture.frames.length === capture.captureFrames && unavailablePassCount === 0,
      unavailablePassCount,
      lastFrameGpuMs: lastFrame ? {
        union: lastFrame.gpuUnionMs,
        envelope: lastFrame.gpuEnvelopeMs,
        renderUnion: lastFrame.renderUnionMs,
        computeUnion: lastFrame.computeUnionMs,
      } : null,
      threeResolvedNonAdditiveLastFrameMs: {
        render: renderMs,
        compute: computeMs,
        total: renderMs + computeMs,
      },
      captureThroughput: {
        trackedGpuMsPerFrame,
        completionDeltaSamplesMs: completionDeltasMs,
        completionDeltaP50Ms: quantile(completionDeltasMs, 0.50),
        completionDeltaP95Ms: quantile(completionDeltasMs, 0.95),
        note: 'Frame-completion cadence is the throughput metric; individual pass spans and frame envelopes may overlap.',
      },
      passCoverage: {
        includes: ['Three render passes', 'Three compute passes'],
        excludes: ['texture/framebuffer copies', 'presentation'],
        frameMetric: 'union of native WebGPU timestamp intervals; overlapping pass spans are merged, never summed',
      },
      passes,
      frames,
    };
  }
}
