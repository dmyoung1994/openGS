// Minimal PNG codec for the texture-bake and renderer-QA scripts.
//
// The bakes write 2048^2 RGB/RGBA buffers and nothing else, so a dependency-free
// 40-line encoder beats pulling in an image library. It lived copy-pasted in
// gen_turf_detail.mjs and gen_bunker_sand.mjs; a third copy for the rough bake was
// the point at which it had to become a module.
//
// 8-bit, no interlace, filter type 0 (none) on every row — the data is noisy texture,
// so the adaptive filters buy little and cost a pass.
import { deflateSync, inflateSync } from 'node:zlib';

// Chrome screenshots are 8-bit RGB/RGBA, non-interlaced PNGs. Decode every PNG
// filter type so renderer probes inspect the screenshot bytes Chrome actually
// presents rather than attempting an invalid 2D readback of the WebGPU canvas.
export function decodePNG(bytes) {
  const b = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 33 || !b.subarray(0, 8).equals(signature)
    || b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Invalid PNG signature or IHDR');
  }
  const bitDepth = b[24], colorType = b[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)
    || b[26] !== 0 || b[27] !== 0 || b[28] !== 0) {
    throw new Error(`Unsupported PNG format: depth=${bitDepth}, color=${colorType}, interlace=${b[28]}`);
  }
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('Invalid PNG dimensions');
  const channels = colorType === 6 ? 4 : 3;
  let offset = 8;
  const idat = [];
  while (offset < b.length) {
    const length = b.readUInt32BE(offset);
    if (b.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      idat.push(b.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  if (idat.length === 0) throw new Error('PNG has no IDAT data');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('Unexpected PNG scanline length');
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++];
    const line = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous ? previous[i] : 0;
      const upperLeft = previous && i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const prediction = left + up - upperLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upperLeftDistance = Math.abs(prediction - upperLeft);
        value += leftDistance <= upDistance && leftDistance <= upperLeftDistance
          ? left : (upDistance <= upperLeftDistance ? up : upperLeft);
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }
      current[i] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), body])), body.length + 8);
  return out;
}

// ch: 3 = RGB, 4 = RGBA. `data` is tightly packed w*h*ch bytes.
export function png(w, h, ch, data) {
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                          // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = ch === 3 ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 8 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
