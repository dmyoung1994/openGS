// Three's WebGPU renderer owns GPUBuffer lifetime through its internal attribute
// registry. Geometry disposal releases attributes attached to a draw geometry, but
// compute-only storage streams have no owning geometry and therefore need an explicit
// release. Keep the version-specific renderer integration in one fail-closed helper.
// If Three changes this contract, a rebuild must stop loudly instead of leaking and
// pretending that cleanup succeeded.
export function disposeWebGPUAttributes(renderer, attributes) {
  if (!renderer?.isWebGPURenderer || typeof renderer._attributes?.delete !== 'function') {
    throw new Error('WebGPU attribute disposal contract is unavailable.');
  }

  const unique = new Set(attributes.filter(Boolean));
  for (const attribute of unique) renderer._attributes.delete(attribute);
}

export function disposeComputeNodes(nodes) {
  const unique = new Set(nodes.filter(Boolean));
  for (const node of unique) node.dispose();
}

export function disposeWebGPUGeometries(renderer, geometries) {
  const unique = new Set(geometries.filter(Boolean));
  for (const geometry of unique) {
    if (geometry.userData?.sharedWebGPUAsset === true) continue;
    const attributes = [
      geometry.index,
      geometry.indirect,
      ...Object.values(geometry.attributes || {}),
      ...Object.values(geometry.morphAttributes || {}).flat(),
    ];
    geometry.dispose();
    // Renderer geometry disposal normally deletes these. Explicit deletion is
    // intentional and idempotent: procedural node materials can register attributes
    // outside the geometry listener's first render-object snapshot.
    disposeWebGPUAttributes(renderer, attributes);
  }
}

export function disposeMaterialTextures(materials) {
  const textures = new Set();
  for (const material of new Set(materials.filter(Boolean))) {
    for (const value of Object.values(material)) {
      if (value?.isTexture && value.userData?.sharedWebGPUAsset !== true) textures.add(value);
    }
    for (const value of material.userData?.ownedTextures || []) {
      if (value?.isTexture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}
