import { execFileSync, spawn } from 'node:child_process';

const REQUIRED_MACOS_ASSERTIONS = [
  'UserIsActive',
  'PreventUserIdleDisplaySleep',
  'PreventUserIdleSystemSleep',
  'PreventSystemSleep',
];

// Own and verify the host wake state for a bounded renderer benchmark. A browser
// target destroyed by display sleep is neither a renderer failure nor valid GPU
// performance evidence, so the harness must fail closed instead of depending on a
// user's current Energy Saver settings.
export async function acquireHostWakeAssertion({ timeoutSeconds, requireAC = false } = {}) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Host wake assertion requires a positive timeout.');
  }
  if (process.platform !== 'darwin') {
    return {
      report: {
        provider: null,
        processScoped: false,
        requireAC,
        verifications: [],
        note: 'The non-macOS runner must provide and record its native wake assertion.',
      },
      verify() {},
      release() {},
    };
  }

  const args = [
    '-d', '-i', '-s', '-u', '-t', String(Math.ceil(timeoutSeconds)),
    '-w', String(process.pid),
  ];
  const child = spawn('/usr/bin/caffeinate', args, { stdio: 'ignore' });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  let released = false;
  let earlyExit = null;
  child.once('exit', (code, signal) => {
    if (!released) earlyExit = signal || code;
  });

  const report = {
    provider: 'macOS caffeinate',
    binary: '/usr/bin/caffeinate',
    pid: child.pid,
    args,
    timeoutSeconds: Math.ceil(timeoutSeconds),
    processScoped: true,
    requireAC,
    verifications: [],
  };

  const verify = (label) => {
    if (earlyExit !== null || child.exitCode !== null) {
      throw new Error(`${label}: macOS wake assertion exited early (${earlyExit ?? child.exitCode})`);
    }
    const rawAssertions = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' });
    const powerSource = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
      .split('\n')[0]?.trim() || 'unknown';
    const owner = `pid ${child.pid}(caffeinate):`;
    const ownedAssertions = rawAssertions.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(owner));
    const missing = REQUIRED_MACOS_ASSERTIONS.filter((name) =>
      !ownedAssertions.some((line) => line.includes(name)));
    const verification = {
      label,
      at: new Date().toISOString(),
      powerSource,
      ownedAssertions,
      missing,
    };
    report.verifications.push(verification);
    if (missing.length) {
      throw new Error(`${label}: owned macOS wake assertion missing ${missing.join(', ')}`);
    }
    if (requireAC && !/AC Power/i.test(powerSource)) {
      throw new Error(`${label}: strict Metal performance evidence requires AC power; ${powerSource}`);
    }
    return verification;
  };

  const release = () => {
    if (released) return;
    released = true;
    if (child.exitCode === null) child.kill('SIGTERM');
  };

  try {
    verify('before Chrome launch');
  } catch (error) {
    release();
    throw error;
  }

  return { report, verify, release };
}
