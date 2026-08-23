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

// The Southern candidate pass uses a slightly tighter, more asymmetrical frame:
// mature live-oak masses arrive at golfer height near the tee while loblolly
// pines and smaller oak identities recede into the range edge. The default
// catalog/generic generated layout remains unchanged for existing lab tests and
// non-Augusta courses.
const AUGUSTA_GROVES = Object.freeze([
  { id: 'augusta-left-hero', x: -32, z: 0, rx: 8, rz: 12, count: 6, speciesOffset: 0 },
  { id: 'augusta-left-shoulder', x: -35, z: -45, rx: 7, rz: 18, count: 8, speciesOffset: 0 },
  { id: 'augusta-left-front', x: -39, z: -85, rx: 6, rz: 20, count: 9, speciesOffset: 1 },
  { id: 'augusta-left-front-middle', x: -51, z: -126, rx: 8, rz: 19, count: 8, speciesOffset: 0 },
  { id: 'augusta-left-middle', x: -65, z: -167, rx: 8, rz: 20, count: 8, speciesOffset: 1 },
  { id: 'augusta-left-middle-back', x: -78, z: -208, rx: 9, rz: 20, count: 8, speciesOffset: 0 },
  { id: 'augusta-left-back', x: -89, z: -250, rx: 12, rz: 21, count: 8, speciesOffset: 1 },
  { id: 'augusta-left-deep', x: -84, z: -292, rx: 13, rz: 20, count: 9, speciesOffset: 0 },
  { id: 'augusta-left-end', x: -77, z: -323, rx: 7, rz: 9, count: 6, speciesOffset: 1 },
  { id: 'augusta-right-hero', x: 33, z: 0, rx: 8, rz: 12, count: 6, speciesOffset: 1 },
  { id: 'augusta-right-shoulder', x: 36, z: -45, rx: 7, rz: 18, count: 7, speciesOffset: 1 },
  { id: 'augusta-right-front', x: 42, z: -81, rx: 6, rz: 19, count: 8, speciesOffset: 0 },
  { id: 'augusta-right-front-middle', x: 54, z: -123, rx: 8, rz: 19, count: 7, speciesOffset: 1 },
  { id: 'augusta-right-middle', x: 68, z: -165, rx: 8, rz: 20, count: 8, speciesOffset: 0 },
  { id: 'augusta-right-middle-back', x: 80, z: -207, rx: 9, rz: 20, count: 8, speciesOffset: 1 },
  { id: 'augusta-right-back', x: 90, z: -249, rx: 11, rz: 20, count: 8, speciesOffset: 0 },
  { id: 'augusta-right-deep', x: 86, z: -290, rx: 12, rz: 20, count: 8, speciesOffset: 1 },
  { id: 'augusta-right-end', x: 79, z: -323, rx: 7, rz: 9, count: 6, speciesOffset: 0 },
]);

