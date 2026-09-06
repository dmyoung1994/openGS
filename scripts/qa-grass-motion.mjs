// Real production-camera travel plus native GPU readback, through the canonical
// headful Chrome harness. Run: node scripts/qa-grass-motion.mjs
import { spawnSync } from 'node:child_process';

async function probe() {
  const { range, evaluatorCamera: camera } = window.golf;
  const grass = range.grass;
  const samples = [];
  camera.unfreeze();
  for (let step = 0; step <= 12; step++) {
    const x = 35 + step;
    const z = -20 - step * 3;
    const position = [x, range.terrain.heightAt(x, z) + 2, z];
    camera.movePose({ position, lookAt: [70, range.terrain.heightAt(70, -100), -100] });
    await camera.waitForFrames(2);
    const data = await grass.readDiagnostics();
    if (!data.visibleCount || data.overflow
      || data.lodCameraPosition.some((value, axis) => Math.abs(value - position[axis]) > 1e-6)) {
      throw new Error(`Grass camera travel failed: ${JSON.stringify(data)}`);
    }
    samples.push({ position, visibleCount: data.visibleCount, lod: data.lod.counts });
  }
  await camera.waitForFrames(3);
  const counts = await grass.readDiagnostics();
  // Three pads uvec3 storage to four words; read the actual uploaded layout.
  const stride = grass._recordId.value.itemSize;
  const read = async () => new Uint32Array(await grass.renderer.getArrayBufferAsync(grass._recordId.value));
  const before = await read();
  await camera.waitForFrames(30);
  const after = await read();
  let offset = 0, identityChanges = 0, windChanges = 0, previousLodErrors = 0;
  for (let lod = 0; lod < counts.lod.counts.length; lod++) {
    for (let index = 0; index < counts.lod.counts[lod]; index++) {
      const word = (offset + index) * stride;
      identityChanges += Number(before[word] !== after[word]);
      windChanges += Number(before[word + 1] !== after[word + 1]);
      previousLodErrors += Number((after[word + 2] & 65535) !== (after[word + 2] >>> 16));
    }
    offset += counts.lod.capacities[lod];
  }
  const result = { samples, stride, identityChanges, windChanges, previousLodErrors };
  if (identityChanges || !windChanges || previousLodErrors
    || new Set(samples.map(sample => sample.visibleCount)).size < 2) {
    throw new Error(`Grass moving-to-stationary transition failed: ${JSON.stringify(result)}`);
  }
  return result;
}

const output = process.argv[2] || '/tmp/grass-motion-qa';
const result = spawnSync(process.execPath, [
  'scripts/shot.mjs', '--game', '--route=/range.html',
  '--presentation-mode=ultra', '--presentation-scale=1', '--gpu-live',
  '--frames=90', '--frame-timing=240', '--gpu=24',
  '--cam=35,0,-20', '--terrain-lift=2', '--look=70,0,-100', '--look-terrain-lift=0',
  `--eval=(${probe.toString()})()`,
  `--out=${output}.png`, `--qa-report=${output}.json`,
], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
