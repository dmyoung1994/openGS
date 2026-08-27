import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
  RGBAFormat, SRGBColorSpace, TextureLoader, UnsignedByteType,
} from 'three';
import {
  dFdx, dFdy, float, mix, mx_noise_float, oneMinus, smoothstep, texture, vec2, vec3,
} from 'three/tsl';

export const COAST_SAND_URLS = Object.freeze({
  albedoRoughness: '/assets/materials/aerial_beach_01/aerial_beach_01_diff_rough_2k.png',
  normal: '/assets/materials/aerial_beach_01/aerial_beach_01_nor_gl_2k.jpg',
});
export const COAST_SAND_SPECULAR_INTENSITY = 0.52;

const loader = new TextureLoader();
let shared = null;
let references = 0;

function configure(texture, name, srgb = false) {
  texture.name = `coast-sand:${name}`;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// Terrain and backdrop retain the same decoded Poly Haven scan. Their meshes overlap
// at the course edge, so separate texture instances/lifetimes can expose a material
// seam even when the semantic weights match exactly.
export function acquireCoastSandTextures() {
  if (!shared) {
    let resolveReady;
    let rejectReady;
    let pending = 2;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settle = () => {
      pending -= 1;
      if (pending === 0) resolveReady();
    };
    const fail = (url) => (error) => rejectReady(new Error(
      `Required coastal sand texture failed to load: ${url}: ${error?.message || 'network error'}`,
    ));
    let albedoRoughness;
    let normal;
    if (typeof document === 'undefined') {
      albedoRoughness = new DataTexture(new Uint8Array([190, 180, 161, 232]), 1, 1, RGBAFormat, UnsignedByteType);
      normal = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
      pending = 0;
      resolveReady();
    } else {
      albedoRoughness = loader.load(
        COAST_SAND_URLS.albedoRoughness, settle, undefined, fail(COAST_SAND_URLS.albedoRoughness),
      );
      normal = loader.load(COAST_SAND_URLS.normal, settle, undefined, fail(COAST_SAND_URLS.normal));
    }
    shared = {
      textures: Object.freeze({
        albedoRoughness: configure(albedoRoughness, 'albedo-roughness', true),
        normal: configure(normal, 'normal'),
      }),
      ready,
    };
  }
  references += 1;
  return shared;
}

export function releaseCoastSandTextures(textures) {
  if (!shared || textures !== shared.textures) return false;
  references = Math.max(0, references - 1);
  if (references === 0) {
    for (const texture of Object.values(shared.textures)) texture.dispose();
    shared = null;
  }
  return true;
}

// Normalize the semantic splat weights after modulating them with broad material
// density. This preserves profile ordering but stops a 50/50 contour from reading as
// a vector line: grass tongues and sand pockets share a stable 4–18 m overlap, while
// dry and wet sand crossfade through the same scan instead of through flat colours.
export function coastTextureBlendWeights({
  dune, drySand, wetSand, shallowShelf = float(0),
}, worldXZ) {
  // The shallow shelf is still mineral substrate. Water emerges gradually above
  // it, so dropping the beach scan at the wet-sand contour exposes the backdrop's
  // flat fallback colour as a second, sharply bounded sand band. Keep the same
  // authored scan alive beneath the shelf and let the ocean own the final visual
  // handoff through depth/coverage instead of through a material discontinuity.
  const wetSubstrate = wetSand.add(shallowShelf).clamp(0, 1);
  const beachBase = dune.add(drySand).add(wetSubstrate).clamp(0, 1);
  const macroDensity = mx_noise_float(vec3(
    worldXZ.x.mul(0.055), worldXZ.y.mul(0.047), 83.7,
  )).mul(0.5).add(0.5);
  const mesoDensity = mx_noise_float(vec3(
    worldXZ.x.mul(0.16).add(worldXZ.y.mul(0.031)),
    worldXZ.y.mul(0.14).sub(worldXZ.x.mul(0.027)), 191.3,
  )).mul(0.5).add(0.5);
  const density = macroDensity.mul(0.72).add(mesoDensity.mul(0.28));
  const edgeOverlap = beachBase.mul(oneMinus(beachBase)).mul(4.0);
  const beachWeight = beachBase
    .add(density.sub(0.5).mul(0.62).mul(edgeOverlap))
    .clamp(0, 1);

  const duneRaw = dune.mul(macroDensity.mul(0.30).add(0.85));
  // A sub-linear density response broadens the region where both sand states
  // contribute without moving either semantic center. This is the material-layer
  // equivalent of a soft height blend: dry grains persist into the damp zone and
  // wet compacted pockets begin before the nominal waterline.
  const dryRaw = drySand.max(0).pow(0.42).mul(mesoDensity.mul(0.45).add(0.78));
  const wetRaw = wetSubstrate.max(0).pow(0.42)
    .mul(oneMinus(macroDensity).mul(0.42).add(0.79));
  const substrateTotal = duneRaw.add(dryRaw).add(wetRaw).max(0.001);
  return Object.freeze({
    beachWeight,
    duneWeight: duneRaw.div(substrateTotal).clamp(0, 1),
    dryWeight: dryRaw.div(substrateTotal).clamp(0, 1),
    wetWeight: wetRaw.div(substrateTotal).clamp(0, 1),
    density,
  });
}

export function sampleCoastSand(textures, worldXZ, weights) {
  const uvA = vec2(
    worldXZ.x.mul(0.952).add(worldXZ.y.mul(0.306)).div(30.0),
    worldXZ.y.mul(0.952).sub(worldXZ.x.mul(0.306)).div(30.0),
  );
  const uvB = vec2(
    worldXZ.x.mul(0.857).sub(worldXZ.y.mul(0.515)).div(47.3).add(0.371),
    worldXZ.y.mul(0.857).add(worldXZ.x.mul(0.515)).div(47.3).add(0.619),
  );
  // Reuse one base node per physical map. TextureNode clones retain that base as
  // their binding reference, so two projections cost texture samples but not two
  // WebGPU sampler bindings.
  const albedoRoughnessTexture = texture(textures.albedoRoughness);
  const normalTexture = texture(textures.normal);
  const scanA = albedoRoughnessTexture.sample(uvA);
  const scanB = albedoRoughnessTexture.sample(uvB);
  const albedo = scanA.rgb.mul(0.72).add(scanB.rgb.mul(0.28));
  const dryColor = albedo.mul(vec3(1.20, 1.16, 1.08));
  const duneColor = dryColor.mul(vec3(0.92, 0.90, 0.84));
  // Damp sand loses value and warms slightly, but it is still the same mineral
  // substrate. The former ~44% value drop turned the dry/wet crossfade into two
  // graphic stripes even when the weights were mathematically smooth.
  const moistureOverlap = weights.wetWeight.mul(oneMinus(weights.wetWeight)).mul(4.0);
  const moisture = weights.wetWeight
    .add(weights.density.sub(0.5).mul(0.22).mul(moistureOverlap))
    .clamp(0, 1);
  const wetColor = dryColor.mul(mix(
    vec3(1.0), vec3(0.90, 0.92, 0.96), moisture,
  ));
  const color = mix(dryColor, duneColor, weights.duneWeight).mul(
    mix(vec3(1.0), wetColor.div(dryColor.max(0.001)), moisture),
  );

  const normalA = normalTexture.sample(uvA).xy.mul(2).sub(1);
  const normalB = normalTexture.sample(uvB).xy.mul(2).sub(1);
  const worldSlopeA = vec2(
    normalA.x.mul(0.952).sub(normalA.y.mul(0.306)),
    normalA.x.mul(0.306).add(normalA.y.mul(0.952)),
  );
  const worldSlopeB = vec2(
    normalB.x.mul(0.857).add(normalB.y.mul(0.515)),
    normalB.y.mul(0.857).sub(normalB.x.mul(0.515)),
  );
  const footprint = dFdx(worldXZ).length().max(dFdy(worldXZ).length()).max(0.001);
  const normalVisibility = float(0.12).add(
    oneMinus(smoothstep(0.42, 3.8, footprint)).mul(0.88),
  );
  const roughnessScan = scanA.a.mul(0.72).add(scanB.a.mul(0.28));
  const dryRoughness = roughnessScan.mul(0.18).add(0.80).clamp(0.88, 0.99);
  const wetRoughness = roughnessScan.mul(0.16).add(0.76).clamp(0.82, 0.93);
  const roughness = mix(dryRoughness, wetRoughness, moisture);
  return Object.freeze({
    color,
    roughness,
    slope: worldSlopeA.mul(0.72).add(worldSlopeB.mul(0.28)).mul(normalVisibility),
  });
}
