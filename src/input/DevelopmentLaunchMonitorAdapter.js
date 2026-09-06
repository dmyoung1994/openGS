import {
  CANONICAL_LAUNCH_UNITS,
  LaunchMonitorAdapter,
  createLaunchMonitorCapabilities,
} from './LaunchMonitorInput.js';

function freezePreset(shot) {
  return Object.freeze({ ...shot });
}

// These are the existing simulator calibration profiles expressed in the
// canonical provider-neutral field names. MetricsPanel can import this one
// source when the runtime integration replaces its private preset table.
export const DEVELOPMENT_LAUNCH_PRESETS = Object.freeze({
  'Driver (tour)': freezePreset({ ballSpeed: 167, clubSpeed: 113, launchAngle: 10.9, spinRate: 2686, spinAxis: -2, launchDirection: 0 }),
  'Driver (amateur)': freezePreset({ ballSpeed: 133, clubSpeed: 93, launchAngle: 12.5, spinRate: 3200, spinAxis: 3, launchDirection: 0 }),
  '3-wood': freezePreset({ ballSpeed: 158, clubSpeed: 108, launchAngle: 9.2, spinRate: 3655, spinAxis: -1, launchDirection: 0 }),
  '5-iron': freezePreset({ ballSpeed: 132, clubSpeed: 94, launchAngle: 14.3, spinRate: 5361, spinAxis: 0, launchDirection: 0 }),
  '7-iron': freezePreset({ ballSpeed: 120, clubSpeed: 90, launchAngle: 16.3, spinRate: 7097, spinAxis: 0, launchDirection: 0 }),
  '9-iron': freezePreset({ ballSpeed: 108, clubSpeed: 84, launchAngle: 20.4, spinRate: 8647, spinAxis: 0, launchDirection: 0 }),
  'Pitching wedge': freezePreset({ ballSpeed: 102, clubSpeed: 80, launchAngle: 24.2, spinRate: 9304, spinAxis: 0, launchDirection: 0 }),
  'Big slice': freezePreset({ ballSpeed: 150, clubSpeed: 104, launchAngle: 13, spinRate: 3400, spinAxis: 14, launchDirection: -3 }),
  'Towering draw': freezePreset({ ballSpeed: 160, clubSpeed: 109, launchAngle: 12, spinRate: 2900, spinAxis: -9, launchDirection: 2 }),
});

const DEVELOPMENT_CAPABILITIES = createLaunchMonitorCapabilities({
  optionalMetrics: ['clubSpeed', 'clubLabel', 'deviceShotId'],
  transport: 'development',
  units: CANONICAL_LAUNCH_UNITS,
});

export class DevelopmentLaunchMonitorAdapter extends LaunchMonitorAdapter {
  constructor({ now = Date.now, presets = DEVELOPMENT_LAUNCH_PRESETS, maxRecentShots } = {}) {
    super({
      providerId: 'development-launch-lab',
      capabilities: DEVELOPMENT_CAPABILITIES,
      ...(maxRecentShots === undefined ? {} : { maxRecentShots }),
    });
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this.presets = presets;
    this.sequence = 0;
  }

  listPresets() {
    return Object.freeze(Object.keys(this.presets));
  }

  emitPreset(name, overrides = {}) {
    const preset = this.presets[name];
    if (!preset) throw new RangeError(`unknown development launch preset: ${String(name)}`);
    return this.emitShot({ ...preset, ...overrides });
  }

  emitShot(input) {
    const timestamp = input.timestamp ?? this.now();
    const { clubSpeed, ...shot } = input;
    const optional = {
      ...input.optional,
      clubSpeed: input.optional?.clubSpeed ?? clubSpeed,
      deviceShotId: input.optional?.deviceShotId ?? `development-${++this.sequence}`,
    };
    return this.ingest({ ...shot, timestamp, optional });
  }
}
