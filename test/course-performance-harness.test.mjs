import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../scripts/benchmark-course-pose-sweep.mjs', import.meta.url),
  'utf8',
);

test('course performance sweep uses strict production route poses and machine-readable evidence', () => {
  assert.match(source, /scripts\/shot\.mjs/);
  assert.match(source, /arg\('pose', null\)/);
  assert.match(source, /--authored-course/);
  assert.match(source, /--presentation-mode=balanced/);
  assert.match(source, /--gpu-live/);
  assert.match(source, /--terrain-lift=/);
  assert.match(source, /--hole=/);
  assert.match(source, /activeHoleId !== pose\.holeId/);
  assert.match(source, /gpu\?\.complete !== true/);
  assert.match(source, /gpu\?\.unavailablePassCount !== 0/);
  assert.match(source, /gpu\?\.framesCaptured !== requestedGpuFrames/);
  assert.match(source, /gpu\?\.activeGpu\?\.samples !== requestedGpuFrames/);
  assert.match(source, /gpu\?\.activeGpu\?\.meanMs > 0/);
  assert.match(source, /frameTiming\?\.evaluatorFramesPresented >= requestedFrameTiming/);
  assert.match(source, /cpu\?\.taskDurationMsPerFrame > 0/);
  assert.match(source, /terrainClearance\?\.camera, pose\.lift/);
  assert.match(source, /resolvedCamera\?\.owned !== true/);
  assert.match(source, /scene\?\.constructor !== 'CreatorScene'/);
  assert.match(source, /routeSha256: routeHash/);
  assert.match(source, /--terrain-lift-to=/);
  assert.match(source, /--seq=/);
  assert.match(source, /renderer: 'strict-webgpu'/);
  assert.match(source, /summary\.json/);
  assert.equal((source.match(/name: 'h[123]-/g) ?? []).length, 13);
});
