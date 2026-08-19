#!/usr/bin/env node
// Gate a baked tree impostor atlas before it can be promoted into the catalog.
//
// Every failure this checks for actually shipped at some point:
//   * an EMPTY canopy — a generated Blender image packed without a real encode
//     embeds as transparent black, so the tree bakes to a bare stem;
//   * a WRONG-COLOUR canopy — wiring a BlenderKit needle texture straight into
//     Base Color drops the node graph's hue/translucency and bakes dusty pink;
//   * a FLAT cutout cone — a source whose foliage is one untextured mass bakes
//     to a solid silhouette with no internal structure, which reads as cardboard;
//   * a CLONED silhouette — every azimuth frame identical means the multi-view
//     bake never rotated the camera, and the card will swim as the camera orbits.
//
// Usage: node scripts/qa_tree_impostor.mjs <impostor.png> [more.png ...]
// Prints one JSON report per atlas and exits non-zero if any atlas fails.

import { readFileSync, existsSync } from 'node:fs';
import { decodePNG } from './lib/png.mjs';

// Coverage is the share of a frame the silhouette fills. Below the floor the
// canopy is missing; above the ceiling the bake is a filled block, not a tree.
const COVERAGE_MIN = 0.06;
const COVERAGE_MAX = 0.80;
// Azimuth frames of a real tree differ; identical frames mean a broken bake.
const FRAME_COVERAGE_SPREAD_MIN = 0.002;
// Foliage and bark are warm-to-green. Neither is ever blue-dominant, and a
// green channel far below red is the pink-needle failure. An autumn species is
// legitimately red-dominant, so its floor only has to exclude pink and grey.
const GREEN_TO_RED_FLOOR = { conifer: 0.85, autumn: 0.60 };
// A canopy this dark is not a lighting choice; the atlas encode failed.
const MIN_LUMINANCE = 8;
// A silhouette with almost no internal colour variation is a flat cutout.
const FLAT_FRACTION_MAX = 0.90;
const FLAT_TOLERANCE = 6;      // sRGB levels around the mean
const ALPHA_OPAQUE = 128;

function layout(pngPath, width, height) {
  const sidecar = pngPath.replace(/\.png$/, '.json');
  if (existsSync(sidecar)) {
    const meta = JSON.parse(readFileSync(sidecar, 'utf8'));
    if (meta.columns && meta.rows && meta.frameSize) {
      return { columns: meta.columns, rows: meta.rows, frameSize: meta.frameSize };
    }
  }
  // The baked-atlas contract in the environment catalog is a 4x2 grid.
  return { columns: 4, rows: 2, frameSize: Math.round(width / 4) };
}

function analyse(pngPath, palette) {
  const { width, height, channels, pixels } = decodePNG(readFileSync(pngPath));
  if (channels !== 4) throw new Error(`${pngPath}: atlas must carry alpha (RGBA)`);
  const { columns, rows, frameSize } = layout(pngPath, width, height);
  if (columns * frameSize !== width || rows * frameSize !== height) {
    throw new Error(`${pngPath}: ${width}x${height} does not match ${columns}x${rows} frames of ${frameSize}`);
  }

  const coverages = [];
  let r = 0, g = 0, b = 0, opaque = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let frameOpaque = 0;
      for (let y = 0; y < frameSize; y++) {
        const base = ((row * frameSize + y) * width + column * frameSize) * channels;
        for (let x = 0; x < frameSize; x++) {
          const i = base + x * channels;
          if (pixels[i + 3] < ALPHA_OPAQUE) continue;
          frameOpaque++;
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        }
      }
      coverages.push(frameOpaque / (frameSize * frameSize));
      opaque += frameOpaque;
    }
  }
  if (opaque === 0) {
    return { file: pngPath, width, height, columns, rows, frameSize, coverage: 0, failures: ['atlas is fully transparent'] };
  }

  const mean = [r / opaque, g / opaque, b / opaque];
  // Second pass: how much of the silhouette sits within a hair of the mean.
  let flat = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    if (pixels[i + 3] < ALPHA_OPAQUE) continue;
    if (Math.abs(pixels[i] - mean[0]) <= FLAT_TOLERANCE
      && Math.abs(pixels[i + 1] - mean[1]) <= FLAT_TOLERANCE
      && Math.abs(pixels[i + 2] - mean[2]) <= FLAT_TOLERANCE) flat++;
  }

  const coverage = opaque / (width * height);
  const spread = Math.max(...coverages) - Math.min(...coverages);
  const flatFraction = flat / opaque;
  const failures = [];
  const minCoverage = Math.min(...coverages);
  const maxCoverage = Math.max(...coverages);
  if (minCoverage < COVERAGE_MIN) failures.push(`frame coverage ${(minCoverage * 100).toFixed(1)}% below ${COVERAGE_MIN * 100}% — canopy is missing or nearly empty`);
  if (maxCoverage > COVERAGE_MAX) failures.push(`frame coverage ${(maxCoverage * 100).toFixed(1)}% above ${COVERAGE_MAX * 100}% — silhouette is a filled block`);
  if (spread < FRAME_COVERAGE_SPREAD_MIN) failures.push(`azimuth frames vary by only ${(spread * 100).toFixed(2)}% — the multi-view bake did not rotate`);
  const luminance = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
  if (luminance < MIN_LUMINANCE) failures.push(`canopy luminance ${luminance.toFixed(1)} — the atlas baked black (usually an image packed without a real encode)`);
  if (mean[2] > mean[0] && mean[2] > mean[1]) failures.push(`blue-dominant canopy mean ${mean.map((v) => v.toFixed(1)).join(',')} — foliage lost its authored hue`);
  const floor = GREEN_TO_RED_FLOOR[palette];
  if (mean[1] < mean[0] * floor) failures.push(`green/red ratio ${(mean[1] / mean[0]).toFixed(2)} below ${floor} for a ${palette} canopy — raw base-colour texture instead of the baked node graph`);
  if (flatFraction > FLAT_FRACTION_MAX) failures.push(`${(flatFraction * 100).toFixed(1)}% of the silhouette is one flat colour — cardboard cutout, no internal structure`);

  return {
    file: pngPath,
    width, height, columns, rows, frameSize,
    coverage: Number(coverage.toFixed(4)),
    frameCoverage: coverages.map((value) => Number(value.toFixed(4))),
    meanSrgb: mean.map((value) => Number(value.toFixed(1))),
    greenToRed: Number((mean[1] / mean[0]).toFixed(3)),
    flatFraction: Number(flatFraction.toFixed(3)),
    failures,
  };
}

const argv = process.argv.slice(2);
const paletteArg = argv.indexOf('--palette');
const palette = paletteArg === -1 ? 'conifer' : argv[paletteArg + 1];
const inputs = paletteArg === -1
  ? argv
  : argv.filter((value, index) => index !== paletteArg && index !== paletteArg + 1);
if (!inputs.length || !GREEN_TO_RED_FLOOR[palette]) {
  console.error(`usage: node scripts/qa_tree_impostor.mjs [--palette ${Object.keys(GREEN_TO_RED_FLOOR).join('|')}] <impostor.png> [more.png ...]`);
  process.exit(2);
}
let failed = 0;
for (const input of inputs) {
  let report;
  try {
    report = analyse(input, palette);
  } catch (error) {
    report = { file: input, failures: [error.message] };
  }
  if (report.failures.length) failed++;
  console.log(JSON.stringify(report));
  for (const failure of report.failures) console.log(`  FAIL ${failure}`);
}
process.exit(failed ? 1 : 0);
