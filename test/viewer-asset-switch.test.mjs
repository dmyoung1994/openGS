import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function viewerLifecycle() {
  const source = await readFile(new URL('../src/viewer/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('const VIEWER_SUBSYSTEMS');
  const end = source.indexOf('// Isolated asset viewer');
  const context = {};
  vm.runInNewContext(source.slice(start, end).replaceAll('export ', ''), context);
  return context.createViewerAssetSwitcher;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function asset(id) {
  const object = { id };
  const terrainMesh = { id: `${id}:terrain` };
  const grassMesh = { id: `${id}:grass` };
  const treeGroup = { id: `${id}:tree` };
  const waterMesh = { id: `${id}:water` };
  const counts = { terrain: 0, grass: 0, treeBeauty: 0, water: 0 };
  const ready = Promise.resolve();
  return {
    id,
    objects: [object, object, terrainMesh, grassMesh, treeGroup, waterMesh],
    terrain: { mesh: terrainMesh, assetsReady: ready, dispose: () => { counts.terrain++; } },
    grass: { mesh: grassMesh, dispose: () => { counts.grass++; } },
    treeBeauty: { group: treeGroup, dispose: () => { counts.treeBeauty++; } },
    water: { mesh: waterMesh, dispose: () => { counts.water++; } },
    counts,
  };
}

test('stale async viewer selection cannot win and is disposed exactly once', async () => {
  const createViewerAssetSwitcher = await viewerLifecycle();
  const firstBuild = deferred();
  const secondBuild = deferred();
  const builds = { first: firstBuild.promise, second: secondBuild.promise };
  const scene = { added: [], removed: [], add(object) { this.added.push(object); }, remove(object) { this.removed.push(object); } };
  const genericDisposals = [];
  const commits = [];
  const switcher = createViewerAssetSwitcher({
    scene,
    build: (name) => builds[name],
    disposeObjects: (objects, roots) => genericDisposals.push({ objects, roots }),
    commit: (next) => {
      commits.push(next.id);
      for (const object of next.objects) scene.add(object);
    },
  });

  const first = switcher.load('first');
  const second = switcher.load('second');
  const secondAsset = asset('second');
  secondBuild.resolve(secondAsset);
  assert.equal(await second, secondAsset);
  assert.equal(switcher.current, secondAsset);

  const firstAsset = asset('first');
  firstBuild.resolve(firstAsset);
  assert.equal(await first, null);
  assert.equal(switcher.current, secondAsset);
  assert.deepEqual(commits, ['second']);
  assert.deepEqual(firstAsset.counts, { terrain: 1, grass: 1, treeBeauty: 1, water: 1 });
  assert.equal(genericDisposals.length, 1);
  assert.equal(genericDisposals[0].objects[0], firstAsset.objects[0]);

  // The active asset is not torn down until the next switch (or viewer shutdown),
  // and repeated disposal calls cannot double-release its subsystems.
  switcher.disposeCurrent();
  switcher.disposeCurrent();
  assert.deepEqual(secondAsset.counts, { terrain: 1, grass: 1, treeBeauty: 1, water: 1 });
  assert.equal(genericDisposals.length, 2);
});

test('failed active viewer build preserves the current asset', async () => {
  const createViewerAssetSwitcher = await viewerLifecycle();
  const initial = asset('initial');
  const switcher = createViewerAssetSwitcher({
    build: async (name) => {
      if (name === 'broken') throw new Error('broken asset');
      return initial;
    },
    disposeObjects: () => {},
    commit: () => {},
  });
  await switcher.load('initial');
  await assert.rejects(switcher.load('broken'), /broken asset/);
  assert.equal(switcher.current, initial);
  assert.deepEqual(initial.counts, { terrain: 0, grass: 0, treeBeauty: 0, water: 0 });
});
