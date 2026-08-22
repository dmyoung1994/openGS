#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';
import { decodePNG, png } from '../../scripts/lib/png.mjs';

const PROCESSOR_SCHEMA_VERSION = 2;
const PACK_SCHEMA_VERSION = 1;
const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || !argv[i + 1]) throw new Error(`Malformed argument ${argv[i] ?? '<empty>'}`);
    values[key] = argv[i + 1];
  }
  if (!values.config || !values.output) {
    throw new Error('Usage: process-source.mjs --config species/config.json --output out-dir [--input source.png]');
  }
  return values;
}

function strictConfig(raw, configPath) {
  if (!raw || raw.schemaVersion !== 1 || raw.processorVersion !== 'foliage-pipeline-v3') {
    throw new Error(`${configPath}: unsupported foliage species configuration`);
  }
  if (!/^[a-z][a-z0-9.-]{5,95}$/.test(raw.foliageAlias || '')) throw new Error(`${configPath}: invalid foliageAlias`);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(raw.species?.id || '')) throw new Error(`${configPath}: invalid species.id`);
  const layout = raw.source?.layout;
  const roles = raw.source?.roles;
  if (!Number.isInteger(layout?.columns) || !Number.isInteger(layout?.rows)
    || layout.columns < 1 || layout.rows < 1 || layout.columns * layout.rows !== roles?.length) {
    throw new Error(`${configPath}: layout must exactly match source.roles`);
  }
  if (layout.mode !== 'components-2x4') throw new Error(`${configPath}: unsupported source.layout.mode`);
  if (!/^[a-f0-9]{64}$/.test(raw.source?.sha256 || '')) throw new Error(`${configPath}: source.sha256 is required`);
  const names = new Set();
  for (const [index, role] of roles.entries()) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(role.name || '') || names.has(role.name)) {
      throw new Error(`${configPath}: invalid or duplicate source.roles[${index}].name`);
    }
    names.add(role.name);
    if (!['outer', 'sparse', 'medium', 'dense'].includes(role.density)) throw new Error(`${configPath}: invalid density for ${role.name}`);
    if (!['left', 'right', 'bottom', 'top'].includes(role.baseEdge)) throw new Error(`${configPath}: invalid baseEdge for ${role.name}`);
    for (const key of ['attachmentUv', 'tipUv']) {
      if (role[key] !== undefined && (!Array.isArray(role[key]) || role[key].length !== 2
        || role[key].some((value) => !Number.isFinite(value) || value < 0 || value > 1))) {
        throw new Error(`${configPath}: invalid ${key} for ${role.name}`);
      }
    }
    if ((role.attachmentUv === undefined) !== (role.tipUv === undefined)) {
      throw new Error(`${configPath}: ${role.name} must declare attachmentUv and tipUv together`);
    }
    if (!Array.isArray(role.lodUse) || !role.lodUse.length || role.lodUse.some((lod) => ![0, 1, 2].includes(lod))) {
      throw new Error(`${configPath}: invalid lodUse for ${role.name}`);
    }
  }
  if (!['CC0-1.0'].includes(raw.structuralMaterial?.license)
    || !/^https:\/\//.test(raw.structuralMaterial?.source || '')
    || !Array.isArray(raw.structuralMaterial?.textures)
    || raw.structuralMaterial.textures.length !== 3) {
    throw new Error(`${configPath}: structuralMaterial must declare three verified CC0 textures`);
  }
  const materialRoles = new Set();
  for (const textureRecord of raw.structuralMaterial.textures) {
    if (!['albedo', 'normal', 'arm'].includes(textureRecord.role) || materialRoles.has(textureRecord.role)
      || !/^[a-z0-9][a-z0-9.-]*$/i.test(textureRecord.output || '')
      || !/^[a-f0-9]{64}$/.test(textureRecord.sha256 || '')) {
      throw new Error(`${configPath}: malformed structuralMaterial texture record`);
    }
    materialRoles.add(textureRecord.role);
  }
  const processing = raw.processing;
  for (const key of ['atlasSize', 'atlasPadding', 'alphaCleanupThreshold', 'coverageThreshold', 'rgbDilationRadius', 'trimPadding', 'minimumCellSeparationPixels', 'maximumMipCoverageDrift', 'maximumTransparentOverdraw']) {
    if (!Number.isFinite(processing?.[key])) throw new Error(`${configPath}: processing.${key} is required`);
  }
  return raw;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function configRelativeReference(value) {
  return `config-relative:${String(value).replaceAll('\\', '/')}`;
}