// The Premium Range stretches the practice corridor to a full long-range view.
// Its tree line stays outside the wider hitting lane, but the mature masses keep
// arriving at golfer height all the way to the 450-yard targets instead of
// collapsing into a short horizon band.
const PREMIUM_GROVES = Object.freeze([
  { id: 'premium-left-hero', x: -34, z: -6, rx: 5, rz: 18, count: 6, speciesOffset: 0 },
  { id: 'premium-left-shoulder', x: -35, z: -54, rx: 7, rz: 24, count: 8, speciesOffset: 0 },
  { id: 'premium-left-front', x: -47, z: -105, rx: 8, rz: 26, count: 9, speciesOffset: 1 },
  { id: 'premium-left-front-middle', x: -64, z: -157, rx: 11, rz: 25, count: 8, speciesOffset: 0 },
  { id: 'premium-left-middle', x: -92, z: -211, rx: 13, rz: 27, count: 8, speciesOffset: 1 },
  { id: 'premium-left-middle-back', x: -102, z: -267, rx: 14, rz: 28, count: 8, speciesOffset: 0 },
  { id: 'premium-left-back', x: -109, z: -326, rx: 16, rz: 28, count: 8, speciesOffset: 1 },
  { id: 'premium-left-deep', x: -107, z: -388, rx: 17, rz: 27, count: 9, speciesOffset: 0 },
  { id: 'premium-left-end', x: -98, z: -443, rx: 14, rz: 17, count: 6, speciesOffset: 1 },
  { id: 'premium-right-hero', x: 35, z: -6, rx: 5, rz: 18, count: 6, speciesOffset: 1 },
  { id: 'premium-right-shoulder', x: 36, z: -54, rx: 7, rz: 24, count: 7, speciesOffset: 1 },
  { id: 'premium-right-front', x: 50, z: -101, rx: 8, rz: 26, count: 8, speciesOffset: 0 },
  { id: 'premium-right-front-middle', x: 67, z: -155, rx: 11, rz: 25, count: 7, speciesOffset: 1 },
  { id: 'premium-right-middle', x: 96, z: -210, rx: 13, rz: 27, count: 8, speciesOffset: 0 },
  { id: 'premium-right-middle-back', x: 106, z: -267, rx: 14, rz: 28, count: 8, speciesOffset: 1 },
  { id: 'premium-right-back', x: 113, z: -326, rx: 16, rz: 28, count: 8, speciesOffset: 0 },
  { id: 'premium-right-deep', x: 111, z: -388, rx: 17, rz: 27, count: 8, speciesOffset: 1 },
  { id: 'premium-right-end', x: 101, z: -443, rx: 14, rz: 17, count: 6, speciesOffset: 0 },
]);

const AGE_SCALES = Object.freeze([0.56, 0.70, 0.84, 0.98, 1.10]);
const PREMIUM_AGE_SCALES = Object.freeze([0.78, 0.96, 1.12, 1.28, 1.42]);
const DOUGLAS = 'builtin.douglas-fir.pnw.v1';
const ITALIAN = 'builtin.italian-cypress.mediterranean.v1';
const MONTEREY = 'builtin.monterey-cypress.coastal.v1';
const DEFAULT_FOLIAGE_ALIASES = Object.freeze([DOUGLAS, ITALIAN, MONTEREY]);
const OAK = 'builtin.valley-oak.california.v1';
const MAPLE = 'builtin.sugar-maple.northeastern.v1';
const SOUTHERN_OAK = 'local.southern-live-oak.augusta.v1';
const LOBLOLLY = 'local.loblolly-pine.southeast.v1';
const NATIVE_DIMENSIONS = Object.freeze({
  [DOUGLAS]: [19.5, 4.35], [ITALIAN]: [18, 1.65], [MONTEREY]: [16.5, 6.3],
  [OAK]: [17, 7.2], [MAPLE]: [18.5, 6.0],
  [SOUTHERN_OAK]: [17, 7.2], [LOBLOLLY]: [23.5, 4.8],
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
  const augustaLayout = foliageAliases.includes(SOUTHERN_OAK) || foliageAliases.includes(LOBLOLLY);
  const premiumLayout = augustaLayout && (bounds.minZ < -400 || bounds.maxX - bounds.minX > 260);
  const groves = premiumLayout ? PREMIUM_GROVES : augustaLayout ? AUGUSTA_GROVES : GROVES;
  const ageScales = premiumLayout ? PREMIUM_AGE_SCALES : AGE_SCALES;
  const placements = [];
  const minimumSpacing = 5.8;
  for (const grove of groves) {
    const random = createRng(deriveSeed(normalizedSeed, `range-perimeter:${grove.id}`));
    let accepted = 0;
    for (let attempt = 0; accepted < grove.count && attempt < grove.count * 180; attempt++) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      const x = grove.x + Math.cos(angle) * grove.rx * radius;
      const z = grove.z + Math.sin(angle) * grove.rz * radius;
      if (x < bounds.minX + 8 || x > bounds.maxX - 8 || z < bounds.minZ + 8 || z > bounds.maxZ - 8) continue;
      if (Math.abs(x) <= (premiumLayout ? 25 : augustaLayout ? 22 : 68)) continue;
      if (placements.some((prior) => Math.hypot(x - prior.x, z - prior.z) < minimumSpacing)) continue;
      const ageIndex = (accepted * 3 + Math.floor(random() * ageScales.length)) % ageScales.length;
      const scale = ageScales[ageIndex] * (0.94 + random() * 0.12);
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
