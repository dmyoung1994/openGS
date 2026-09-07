#!/usr/bin/env node
// Reproducibly acquire Pine Sapling Small and all 1k glTF dependencies from
// Poly Haven's official files API. Every downloaded file is verified against
// the API-provided MD5 before it can enter the source-processing path.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API_URL = 'https://api.polyhaven.com/files/pine_sapling_small';
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error('usage: node scripts/fetch_polyhaven_pine_sapling_small.mjs --output-dir <directory>');
}
const outputDir = resolve(process.argv[outputIndex + 1]);
await mkdir(outputDir, { recursive: true });

const response = await fetch(API_URL);
if (!response.ok) throw new Error(`Poly Haven files API returned ${response.status}`);
const manifest = await response.json();
const source = manifest?.gltf?.['1k']?.gltf;
if (!source?.url || !source?.md5 || !source?.include) {
  throw new Error('official Pine Sapling Small 1k glTF record is incomplete');
}
const alpha = manifest?.twig_alpha?.['1k']?.png;
if (!alpha?.url || !alpha?.md5) throw new Error('official Pine Sapling Small twig alpha record is incomplete');
const files = new Map([
  ['pine_sapling_small_1k.gltf', source],
  ...Object.entries(source.include),
  ['textures/pine_sapling_small_twig_alpha_1k.png', alpha],
]);
for (const [relativePath, record] of files) {
  const destination = resolve(outputDir, relativePath);
  if (relative(outputDir, destination).startsWith('..')) throw new Error(`unsafe manifest path: ${relativePath}`);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const existing = await readFile(destination);
    if (createHash('md5').update(existing).digest('hex') === record.md5) {
      process.stdout.write(`verified existing ${relativePath} (${existing.byteLength} bytes)\n`);
      continue;
    }
  } catch {
    // Missing or changed files continue through the official download path.
  }
  const fileResponse = await fetch(record.url);
  if (!fileResponse.ok || !fileResponse.body) throw new Error(`download failed (${fileResponse.status}): ${record.url}`);
  await pipeline(Readable.fromWeb(fileResponse.body), createWriteStream(destination));
  const bytes = await readFile(destination);
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (md5 !== record.md5) throw new Error(`MD5 mismatch for ${relativePath}: ${md5} != ${record.md5}`);
  process.stdout.write(`verified ${relativePath} (${bytes.byteLength} bytes)\n`);
}

const sourcePath = resolve(outputDir, 'pine_sapling_small_1k.gltf');
const sourceSha256 = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
await writeFile(resolve(outputDir, 'polyhaven-files-api.json'), `${JSON.stringify({
  apiUrl: API_URL,
  fetchedAt: new Date().toISOString(),
  sourceSha256,
  source,
}, null, 2)}\n`);
process.stdout.write(`PINE_SAPLING_SMALL_SOURCE_READY input=${sourcePath} sha256=${sourceSha256}\n`);