function cleanAlpha(pixels, threshold) {
  for (let i = 3; i < pixels.length; i += 4) {
    const alpha = pixels[i];
    pixels[i] = alpha <= threshold ? 0 : Math.min(255, Math.round((alpha - threshold) * 255 / (255 - threshold)));
  }
}

function cropCell(source, column, row, layout, processing) {
  const cellW = Math.floor(source.width / layout.columns);
  const cellH = Math.floor(source.height / layout.rows);
  const x0 = column * cellW;
  const y0 = row * cellH;
  let minX = cellW, minY = cellH, maxX = -1, maxY = -1;
  for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) {
    const alpha = source.pixels[((y0 + y) * source.width + x0 + x) * 4 + 3];
    if (alpha < processing.coverageThreshold) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error(`No foliage coverage found in cell ${column},${row}`);
  const separation = processing.minimumCellSeparationPixels;
  if (minX < separation || minY < separation || maxX >= cellW - separation || maxY >= cellH - separation) {
    throw new Error(`Cell ${column},${row} foliage touches its separation boundary (possible overlap or crop)`);
  }
  minX = Math.max(0, minX - processing.trimPadding);
  minY = Math.max(0, minY - processing.trimPadding);
  maxX = Math.min(cellW - 1, maxX + processing.trimPadding);
  maxY = Math.min(cellH - 1, maxY + processing.trimPadding);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + minY + y) * source.width + x0 + minX) * 4;
    source.pixels.copy(pixels, y * width * 4, from, from + width * 4);
  }
  return { width, height, pixels, sourceBounds: { x: x0 + minX, y: y0 + minY, width, height } };
}

