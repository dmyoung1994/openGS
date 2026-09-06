import { generateTreeSkeleton } from './TreeGenerator.js';
import { compileTreeGeometry, packTreeGeometry } from './TreeGeometry.js';
self.onmessage = ({ data: { definition, seed } }) => {
  try {
    const started = performance.now(), skeleton = generateTreeSkeleton(definition, { seed });
    const radial = Math.round(definition.plant?.quality.radialSegments ?? 9);
    const tiers = [0, 1, 2].map(tier => {
      const geometry = compileTreeGeometry(skeleton, { radialSegments: Math.max(3, radial - tier * 3), leafStride: [1, 2, 4][tier], plant: definition.plant, includeRoots: tier === 0 });
      const packed = packTreeGeometry(geometry);
      for (const mesh of Object.values(geometry)) mesh.dispose();
      return packed;
    });
    const buffers = tiers.flatMap(tier => Object.values(tier).flatMap(mesh => Object.values(mesh).map(array => array.buffer)));
    self.postMessage({ skeleton, tiers, generationMs: performance.now() - started }, buffers);
  } catch (error) { self.postMessage({ error: error.message }); }
};
