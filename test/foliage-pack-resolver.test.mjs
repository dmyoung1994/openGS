import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createLocalFoliagePackRegistry, FoliagePackError, resolveFoliageAliasDescriptor, verifyFoliageAlias,
} from '../src/foliage/FoliagePackResolver.js';

const root = new URL('../public/assets/trees_candidates/generated_fir_clusters/processed/v2/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('foliage-pack.json', root), 'utf8'));

function localFetch(pathname) {
  const file = pathname.split('/').pop();
  return readFile(new URL(file, root)).then((bytes) => ({
    ok: true,
    json: async () => JSON.parse(bytes.toString('utf8')),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }), () => ({ ok: false, status: 404 }));
}

test('foliage alias resolution fails closed and never substitutes a species', () => {
  assert.throws(() => resolveFoliageAliasDescriptor('builtin.missing.pnw.v1'), FoliagePackError);
  assert.throws(() => resolveFoliageAliasDescriptor('../douglas-fir'), /malformed alias/);
  assert.equal(resolveFoliageAliasDescriptor('builtin.douglas-fir.pnw.v1').compatibilityVersion, 1);
});

test('local foliage registry is explicit, immutable, same-origin, and versioned', () => {
  const local = createLocalFoliagePackRegistry({
    'local.monterey-cypress.coastal.v1': { rootUrl: '/local-foliage/monterey/v1/', compatibilityVersion: 1 },
  });
  const resolved = resolveFoliageAliasDescriptor('local.monterey-cypress.coastal.v1', { local });
  assert.equal(resolved.rootUrl, '/local-foliage/monterey/v1');
  assert.equal(local.size, 1);
  assert.equal(local.set, undefined);
  assert.throws(() => createLocalFoliagePackRegistry({
    'local.private.v1': { rootUrl: 'https://uploads.example/private', compatibilityVersion: 1 },
  }), /same-origin absolute asset path/);
  assert.throws(() => createLocalFoliagePackRegistry({
    'local.escape.v1': { rootUrl: '/local-foliage/../private', compatibilityVersion: 1 },
  }), /same-origin absolute asset path/);
});

test('an approved local alias verifies through its explicit descriptor without builtin substitution', async () => {
  const alias = 'local.douglas-fir.private.v1';
  const local = createLocalFoliagePackRegistry({
    [alias]: { rootUrl: '/local-foliage/douglas/private-v1', compatibilityVersion: 1 },
  });
  const approved = {
    ...manifest,
    foliageAlias: alias,
    candidateOnly: false,
    validation: { ...manifest.validation, state: 'approved' },
  };
  const fetchLocal = (url, options) => url.endsWith('/foliage-pack.json')
    ? Promise.resolve({ ok: true, json: async () => approved })
    : localFetch(url, options);
  const resolved = await verifyFoliageAlias(alias, { fetchImpl: fetchLocal, local, memoize: false });
  assert.equal(resolved.descriptor.rootUrl, '/local-foliage/douglas/private-v1');
  assert.equal(resolved.manifest.validation.state, 'approved');
});

test('candidate pack integrity verifies only when candidate QA is explicitly allowed', async () => {
  await assert.rejects(() => verifyFoliageAlias(manifest.foliageAlias, {
    fetchImpl: localFetch, memoize: false,
  }), /not production-approved/);
  const resolved = await verifyFoliageAlias(manifest.foliageAlias, {
    fetchImpl: localFetch, allowCandidate: true, memoize: false,
  });
  assert.equal(resolved.manifest.generationSpecHash, manifest.generationSpecHash);
  assert.equal(resolved.manifest.requiredFiles.length, 8);
  assert.equal(resolved.manifest.structuralMaterial.license, 'CC0-1.0');
});

test('foliage pack hash mismatch is actionable', async () => {
  let request = 0;
  const tamperedFetch = async (url, options) => {
    const response = await localFetch(url, options);
    request++;
    if (request === 2 && response.ok) return { ...response, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return response;
  };
  await assert.rejects(() => verifyFoliageAlias(manifest.foliageAlias, {
    fetchImpl: tamperedFetch, allowCandidate: true, memoize: false,
  }), /byte length mismatch/);
});

test('all generated species expose complete self-contained runtime roles', async () => {
  const speciesRoots = [
    '../public/assets/trees_candidates/generated_fir_clusters/processed/v2/',
    '../public/assets/trees_candidates/generated_italian_cypress/processed/v1/',
    '../public/assets/trees_candidates/generated_monterey_cypress/processed/v1/',
  ];
  for (const relativeRoot of speciesRoots) {
    const speciesRoot = new URL(relativeRoot, import.meta.url);
    const speciesManifest = JSON.parse(await readFile(new URL('foliage-pack.json', speciesRoot), 'utf8'));
    const fetchSpecies = (pathname) => readFile(new URL(pathname.split('/').pop(), speciesRoot)).then((bytes) => ({
      ok: true,
      json: async () => JSON.parse(bytes.toString('utf8')),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }), () => ({ ok: false, status: 404 }));
    const resolved = await verifyFoliageAlias(speciesManifest.foliageAlias, {
      fetchImpl: fetchSpecies, allowCandidate: true, memoize: false,
    });
    assert.equal(resolved.manifest.requiredFiles.length, 8);
    assert.deepEqual(Object.keys(resolved.manifest.runtime.bark).sort(), ['albedo', 'arm', 'normal']);
    assert.ok(resolved.manifest.species.nativeHeightMeters >= 18);
  }
});