function extractSheetComponents(source, layout, processing) {
  const { width, height, pixels } = source;
  const seen = new Uint8Array(width * height);
  const components = [];
  const threshold = processing.coverageThreshold;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const start = y * width + x;
    if (seen[start] || pixels[start * 4 + 3] < threshold) continue;
    const queue = [start];
    seen[start] = 1;
    let cursor = 0, size = 0, minX = width, minY = height, maxX = -1, maxY = -1;
    while (cursor < queue.length) {
      const index = queue[cursor++];
      const px = index % width;
      const py = Math.floor(index / width);
      size++;
      minX = Math.min(minX, px); minY = Math.min(minY, py);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = px + ox, ny = py + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (seen[neighbor] || pixels[neighbor * 4 + 3] < threshold) continue;
        seen[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    if (size >= 256) components.push({ size, minX, minY, maxX, maxY, pixelIndices: queue });
  }
  components.sort((a, b) => b.size - a.size);
  const required = layout.columns * layout.rows;
  if (components.length < required) throw new Error(`Source has only ${components.length}/${required} substantial separated clusters`);
  const selected = components.slice(0, required);
  const nextLargest = components[required]?.size ?? 0;
  const smallestSelected = selected.at(-1).size;
  if (nextLargest > smallestSelected * 0.12) {
    throw new Error(`Source has an ambiguous ninth component (${nextLargest} pixels versus ${smallestSelected} selected)`);
  }
  const separation = processing.minimumCellSeparationPixels;
  for (const [index, component] of selected.entries()) {
    if (component.minX < separation || component.minY < separation
      || component.maxX >= width - separation || component.maxY >= height - separation) {
      throw new Error(`Cluster component ${index} touches the source boundary`);
    }
  }
  // Organic sprays can have overlapping axis-aligned bounds while remaining well
  // separated (for example a tall tip beside a broad lower branch). Measure the
  // actual alpha components instead of rejecting that valid silhouette geometry.
  const componentLabels = new Int16Array(width * height);
  componentLabels.fill(-1);
  selected.forEach((component, label) => {
    for (const index of component.pixelIndices) componentLabels[index] = label;
  });
  const separationRadius = separation - 1;
  for (let label = 0; label < selected.length; label++) {
    for (const index of selected[label].pixelIndices) {
      const px = index % width;
      const py = Math.floor(index / width);
      const minY = Math.max(0, py - separationRadius);
      const maxY = Math.min(height - 1, py + separationRadius);
      const minX = Math.max(0, px - separationRadius);
      const maxX = Math.min(width - 1, px + separationRadius);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const neighborLabel = componentLabels[y * width + x];
        if (neighborLabel >= 0 && neighborLabel !== label) {
          throw new Error(`Cluster components ${label} and ${neighborLabel} are closer than ${separation} pixels`);
        }
      }
    }
  }
  selected.sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY));
  const ordered = [];
  for (let row = 0; row < layout.rows; row++) {
    ordered.push(...selected.slice(row * layout.columns, (row + 1) * layout.columns)
      .sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX)));
  }
  return ordered.map((component) => {
    const minX = Math.max(0, component.minX - processing.trimPadding);
    const minY = Math.max(0, component.minY - processing.trimPadding);
    const maxX = Math.min(width - 1, component.maxX + processing.trimPadding);
    const maxY = Math.min(height - 1, component.maxY + processing.trimPadding);
    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;
    const cropPixels = Buffer.alloc(cropWidth * cropHeight * 4);
    // The selected high-confidence component defines this card. Copying its full
    // axis-aligned crop used to retain unrelated flecks that happened to fall
    // inside that rectangle. Flood through every non-zero antialiased edge texel
    // from the selected component, then copy only that connected silhouette.
    const retained = new Uint8Array(width * height);
    const queue = [...component.pixelIndices];
    for (const index of queue) retained[index] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      const px = index % width, py = Math.floor(index / width);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = px + ox, ny = py + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (retained[neighbor] || pixels[neighbor * 4 + 3] === 0) continue;
        retained[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
      const sourceIndex = (minY + y) * width + minX + x;
      if (!retained[sourceIndex]) continue;
      const from = sourceIndex * 4;
      pixels.copy(cropPixels, (y * cropWidth + x) * 4, from, from + 4);
    }
    return { width: cropWidth, height: cropHeight, pixels: cropPixels,
      sourceBounds: { x: minX, y: minY, width: cropWidth, height: cropHeight }, componentPixels: component.size };
  });
}

function dilateTransparentRgb(image, radius) {
  const { width, height, pixels } = image;
  let filled = new Uint8Array(width * height);
  for (let p = 0; p < filled.length; p++) filled[p] = pixels[p * 4 + 3] > 0 ? 1 : 0;
  for (let step = 0; step < radius; step++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (filled[p]) continue;
      let donor = -1;
      for (let oy = -1; oy <= 1 && donor < 0; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const q = ny * width + nx;
        if (filled[q]) { donor = q; break; }
      }
      if (donor < 0) continue;
      pixels[p * 4] = pixels[donor * 4];
      pixels[p * 4 + 1] = pixels[donor * 4 + 1];
      pixels[p * 4 + 2] = pixels[donor * 4 + 2];
      next[p] = 1;
    }
    filled = next;
  }
}

function packShelves(images, size, gutter) {
  const ordered = images.map((image, index) => ({ image, index })).sort((a, b) => b.image.height - a.image.height);
  let x = gutter, y = gutter, shelfH = 0;
  const placements = Array(images.length);
  for (const item of ordered) {
    const width = item.image.width + gutter * 2;
    const height = item.image.height + gutter * 2;
    if (x + width > size) { x = gutter; y += shelfH; shelfH = 0; }
    if (y + height > size) throw new Error(`Extracted foliage does not fit ${size}x${size} atlas`);
    placements[item.index] = { x: x + gutter, y: y + gutter, width: item.image.width, height: item.image.height };
    x += width; shelfH = Math.max(shelfH, height);
  }
  return placements;
}

