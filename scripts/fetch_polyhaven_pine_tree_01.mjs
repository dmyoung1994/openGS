#!/usr/bin/env node
// Reproducibly acquire Pine Tree 01 and every dependency from Poly Haven's
// official files API. The very large geometry buffer is intentionally fetched
// from its authored source rather than replaced with a generic tree.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const API_URL = 'https://api.polyhaven.com/files/pine_tree_01';
const SOURCE_GLTF_SHA256 = 'c81e8eebbda722313f07bed37b8b9156ce520f7fa95488d83a694d02fffdb469';
const TWIG_ALPHA_MD5 = '641911a5a3f543911dad04ebb26e7bca';
const TWIG_MASK_MD5 = '8a2b451afa2ef9f5c548ae9772ffbcf0';
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error('usage: node scripts/fetch_polyhaven_pine_tree_01.mjs --output-dir <empty-or-existing-directory>');
}
const outputDir = resolve(process.argv[outputIndex + 1]);
const mapsOnly = process.argv.includes('--maps-only');
await mkdir(outputDir, { recursive: true });

const response = await fetch(API_URL);
if (!response.ok) throw new Error(`Poly Haven files API returned ${response.status}`);
const manifest = await response.json();
const source = manifest?.gltf?.['1k']?.gltf;
if (!source?.url || !source?.md5 || !source?.include) throw new Error('official Pine Tree 01 1k glTF record is incomplete');
const twigAlpha = manifest?.twig_alpha?.['1k']?.png;
const twigMask = manifest?.twig_mask?.['1k']?.png;
if (twigAlpha?.md5 !== TWIG_ALPHA_MD5 || twigMask?.md5 !== TWIG_MASK_MD5) {
  throw new Error('official Pine Tree 01 twig coverage records changed');
}

const coverageFiles = [
  ['textures/pine_tree_01_twig_alpha_1k.png', twigAlpha],
  ['textures/pine_tree_01_twig_mask_1k.png', twigMask],
];
const files = new Map(mapsOnly ? coverageFiles : [
  ['pine_tree_01_1k.gltf', source],
  ...Object.entries(source.include),
  ...coverageFiles,
]);
for (const [relativePath, record] of files) {
  const destination = resolve(outputDir, relativePath);
  if (relative(outputDir, destination).startsWith('..')) throw new Error(`unsafe manifest path: ${relativePath}`);
  await mkdir(dirname(destination), { recursive: true });
  const fileResponse = await fetch(record.url);
  if (!fileResponse.ok || !fileResponse.body) throw new Error(`download failed (${fileResponse.status}): ${record.url}`);
  await pipeline(Readable.fromWeb(fileResponse.body), createWriteStream(destination));
  const bytes = await readFile(destination);
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (md5 !== record.md5) throw new Error(`MD5 mismatch for ${relativePath}: ${md5} != ${record.md5}`);
  process.stdout.write(`verified ${relativePath} (${bytes.byteLength} bytes)\n`);
}

const sourcePath = resolve(outputDir, 'pine_tree_01_1k.gltf');
const sourceSha256 = mapsOnly ? SOURCE_GLTF_SHA256 : createHash('sha256').update(await readFile(sourcePath)).digest('hex');
if (!mapsOnly && sourceSha256 !== SOURCE_GLTF_SHA256) throw new Error(`source glTF SHA-256 mismatch: ${sourceSha256}`);
await writeFile(resolve(outputDir, 'polyhaven-files-api.json'), `${JSON.stringify({ apiUrl: API_URL, fetchedAt: new Date().toISOString(), source }, null, 2)}\n`);
process.stdout.write(`PINE_TREE_SOURCE_READY input=${sourcePath} sha256=${sourceSha256}\n`);
