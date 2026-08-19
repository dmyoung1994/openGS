import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadSkyManifest, validateSkyManifest } from '../src/scene/SkyManifest.js';

function decodeBrightestRadiance(buffer) {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  const readLine = () => {
    const start = offset;
    while (offset < bytes.length && bytes[offset++] !== 10) {}
    return new TextDecoder().decode(bytes.slice(start, offset - 1));
  };
  if (readLine() !== '#?RADIANCE') throw new Error('Expected Radiance HDR header.');
  let line;
  while (offset < bytes.length && (line = readLine()) !== '') {}
  // Radiance terminates metadata with a blank line, then writes the
  // orientation/dimensions record directly before the scanline payload.
  const dimensions = readLine().match(/^-Y\s+(\d+)\s+\+X\s+(\d+)$/);
  const height = dimensions ? Number(dimensions[1]) : 0;
  const width = dimensions ? Number(dimensions[2]) : 0;
  if (!width || !height) throw new Error('Radiance dimensions missing.');
  const scanline = new Uint8Array(width * 4);
  let brightest = { luminance: -Infinity, x: 0, y: 0 };
  for (let y = 0; y < height; y++) {
    if (bytes[offset++] !== 2 || bytes[offset++] !== 2) throw new Error('Only RLE Radiance scanlines are supported.');
    const scanWidth = (bytes[offset++] << 8) | bytes[offset++];
    if (scanWidth !== width) throw new Error('Radiance scanline width mismatch.');
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        const count = bytes[offset++];
        if (count > 128) {
          const length = count - 128;
          const value = bytes[offset++];
          scanline.fill(value, channel * width + x, channel * width + x + length);
          x += length;
        } else {
          scanline.set(bytes.subarray(offset, offset + count), channel * width + x);
          offset += count;
          x += count;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      const exponent = scanline[3 * width + x];
      if (!exponent) continue;
      const scale = 2 ** (exponent - 128 - 8);
      const luminance = (0.2126 * scanline[x] + 0.7152 * scanline[width + x]
        + 0.0722 * scanline[2 * width + x]) * scale;
      if (luminance > brightest.luminance) brightest = { luminance, x, y };
    }
  }
  const u = (brightest.x + 0.5) / width;
  // HDRLoader returns flipY=true. EquirectUV's v=0 is the bottom of the
  // uploaded image, so invert the Radiance top-down row before decoding phi.
  const v = 1 - (brightest.y + 0.5) / height;
  const theta = (u - 0.5) * Math.PI * 2;
  const phi = (v - 0.5) * Math.PI;
  const cosPhi = Math.cos(phi);
  return {
    direction: [cosPhi * Math.cos(theta), Math.sin(phi), cosPhi * Math.sin(theta)],
    pixel: [brightest.x, brightest.y],
    luminance: brightest.luminance,
  };
}

test('Poly Haven sky manifest is bounded, local, and provenance-complete', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/sky-manifest.json', import.meta.url), 'utf8'));
  const validated = validateSkyManifest(manifest);
  assert.equal(validated.license, 'CC0');
  assert.equal(validated.md5, '5abfeb43c4d60566973da21483e8cfbd');
  assert.deepEqual(validated.resolution, [2048, 1024]);
  assert.deepEqual(validated.sourceSunDirection, [0.599337, 0.670422, 0.437413]);
  assert.match(validated.url, /^\/assets\/environment\/.*\.hdr$/);
  assert.equal(validated.authors.length, 1);
  // Offline luminance analysis finds the source sun at this unit direction.
  // The manifest yaw must rotate it onto the authoritative game sun rather than
  // merely providing an arbitrary aesthetic environment rotation.
  const sourceSun = validated.sourceSunDirection;
  const gameSun = [-0.72, 0.60, -0.32];
  const c = Math.cos(validated.rotationRadians);
  const s = Math.sin(validated.rotationRadians);
  const rotated = [
    c * sourceSun[0] + s * sourceSun[2],
    sourceSun[1],
    c * sourceSun[2] - s * sourceSun[0],
  ];
  const length = (v) => Math.hypot(...v);
  const alignment = rotated.reduce((sum, value, index) => sum + value * gameSun[index], 0)
    / (length(rotated) * length(gameSun));
  assert.ok(alignment > 0.97, `HDR sun alignment ${alignment} is inconsistent with game daylight`);
  const sourceHorizontal = [validated.sourceSunDirection[0], validated.sourceSunDirection[2]];
  const gameHorizontal = [gameSun[0], gameSun[2]];
  const horizontalAlignment = (rotated[0] * gameSun[0] + rotated[2] * gameSun[2])
    / (Math.hypot(...sourceHorizontal) * Math.hypot(...gameHorizontal));
  assert.ok(horizontalAlignment > 0.999, `HDR source azimuth alignment ${horizontalAlignment} is inconsistent with game daylight`);
});

test('Poly Haven sky HDR matches the pinned repository hash', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/sky-manifest.json', import.meta.url), 'utf8'));
  const bytes = await readFile(new URL(`../public/${manifest.url.slice(1)}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.ok(bytes.byteLength < 8_000_000, '2K HDR must remain a bounded static asset');
});

test('manifest source direction is measured from the shipped Radiance pixels', async () => {
  const manifest = validateSkyManifest(JSON.parse(await readFile(
    new URL('../public/assets/environment/sky-manifest.json', import.meta.url), 'utf8',
  )));
  const bytes = await readFile(new URL(`../public/${manifest.url.slice(1)}`, import.meta.url));
  const brightest = decodeBrightestRadiance(bytes);
  const alignment = brightest.direction.reduce((sum, value, index) => (
    sum + value * manifest.sourceSunDirection[index]
  ), 0);
  assert.ok(alignment > 0.995, `measured HDR source direction drifted: ${alignment}`);
  assert.ok(brightest.luminance > 1000, 'HDR source sun was not detected as a high-energy pixel');
});

test('sky manifest loader fails closed on a changed local descriptor', async () => {
  await assert.rejects(() => loadSkyManifest('/sky.json', async () => ({ ok: true, async json() { return { version: 2 }; } })), /version/);
});

test('sky manifest rejects an unmeasured or non-unit source sun direction', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/assets/environment/sky-manifest.json', import.meta.url), 'utf8'));
  assert.throws(() => validateSkyManifest({ ...manifest, sourceSunDirection: [0, 0, 0] }), /unit length/);
});