function blit(target, targetWidth, source, placement) {
  for (let y = 0; y < source.height; y++) {
    source.pixels.copy(target, ((placement.y + y) * targetWidth + placement.x) * 4,
      y * source.width * 4, (y + 1) * source.width * 4);
  }
}

function buildMaterialMask(atlas) {
  const out = Buffer.alloc(atlas.length);
  for (let i = 0; i < atlas.length; i += 4) {
    const red = atlas[i], green = atlas[i + 1], blue = atlas[i + 2], alpha = atlas[i + 3];
    if (alpha === 0) continue;
    const luminance = (red * 54 + green * 183 + blue * 19) / 256;
    const greenDominance = Math.max(0, green - Math.max(red, blue));
    out[i] = Math.round(Math.max(184, Math.min(224, 218 - luminance * 0.10)));
    out[i + 1] = Math.round(Math.min(255, 72 + greenDominance * 1.55));
    out[i + 2] = alpha;
    out[i + 3] = alpha;
  }
  return out;
}

function alphaMetrics(pixels, threshold) {
  let covered = 0, alphaSum = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] >= threshold) covered++;
    alphaSum += pixels[i];
  }
  const texels = pixels.length / 4;
  return { thresholdCoverage: covered / texels, meanAlpha: alphaSum / (texels * 255) };
}

