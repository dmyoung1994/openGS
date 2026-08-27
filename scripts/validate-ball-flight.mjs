import { GCQUAD_VALIDATION_CORPUS } from '../src/physics/calibration.js';
import { makeEnv, simulateFlight } from '../src/physics/ballistics.js';
import { pathToFileURL } from 'node:url';

const YARDS_PER_METER = 1 / 0.9144;
const FEET_PER_METER = 3.28084;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const env = makeEnv({ sampleWind: (_position, _time, out) => out.set(0, 0, 0) });

export function replayGcquadCorpus(corpus = GCQUAD_VALIDATION_CORPUS) {
  return corpus.map((fixture) => {
    const { launch } = fixture;
    const result = simulateFlight({
      ballSpeed: launch.ballSpeedMph,
      launchAngle: launch.launchAngleDeg,
      azimuth: launch.azimuthDeg,
      spinRate: launch.totalSpinRpm,
      spinAxis: launch.spinAxisDeg,
      // Explicitly prove unrelated launch metadata cannot enter flight physics.
      club: 'ignored-by-ballistics',
    }, env);
    const simulated = {
      carryYards: result.carry * YARDS_PER_METER,
      apexFeet: result.apexHeight * FEET_PER_METER,
      offlineYards: result.lateral * YARDS_PER_METER,
      descentDeg: result.descentAngle * DEGREES_PER_RADIAN,
    };
    const error = Object.fromEntries(Object.entries(fixture.observed)
      .map(([key, value]) => [key, value == null ? null : simulated[key] - value]));
    return { id: fixture.id, sourceKind: fixture.source.kind, simulated, observed: fixture.observed, error };
  });
}

export function summarize(rows) {
  const metrics = ['carryYards', 'apexFeet', 'offlineYards', 'descentDeg'];
  return Object.fromEntries(metrics.map((metric) => {
    const errors = rows.map((row) => row.error[metric]).filter(Number.isFinite);
    if (errors.length === 0) return [metric, null];
    return [metric, {
      samples: errors.length,
      bias: errors.reduce((sum, value) => sum + value, 0) / errors.length,
      meanAbsoluteError: errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length,
      maximumAbsoluteError: Math.max(...errors.map(Math.abs)),
    }];
  }));
}

export function summarizeBySource(rows) {
  const groups = Map.groupBy(rows, (row) => row.sourceKind);
  return Object.fromEntries([...groups].map(([sourceKind, sourceRows]) => [sourceKind, summarize(sourceRows)]));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = replayGcquadCorpus();
  const report = {
    environment: 'sea-level ISA, still air, flat ground',
    rows,
    summary: summarize(rows),
    summaryBySource: summarizeBySource(rows),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.table(rows.map((row) => ({
      id: row.id,
      carry: row.simulated.carryYards.toFixed(1),
      reference: row.observed.carryYards?.toFixed(1) ?? '—',
      delta: row.error.carryYards?.toFixed(1) ?? '—',
      apexDelta: row.error.apexFeet?.toFixed(1) ?? '—',
      offlineDelta: row.error.offlineYards?.toFixed(1) ?? '—',
    })));
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(JSON.stringify(report.summaryBySource, null, 2));
  }
}
