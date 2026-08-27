// Ball-flight evidence, kept separate from the production equations so this
// corpus can expose errors without becoming a table of shot-specific fixes.
// Every simulated record is replayed from launch state alone. `club` is
// intentionally absent from the schema.

export const BALL_FLIGHT_MODEL_EVIDENCE = Object.freeze({
  source: 'https://hdl.handle.net/10012/19337',
  title: 'A Two-Armed Forward Dynamic Model of a Golf Drive',
  author: 'Spencer Ferguson',
  year: 2023,
  ball: '2021 Titleist Pro V1',
  collection: Object.freeze({
    shots: 1040,
    launchMonitor: 'Foresight GCQuad',
    flightTracker: 'FlightScope X3',
    clubs: 'lob wedge through driver',
    maximumWindMps: 1.3,
    observedSpinRatio: Object.freeze([0.02, 0.75]),
    trainingFraction: 0.8,
  }),
  heldOutMeanAbsoluteError: Object.freeze({
    carryYards: 2.74,
    offlineYards: 1.68,
    apexYards: 1.28,
  }),
});

const COMBINE_TEST_SOURCE = Object.freeze({
  kind: 'gcquad-fsx-calculated',
  url: 'https://github.com/christianrehn/CombineTest/blob/master/test/data/SessionData/tmp/20221112PLAYER_11505.session',
  notes: 'Public FSX session export. Flat-ground/air settings are not embedded in the session file.',
});

const FALSARELLA_SOURCE = Object.freeze({
  kind: 'gcquad-fsx-calculated',
  url: 'https://thesis.unipd.it/handle/20.500.12608/49763',
  notes: 'Figures 4.14 and 4.15; FSX screen shows manual 0 mph wind and 0 ft elevation.',
});

const METASEAL_SOURCE = Object.freeze({
  kind: 'gcquad-robot-average',
  url: 'https://metasealgolf.com/urethane-golf-balls/robot-test',
  notes: 'Five-shot robot averages. Azimuth, spin axis, and atmospheric settings were not published.',
});

const USER_SOURCE = Object.freeze({
  kind: 'gcquad-device-calculated',
  notes: 'GCQuad device photos supplied by the project owner; atmospheric settings were not visible.',
});

function record(id, source, launch, observed, notes = '') {
  return Object.freeze({
    id,
    source,
    launch: Object.freeze({ azimuthDeg: 0, spinAxisDeg: 0, ...launch }),
    observed: Object.freeze(observed),
    notes,
  });
}