function convexHull(points) {
  const unique = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (origin, a, b) => (a[0] - origin[0]) * (b[1] - origin[1])
    - (a[1] - origin[1]) * (b[0] - origin[0]);
  const half = (ordered) => {
    const result = [];
    for (const point of ordered) {
      while (result.length >= 2 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  return [...half(unique).slice(0, -1), ...half([...unique].reverse()).slice(0, -1)];
}

function supportHullUv(image, threshold, sectors = 12) {
  const points = [];
  let centerX = 0, centerY = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.pixels[(y * image.width + x) * 4 + 3] < threshold) continue;
    const u = x / Math.max(1, image.width - 1);
    const v = 1 - y / Math.max(1, image.height - 1);
    points.push([u, v]); centerX += u; centerY += v;
  }
  if (points.length < sectors) throw new Error('Cluster has insufficient alpha support for a card hull');
  centerX /= points.length; centerY /= points.length;
  const directionalExtrema = [];
  for (let sector = 0; sector < sectors; sector++) {
    const angle = sector / sectors * Math.PI * 2;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let best = points[0], bestProjection = -Infinity;
    for (const point of points) {
      const projection = (point[0] - centerX) * dx + (point[1] - centerY) * dy;
      if (projection > bestProjection) { bestProjection = projection; best = point; }
    }
    directionalExtrema.push(best);
  }
  // Directional extrema are efficient, but their sector order can contain a
  // repeated or slightly concave turn. A triangle fan over that sequence then
  // crosses the alpha support and appears as a black wedge at oblique angles.
  // The monotonic hull makes the runtime fan simple, convex, and consistently
  // wound while retaining the same bounded support points.
  const hull = convexHull(directionalExtrema);
  if (hull.length < 6) throw new Error('Cluster alpha support produced a malformed card hull');
  return hull.map(([u, v]) => [Number(u.toFixed(6)), Number(v.toFixed(6))]);
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], next = points[(index + 1) % points.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return Math.abs(twiceArea) * 0.5;
}

function attachmentFrame(hull, role) {
  if (!role.attachmentUv) return null;
  const [baseU, baseV] = role.attachmentUv;
  const dx = role.tipUv[0] - baseU;
  const dy = role.tipUv[1] - baseV;
  const axisLength = Math.hypot(dx, dy);
  if (axisLength < 0.1) throw new Error(`${role.name} attachment and tip are too close`);
  const axisU = dx / axisLength;
  const axisV = dy / axisLength;
  const growthExtent = Math.max(...hull.map(([u, v]) => (u - baseU) * axisU + (v - baseV) * axisV));
  const lateralHalfExtent = Math.max(...hull.map(([u, v]) => Math.abs(
    (u - baseU) * -axisV + (v - baseV) * axisU,
  )));
  if (growthExtent < 0.1 || lateralHalfExtent < 0.02) throw new Error(`${role.name} attachment frame does not span its alpha hull`);
  return {
    baseUv: role.attachmentUv,
    axisUv: [Number(axisU.toFixed(6)), Number(axisV.toFixed(6))],
    growthExtent: Number(growthExtent.toFixed(6)),
    lateralHalfExtent: Number(lateralHalfExtent.toFixed(6)),
  };
}

function scaleMipAlpha(pixels, threshold, targetCoverage) {
  let bestScale = 1, bestDrift = Infinity;
  for (let step = 1; step <= 512; step++) {
    const scale = step / 64;
    let covered = 0;
    for (let i = 3; i < pixels.length; i += 4) if (Math.min(255, pixels[i] * scale) >= threshold) covered++;
    const drift = Math.abs(covered / (pixels.length / 4) - targetCoverage);
    if (drift < bestDrift) { bestDrift = drift; bestScale = scale; }
  }
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = Math.min(255, Math.round(pixels[i] * bestScale));
  return bestScale;
}

function downsampleCoveragePreserving(source, threshold, targetCoverage) {
  const width = Math.max(1, Math.floor(source.width / 2));
  const height = Math.max(1, Math.floor(source.height / 2));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let alphaSum = 0, red = 0, green = 0, blue = 0, samples = 0;
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const sx = Math.min(source.width - 1, x * 2 + ox);
      const sy = Math.min(source.height - 1, y * 2 + oy);
      const si = (sy * source.width + sx) * 4;
      const alpha = source.pixels[si + 3] / 255;
      red += source.pixels[si] * alpha; green += source.pixels[si + 1] * alpha; blue += source.pixels[si + 2] * alpha;
      alphaSum += alpha; samples++;
    }
    const di = (y * width + x) * 4;
    pixels[di] = Math.round(red / Math.max(alphaSum, 1e-6));
    pixels[di + 1] = Math.round(green / Math.max(alphaSum, 1e-6));
    pixels[di + 2] = Math.round(blue / Math.max(alphaSum, 1e-6));
    pixels[di + 3] = Math.round(alphaSum / samples * 255);
  }
  const alphaScale = scaleMipAlpha(pixels, threshold, targetCoverage);
  return { width, height, pixels, alphaScale };
}

function buildMipChain(base, threshold) {
  const levels = [{ ...base, alphaScale: 1 }];
  const targetCoverage = alphaMetrics(base.pixels, threshold).thresholdCoverage;
  while (levels.at(-1).width > 1 || levels.at(-1).height > 1) {
    levels.push(downsampleCoveragePreserving(levels.at(-1), threshold, targetCoverage));
  }
  return levels.map((level, index) => {
    const metrics = alphaMetrics(level.pixels, threshold);
    return { ...level, index, ...metrics, coverageDrift: metrics.thresholdCoverage - targetCoverage };
  });
}

function validateKtx2(bytes, expectedLevels) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 80 || !buffer.subarray(0, 12).equals(KTX2_IDENTIFIER)) throw new Error('KTX2 encoder returned an invalid container');
  const levels = buffer.readUInt32LE(40);
  if (levels !== expectedLevels) throw new Error(`KTX2 mip count ${levels} does not match expected ${expectedLevels}`);
  return { bytes: buffer.length, levels };
}

