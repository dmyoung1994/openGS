import { sha256 } from '../environment/EnvironmentCatalog.js';

export const SKY_MANIFEST_VERSION = 1;

export function validateSkyManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Sky manifest must be an object.');
  if (raw.version !== SKY_MANIFEST_VERSION) throw new Error(`Sky manifest version must be ${SKY_MANIFEST_VERSION}.`);
  for (const key of ['id', 'url', 'sha256', 'source', 'api', 'license']) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) throw new Error(`Sky manifest ${key} is required.`);
  }
  if (!/^\/[a-z0-9_./-]+\.hdr$/.test(raw.url)) throw new Error('Sky manifest URL must be a local HDR asset.');
  if (!/^[a-f0-9]{64}$/.test(raw.sha256)) throw new Error('Sky manifest SHA-256 is invalid.');
  if (raw.license !== 'CC0') throw new Error('Sky manifest asset must be CC0.');
  if (!Array.isArray(raw.resolution) || raw.resolution.length !== 2
    || raw.resolution.some((value) => !Number.isInteger(value) || value <= 0 || value > 2048)) {
    throw new Error('Sky manifest resolution must be bounded to 2K.');
  }
  if (!Array.isArray(raw.sourceSunDirection) || raw.sourceSunDirection.length !== 3
    || raw.sourceSunDirection.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Sky manifest source sun direction is required.');
  }
  const sourceSunLength = Math.hypot(...raw.sourceSunDirection);
  if (sourceSunLength < 0.99 || sourceSunLength > 1.01) throw new Error('Sky manifest source sun direction must be unit length.');
  if (!Number.isFinite(raw.rotationRadians)) throw new Error('Sky manifest rotation is required.');
  return Object.freeze({ ...raw, authors: Object.freeze([...(raw.authors || [])]), resolution: Object.freeze([...raw.resolution]), sourceSunDirection: Object.freeze([...raw.sourceSunDirection]) });
}

export async function loadSkyManifest(url = '/assets/environment/sky-manifest.json', fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Sky manifest requires fetch.');
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response?.ok) throw new Error(`Sky manifest load failed: ${response?.status ?? 'network error'}`);
  return validateSkyManifest(await response.json());
}

export async function verifySkyAsset(manifest, fetchImpl = globalThis.fetch) {
  if (!manifest?.url || typeof fetchImpl !== 'function') throw new Error('Sky asset verification requires manifest and fetch.');
  const response = await fetchImpl(manifest.url, { cache: 'reload' });
  if (!response?.ok) throw new Error(`Sky asset unavailable: ${manifest.url}`);
  const digest = await sha256(await response.arrayBuffer());
  if (digest !== manifest.sha256) throw new Error(`Sky asset hash mismatch: ${manifest.url}`);
  return manifest;
}
