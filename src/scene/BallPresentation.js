const BALL_DIAMETER_METRES = 0.04267;
const MIN_FLIGHT_DIAMETER_PIXELS = 4.5;
const MAX_PRESENTATION_SCALE = 1.85;

// Broadcast cameras need the physical ball to survive sub-pixel minification. This
// bounded scale affects only the rendered mesh: trajectory, contact radius, spin,
// carry, and terrain collision all continue to use the regulation 42.67 mm ball.
// Close and native-resolution views remain exactly 1:1.
export function ballPresentationScale({ distance, verticalFovRadians, viewportHeight }) {
  if (!(distance > 0) || !(verticalFovRadians > 0) || !(viewportHeight > 0)) return 1;
  const metresPerPixel = 2 * distance * Math.tan(verticalFovRadians * 0.5) / viewportHeight;
  const requiredScale = MIN_FLIGHT_DIAMETER_PIXELS * metresPerPixel / BALL_DIAMETER_METRES;
  return Math.min(MAX_PRESENTATION_SCALE, Math.max(1, requiredScale));
}