const args = parseArgs(process.argv.slice(2));
const configPath = resolve(args.config);
const configBytes = await readFile(configPath);
const config = strictConfig(JSON.parse(configBytes.toString('utf8')), configPath);
const inputPath = resolve(args.input || join(dirname(configPath), config.source.file));
const outputPath = resolve(args.output);
const sourceBytes = await readFile(inputPath);
const sourceDigest = sha256(sourceBytes);
if (sourceDigest !== config.source.sha256) throw new Error(`Source hash mismatch for ${inputPath}: ${sourceDigest}`);
const decoded = decodePNG(sourceBytes);
if (decoded.channels !== 4) throw new Error('Foliage source must be RGBA');
const layout = config.source.layout;
if (decoded.width % layout.columns || decoded.height % layout.rows) throw new Error('Source dimensions must divide exactly into configured layout');
cleanAlpha(decoded.pixels, config.processing.alphaCleanupThreshold);

const clusters = extractSheetComponents(decoded, layout, config.processing);
for (const image of clusters) dilateTransparentRgb(image, config.processing.rgbDilationRadius);

await mkdir(join(outputPath, 'clusters'), { recursive: true });
for (let index = 0; index < clusters.length; index++) {
  const role = config.source.roles[index];
  await writeFile(join(outputPath, 'clusters', `${String(index + 1).padStart(2, '0')}-${role.name}.png`),
    png(clusters[index].width, clusters[index].height, 4, clusters[index].pixels));
}

const atlasSize = config.processing.atlasSize;
const placements = packShelves(clusters, atlasSize, config.processing.atlasPadding);
const atlasPixels = Buffer.alloc(atlasSize * atlasSize * 4);
for (let index = 0; index < clusters.length; index++) blit(atlasPixels, atlasSize, clusters[index], placements[index]);
const atlasPng = png(atlasSize, atlasSize, 4, atlasPixels);
const maskPixels = buildMaterialMask(atlasPixels);
const maskPng = png(atlasSize, atlasSize, 4, maskPixels);
const atlasName = `${config.species.id}-cluster-atlas`;
const maskName = `${config.species.id}-material-mask`;
await writeFile(join(outputPath, `${atlasName}.png`), atlasPng);
await writeFile(join(outputPath, `${maskName}.png`), maskPng);

const mipChain = buildMipChain({ width: atlasSize, height: atlasSize, pixels: atlasPixels }, config.processing.coverageThreshold);
await mkdir(join(outputPath, 'mips'), { recursive: true });
for (const level of mipChain) {
  await writeFile(join(outputPath, 'mips', `${atlasName}-mip-${String(level.index).padStart(2, '0')}.png`),
    png(level.width, level.height, 4, level.pixels));
}
const measurableMips = mipChain.filter((level) => level.width >= 64 && level.height >= 64);
const maximumMeasuredMipDrift = Math.max(...measurableMips.map((level) => Math.abs(level.coverageDrift)));
if (maximumMeasuredMipDrift > config.processing.maximumMipCoverageDrift) {
  throw new Error(`Alpha coverage mip drift ${maximumMeasuredMipDrift.toFixed(6)} exceeds ${config.processing.maximumMipCoverageDrift}`);
}

const ktxOptions = config.processing.ktx2;
const encode = async (imageBytes, srgb) => encodeToKTX2(new Uint8Array(imageBytes), {
  isKTX2File: true,
  isUASTC: ktxOptions.mode === 'UASTC',
  uastcLDRQualityLevel: ktxOptions.qualityLevel,
  enableRDO: true,
  rdoQualityLevel: ktxOptions.rdoQualityLevel,
  needSupercompression: ktxOptions.zstdSupercompression,
  // CompressedTexture cannot use Texture.flipY at upload time. Encode with the
  // same bottom-left sampling convention as Three's ordinary PNG TextureLoader
  // path so one atlas UV contract works for both shipping and parity modes.
  isYFlip: ktxOptions.flipYForThreeTextureConvention,
  generateMipmap: true,
  isPerceptual: srgb,
  isSetKTX2SRGBTransferFunc: srgb,
  imageDecoder: async (bytes) => {
    const image = decodePNG(Buffer.from(bytes));
    return { width: image.width, height: image.height, data: new Uint8Array(image.pixels) };
  },
});
const [atlasKtx2, maskKtx2] = await Promise.all([encode(atlasPng, true), encode(maskPng, false)]);
const atlasKtxMetrics = validateKtx2(atlasKtx2, mipChain.length);
const maskKtxMetrics = validateKtx2(maskKtx2, mipChain.length);
await writeFile(join(outputPath, `${atlasName}.ktx2`), atlasKtx2);
await writeFile(join(outputPath, `${maskName}.ktx2`), maskKtx2);

