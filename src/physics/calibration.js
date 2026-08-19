// Committed flight acceptance fixtures for the one shipped ball profile.
//
// The TrackMan example is a published measured/optimizer report. Its weather,
// elevation, and exact ball are not disclosed, so it is an envelope rather than
// a claim of laboratory identity. The hero fixture records the product target
// requested for neutral ISA conditions and medium fairway firmness.
export const MODERN_TOUR_CALIBRATION = Object.freeze({
  environment: Object.freeze({
    altitudeM: 0,
    temperatureC: 15,
    humidity: 0,
    windMph: 0,
    groundFirmness: 'medium',
  }),
  fixtures: Object.freeze([
    Object.freeze({
      id: 'trackman-shot-optimizer-2015',
      source: 'https://www.trackman.com/blog/golf/trackman-shot-optimizer',
      launch: Object.freeze({ ballSpeed: 150.4, launchAngle: 9.6, spinRate: 2828, spinAxis: 0 }),
      expected: Object.freeze({
        carryYards: [241, 251],
        apexFeet: [65, 76],
        descentDegrees: [29, 34],
        // The velocity vector must steepen after launch: this is the visible
        // flat-then-rise signature of backspin/Magnus lift.
        earlyFlightAngleGainDegrees: [1.35, 4.5],
      }),
    }),
    Object.freeze({
      id: 'hero-driver-neutral-isa',
      source: 'product-calibration-target',
      launch: Object.freeze({ ballSpeed: 168, launchAngle: 12, spinRate: 2200, spinAxis: 0 }),
      expected: Object.freeze({
        carryYards: [283, 291],
        totalYards: [310, 320],
        apexFeet: [92, 105],
        descentDegrees: [32, 37],
      }),
    }),
  ]),
});
