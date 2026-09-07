// Measure how much of each grass LOD reservation is actually used, across a spread
// of real camera poses. The far tier is the one that overflows in practice while the
// near tiers sit far below their reservation; this quantifies that before any
// capacity is moved between them. Read-only: no authored source is touched.
import { spawnSync } from 'node:child_process';

async function probe(poses) {
  const { range, evaluatorCamera: camera } = window.golf;
  const terrain = range.terrain;
  if (!camera.active) camera.enter();
  camera.unfreeze();
  const rows = [];
  for (const [label, x, lift, z, lx, lz, lookLift] of poses) {
    camera.movePose({
      position: [x, terrain.heightAt(x, z) + lift, z],
      lookAt: [lx, terrain.heightAt(lx, lz) + lookLift, lz],
    });
    // Camera/projection changes retain full recompaction, so let it settle.
    await camera.waitForFrames(12);
    const g = await range.grass.readDiagnostics();
    rows.push({
      label,
      visible: g.visibleCount,
      triangles: g.triangleCount,
      overflow: g.overflow,
      counts: g.lod.counts,
      capacities: g.lod.capacities,
      used: g.lod.counts.map((n, i) => +(n / g.lod.capacities[i]).toFixed(4)),
    });
  }
  return rows;
}

const COURSES = [
  ['grasslands', '/play.html?course=grasslands-reference', [
    // label, camX, camLift, camZ, lookX, lookZ, lookLift
    ['reference-elevated', 0, 6, -35, -7, 105, 5],
    ['golfer-height-tee', 0, 1.7, -35, -7, 105, 1.7],
    ['low-along-ground', 0, 0.4, -20, 0, 160, 0.6],
    ['at-jacaranda', -46, 2.2, 112, -46, 140, 6],
    ['mid-fairway', 0, 1.7, 60, 0, 200, 1.7],
    ['looking-back', 0, 1.7, 150, 0, -20, 1.7],
  ]],
  ['beach-range', '/range.html?view=practice', [
    ['practice-address', 30, 1.7, -20, 48, -70, 1.7],
    ['low-down-range', 30, 0.4, -20, 30, -120, 0.6],
    ['elevated', 30, 8, -20, 30, -140, 2],
  ]],
  ['pineglass', '/play.html', [
    ['tee', 0, 1.7, 0, 0, 120, 1.7],
    ['low', 0, 0.4, 0, 0, 140, 0.6],
  ]],
];

for (const [name, route, poses] of COURSES) {
  console.log(`\n===== ${name} =====`);
  const result = spawnSync(process.execPath, [
    'scripts/shot.mjs', '--game', `--route=${route}`,
    '--presentation-mode=ultra', '--presentation-scale=1',
    '--frames=30', '--size=900x900',
    `--eval=(${probe.toString()})(${JSON.stringify(poses)})`,
    `--out=/tmp/grass-lod-occupancy-${name}.png`,
    `--qa-report=/tmp/grass-lod-occupancy-${name}.json`,
  ], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
  if (result.error) throw result.error;
}