const baseMetrics = alphaMetrics(atlasPixels, config.processing.coverageThreshold);
const occupiedPixels = placements.reduce((sum, placement) => sum + placement.width * placement.height, 0);
const coveredPixels = Math.round(baseMetrics.thresholdCoverage * atlasSize * atlasSize);
const transparentOverdrawEstimate = 1 - coveredPixels / occupiedPixels;
if (transparentOverdrawEstimate > config.processing.maximumTransparentOverdraw) {
  throw new Error(`Transparent overdraw ${transparentOverdrawEstimate.toFixed(6)} exceeds ${config.processing.maximumTransparentOverdraw}`);
}
const atlasUtilization = occupiedPixels / (atlasSize * atlasSize);

const metadata = {
  schemaVersion: PROCESSOR_SCHEMA_VERSION,
  candidateOnly: true,
  foliageAlias: config.foliageAlias,
  species: config.species.id,
  coordinateSystem: { up: '+Y', branchBaseDirection: 'card-local edge declared per cluster baseEdge', units: 'meters' },
  source: {
    file: basename(inputPath), sha256: sourceDigest, generatedAt: config.source.generatedAt,
    provider: config.source.provider, mode: config.source.mode,
    promptRecord: configRelativeReference(config.source.promptRecord),
  },
  sourceLayout: layout,
  atlas: {
    width: atlasSize, height: atlasSize, padding: config.processing.atlasPadding,
    alphaCleanupThreshold: config.processing.alphaCleanupThreshold,
    alphaCoverageThreshold: config.processing.coverageThreshold,
    rgbDilationRadius: config.processing.rgbDilationRadius,
    png: `${atlasName}.png`, ktx2: `${atlasName}.ktx2`, materialMaskPng: `${maskName}.png`, materialMaskKtx2: `${maskName}.ktx2`,
  },
  metrics: {
    alphaCoverage: baseMetrics.thresholdCoverage, meanAlpha: baseMetrics.meanAlpha,
    occupiedArea: occupiedPixels, atlasUtilization, transparentOverdrawEstimate, maximumMeasuredMipDrift,
    mipCoverage: mipChain.map((level) => ({ level: level.index, width: level.width, height: level.height,
      thresholdCoverage: level.thresholdCoverage, meanAlpha: level.meanAlpha, coverageDrift: level.coverageDrift, alphaScale: level.alphaScale })),
    compression: {
      mode: ktxOptions.mode, atlasPngBytes: atlasPng.length, atlasKtx2Bytes: atlasKtxMetrics.bytes,
      maskPngBytes: maskPng.length, maskKtx2Bytes: maskKtxMetrics.bytes,
      atlasRatio: atlasKtxMetrics.bytes / atlasPng.length, maskRatio: maskKtxMetrics.bytes / maskPng.length,
    },
  },
  clusters: placements.map((placement, index) => {
    const role = config.source.roles[index];
    const metrics = alphaMetrics(clusters[index].pixels, config.processing.coverageThreshold);
    const hull = supportHullUv(clusters[index], config.processing.coverageThreshold,
      config.processing.supportHullSectors ?? 12);
    const hullArea = polygonArea(hull);
    return {
      name: role.name, species: config.species.id, density: role.density,
      lodUse: role.lodUse, baseEdge: role.baseEdge, recommendedScaleMeters: role.recommendedScaleMeters,
      pixelBounds: placement, sourceBounds: clusters[index].sourceBounds,
      aspect: placement.width / placement.height, alphaCoverage: metrics.thresholdCoverage,
      supportHullUv: hull, supportHullArea: hullArea,
      ...(role.attachmentUv ? { attachmentFrame: attachmentFrame(hull, role) } : {}),
      rectangularTransparentOverdrawEstimate: 1 - metrics.thresholdCoverage,
      transparentOverdrawEstimate: Math.max(0, 1 - metrics.thresholdCoverage / hullArea),
      uv: { u0: placement.x / atlasSize, v0: 1 - (placement.y + placement.height) / atlasSize,
        u1: (placement.x + placement.width) / atlasSize, v1: 1 - placement.y / atlasSize },
    };
  }),
};
const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
await writeFile(join(outputPath, `${atlasName}.json`), metadataBytes);

