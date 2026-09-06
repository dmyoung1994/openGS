// Fixed packed PBR sources, ordered by fairway/green/rough and albedo/normal-relief.
export const TURF_PACK_SOURCE_URLS = Object.freeze(
  ['blendkit_fairway', 'blendkit_green', 'roughdetail'].flatMap(name =>
    ['alb', 'nrh'].map(suffix => `/assets/textures/${name}_${suffix}.png`)),
);
