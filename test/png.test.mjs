import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePNG, png } from '../scripts/lib/png.mjs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), data.length + 8);
  return out;
};
const paeth = (left, up, upperLeft) => {
  const prediction = left + up - upperLeft;
  const dl = Math.abs(prediction - left), du = Math.abs(prediction - up), dul = Math.abs(prediction - upperLeft);
  return dl <= du && dl <= dul ? left : (du <= dul ? up : upperLeft);
};

function fixture(width, height, channels, pixels, filters, splitIdat = false) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const source = pixels[y * stride + i];
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upperLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? ((left + up) >> 1) : paeth(left, up, upperLeft);
      raw[y * (stride + 1) + i + 1] = (source - prediction) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  const compressed = deflateSync(raw);
  const idat = splitIdat
    ? [chunk('IDAT', compressed.subarray(0, compressed.length >> 1)), chunk('IDAT', compressed.subarray(compressed.length >> 1))]
    : [chunk('IDAT', compressed)];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), ...idat, chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG codec round-trips renderer probe pixels', () => {
  const source = Buffer.from([
    1, 2, 3, 4, 5, 6,
    7, 8, 9, 10, 11, 12,
  ]);
  const decoded = decodePNG(png(2, 2, 3, source));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 3);
  assert.deepEqual(decoded.pixels, source);
});

test('PNG decoder handles filters 0 through 4', () => {
  const pixels = Buffer.from(Array.from({ length: 3 * 5 * 3 }, (_, i) => (i * 37 + 11) & 255));
  const decoded = decodePNG(fixture(3, 5, 3, pixels, [0, 1, 2, 3, 4]));
  assert.deepEqual(decoded.pixels, pixels);
});

test('PNG decoder handles RGBA and split IDAT chunks', () => {
  const pixels = Buffer.from(Array.from({ length: 4 * 3 * 4 }, (_, i) => (i * 19 + 7) & 255));
  const decoded = decodePNG(fixture(4, 3, 4, pixels, [4, 2, 1], true));
  assert.equal(decoded.channels, 4);
  assert.deepEqual(decoded.pixels, pixels);
});

test('PNG decoder rejects unsupported or malformed screenshots', () => {
  const valid = png(1, 1, 3, Buffer.from([1, 2, 3]));
  const badSignature = Buffer.from(valid); badSignature[0] = 0;
  const badDepth = Buffer.from(valid); badDepth[24] = 16;
  const interlaced = Buffer.from(valid); interlaced[28] = 1;
  assert.throws(() => decodePNG(badSignature), /Invalid PNG/);
  assert.throws(() => decodePNG(badDepth), /Unsupported PNG/);
  assert.throws(() => decodePNG(interlaced), /Unsupported PNG/);
});
