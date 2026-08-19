// Dependency-free PNG comparison for fixed-camera renderer captures.
// Reports full-resolution error plus block-averaged low-frequency error so animated
// grass edges do not hide broad exposure, grading, fog, or post-processing changes.
import { readFile } from 'node:fs/promises';
import { decodePNG } from './lib/png.mjs';

const argv = process.argv.slice(2);
const [referencePath, candidatePath] = argv;
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be non-negative`);
  return value;
};
const thresholds = {
  meanAbsoluteRgbError: option('max-mae'),
  meanAbsoluteLumaError: option('max-luma-mae'),
  pixelsOver8Pct: option('max-changed-pct'),
  block16MeanAbsoluteRgbError: option('max-block-mae'),
};
if (!referencePath || !candidatePath) {
  throw new Error('Usage: node scripts/compare-render-images.mjs REFERENCE.png CANDIDATE.png');
}

const reference = decodePNG(await readFile(referencePath));
const candidate = decodePNG(await readFile(candidatePath));
if (reference.width !== candidate.width || reference.height !== candidate.height) {
  throw new Error(`Image sizes differ: ${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}`);
}

const pixel = (image, x, y, channel) =>
  image.pixels[(y * image.width + x) * image.channels + channel];
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

let absSum = 0;
let squaredSum = 0;
let lumaAbsSum = 0;
let pixelsOver8 = 0;
const pixelCount = reference.width * reference.height;
for (let y = 0; y < reference.height; y++) {
  for (let x = 0; x < reference.width; x++) {
    let pixelMax = 0;
    const ref = [0, 0, 0];
    const next = [0, 0, 0];
    for (let channel = 0; channel < 3; channel++) {
      ref[channel] = pixel(reference, x, y, channel);
      next[channel] = pixel(candidate, x, y, channel);
      const delta = Math.abs(ref[channel] - next[channel]);
      absSum += delta;
      squaredSum += delta * delta;
      pixelMax = Math.max(pixelMax, delta);
    }
    lumaAbsSum += Math.abs(luma(...ref) - luma(...next));
    if (pixelMax > 8) pixelsOver8++;
  }
}

const blockSize = 16;
let blockAbsSum = 0;
let blockChannels = 0;
for (let by = 0; by < reference.height; by += blockSize) {
  for (let bx = 0; bx < reference.width; bx += blockSize) {
    const maxY = Math.min(by + blockSize, reference.height);
    const maxX = Math.min(bx + blockSize, reference.width);
    const count = (maxY - by) * (maxX - bx);
    for (let channel = 0; channel < 3; channel++) {
      let refSum = 0;
      let nextSum = 0;
      for (let y = by; y < maxY; y++) {
        for (let x = bx; x < maxX; x++) {
          refSum += pixel(reference, x, y, channel);
          nextSum += pixel(candidate, x, y, channel);
        }
      }
      blockAbsSum += Math.abs(refSum / count - nextSum / count);
      blockChannels++;
    }
  }
}

const sampleCount = pixelCount * 3;
const mse = squaredSum / sampleCount;
const report = {
  reference: referencePath,
  candidate: candidatePath,
  size: [reference.width, reference.height],
  meanAbsoluteRgbError: absSum / sampleCount,
  rootMeanSquareRgbError: Math.sqrt(mse),
  psnrDb: mse === 0 ? null : 10 * Math.log10(255 * 255 / mse),
  meanAbsoluteLumaError: lumaAbsSum / pixelCount,
  pixelsOver8Pct: 100 * pixelsOver8 / pixelCount,
  block16MeanAbsoluteRgbError: blockAbsSum / blockChannels,
};

const failures = Object.entries(thresholds)
  .filter(([, threshold]) => threshold !== null)
  .filter(([metric, threshold]) => report[metric] > threshold)
  .map(([metric, threshold]) => `${metric} ${report[metric]} > ${threshold}`);
report.thresholds = thresholds;
report.passed = failures.length === 0;
report.failures = failures;

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
