// Canonical production WebGPU QA plus an isolated cold-pack/warm-pack lifecycle
// check. Outputs stay outside the repository. Run with the Vite server on 5173.
import { spawnSync } from 'node:child_process';

async function probe() {
  const { loadTurfMaps } = await import('/src/terrain/Terrain.js?turf-cache-benchmark');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const samples = [];
  let previous = null;
  let packedBytes = 0;
  for (let index = 0; index < 4; index++) {
    const started = performance.now();
    const maps = loadTurfMaps();
    // Concurrent requests must share pending decode/packing, never GPU handles.
    const sibling = loadTurfMaps();
    await Promise.all([maps.ready, sibling.ready]);
    samples.push(performance.now() - started);
    packedBytes = 0;
    for (const key of ['albedoArray', 'nrhArray']) {
      const array = maps[key];
      assert(array !== sibling[key], 'GPU Texture ownership must remain per scene');
      assert(array.image.data === sibling[key].image.data, 'Concurrent packs must deduplicate');
      assert(array.image.width === 2048 && array.image.depth === 3, 'Authored resolution/layers changed');
      if (previous) assert(array.image.data === previous[key].image.data, 'Disposed owner lost cached CPU pixels');
      packedBytes += array.image.data.byteLength;
      array.dispose();
      sibling[key].dispose();
    }
    previous = maps;
  }
  assert(packedBytes === 96 * 1024 * 1024, 'Cache must be bounded to the fixed six-map pack');
  // Exercise the real course lifetime too, not just standalone texture factories.
  const golf = window.golf;
  const pose = golf.evaluatorCamera.getState();
  const oldMaps = golf.range.terrain._turfMaps;
  const disposalCounts = { albedoArray: 0, nrhArray: 0 };
  for (const key of Object.keys(disposalCounts)) {
    oldMaps[key].addEventListener('dispose', () => disposalCounts[key]++);
  }
  const rebuildStart = performance.now();
  await golf.rebuild();
  await golf.environmentReady;
  const courseRebuildMs = performance.now() - rebuildStart;
  const newMaps = golf.range.terrain._turfMaps;
  for (const key of Object.keys(disposalCounts)) {
    assert(newMaps[key] === oldMaps[key], 'Retained loading terrain should keep the live GPU array resident');
    assert(newMaps[key].image.data === oldMaps[key].image.data, 'Course rebuild repacked turf');
    assert(disposalCounts[key] === 0, 'Course teardown disposed an array still owned by the retained loading terrain');
  }
  golf.evaluatorCamera.setPose({ position: pose.position, lookAt: pose.lookAt, fov: pose.fov });
  await golf.evaluatorCamera.waitForFrames(45);
  return { turfPackMs: samples, packedBytes, sharedCpuPixels: true, separateGpuOwnership: true,
    sharedResidentGpuArrays: true, courseRebuildMs, disposalCounts };
}

const result = spawnSync(process.execPath, [
  'scripts/shot.mjs', '--game', '--route=/range.html',
  '--presentation-mode=ultra', '--presentation-scale=1',
  '--cam=0,0,-20', '--terrain-lift=0.5', '--look=0,0,-22', '--look-terrain-lift=0',
  '--out=/tmp/turf-loading-after.png', '--qa-report=/tmp/turf-loading-after.json',
  `--eval=(${probe.toString()})()`,
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
