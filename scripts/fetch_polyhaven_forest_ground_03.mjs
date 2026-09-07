import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ASSET_ID = 'forrest_ground_03';
const API_URL = `https://api.polyhaven.com/files/${ASSET_ID}`;
const outputIndex = process.argv.indexOf('--output-dir');
const outputDir = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1]
  : 'public/assets/textures');
const roles = Object.freeze({
  diff: ['Diffuse', 'forrest_ground_03_diff_2k.jpg', '605bfa541b0d406bcf88a16a8c82b821'],
  nor_gl: ['nor_gl', 'forrest_ground_03_nor_gl_2k.jpg', '104ecda19a7dce8f7b809b332cb41d37'],
  arm: ['arm', 'forrest_ground_03_arm_2k.jpg', '905e52f65336525f23a64529d42b5018'],
  displacement: ['Displacement', 'forrest_ground_03_disp_2k.jpg', '9f4313598fa4a11a988607cd7c2b34f5'],
});

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const get = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

await mkdir(outputDir, { recursive: true });
const manifestBytes = await get(API_URL);
const manifest = JSON.parse(manifestBytes);
for (const [role, [apiKey, filename, expectedMd5]] of Object.entries(roles)) {
  const source = manifest?.[apiKey]?.['2k']?.jpg;
  if (!source?.url || !source?.md5 || !Number.isInteger(source?.size)) {
    throw new Error(`Poly Haven manifest is missing ${apiKey} 2k jpg`);
  }
  if (source.md5 !== expectedMd5) throw new Error(`${role} upstream MD5 changed`);
  const bytes = await get(source.url);
  if (bytes.length !== source.size) throw new Error(`${role} byte-size mismatch`);
  if (digest('md5', bytes) !== source.md5) throw new Error(`${role} API MD5 mismatch`);
  await writeFile(resolve(outputDir, filename), bytes);
  console.log(JSON.stringify({ role, filename, bytes: bytes.length,
    md5: source.md5, sha256: digest('sha256', bytes), sourceUrl: source.url }));
}
console.log(JSON.stringify({ assetId: ASSET_ID, apiUrl: API_URL,
  manifestSha256: digest('sha256', manifestBytes) }));
