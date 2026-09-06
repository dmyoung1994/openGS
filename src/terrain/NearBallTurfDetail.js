// Runtime presentation policy for the texture-only maintained-turf macro view.
// These values are deliberately not course authoring data: the same physical turf
// material is rendered everywhere, while a low camera near a grounded ball gets a
// little more of the already-resident source relief over its forward view.
export const NEAR_BALL_TURF_DETAIL = Object.freeze({
  forwardStartMeters: 0.0,
  forwardFullMeters: 0.75,
  forwardFadeMeters: 9.5,
  forwardEndMeters: 13.716, // exactly 15 yards
  lateralFullBaseMeters: 0.35,
  lateralFullSlope: 0.26,
  lateralEndBaseMeters: 0.70,
  lateralEndSlope: 0.36,
  cameraHeightFullMeters: 1.8,
  cameraHeightEndMeters: 2.6,
  cameraBallDistanceFullMeters: 6.0,
  cameraBallDistanceEndMeters: 9.0,
  activationSeconds: 0.22,
  deactivationSeconds: 0.30,
  focusFollowSeconds: 0.12,
  maxDeltaSeconds: 1 / 15,
  normalGain: 0.12,
});

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function smootherstep01(value) {
  const x = clamp01(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function descendingRamp(value, fullAt, zeroAt) {
  if (!Number.isFinite(value)) return 0;
  return 1 - smootherstep01((value - fullAt) / (zeroAt - fullAt));
}

export function nearBallTurfDetailTarget({
  enabled = true,
  ballState,
  cameraHeightMeters,
  cameraBallDistanceMeters,
} = {}) {
  if (!enabled || (ballState !== 'rest' && ballState !== 'rolling')) return 0;
  const p = NEAR_BALL_TURF_DETAIL;
  return descendingRamp(cameraHeightMeters, p.cameraHeightFullMeters, p.cameraHeightEndMeters)
    * descendingRamp(
      cameraBallDistanceMeters,
      p.cameraBallDistanceFullMeters,
      p.cameraBallDistanceEndMeters,
    );
}

export function dampNearBallTurfDetail(current, target, deltaSeconds) {
  const p = NEAR_BALL_TURF_DETAIL;
  const from = clamp01(Number.isFinite(current) ? current : 0);
  const to = clamp01(Number.isFinite(target) ? target : 0);
  const dt = Math.min(p.maxDeltaSeconds, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
  const seconds = to > from ? p.activationSeconds : p.deactivationSeconds;
  return from + (to - from) * (1 - Math.exp(-dt / seconds));
}

export function nearBallTurfFocusFollowAlpha(deltaSeconds) {
  const p = NEAR_BALL_TURF_DETAIL;
  const dt = Math.min(p.maxDeltaSeconds, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
  return 1 - Math.exp(-dt / p.focusFollowSeconds);
}

// CPU mirror of the shader footprint for deterministic tests and diagnostics.
// `forwardMeters` and `lateralMeters` are camera-local ground-plane coordinates.
export function nearBallTurfFootprintWeight(forwardMeters, lateralMeters) {
  if (!Number.isFinite(forwardMeters) || !Number.isFinite(lateralMeters)) return 0;
  const p = NEAR_BALL_TURF_DETAIL;
  const leading = smootherstep01(
    (forwardMeters - p.forwardStartMeters) / (p.forwardFullMeters - p.forwardStartMeters),
  );
  const trailing = 1 - smootherstep01(
    (forwardMeters - p.forwardFadeMeters) / (p.forwardEndMeters - p.forwardFadeMeters),
  );
  const forward = Math.max(0, forwardMeters);
  const fullHalfWidth = p.lateralFullBaseMeters + forward * p.lateralFullSlope;
  const endHalfWidth = p.lateralEndBaseMeters + forward * p.lateralEndSlope;
  const lateral = 1 - smootherstep01(
    (Math.abs(lateralMeters) - fullHalfWidth) / (endHalfWidth - fullHalfWidth),
  );
  return clamp01(leading * trailing * lateral);
}
