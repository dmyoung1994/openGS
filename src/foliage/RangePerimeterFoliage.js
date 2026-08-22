import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';

const GROVES = Object.freeze([
  { id: 'left-tee', x: -75, z: -9, rx: 6, rz: 15, count: 6, speciesOffset: 1 },
  { id: 'left-near', x: -80, z: -45, rx: 9, rz: 18, count: 8, speciesOffset: 0 },
  { id: 'left-front', x: -85, z: -85, rx: 11, rz: 20, count: 9, speciesOffset: 2 },
  { id: 'left-front-middle', x: -91, z: -126, rx: 10, rz: 19, count: 8, speciesOffset: 1 },
  { id: 'left-middle', x: -94, z: -167, rx: 9, rz: 20, count: 8, speciesOffset: 0 },
  { id: 'left-middle-back', x: -92, z: -208, rx: 10, rz: 20, count: 8, speciesOffset: 2 },
  { id: 'left-back', x: -89, z: -250, rx: 12, rz: 21, count: 8, speciesOffset: 1 },
  { id: 'left-deep', x: -85, z: -292, rx: 13, rz: 20, count: 9, speciesOffset: 0 },
  { id: 'left-end', x: -77, z: -323, rx: 7, rz: 9, count: 6, speciesOffset: 2 },
  { id: 'right-tee', x: 75, z: -8, rx: 6, rz: 14, count: 6, speciesOffset: 2 },
  { id: 'right-near', x: 80, z: -43, rx: 9, rz: 17, count: 7, speciesOffset: 1 },
  { id: 'right-pond-front', x: 88, z: -81, rx: 11, rz: 19, count: 8, speciesOffset: 0 },
  { id: 'right-pond-middle', x: 94, z: -123, rx: 8, rz: 19, count: 7, speciesOffset: 2 },
  { id: 'right-pond-back', x: 95, z: -165, rx: 7, rz: 20, count: 8, speciesOffset: 1 },
  { id: 'right-middle', x: 94, z: -207, rx: 8, rz: 20, count: 8, speciesOffset: 0 },
  { id: 'right-middle-back', x: 92, z: -249, rx: 10, rz: 20, count: 8, speciesOffset: 2 },
  { id: 'right-back', x: 86, z: -290, rx: 12, rz: 20, count: 8, speciesOffset: 1 },
  { id: 'right-end', x: 78, z: -323, rx: 7, rz: 9, count: 6, speciesOffset: 0 },
]);

const AGE_SCALES = Object.freeze([0.56, 0.70, 0.84, 0.98, 1.10]);
const DOUGLAS = 'builtin.douglas-fir.pnw.v1';
const ITALIAN = 'builtin.italian-cypress.mediterranean.v1';
const MONTEREY = 'builtin.monterey-cypress.coastal.v1';
const DEFAULT_FOLIAGE_ALIASES = Object.freeze([DOUGLAS, ITALIAN, MONTEREY]);
const OAK = 'builtin.valley-oak.california.v1';
const MAPLE = 'builtin.sugar-maple.northeastern.v1';
const NATIVE_DIMENSIONS = Object.freeze({
  [DOUGLAS]: [19.5, 4.35], [ITALIAN]: [18, 1.65], [MONTEREY]: [16.5, 6.3],
  [OAK]: [17, 7.2], [MAPLE]: [18.5, 6.0],
});

// Purpose-built practice-range planting. It deliberately does not consume the
// course-vibe/environment tree records: those author a course, while this layout
// forms irregular edge communities around a permanently open hitting corridor.
export function buildRangePerimeterFoliage({ bounds, seed, foliageAliases = DEFAULT_FOLIAGE_ALIASES }) {
  if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)
    || !Number.isFinite(bounds.minZ) || !Number.isFinite(bounds.maxZ)) {
    throw new TypeError('Range perimeter foliage requires finite course bounds.');
  }
  if (!Array.isArray(foliageAliases) || foliageAliases.length < 1 || foliageAliases.length > 3
    || foliageAliases.some((alias) => typeof alias !== 'string')
    || new Set(foliageAliases).size !== foliageAliases.length) {
    throw new TypeError('Range perimeter foliage requires one to three unique aliases.');
  }
  const normalizedSeed = normalizeSeed(seed);
  const placements = [];
  const minimumSpacing = 5.8;
  for (const grove of GROVES) {
    const random = createRng(deriveSeed(normalizedSeed, `range-perimeter:${grove.id}`));
    let accepted = 0;
    for (let attempt = 0; accepted < grove.count && attempt < grove.count * 180; attempt++) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      const x = grove.x + Math.cos(angle) * grove.rx * radius;
      const z = grove.z + Math.sin(angle) * grove.rz * radius;
      if (x < bounds.minX + 8 || x > bounds.maxX - 8 || z < bounds.minZ + 8 || z > bounds.maxZ - 8) continue;
      if (Math.abs(x) <= 68) continue;
      if (placements.some((prior) => Math.hypot(x - prior.x, z - prior.z) < minimumSpacing)) continue;
      const ageIndex = (accepted * 3 + Math.floor(random() * AGE_SCALES.length)) % AGE_SCALES.length;
      const scale = AGE_SCALES[ageIndex] * (0.94 + random() * 0.12);
      const rotationY = random() * Math.PI * 2;
      const foliageAlias = foliageAliases[(accepted + grove.speciesOffset) % foliageAliases.length];
      const [nativeHeight, nativeCanopyRadius] = NATIVE_DIMENSIONS[foliageAlias] ?? [19.5, 4.35];
      placements.push(Object.freeze({
        sourceId: `generated-range-perimeter-${grove.id}-${accepted}`,
        x, z, rotationY, rotY: rotationY,
        foliageAlias, scale, targetHeight: nativeHeight * scale, canopyRadius: nativeCanopyRadius * scale,
      }));
      accepted++;
    }
    if (accepted !== grove.count) throw new Error(`Range perimeter grove ${grove.id} placed ${accepted}/${grove.count}.`);
  }
  return Object.freeze(placements);
}

export const RANGE_PERIMETER_FOLIAGE_COUNT = GROVES.reduce((sum, grove) => sum + grove.count, 0);
