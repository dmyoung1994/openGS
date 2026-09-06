// Exactly one immutable two-array turf pack per renderer, retained only while
// actual Terrain owners exist. The preloaded putting terrain is one such owner.
const resident = new WeakMap();

export function acquireTurfMaps(renderer, createMaps) {
  if (!renderer?.isWebGPURenderer) throw new Error('Turf residency requires the production WebGPU renderer.');
  let entry = resident.get(renderer);
  if (!entry) {
    entry = { maps: createMaps(), owners: 0 };
    resident.set(renderer, entry);
    for (const texture of [entry.maps.albedoArray, entry.maps.nrhArray]) {
      texture.userData.sharedWebGPUAsset = true;
    }
    void entry.maps.ready.catch(() => {
      if (resident.get(renderer) === entry) resident.delete(renderer);
    });
  }
  entry.owners++;
  let released = false;
  return { ...entry.maps, release() {
    if (released) return false;
    released = true;
    if (--entry.owners === 0) {
      if (resident.get(renderer) === entry) resident.delete(renderer);
      entry.maps.albedoArray.dispose();
      entry.maps.nrhArray.dispose();
    }
    return true;
  } };
}
