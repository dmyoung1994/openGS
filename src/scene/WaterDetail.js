import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
  RGBAFormat, TextureLoader, UnsignedByteType,
} from 'three';
import { dFdx, dFdy, oneMinus, smoothstep, texture, vec2 } from 'three/tsl';

export const WATER_DETAIL_URL = '/assets/textures/water_detail_rgba.png';
export const WATER_DETAIL_RESOLUTION = 1024;

const loader = new TextureLoader();
let shared = null;
let references = 0;

export function configureWaterDetailTexture(detailTexture) {
  detailTexture.name = 'water:seamless-capillary-detail';
  detailTexture.wrapS = detailTexture.wrapT = RepeatWrapping;
  detailTexture.minFilter = LinearMipmapLinearFilter;
  detailTexture.magFilter = LinearFilter;
  detailTexture.anisotropy = 8;
  detailTexture.flipY = false;
  detailTexture.generateMipmaps = true;
  detailTexture.needsUpdate = true;
  return detailTexture;
}

// Pond and ocean share one decoded image and one disposal contract. Consumers
// retain a reference for their lifetime; the final release disposes the texture.
export function acquireWaterDetailTexture() {
  if (!shared) {
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const detailTexture = typeof document === 'undefined'
      ? new DataTexture(new Uint8Array([128, 128, 128, 0]), 1, 1, RGBAFormat, UnsignedByteType)
      : loader.load(
        WATER_DETAIL_URL,
        () => resolveReady(),
        undefined,
        (error) => rejectReady(error || new Error('Required shared water detail failed to load.')),
      );
    configureWaterDetailTexture(detailTexture);
    if (typeof document === 'undefined') resolveReady();
    shared = { texture: detailTexture, ready };
  }
  references += 1;
  return shared;
}

export function releaseWaterDetailTexture(detailTexture) {
  if (!shared || detailTexture !== shared.texture) return false;
  references = Math.max(0, references - 1);
  if (references === 0) {
    shared.texture.dispose();
    shared = null;
  }
  return true;
}

export function waterDetailDiagnostics() {
  return Object.freeze({ references, loaded: !!shared, url: WATER_DETAIL_URL });
}

// Shared TSL decode for both managed ponds and the maritime ocean. The two
// rotations are deliberately oblique and incommensurate. Mips are selected from
// the actual world-space fragment footprint, so camera motion cannot expose a
// distance ring or a high-frequency grid.
export function sampleWaterDetail(detailTexture, worldXZ, {
  broadScale,
  fineScale,
  broadRotation = 0.487,
  fineRotation = 1.181,
  broadFade = [0.55, 2.4],
  fineFade = [0.08, 0.42],
  broadAmplitude = 0.092,
  fineAmplitude = 0.112,
} = {}) {
  const footprint = dFdx(worldXZ).length().max(dFdy(worldXZ).length()).max(0.0001);
  const rotate = (scale, angle) => {
    const c = Math.cos(angle) * scale;
    const s = Math.sin(angle) * scale;
    return vec2(
      worldXZ.x.mul(c).add(worldXZ.y.mul(s)),
      worldXZ.x.mul(-s).add(worldXZ.y.mul(c)),
    );
  };
  const broadUv = rotate(broadScale, broadRotation);
  const fineUv = rotate(fineScale, fineRotation);
  const maxLod = Math.log2(WATER_DETAIL_RESOLUTION);
  const broadLod = footprint.mul(broadScale * WATER_DETAIL_RESOLUTION)
    .max(1).log2().clamp(0, maxLod);
  const fineLod = footprint.mul(fineScale * WATER_DETAIL_RESOLUTION)
    .max(1).log2().clamp(0, maxLod);
  const broad = texture(detailTexture, broadUv).level(broadLod);
  const fine = texture(detailTexture, fineUv).level(fineLod);
  const broadVisibility = oneMinus(smoothstep(broadFade[0], broadFade[1], footprint));
  const fineVisibility = oneMinus(smoothstep(fineFade[0], fineFade[1], footprint));
  const broadSlope = broad.rg.mul(2).sub(1).mul(broadAmplitude).mul(broadVisibility);
  const fineSlope = fine.rg.mul(2).sub(1).mul(fineAmplitude).mul(fineVisibility);
  return Object.freeze({
    footprint,
    broad,
    fine,
    broadVisibility,
    fineVisibility,
    slope: vec2(
      broadSlope.x.add(fineSlope.y.mul(0.34)),
      broadSlope.y.sub(fineSlope.x.mul(0.30)),
    ),
    sediment: broad.b.mul(0.72).add(fine.b.mul(0.28)),
    crest: broad.a.mul(0.64).add(fine.a.mul(0.36)),
  });
}
