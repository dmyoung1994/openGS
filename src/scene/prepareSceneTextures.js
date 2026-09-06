import { yieldToRendering } from '../util/yieldToRendering.js';

// Upload the same owned material maps the real scene will render, one per paint.
// There is no cache or new Texture: existing scene disposal remains authoritative.
// Render-target textures are produced by their passes, not by this asset step.
export async function prepareSceneTextures(renderer, scene) {
  const materials = new Set();
  scene.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });
  const textures = new Set();
  for (const material of materials) {
    for (const value of [...Object.values(material), ...(material.userData?.ownedTextures || [])]) {
      if (value?.isTexture && !value.isRenderTargetTexture) textures.add(value);
    }
  }
  for (const texture of textures) {
    renderer.initTexture(texture);
    await yieldToRendering();
  }
  return textures.size;
}
