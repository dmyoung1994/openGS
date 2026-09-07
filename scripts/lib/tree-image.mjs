import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';
import { decodePNG, png } from './png.mjs';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 4096;

export async function readTreePng(inputPath, { root = process.cwd() } = {}) {
  const resolved = await allowedImagePath(inputPath, root);
  const bytes = await readFile(resolved);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Tree source PNG must be 1-${MAX_IMAGE_BYTES} bytes.`);
  const image = decodePNG(bytes);
  if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION) throw new Error(`Tree source PNG dimensions must not exceed ${MAX_DIMENSION}px.`);
  if (image.channels !== 4) throw new Error('Tree source PNG must contain an alpha channel.');
  return { ...image, bytes, path: resolved, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function loadOrthographicMasks(inputPath, { root = process.cwd(), size = 96 } = {}) {
  if (!Number.isInteger(size) || size < 32 || size > 256) throw new Error('Mask size must be an integer in [32, 256].');
  const image = await readTreePng(inputPath, { root });
  if (image.width < image.height * 2.1 || image.width > image.height * 4.2) throw new Error('Orthographic sheet must be one horizontal row containing front, right, and top panels.');
  const panelWidth = Math.floor(image.width / 3);
  const views = ['front', 'side', 'top'];
  const masks = {};
  for (let panel = 0; panel < 3; panel++) {
    const source = alphaMask(image, panel * panelWidth, 0, panel === 2 ? image.width - panel * panelWidth : panelWidth, image.height);
    const bounds = maskBounds(source.mask, source.width, source.height);
    if (!bounds) throw new Error(`${views[panel]} panel has no alpha silhouette.`);
    const coverage = bounds.count / (source.width * source.height);
    if (coverage < 0.01 || coverage > 0.82) throw new Error(`${views[panel]} panel silhouette coverage ${coverage.toFixed(3)} is outside [0.01, 0.82].`);
    masks[views[panel]] = fitMask(source.mask, source.width, source.height, bounds, size);
  }
  return Object.freeze({ masks: Object.freeze(masks), size, sha256: image.sha256, path: image.path });
}

export async function prepareLeafTexture(inputPath, { root = process.cwd(), outputDirectory, id, size = 512, prompt = '' } = {}) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id || '')) throw new Error('Leaf texture id must be a stable kebab-case identifier.');
  if (!Number.isInteger(size) || size < 128 || size > 1024 || (size & (size - 1)) !== 0) throw new Error('Leaf texture size must be a power of two in [128, 1024].');
  const image = await readTreePng(inputPath, { root });
  const source = alphaMask(image, 0, 0, image.width, image.height);
  const bounds = maskBounds(source.mask, source.width, source.height);
  if (!bounds || bounds.count < 256) throw new Error('Leaf source contains no substantial alpha silhouette.');
  const pixels = resizeRgbaCrop(image, bounds, size);
  cleanAlpha(pixels, 12); dilateTransparentRgb(pixels, size, size, 8);
  const imageBytes = png(size, size, 4, pixels);
  const ktx2 = await encodeToKTX2(new Uint8Array(imageBytes), {
    isKTX2File: true, isUASTC: true, uastcLDRQualityLevel: 2,
    enableRDO: true, rdoQualityLevel: 1, needSupercompression: false,
    isYFlip: true, generateMipmap: true, isPerceptual: true,
    isSetKTX2SRGBTransferFunc: true,
    imageDecoder: async (bytes) => { const decoded = decodePNG(Buffer.from(bytes)); return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.pixels) }; },
  });
  const output = resolve(root, outputDirectory || `public/assets/procedural-trees/${id}`);
  if (!inside(resolve(root), output)) throw new Error('Leaf texture output must stay inside the workspace.');
  await mkdir(output, { recursive: true });
  const sourcePath = join(output, 'leaf-source.png'), pngPath = join(output, 'leaf.png'), ktxPath = join(output, 'leaf.ktx2');
  if (resolve(image.path) !== resolve(sourcePath)) await copyFile(image.path, sourcePath);
  await writeFile(pngPath, imageBytes); await writeFile(ktxPath, ktx2);
  const manifest = {
    version: 1, id, sourceSha256: image.sha256,
    promptHash: createHash('sha256').update(String(prompt || image.sha256)).digest('hex'),
    width: size, height: size,
    alphaCoverage: Number((pixels.filter((_, index) => index % 4 === 3 && pixels[index] >= 32).length / (size * size)).toFixed(6)),
    files: { source: relative(root, sourcePath).replaceAll(sep, '/'), png: relative(root, pngPath).replaceAll(sep, '/'), ktx2: relative(root, ktxPath).replaceAll(sep, '/') },
  };
  await writeFile(join(output, 'leaf-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function imageGenTreePrompts(description) {
  const subject = String(description || '').trim();
  if (!subject || subject.length > 500) throw new Error('Tree description must contain 1-500 characters.');
  return Object.freeze({
    orthographic: `Use case: scientific-educational\nAsset type: procedural 3D tree fitting reference\nPrimary request: ${subject}\nSubject: the exact same mature tree in three orthographic views\nComposition/framing: one horizontal three-panel sheet, FRONT then RIGHT SIDE then TOP; identical scale and centered baseline in every panel\nLighting/mood: flat neutral studio illumination with no cast shadow\nConstraints: genuinely transparent background; one complete isolated tree per panel; preserve branch and crown silhouette; no labels, ground, pot, text, border, people, scenery, watermark, or perspective camera`,
    leaf: `Use case: background-extraction\nAsset type: alpha-tested texture for explicit procedural leaf meshes\nPrimary request: one representative leaf or compact natural leaf cluster from ${subject}\nComposition/framing: centered, face-on, fully visible with generous transparent margin\nLighting/mood: soft even diffuse illumination\nConstraints: genuinely transparent background; crisp natural alpha edge; no branch thicker than a petiole; no text, shadow, border, scenery, or watermark`,
  });
}

async function allowedImagePath(inputPath, root) {
  if (typeof inputPath !== 'string' || !inputPath.toLowerCase().endsWith('.png')) throw new Error('Tree source must be a local PNG path.');
  const candidate = await realpath(isAbsolute(inputPath) ? inputPath : resolve(root, inputPath));
  const workspace = await realpath(root);
  const temporaryRoots = await Promise.all([...new Set([tmpdir(), '/tmp'])].map((path) => realpath(path)));
  if (!inside(workspace, candidate) && !temporaryRoots.some((temporary) => inside(temporary, candidate))) throw new Error('Tree source must be inside the workspace or operating-system temporary directory.');
  return candidate;
}

function inside(parent, child) { return child === parent || child.startsWith(`${parent}${sep}`); }
function alphaMask(image, x0, y0, width, height) { const mask = new Uint8Array(width * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask[y * width + x] = image.pixels[((y0 + y) * image.width + x0 + x) * 4 + 3] >= 32 ? 255 : 0; return { mask, width, height }; }
function maskBounds(mask, width, height) { let minX = width, minY = height, maxX = -1, maxY = -1, count = 0; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++; } return count ? { minX, minY, maxX, maxY, count } : null; }
function fitMask(source, width, height, bounds, size) { const output = new Uint8Array(size * size), padding = Math.max(2, Math.floor(size * 0.04)), sourceWidth = bounds.maxX - bounds.minX + 1, sourceHeight = bounds.maxY - bounds.minY + 1, scale = Math.min((size - padding * 2) / sourceWidth, (size - padding * 2) / sourceHeight), drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale, offsetX = (size - drawWidth) * 0.5, offsetY = (size - drawHeight) * 0.5; for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const sx = Math.floor(bounds.minX + (x - offsetX) / scale), sy = Math.floor(bounds.minY + (y - offsetY) / scale); if (sx >= bounds.minX && sx <= bounds.maxX && sy >= bounds.minY && sy <= bounds.maxY) output[y * size + x] = source[sy * width + sx]; } return output; }
function resizeRgbaCrop(image, bounds, size) { const output = Buffer.alloc(size * size * 4), sourceWidth = bounds.maxX - bounds.minX + 1, sourceHeight = bounds.maxY - bounds.minY + 1, padding = Math.floor(size * 0.06), scale = Math.min((size - padding * 2) / sourceWidth, (size - padding * 2) / sourceHeight), drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale, offsetX = (size - drawWidth) * 0.5, offsetY = (size - drawHeight) * 0.5; for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const sx = Math.floor(bounds.minX + (x - offsetX) / scale), sy = Math.floor(bounds.minY + (y - offsetY) / scale); if (sx < bounds.minX || sx > bounds.maxX || sy < bounds.minY || sy > bounds.maxY) continue; const from = (sy * image.width + sx) * 4; image.pixels.copy(output, (y * size + x) * 4, from, from + 4); } return output; }
function cleanAlpha(pixels, threshold) { for (let index = 3; index < pixels.length; index += 4) pixels[index] = pixels[index] <= threshold ? 0 : Math.min(255, Math.round((pixels[index] - threshold) * 255 / (255 - threshold))); }
function dilateTransparentRgb(pixels, width, height, passes) { for (let pass = 0; pass < passes; pass++) { const source = Buffer.from(pixels); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 4; if (source[at + 3]) continue; let count = 0, r = 0, g = 0, b = 0; for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const nx = x + ox, ny = y + oy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue; const neighbor = (ny * width + nx) * 4; if (!source[neighbor + 3]) continue; r += source[neighbor]; g += source[neighbor + 1]; b += source[neighbor + 2]; count++; } if (count) { pixels[at] = r / count; pixels[at + 1] = g / count; pixels[at + 2] = b / count; } } } }
