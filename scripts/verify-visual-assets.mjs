import { readFile } from 'node:fs/promises';
import {
  loadVisualAssetManifest,
  resolveVisualAssetProfile,
} from '../src/assets/VisualAssetManifest.js';
import { verifyVisualAssetBytes } from '../src/assets/VisualAssetResidency.js';

const manifestPath = new URL('../public/assets/visual-quality-manifest.json', import.meta.url);
const publicRoot = new URL('../public/', import.meta.url);

const manifest = await loadVisualAssetManifest(
  '/assets/visual-quality-manifest.json',
  async () => ({
    ok: true,
    async json() {
      return JSON.parse(await readFile(manifestPath, 'utf8'));
    },
  }),
);

for (const file of manifest.files) {
  const bytes = await readFile(new URL(file.url.slice(1), publicRoot));
  await verifyVisualAssetBytes(file, bytes);
}

const summaries = [];
for (const variant of ['critical', 'balanced', 'quality', 'ultra']) {
  const profile = resolveVisualAssetProfile(manifest, variant);
  summaries.push(`${variant}: ${profile.fileCount} files, ${profile.transferBytes} transfer bytes, ${profile.memoryBytes} estimated GPU bytes`);
}

console.log(`Verified ${manifest.files.length} visual files from ${manifest.manifestId}.`);
for (const summary of summaries) console.log(summary);