// Signed convention used throughout this corpus and the simulator:
// azimuth L is negative / R positive; spin-axis L is negative / R positive.
// Missing lateral values are represented as null, never inferred from a club.
export const GCQUAD_VALIDATION_CORPUS = Object.freeze([
  record('owner-img-9183', USER_SOURCE,
    { ballSpeedMph: 157, launchAngleDeg: 11.7, azimuthDeg: -2, totalSpinRpm: 4199, spinAxisDeg: 17 },
    { carryYards: 244, apexFeet: null, offlineYards: null, descentDeg: null }),
  record('owner-img-9182', USER_SOURCE,
    { ballSpeedMph: 157, launchAngleDeg: 6.3, azimuthDeg: -4.4, totalSpinRpm: 3024, spinAxisDeg: -33 },
    { carryYards: 221, apexFeet: null, offlineYards: null, descentDeg: null }),

  record('falsarella-figure-4-14', FALSARELLA_SOURCE,
    { ballSpeedMph: 173, launchAngleDeg: 12.3, azimuthDeg: 2.1, totalSpinRpm: 3400, spinAxisDeg: -4.6 },
    { carryYards: 287, apexFeet: 142.7, offlineYards: null, descentDeg: 47.3 },
    'FSX displayed 3389 rpm backspin; total spin is reconstructed from the displayed -4.6 degree axis.'),
  record('falsarella-figure-4-15-low-spin', FALSARELLA_SOURCE,
    { ballSpeedMph: 175.1, launchAngleDeg: 15.6, azimuthDeg: -3.4, totalSpinRpm: 1800, spinAxisDeg: 9.3 },
    { carryYards: 326, apexFeet: null, offlineYards: 3.9, descentDeg: null },
    'The source flags this as GCQuad overestimation: TrackMan reported 311 yd for the same shot.'),

  record('metaseal-supurnewling-tour-pu', METASEAL_SOURCE,
    { ballSpeedMph: 168.4, launchAngleDeg: 13, totalSpinRpm: 2467 },
    { carryYards: 283.4, apexFeet: null, offlineYards: null, descentDeg: null }),
  record('metaseal-votaway-tpu', METASEAL_SOURCE,
    { ballSpeedMph: 166.5, launchAngleDeg: 12.4, totalSpinRpm: 3506 },
    { carryYards: 265.5, apexFeet: null, offlineYards: null, descentDeg: null }),
  record('metaseal-titleist-pro-v1', METASEAL_SOURCE,
    { ballSpeedMph: 167.5, launchAngleDeg: 12.4, totalSpinRpm: 2678 },
    { carryYards: 279.3, apexFeet: null, offlineYards: null, descentDeg: null }),
  record('metaseal-taylormade-tp5x', METASEAL_SOURCE,
    { ballSpeedMph: 167.8, launchAngleDeg: 12.7, totalSpinRpm: 2472 },
    { carryYards: 282.1, apexFeet: null, offlineYards: null, descentDeg: null }),
  record('metaseal-vice-pro-plus', METASEAL_SOURCE,
    { ballSpeedMph: 167.5, launchAngleDeg: 13, totalSpinRpm: 2531 },
    { carryYards: 281.3, apexFeet: null, offlineYards: null, descentDeg: null }),

  ...[
    [2, 36.0591, 21.753353, 0.870363, 1706, 5.480083, 20.5456, 6.5547, 0.7013, 23.860283],
    [3, 41.2229, 21.830843, 1.561085, 1963, 4.087728, 27.1523, 8.8502, 1.4377, 24.58292],
    [4, 42.1189, 19.346813, 0.832915, 2759, 14.202436, 26.267, 7.5465, 1.6405, 22.076269],
    [5, 42.8624, 20.496126, 1.506719, 2709, 12.189306, 28.3083, 8.7086, 2.0011, 23.520332],
    [6, 40.2931, 18.32741, -1.968875, 1559, -23.787167, 22.6615, 6.0095, -2.3445, 20.186327],
    [7, 41.2075, 19.927679, 0.539615, 1649, -14.002554, 25.4038, 7.4225, -0.3762, 22.196356],
    [8, 44.2963, 21.949577, 2.263337, 2364, 11.390721, 31.5683, 10.5268, 2.7979, 25.29073],
    [9, 43.4285, 22.457546, 3.432217, 2259, 9.991843, 30.7334, 10.4772, 3.357, 25.720449],
    [10, 40.6897, 19.434156, 1.407306, 3164, 12.094763, 24.5692, 7.0972, 1.7619, 22.07733],
    [11, 41.3633, 21.487577, 0.849416, 1889, 3.580147, 27.0519, 8.6551, 0.8315, 24.150845],
    [12, 40.7687, 21.249641, 0.040718, 1514, -8.6973, 25.9695, 8.138, -0.4119, 23.602819],
    [13, 45.823, 22.329704, 1.582042, 2259, 6.989825, 34.2303, 11.7034, 2.0017, 25.915642],
    [14, 49.5035, 19.98526, -2.754359, 2829, 0.485778, 37.7978, 11.6498, -2.5462, 23.96236],
  ].map(([id, speed, launch, azimuth, spin, axis, carry, apex, offline, descent]) => record(
    `combine-test-20221112-${id}`,
    COMBINE_TEST_SOURCE,
    { ballSpeedMph: speed, launchAngleDeg: launch, azimuthDeg: azimuth, totalSpinRpm: spin, spinAxisDeg: axis },
    { carryYards: carry, apexFeet: apex, offlineYards: offline, descentDeg: descent },
  )),
]);
