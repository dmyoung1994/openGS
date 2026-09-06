#!/usr/bin/env node
// Reproducibly acquire Fir Tree 01 and every dependency from Poly Haven's
// official files API. The complete source package is required by the
// source-faithful component-selection baker; no substitute geometry is allowed.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const API_URL = 'https://api.polyhaven.com/files/fir_tree_01';
const SOURCE_GLTF_SHA256 = '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709';
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error('usage: node scripts/fetch_polyhaven_fir_tree_01.mjs --output-dir <directory>');
}
const outputDir = resolve(process.argv[outputIndex + 1]);
await mkdir(outputDir, { recursive: true });

const response = await fetch(API_URL);
if (!response.ok) throw new Error(`Poly Haven files API returned ${response.status}`);
const manifest = await response.json();
const source = manifest?.gltf?.['1k']?.gltf;
if (!source?.url || !source?.md5 || !source?.include) throw new Error('official Fir Tree 01 1k glTF record is incomplete');

const alpha = manifest?.twig_alpha?.['1k']?.png;
if (!alpha?.url || !alpha?.md5) throw new Error('official Fir Tree 01 twig alpha record is incomplete');
const files = new Map([
  ['fir_tree_01_1k.gltf', source],
  ...Object.entries(source.include),
  ['textures/fir_tree_01_twig_alpha_1k.png', alpha],
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
    // Missing files continue through the official download path below.
  }
  const fileResponse = await fetch(record.url);
  if (!fileResponse.ok || !fileResponse.body) throw new Error(`download failed (${fileResponse.status}): ${record.url}`);
  await pipeline(Readable.fromWeb(fileResponse.body), createWriteStream(destination));
  const bytes = await readFile(destination);
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (md5 !== record.md5) throw new Error(`MD5 mismatch for ${relativePath}: ${md5} != ${record.md5}`);
  process.stdout.write(`verified ${relativePath} (${bytes.byteLength} bytes)\n`);
}

const sourcePath = resolve(outputDir, 'fir_tree_01_1k.gltf');
const sourceSha256 = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
if (sourceSha256 !== SOURCE_GLTF_SHA256) throw new Error(`source glTF SHA-256 mismatch: ${sourceSha256}`);
await writeFile(resolve(outputDir, 'polyhaven-files-api.json'), `${JSON.stringify({ apiUrl: API_URL, fetchedAt: new Date().toISOString(), source }, null, 2)}\n`);
process.stdout.write(`FIR_TREE_SOURCE_READY input=${sourcePath} sha256=${sourceSha256}\n`);
