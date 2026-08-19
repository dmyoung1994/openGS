// Localize adjacent-frame instability in renderer captures. Bright red marks pixels
// whose largest RGB-channel delta exceeds 8; amber shows smaller reconstruction error.
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { decodePNG } from './lib/png.mjs';

const [referencePath, candidatePath, outputPath] = process.argv.slice(2);
if (!referencePath || !candidatePath || !outputPath) {
  throw new Error('Usage: node scripts/temporal-heatmap.mjs REFERENCE.png CANDIDATE.png OUTPUT.png');
}
const reference = decodePNG(await readFile(referencePath));
const candidate = decodePNG(await readFile(candidatePath));
if (reference.width !== candidate.width || reference.height !== candidate.height) {
  throw new Error('Capture dimensions differ.');
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let c = value;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, checksum]);
};
const { width, height } = reference;
const raw = Buffer.alloc(height * (width * 3 + 1));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const pixel = y * width + x;
    const a = pixel * reference.channels;
    const b = pixel * candidate.channels;
    const delta = Math.max(
      Math.abs(reference.pixels[a] - candidate.pixels[b]),
      Math.abs(reference.pixels[a + 1] - candidate.pixels[b + 1]),
      Math.abs(reference.pixels[a + 2] - candidate.pixels[b + 2]),
    );
    const value = Math.min(255, delta * 8);
    const out = y * (width * 3 + 1) + 1 + x * 3;
    raw[out] = value;
    raw[out + 1] = Math.max(0, value - 128) * 0.45;
    raw[out + 2] = 0;
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
header[8] = 8; header[9] = 2;
await writeFile(outputPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote ${outputPath}`);