const structuralFiles = await Promise.all(config.structuralMaterial.textures.map(async (record) => {
  const bytes = await readFile(resolve(dirname(configPath), record.file));
  if (sha256(bytes) !== record.sha256) throw new Error(`Structural material hash mismatch: ${record.file}`);
  await writeFile(join(outputPath, record.output), bytes);
  return [record.output, bytes, record.role];
}));
const requiredFiles = [
  [`${atlasName}.png`, atlasPng], [`${atlasName}.ktx2`, Buffer.from(atlasKtx2)],
  [`${maskName}.png`, maskPng], [`${maskName}.ktx2`, Buffer.from(maskKtx2)],
  [`${atlasName}.json`, metadataBytes], ...structuralFiles.map(([file, bytes]) => [file, bytes]),
];
const manifest = {
  schemaVersion: PACK_SCHEMA_VERSION,
  compatibilityVersion: 1,
  candidateOnly: true,
  foliageAlias: config.foliageAlias,
  species: config.species,
  generationSpecHash: sha256(Buffer.from(JSON.stringify({ source: config.source.sha256, config }))),
  processor: { id: config.processorVersion, config: basename(configPath), configSha256: sha256(configBytes) },
  requiredFiles: requiredFiles.map(([file, bytes]) => ({ file, sha256: sha256(bytes), bytes: bytes.length })),
  materialChannels: { albedo: 'sRGB RGBA; A is coverage', materialMask: 'linear RGBA; R roughness, G transmission, B/A coverage' },
  structuralMaterial: {
    license: config.structuralMaterial.license, source: config.structuralMaterial.source,
    provenance: configRelativeReference(config.structuralMaterial.provenance),
    textures: Object.fromEntries(structuralFiles.map(([file, , role]) => [role, file])),
  },
  runtime: {
    metadata: `${atlasName}.json`,
    albedo: { png: `${atlasName}.png`, ktx2: `${atlasName}.ktx2` },
    materialMask: { png: `${maskName}.png`, ktx2: `${maskName}.ktx2` },
    bark: Object.fromEntries(structuralFiles.map(([file, , role]) => [role, file])),
  },
  hierarchy: { levels: [0, 1, 2], selection: 'projected-screen-error', transition: 'exclusive-stable-membership' },
  validation: { state: 'candidate', maximumMeasuredMipDrift, transparentOverdrawEstimate },
  provenance: { sourceFile: basename(inputPath), sourceSha256: sourceDigest, promptRecord: metadata.source.promptRecord },
};
await writeFile(join(outputPath, 'foliage-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  input: inputPath, output: outputPath, foliageAlias: config.foliageAlias,
  clusters: clusters.length, atlasSize, mipLevels: mipChain.length,
  alphaCoverage: baseMetrics.thresholdCoverage, atlasUtilization,
  transparentOverdrawEstimate, maximumMeasuredMipDrift,
  ktx2: { atlasBytes: atlasKtxMetrics.bytes, maskBytes: maskKtxMetrics.bytes },
}, null, 2));
