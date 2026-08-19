import {
  BufferGeometry, Color, Float32BufferAttribute, Group, LinearMipmapLinearFilter,
  Mesh, RepeatWrapping, SRGBColorSpace, TextureLoader, Uint32BufferAttribute,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute, cameraPosition, float, mix, mx_noise_float, normalWorld, positionWorld,
  smoothstep, texture, transformNormalToView, vec2, vec3, vec4, vertexColor,
} from 'three/tsl';
import { Noise } from '../util/noise.js';
import { createRng, deriveSeed } from '../util/random.js';
import { NORTH_CASCADES_DEM } from '../terrain/northCascadesDem.js';

// Render-only world continuation outside the authoritative physics terrain.
// A shared height sampler owns every patch and distance band, so seams cannot form.
// The playable heightfield remains the only collision/surface source.
export class BackdropTerrain {
  constructor({ terrain, bounds, seed, biome = 'temperate-maritime', environment = null }) {
    this.group = new Group();
    this.group.name = `${biome}-procedural-world`;
    this.biome = biome;
    this.seed = seed >>> 0;
    this.environment = environment;

    if (biome === 'temperate-alpine') this._buildAlpine(terrain, bounds);
    else this._buildMaritime(terrain, bounds);
  }

  _buildAlpine(terrain, bounds) {
    const composition = alpineComposition(this.seed);
    this.composition = composition;
    // The horizon used to be delegated to the Poly Haven photographic HDR. That
    // source was dropped (docs/BACKDROP_PLAN.md), which left nothing at all
    // owning the skyline: the range read as a green plate under empty sky. The
    // authored shell below is the replacement and the only backdrop source now.
    //
    // Two depth bands share one continuous height sampler, so no seam can form
    // between them or against the playable edge:
    //   Band A  rectangular ring, course edge -> 1.4 km, 30 m spacing. Relief is
    //           genuinely visible here (spurs, drainage, the wall band, the
    //           tree-line base), so it keeps the full geology attribute.
    //   Band B  azimuth ribbon, 1.4 km -> 3.3 km. At that range 1 m of geometry
    //           is well under a pixel, so the massif is perceived as skyline
    //           plus broad faces; a radial grid there would be wasted vertices.
    const sampler = alpineSampler(terrain, bounds, this.seed, composition);
    this.group.userData.backdropSource = 'procedural-alpine-shell';
    this.group.userData.proceduralShell = true;
    this.group.userData.authoringSampler = sampler;
    this.assetsReady = Promise.resolve();

    // The reviewed granite source finally reaches the render path. It has shipped
    // as a required, hash-pinned asset for several cycles, but `worldMaterial`
    // was only ever called with its texture argument defaulted to null, so the
    // massif carried no surface texture at all — every face was a low-frequency
    // noise multiply over an interpolated vertex colour, which is most of why the
    // rock read as smooth painted clay.
    const material = worldMaterial('distant-temperate-alpine-ground', 'temperate-alpine',
      loadGraniteAlbedo(), { environment: this.environment, snowline: composition.snowline });
    for (const patch of ringPatches(bounds, 0, ALPINE_BAND_A_OUTER)) {
      const mesh = new Mesh(buildPatch(...patch, ALPINE_BAND_A_SPACING, sampler), material);
      mesh.name = 'alpine-foothill-band';
      this._addShellMesh(mesh);
    }
    for (const geometry of alpineMassifRibbon(bounds, sampler)) {
      const mesh = new Mesh(geometry, material);
      mesh.name = 'alpine-far-massif';
      this._addShellMesh(mesh);
    }
  }

  // Render-only scenery: never a shadow caster or receiver, never collidable,
  // and drawn before the playable terrain so it can never overdraw the hero turf.
  _addShellMesh(mesh) {
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = -2;
    this.group.add(mesh);
  }

  _buildMaritime(terrain, bounds) {
    const noise = new Noise(this.seed ^ 0x7a31c4e9);
    const extent = 440;
    const sample = (x, z) => sampleMaritime(terrain, bounds, noise, x, z, extent);
    const material = worldMaterial('distant-temperate-maritime-ground', 'temperate-maritime');
    this.assetsReady = Promise.resolve();
    for (const patch of ringPatches(bounds, 0, extent)) {
      const mesh = new Mesh(buildPatch(...patch, 18, sample), material);
      mesh.name = 'maritime-distant-terrain';
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      mesh.renderOrder = -2;
      this.group.add(mesh);
    }
  }

  dispose() {
    const geometries = new Set();
    const materials = new Set();
    this.group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.clear();
  }
}

export function alpineComposition(seed) {
  const random = createRng(deriveSeed(seed, 'alpine-basin-composition-v2'));
  const dominantSide = random() < 0.5 ? -1 : 1;
  return Object.freeze({
    dominantSide,
    // Keep both basin walls inside the golfer-height 40-degree camera's useful
    // horizontal field. The previous +46/-71 degree bearings put one swollen
    // shoulder at the extreme right edge and hid the opposite wall entirely.
    dominantAzimuth: dominantSide * (0.38 + random() * 0.12),
    secondaryAzimuth: -dominantSide * (0.46 + random() * 0.12),
    openingAzimuth: (random() - 0.5) * 0.16,
    // Raised with the massif. 360-430 m was calibrated against a shell whose
    // crest reached ~550 m on two narrow bearings and under 260 m everywhere
    // else, so almost nothing ever crossed it. Against summits at 750-930 m the
    // same value sits a third of the way up the range and turns the whole
    // backdrop white. A real alpine snowline sits high on the massif and caps
    // only the summits.
    snowline: 640 + random() * 80,
    peakScale: 0.92 + random() * 0.16,
  });
}

export function sampleAlpineWorld({ terrain, bounds, seed, x, z, composition = alpineComposition(seed) }) {
  return alpineSampler(terrain, bounds, seed, composition)(x, z);
}

function alpineSampler(terrain, bounds, seed, composition) {
  const broadNoise = new Noise(seed ^ 0x54bd39a1);
  const detailNoise = new Noise(seed ^ 0x2f1c8e77);
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const playableRadius = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.44;

  // The patch builder asks for the same physical sample four more times to
  // derive a continuous normal.  Keep that path on the exact same height
  // function, but let it stop before the render-only colour/geology fields.
  // Those fields are useful once per vertex, but evaluating them for normal
  // taps was a large fraction of cold range startup with no visual benefit.
  const sampler = (x, z, heightOnly = false) => {
    const cx = clamp(x, bounds.minX, bounds.maxX);
    const cz = clamp(z, bounds.minZ, bounds.maxZ);
    const edgeDistance = Math.hypot(x - cx, z - cz);
    const blend = smootherstep(0, 180, edgeDistance);
    const edgeHeight = terrain.heightAt(cx, cz);
    const dx = x - centerX;
    const dz = z - centerZ;
    const radial = Math.max(0, Math.hypot(dx, dz) - playableRadius);
    const azimuth = Math.atan2(dx, -dz);

    // Domain warp keeps ridge systems coherent while preventing concentric contours.
    const warpX = broadNoise.fbm(x * 0.00042, z * 0.00042, { octaves: 3 }) * 210;
    const warpZ = broadNoise.fbm(x * 0.00039 + 17, z * 0.00039 - 11, { octaves: 3 }) * 190;
    const wx = x + warpX;
    const wz = z + warpZ;
    const foot = smootherstep(70, 900, radial);
    // The low-frequency ridge skeleton comes from a fixed, offline-baked USGS
    // 3DEP sample. It is deliberately render-only: the playable terrain remains
    // authoritative, and the table is bundled so no runtime network request is
    // needed. The procedural fields below stay as bounded meso breakup and seed-
    // stable composition detail, rather than inventing the mountain silhouette.
    // Use one broad mountain envelope for the visible relief. The former wall +
    // massif ramps were individually added to every ridge term, which made the
    // backdrop read as concentric stacked shells even when the noise was warped.
    // Bring the first structural shoulder forward.  The old 420–3000 m ramp
    // left the golfer looking at a dark, nearly planar forest shelf until the
    // distant massif finally appeared.  This remains one continuous envelope,
    // but its toe, wall, and high mass now overlap like a real glacial basin.
    const mountain = smootherstep(260, 2350, radial);
    const highMass = smootherstep(980, 2850, radial);
    const demField = sampleNorthCascadesDem(x, z);
    // Contrast the measured elevation field before applying its amplitude. The
    // source DEM is intentionally compact (128²) and its linear interpolation
    // otherwise rounds every crest into a broad swell at the far-band spacing.
    // This monotone contrast preserves drainage ordering while restoring the
    // asymmetric ridge/valley hierarchy visible from golfer height.
    const demDelta = demField - 0.50;
    const demContrast = 0.50 + Math.sign(demDelta) * Math.pow(Math.abs(demDelta), 0.84);
    // The table is 128 samples across 7.6 km: one cell is 59 m. It can carry
    // COMPOSITION -- where the massif is high and which way the drainages run --
    // but it cannot carry relief: 800 m of amplitude across a 59 m cell is a
    // 7:1 slope no interpolation can rescue, which is what the old 240 m box
    // blur was really there to hide. The ridged multifractal owns relief now, so
    // the measured field is scaled back to the broad envelope it can actually
    // support and is no longer blurred into a featureless swell.
    const demRelief = (demContrast - 0.50) * (mountain * 250 + highMass * 110);

    // Two unequal mountain walls, an off-axis dominant massif, and a deliberately
    // lower down-range valley opening. Angular Gaussian lobes shape composition;
    // ridged noise supplies geology inside those authored relationships.
    // Keep the walls broad enough to frame the course, but let the authored ridge
    // tracks (below) carry most of the relief.  Wide, high lobes are what made the
    // previous version read as inflated procedural blobs from the pond camera.
    const dominant = angularLobe(azimuth, composition.dominantAzimuth, 0.34);
    const secondary = angularLobe(azimuth, composition.secondaryAzimuth, 0.38);
    const sideWalls = 0.30 + 0.72 * Math.max(dominant, secondary * 0.82);
    const valley = angularLobe(azimuth, composition.openingAzimuth, 0.36);
    // Widen the downrange U-shaped window only through the near/middle wall.
    // Its smooth depth profile exposes the accepted HDR peaks without making a
    // hard trench at the playable edge or changing the far skyline composition.
    // Narrowed from 0.68. The window has to stay deep on the aiming line while
    // leaving its two flanking shoulders standing; at 0.68 the lobe was still
    // at 0.78 a half-radian off centre, so the fade that opens the U was also
    // flattening the shoulders that frame it.
    const openingWindow = angularLobe(azimuth, composition.openingAzimuth, 0.52)
      * smootherstep(220, 820, radial) * (1 - smootherstep(1320, 2100, radial));
    const openingSaddle = openingWindow * (68 + smootherstep(500, 1220, radial) * 14);
    // The broad U-window frames the basin, but its centre must fall below the
    // two near-toe shoulders rather than reading as one green berm. A narrower,
    // smooth floor lobe lowers only the downrange centre; it uses the authored
    // opening bearing and radial easing, so no new noise or camera-dependent
    // terrain is introduced and the continuous backdrop remains grounded.
    const openingFloorWindow = angularLobe(azimuth, composition.openingAzimuth, 0.24)
      * smootherstep(240, 680, radial) * (1 - smootherstep(1320, 2400, radial));
    const openingFloorCut = openingFloorWindow
      * (60 + smootherstep(500, 1100, radial) * 8);
    const openingShoulderFade = 1 - openingWindow * 0.50;
    // Keep the cut visibly open while allowing resistant ribs and drainage
    // planes to survive inside it. The opening is a valley window, not a
    // material mask that erases the geology coupled to the height field.
    const openingLandformFade = 1 - openingWindow * 0.40;
    const enclosure = Math.max(0.14, sideWalls * (1 - valley * 0.82));
    // Three depth-separated landform tiers give the fixed golfer cameras a real
    // basin reading: a low near shoulder, a broken middle wall, then a farther
    // massif. Each radial envelope is bearing-weighted, so this is not a set of
    // concentric shells; the central opening remains a deliberate low window.
    // Keep the first landform low enough that it reads as a real basin toe, not
    // a continuous green wall in front of the mountains.  The authored ridge
    // tracks below still lift the individual spurs; this baseline is deliberately
    // restrained so saddles expose atmosphere and the playable tree line.
    const nearShoulder = smootherstep(140, 760, radial)
      * (0.38 + secondary * 0.26) * openingShoulderFade;
    const middleWall = smootherstep(580, 1680, radial)
      * (0.28 + sideWalls * 0.72) * (1 - valley * 0.42) * openingShoulderFade;
    const farMassif = smootherstep(1420, 3200, radial)
      * (0.24 + (dominant * 0.58 + secondary * 0.42) * 0.76)
      * (1 - valley * 0.58);
    // Broken crests sit on those tiers as broad warped depth ridges. Their
    // bearings and widths vary with the two authored walls, so they read as
    // overlapping glacial spurs rather than repeated radial contour shells.
    const depthWarp = broadNoise.fbm(wx * 0.0011 + 3, wz * 0.0009 - 7, { octaves: 2 }) * 130;
    const warpedDepth = radial + depthWarp;
    const nearCrest = Math.exp(-(((warpedDepth - 760) / 270) ** 2))
      * (0.24 + (dominant * 0.62 + secondary * 0.38) * 0.76);
    const middleCrest = Math.exp(-(((warpedDepth - 1580) / 370) ** 2))
      * (0.26 + sideWalls * 0.74) * (1 - valley * 0.34);
    // A broad saddle before the far ridge is important from golfer height: a
    // steadily rising envelope reads as a pasted wall even when its albedo is
    // varied. Keep the break wide and smooth so it survives the coarser far
    // mesh without producing a faceted skyline.
    const farSaddle = Math.exp(-(((warpedDepth - 1900) / 300) ** 2))
      * (0.20 + sideWalls * 0.50) * (1 - valley * 0.34);
    const farCrest = Math.exp(-(((warpedDepth - 2520) / 460) ** 2))
      * (0.20 + (dominant * 0.64 + secondary * 0.36) * 0.80) * (1 - valley * 0.46);

    // The basin is built from an authored ridge skeleton first. A long, warped
    // peak train produces knife-like alpine crests; subordinate angular chains
    // create asymmetric cirques. Broad fBm is only a low-amplitude substrate now,
    // so smooth inflated noise hills cannot dominate the skyline.
    const rolling = broadNoise.fbm(wx * 0.0015, wz * 0.0015, { octaves: 4 });
    const ridges = broadNoise.ridged(wx * 0.00078, wz * 0.00105, { octaves: 4 });
    const folded = detailNoise.ridged(wx * 0.0024 + 8, wz * 0.0018 - 3, { octaves: 3 });
    // Raw ridged noise clusters near one, which produces a swollen plateau. Cut it
    // into narrow ridge crests and subordinate folds so the horizon reads as peaks.
    // Use broad fBm envelopes for the shoulder breaks. Thresholding a ridged
    // field here created large derivatives at its crest boundaries; those
    // compounded with DEM relief into the needle towers rejected in the pond
    // camera. The ridge/face fields below still supply broken mineral variation.
    const ridgeCrest = smootherstep(0.28, 0.78, ridges * 0.5 + 0.5);
    const foldCrest = smootherstep(0.30, 0.80, folded * 0.5 + 0.5);
    const drainage = detailNoise.fbm(wx * 0.0033, wz * 0.0033, { octaves: 2 });
    // Narrow, warped erosion channels and face ribs are render-only geology: they
    // sit below the authored ridge skeleton, but are large enough to survive the
    // fixed pond view and break the swollen smooth mountain faces.
    const gullyWarp = broadNoise.fbm(wx * 0.0022 + 31, wz * 0.0021 - 17, { octaves: 2 }) * 90;
    const gullyField = detailNoise.fbm((wx + gullyWarp) * 0.0048, (wz - gullyWarp * 0.6) * 0.0048, { octaves: 3 });
    // The old .64/.92 threshold almost never survived the 12–24 m mountain
    // vertices.  These channels are intentionally broad enough to span at least
    // two samples, but their warped field remains irregular rather than striped.
    const gullyMask = smootherstep(0.32, 0.80, Math.abs(gullyField));
    // Face ribs are broad bedding breaks, not a high-frequency ridged field. The
    // previous ridged signal could jump across one 8–14 m far-band vertex and
    // create a solitary needle or a crushed black slot under grazing light.
    const faceRibNoise = detailNoise.fbm(wx * 0.0027 + 11, wz * 0.0022 - 7, { octaves: 3 });
    const faceRibs = smootherstep(0.34, 0.74, faceRibNoise * 0.5 + 0.5);
    // An incommensurate ridged field accumulates talus fans below exposed faces;
    // broad enough to survive haze, irregular enough to avoid contour striping.
    const talusField = detailNoise.ridged(wx * 0.0038 - 19, wz * 0.0051 + 23, { octaves: 3 });
    // Talus follows the broad exposed mountain envelope, not a radial annulus.
    // The old 85–620 / 1250–2200 m window painted a dark contour shelf across
    // foothills in address/approach views.
    const talusFan = smootherstep(0.48, 0.82, talusField)
      * mountain * (1 - highMass * 0.55);
    // Do not use radial sine trains here: those make concentric shell terraces
    // around the basin. Two warped ridge skeletons provide discrete peak chains
    // without a repeat distance, subordinate to the authored angular walls.
    const ridgeWarpX = broadNoise.fbm(wx * 0.0010 + 7, wz * 0.0012 - 9, { octaves: 2 }) * 170;
    const ridgeWarpZ = broadNoise.fbm(wx * 0.0012 - 13, wz * 0.0009 + 5, { octaves: 2 }) * 150;
    const peakTrain = smootherstep(0.24, 0.76,
      broadNoise.fbm((wx + ridgeWarpX) * 0.00105, (wz + ridgeWarpZ) * 0.00086, { octaves: 3 }) * 0.5 + 0.5);
    const peakTrain2 = smootherstep(0.26, 0.78,
      detailNoise.fbm((wx - ridgeWarpZ * 0.7) * 0.00165 + 1.8, (wz + ridgeWarpX * 0.5) * 0.0013, { octaves: 2 }) * 0.5 + 0.5);
    // Ridged noise is used as a broken amplitude envelope, not as the ridge
    // itself.  Its raw values cluster toward one and create swollen plateaus,
    // so the broad baseline is deliberately small.
    const dominantRidge = dominant * (0.06 + 0.34 * peakTrain);
    const secondaryRidge = secondary * (0.06 + 0.36 * peakTrain2);

    // The near wall needs its own landform scale. A single radial envelope makes
    // the first 700--1400 m read as one continuous shelf until the distant massif
    // arrives. These two oblique, world-space fields create broad spur shoulders
    // and drainage saddles that remain coherent across adjacent patches; unlike a
    // radial sine train they do not repeat around the course or make a second shell.
    const foothillAlong = (wx - centerX) * 0.64 + (wz - centerZ) * 0.77;
    const foothillCross = (wx - centerX) * 0.77 - (wz - centerZ) * 0.64;
    // Reuse the domain-warp displacement already evaluated for the DEM/ridge
    // skeleton; this adds no new noise octaves to the normal-height path.
    const foothillTrack = warpX * 0.78 + warpZ * 0.62;
    const foothillOffset = Math.abs(foothillCross - foothillTrack);
    const foothillSpur = Math.exp(-((foothillOffset / 470) ** 1.42));
    const foothillCrest = Math.exp(-((foothillOffset / 205) ** 1.72));
    const foothillRidge = (foothillSpur * 0.70 + foothillCrest * 0.30)
      * smootherstep(170, 1560, radial);
    // Existing broad rolling/drainage fields provide the fold/saddle polarity;
    // keeping them shared avoids reintroducing expensive geology sampling during
    // normal construction.
    const foothillFold = smootherstep(0.24, 0.76, rolling * 0.5 + 0.5);
    const foothillBasin = smootherstep(0.34, 0.78, drainage * 0.5 + 0.5);
    // Fade the near-wall field before the high massif: letting it persist at full
    // strength into the 14 m far ring was enough to create an over-steep single
    // vertex on the skyline.
    const foothillBand = smootherstep(180, 1740, radial) * (1 - highMass);
    const lowerLandform = foothillBand
      * ((foothillRidge * 0.84 + foothillFold * 0.16) - foothillBasin * 0.52);

    // The first visible wall needs its own geologic transition.  The old
    // altitude-only exposure left the 500--800 m toe entirely conifer-green,
    // then switched abruptly to mineral near the massif cap.  This band follows
    // the same oblique spur/saddle and drainage fields as the height sampler:
    // convex spurs expose rock, while basin polarity leaves meadow and conifer
    // toes.  It is a smooth finite envelope, not a radial terrace or a new mesh.
    const wallBand = smootherstep(300, 500, radial)
      * (1 - smootherstep(1320, 1680, radial));
    const wallWash = wallBand * (
      smootherstep(0.24, 0.78, Math.abs(drainage)) * 0.62
      + foothillBasin * 0.28
    );
    const wallOutcrop = wallBand * clamp(
      0.08 + foothillRidge * 0.54 + foothillCrest * 0.34
        + ridgeCrest * 0.16 - foothillBasin * 0.52
        + smootherstep(0.22, 0.78, Math.abs(drainage)) * 0.18,
      0, 1,
    );
    // Give the toe a broad spur shoulder and irregular wash cuts.  Keep the
    // amplitude below the existing ridge skeleton so edge continuity and the
    // bounded slope/curvature contract remain unchanged.
    const wallRelief = wallBand * (
      (foothillRidge * 0.80 + foothillFold * 0.16) * 10
      - foothillBasin * 6
      - wallWash * 4
    );

    // Structural toe/bench/outcrop planes.  These are three localized oblique
    // spurs along the same warped strike, each occupying a different depth
    // window.  Gaussian cross-strike profiles avoid radial repetition while the
    // broad along-strike envelopes keep the skyline smooth at 10/16 m sampling.
    const spurFrame = foothillCross - foothillTrack;
    const toeSpur = Math.exp(-(((spurFrame - 330) / 450) ** 2))
      * smootherstep(250, 470, radial) * (1 - smootherstep(700, 980, radial));
    const benchLobe = Math.exp(-(((spurFrame + 300) / 500) ** 2))
      * smootherstep(470, 680, radial) * (1 - smootherstep(920, 1240, radial));
    const outcropLobe = Math.exp(-(((spurFrame - 110) / 420) ** 2))
      * smootherstep(760, 940, radial) * (1 - smootherstep(1180, 1480, radial));
    const drainageCut = smootherstep(0.22, 0.82, Math.abs(drainage))
      * (0.42 + 0.58 * foothillBasin)
      * smootherstep(300, 620, radial) * (1 - smootherstep(1080, 1420, radial));
    // Raise the existing oblique spur planes into golfer-visible relief. These
    // broad Gaussian landforms remain smooth across patches and leave the
    // authored valley opening intact; they are not a repeated radial shell.
    const spurRelief = toeSpur * 60 + benchLobe * 52 + outcropLobe * 68 - drainageCut * 38;

    // Add one physical meso scale inside the broad spurs: resistant ribs,
    // incised drainage slots, and talus pockets at roughly 20--45 m spacing.
    // These are world-anchored and warped by the existing foothill strike, so
    // they continue across patch boundaries without becoming radial terraces.
    // Keep the envelope out of the valley window and fade it before the far
    // massif; the coarse silhouette remains owned by the authored ridge field.
    const wallMesoBand = smootherstep(300, 380, radial)
      * (1 - smootherstep(1260, 1510, radial))
      * (0.34 + sideWalls * 0.66) * (1 - valley * 0.52);
    const mesoRibNoise = detailNoise.fbm(
      (wx + foothillAlong * 0.14 + foothillTrack * 0.26) * 0.021,
      (wz - foothillAlong * 0.10 + foothillTrack * 0.18) * 0.018,
      { octaves: 2 },
    );
    const mesoRib = wallMesoBand
      * smootherstep(0.34, 0.74, mesoRibNoise * 0.5 + 0.5)
      * (0.52 + foothillRidge * 0.48);
    const mesoIncisionNoise = detailNoise.fbm(
      (wx - foothillTrack * 0.22) * 0.034,
      (wz + foothillTrack * 0.16) * 0.029,
      { octaves: 3 },
    );
    const mesoIncision = wallMesoBand
      * smootherstep(0.18, 0.56, Math.abs(mesoIncisionNoise))
      * (0.50 + foothillBasin * 0.50);
    const mesoTalusNoise = detailNoise.ridged(
      (wx + foothillAlong * 0.08) * 0.017 - 13,
      (wz - foothillAlong * 0.12) * 0.020 + 19,
      { octaves: 2 },
    );
    const mesoTalus = wallMesoBand
      * smootherstep(0.48, 0.78, mesoTalusNoise)
      * smootherstep(340, 980, radial)
      * (1 - mesoIncision * 0.42);
    // Keep the meso planes broad enough to read at golfer height. Positive
    // resistant ribs, negative runoff cuts, and lower talus all share the same
    // continuous height authority used by patch normals and edge blending.
    const mesoRelief = mesoRib * 6.0 - mesoIncision * 4.0 + mesoTalus * 2.0;

    // Golfer-scale glacial planes: two unequal, oblique spurs and one incised
    // chute overlap the 300--950 m toe. Along-strike gates keep these from
    // becoming a repeated radial ring, while the broad cross profiles survive
    // the 10 m foothill grid as real silhouette/normal changes.
    const nearSpurA = Math.exp(-(((foothillAlong - 250) / 620) ** 2))
      * Math.exp(-(((spurFrame - 470) / 250) ** 2))
      * smootherstep(280, 390, radial) * (1 - smootherstep(700, 920, radial));
    const nearSpurB = Math.exp(-(((foothillAlong + 470) / 540) ** 2))
      * Math.exp(-(((spurFrame + 360) / 220) ** 2))
      * smootherstep(410, 520, radial) * (1 - smootherstep(780, 1010, radial));
    const glacialChute = Math.exp(-(((foothillAlong - 40) / 760) ** 2))
      * Math.exp(-(((spurFrame + 70) / 125) ** 2))
      * smootherstep(500, 610, radial) * (1 - smootherstep(860, 1080, radial));
    const landformRib = nearSpurA * 0.78 + nearSpurB * 0.64;
    const landformDrain = glacialChute * (0.72 + foothillBasin * 0.28);
    const glacialPlaneRelief = (landformRib * 46 - landformDrain * 29) * openingLandformFade;
    // Keep the widened saddle from becoming a single smooth cut: two existing,
    // unequal toe mouths hold up the left/right shoulders while the chute opens
    // a lower drainage mouth between them. No new field or radial repetition.
    const openingShoulderRelief = (nearSpurA * 6 + nearSpurB * 4 - glacialChute * 6)
      * openingLandformFade;

    // Address-scale hierarchy: two unequal resistant shoulders, a middle bench,
    // and one oblique drainage breach. These signed-distance-like profiles use
    // the established along/cross frame, so height, geology, and PBR response
    // remain coupled without a radial terrace or an additional noise field.
    const hierarchyShoulderA = Math.exp(-(((foothillAlong + 260) / 760) ** 2))
      * Math.exp(-(((spurFrame - 360) / 290) ** 2))
      * smootherstep(140, 500, radial) * (1 - smootherstep(600, 1000, radial));
    const hierarchyShoulderB = Math.exp(-(((foothillAlong - 420) / 720) ** 2))
      * Math.exp(-(((spurFrame + 300) / 260) ** 2))
      * smootherstep(300, 650, radial) * (1 - smootherstep(800, 1200, radial));
    const hierarchyBench = Math.exp(-(((foothillAlong + 40) / 900) ** 2))
      * Math.exp(-(((spurFrame - 80) / 420) ** 2))
      * smootherstep(500, 850, radial) * (1 - smootherstep(1000, 1400, radial));
    const hierarchyDrain = Math.exp(-(((foothillAlong - 60) / 880) ** 2))
      * Math.exp(-(((spurFrame + 10) / 105) ** 2))
      * smootherstep(260, 600, radial) * (1 - smootherstep(1000, 1400, radial));
    const hierarchyFade = 1 - valley * 0.70;
    const hierarchyRib = (hierarchyShoulderA * 0.86 + hierarchyShoulderB * 0.76) * hierarchyFade;
    const hierarchyDrainage = hierarchyDrain * (0.76 + foothillBasin * 0.24) * hierarchyFade;
    const hierarchyBenchPlane = hierarchyBench * (0.64 + foothillRidge * 0.36) * hierarchyFade;
    const hierarchyRelief = hierarchyRib * 28 + hierarchyBenchPlane * 20 - hierarchyDrainage * 24;

    // Three smooth signed-distance buttresses replace the broad first-wall
    // ramp with distinct toe/bench/outcrop planes. Each profile has a separate
    // radial depth and along-strike gate, then shares a warped cross coordinate
    // so it cannot become a periodic contour terrace. Matching saddles are
    // subtracted from the same height field and exposed through the geology
    // channels returned below.
    const buttressCross = spurFrame - foothillTrack * 0.35;
    const toeButtress = (1 - smootherstep(0, 300, Math.abs(buttressCross - 280)))
      * Math.exp(-(((foothillAlong + 180) / 660) ** 2))
      * smootherstep(300, 390, radial) * (1 - smootherstep(540, 680, radial));
    const benchButtress = (1 - smootherstep(0, 280, Math.abs(buttressCross + 190)))
      * Math.exp(-(((foothillAlong - 340) / 720) ** 2))
      * smootherstep(500, 620, radial) * (1 - smootherstep(760, 900, radial));
    const outcropButtress = (1 - smootherstep(0, 250, Math.abs(buttressCross - 120)))
      * Math.exp(-(((foothillAlong + 520) / 640) ** 2))
      * smootherstep(740, 850, radial) * (1 - smootherstep(1000, 1140, radial));
    const toeSaddle = (1 - smootherstep(0, 92, Math.abs(buttressCross + 35)))
      * Math.exp(-(((foothillAlong + 80) / 700) ** 2))
      * smootherstep(360, 450, radial) * (1 - smootherstep(600, 720, radial));
    const benchSaddle = (1 - smootherstep(0, 80, Math.abs(buttressCross - 40)))
      * Math.exp(-(((foothillAlong - 280) / 760) ** 2))
      * smootherstep(580, 670, radial) * (1 - smootherstep(800, 920, radial));
    const buttressRib = toeButtress * 0.76 + benchButtress * 0.70 + outcropButtress * 0.66;
    const buttressDrain = toeSaddle * 0.72 + benchSaddle * 0.68;
    const buttressRelief = (toeButtress * 25 + benchButtress * 25
      + outcropButtress * 25 - toeSaddle * 10 - benchSaddle * 10) * openingLandformFade;

    // The first wall needs a readable shoulder succession even on the valley
    // bearing. Reuse the existing warped spur/basin signals rather than adding a
    // second noise field: convex shoulders get one broad resistant plane, while
    // the basin signal cuts a lower drainage pocket between them. The valley
    // centre remains open because both terms are attenuated by its authored lobe.
    const shoulderPlane = wallMesoBand
      * (0.34 + foothillRidge * 0.66)
      * (1 - valley * 0.74);
    const shoulderDrain = wallMesoBand
      * (0.30 + foothillBasin * 0.70)
      * (1 - valley * 0.48);
    // Keep the added relief below the established slope/curvature envelope at
    // the coarse 10 m foothill grid; its purpose is plane separation, not a new
    // sharp ridge.
    const shoulderPlaneRelief = shoulderPlane * 10 - shoulderDrain * 6;

    // A mountain range is not an inflated radial lobe: its spurs stay coherent
    // along strike and then break into cirques across the face.  These two
    // warped ridge tracks are cheap CPU-domain geometry, not extra meshes, and
    // keep the silhouette legible at the 12–24 m far-band sampling density.
    const dominantAxisX = Math.sin(composition.dominantAzimuth);
    const dominantAxisZ = -Math.cos(composition.dominantAzimuth);
    const dominantAlong = (wx - centerX) * dominantAxisX + (wz - centerZ) * dominantAxisZ;
    const dominantCross = (wx - centerX) * dominantAxisZ - (wz - centerZ) * dominantAxisX;
    const dominantTrack = broadNoise.fbm(dominantAlong * 0.00082 + 5,
      dominantCross * 0.00054 - 13, { octaves: 2 }) * 220;
    const dominantOffset = Math.abs(dominantCross - dominantTrack);
    // A two-scale ridge profile gives a crisp crest and broad shoulder while
    // keeping both derivatives continuous (no low-poly sawtooth silhouette).
    const dominantSpur = Math.exp(-((dominantOffset / 620) ** 1.38));
    const dominantCrest = Math.exp(-((dominantOffset / 280) ** 1.76));
    const dominantRidgeProfile = (dominantSpur * 0.74 + dominantCrest * 0.26)
      * smootherstep(420, 2100, radial);
    const secondaryAxisX = Math.sin(composition.secondaryAzimuth);
    const secondaryAxisZ = -Math.cos(composition.secondaryAzimuth);
    const secondaryAlong = (wx - centerX) * secondaryAxisX + (wz - centerZ) * secondaryAxisZ;
    const secondaryCross = (wx - centerX) * secondaryAxisZ - (wz - centerZ) * secondaryAxisX;
    const secondaryTrack = detailNoise.fbm(secondaryAlong * 0.0010 - 9,
      secondaryCross * 0.00062 + 17, { octaves: 2 }) * 180;
    const secondaryOffset = Math.abs(secondaryCross - secondaryTrack);
    const secondarySpur = Math.exp(-((secondaryOffset / 660) ** 1.34));
    const secondaryCrest = Math.exp(-((secondaryOffset / 320) ** 1.72));
    const secondaryRidgeProfile = (secondarySpur * 0.72 + secondaryCrest * 0.28)
      * smootherstep(520, 2250, radial);

    // Distinct North Cascades-scale planes sit inside the first wall: a low
    // forested toe, a broad glacial bench, then broken mineral outcrops.  The
    // radial envelopes only establish depth; each plane is weighted by the
    // oblique spur/saddle fields and the authored valley opening so it cannot
    // become a repeated contour shell around the course.
    const benchBand = smootherstep(460, 620, radial)
      * (1 - smootherstep(880, 1080, radial)) * (1 - valley * 0.68);
    const benchSpur = clamp(
      0.18 + foothillRidge * 0.68 + foothillFold * 0.22
        - foothillBasin * 0.48 + dominantRidgeProfile * 0.16,
      0, 1,
    );
    const outcropBand = smootherstep(720, 900, radial)
      * (1 - smootherstep(1240, 1500, radial)) * (1 - valley * 0.58);
    const outcropSpur = clamp(
      0.10 + dominantRidgeProfile * 0.56 + secondaryRidgeProfile * 0.34
        + foothillCrest * 0.24 + faceRibs * 0.18
        - foothillBasin * 0.30,
      0, 1,
    );
    const benchWash = benchBand * smootherstep(0.20, 0.78, Math.abs(drainage));
    // Broad, low-amplitude shelves survive the 10/16 m backdrop grids while
    // staying well below the existing massif relief and slope contract.
    const benchRelief = benchBand * ((benchSpur - 0.42) * 42 - benchWash * 16);
    const outcropRelief = outcropBand * ((outcropSpur - 0.32) * 38 - wallWash * 10);
    // Keep the same warped cliff skeleton in geometry as in the material. A
    // material-only cliff signal still leaves a smooth interpolated lobe, which
    // is exactly the stylized look this field is meant to break.
    const cliffField = smootherstep(0.54, 0.86,
      detailNoise.ridged((wx + ridgeWarpX * 0.6) * 0.0032 - 27,
        (wz - ridgeWarpZ * 0.5) * 0.0027 + 31, { octaves: 2 }));
    const cirqueCut = smootherstep(0.44, 0.82, Math.abs(drainage)) * (dominant * 0.75 + secondary * 0.45);
    // Long wash cuts are aligned with the ridge tracks and widen toward their
    // talus toes.  This subtractive pass is what turns a smooth mountain wall
    // into distinct faces without radial terrace bands.
    const crossWash = smootherstep(0.54, 0.88, Math.abs(
      detailNoise.fbm(wx * 0.0015 + dominantAlong * 0.00028,
        wz * 0.0017 + secondaryAlong * 0.00022, { octaves: 2 }),
    ));
    // Elongated, warped chutes run down the faces toward the talus toes.  They
    // are deliberately aperiodic and low amplitude: enough to notch the mesh at
    // the 12–24 m far-band spacing, without becoming contour stripes or gullies
    // that sever the course-edge continuation.
    const chuteField = smootherstep(0.24, 0.56, Math.abs(detailNoise.fbm(
      (wx + dominantAlong * 0.24) * 0.0030 + 21,
      (wz + secondaryAlong * 0.18) * 0.0025 - 14,
      { octaves: 3 },
    )));
    const talusToe = talusFan * smootherstep(380, 1100, radial) * (1 - highMass * 0.72);
    // Build the massif as broad ridge shoulders first, then let erosion articulate
    // those shoulders.  In the previous field, six independent masks each removed
    // 50--175 m from a coarse 12--24 m grid. Their coincidences generated needles,
    // inverted-looking bowls, and swollen noise lobes instead of eroded rock.  The
    // bounded terms below retain the same deterministic geology signals, but keep
    // every cut subordinate to a continuous ridge volume.
    // A glacial opening reveals a lower saddle and farther peaks; it is not an
    // infinitely deep cut to empty sky. Preserve the near/mid valley subtraction,
    // then recover a broken far ridge only after the high-mass envelope begins.
    const distantSaddle = valley * highMass
      * (72 + peakTrain * 34 + peakTrain2 * 18);
    const farWallLift = (dominant + secondary * 0.82) * highMass * 180;
    const authoredValleyRelief = -valley * (mountain * 168 + highMass * 96)
      + distantSaddle
      + farWallLift
      + sideWalls * (mountain * 62 + highMass * 42);
    // Keep the measured ridge relief on the enclosure walls, but attenuate the
    // DEM contribution inside the authored opening. This preserves the real
    // elevation ordering without allowing a high source pixel to fill the
    // deliberately lower down-range saddle.
    // Every bearing needs depth tiers between the course edge and the far ridge.
    // A wall that climbs monotonically for a kilometre reads as a pasted ramp no
    // matter what its surface response does.
    //
    // Driving that from a noise field alone does not work: any single field has
    // bearings along which it happens to be monotone, so whether a given wall
    // shows a col comes down to the seed. This is a radial undulation whose PHASE
    // is displaced by a broad world field. Along any ray the radial term
    // guarantees the profile rises and falls; around the course the phase wander
    // (up to about +/-1.2 km of radius) means the crests never close into the
    // concentric ring a plain radial sine would draw.
    const tierPhase = radial * 0.0042
      + broadNoise.fbm(wx * 0.00055 + 19, wz * 0.00055 - 7, { octaves: 2 }) * 5.2;
    const tierWave = Math.sin(tierPhase);
    const tierBand = smootherstep(320, 720, radial) * (1 - smootherstep(2600, 3300, radial));
    const tierRelief = tierWave * 58 * tierBand;

    const relief = tierRelief
      + demRelief * enclosure * (1 - valley * 0.48)
      + authoredValleyRelief
      + rolling * (6 + foot * 12)
      // Establish meso landform before the middle wall: one broad positive spur
      // and irregular negative saddles replace the former dark, planar toe.
      + lowerLandform * (52 + mountain * 38)
      + wallRelief
      + spurRelief
      + mesoRelief
      + glacialPlaneRelief
      + openingShoulderRelief
      + hierarchyRelief
      + buttressRelief
      + shoulderPlaneRelief
      - openingSaddle
      - openingFloorCut
      + benchRelief
      + outcropRelief
      + ridgeCrest * (foot * 22 + mountain * 42) * enclosure
      + foldCrest * (mountain * 18 + highMass * 12) * enclosure
      + (dominantRidge * (mountain * 36 + highMass * 20) * composition.peakScale
        + secondaryRidge * (mountain * 30 + highMass * 18)) * enclosure
      + (dominantRidgeProfile * (mountain * 82 + highMass * 54) * composition.peakScale
        + secondaryRidgeProfile * (mountain * 68 + highMass * 48)) * enclosure
      - cirqueCut * (mountain * 42 + highMass * 30)
      - Math.abs(drainage) * mountain * 20
      - gullyMask * (mountain * 10 + highMass * 7) * enclosure
      - crossWash * (mountain * 17 + highMass * 12) * enclosure
      - chuteField * (mountain * 14 + highMass * 10) * enclosure
      - cliffField * (mountain * 16 + highMass * 12) * enclosure
      + faceRibs * (mountain * 12 + highMass * 8) * enclosure
      - talusFan * (mountain * 13 + highMass * 8) * enclosure
      + talusToe * (mountain * 17 + highMass * 10) * enclosure;
    // The source DEM is relative relief, not an absolute sea-level terrain. Give
    // the outer basin a restrained alpine base lift so its exposed faces rise
    // above the playable forest shelf; the DEM/ridge terms still provide all
    // local hierarchy and the valley subtraction keeps the opening legible.
    // The authored U-window exists to frame something, and until now it framed
    // an empty 240 m swell: the golfer looked down the range at the one bearing
    // with no snow, no mineral face, and nothing above 5 degrees. This is the
    // hero the plan calls for -- a single snow-capped massif on the downrange
    // bearing, seen through the opening.
    //
    // Its depth envelope starts only after the near/middle opening window has
    // faded (that fade completes by 2100 m), so the U-saddle and its two toe
    // mouths are untouched and the peak reads as distance rather than as a plug
    // in the window. Both envelopes are deliberately very broad: the whole field
    // already sits at the edge of the bounded slope/curvature contract, and a
    // tight peak here would break it. Height alone earns the snow and mineral
    // response, because the snowline and exposure fields below key off altitude.
    // Deliberately off the exact aiming line. A peak dead-centre behind the
    // target line is static, and it would also lift the opening bearing above
    // the two side walls, which is the one thing the authored valley opening
    // contract forbids. Offsetting it onto the dominant shoulder keeps the U
    // framing it while the opening bearing itself stays the low window.
    const heroBearing = angularLobe(azimuth,
      composition.openingAzimuth + 0.22 * composition.dominantSide, 0.20);
    // Reach full height by 2500 m and stay there. The existing farCrest lobe has
    // its steep flank at roughly 2200-2600 m, and an envelope that was still
    // climbing through that window pushed the combined gradient to 1.18 against
    // the 1.0 contract. Saturating first means the two never stack. The profile
    // is a smoothstep rather than the smootherstep used elsewhere because its
    // peak derivative is 1.5/W instead of 1.875/W, which is most of the headroom.
    const heroRamp = clamp((radial - 1400) / 1100, 0, 1);
    const heroDepth = heroRamp * heroRamp * (3 - 2 * heroRamp);
    const heroPeak = heroBearing * heroDepth
      * (0.72 + peakTrain * 0.38) * composition.peakScale;

    // --- world-space ridge skeleton -------------------------------------
    // Almost all of this basin's height used to come from radial envelopes:
    // nearShoulder + middleWall + farMassif plus three crest lobes, about 880 m
    // of lift that is a function of DISTANCE FROM THE TEE and nothing else. A
    // height field of that shape is a crater rim by construction — which is
    // precisely how the shell read from the air — and it also meant every
    // bearing showed the same monotone ramp out to the mesh's outer edge, so the
    // visible skyline was the rim of the ribbon rather than a summit. No amount
    // of tuning inside that structure could produce a local peak, which is why
    // the "near and far ridge tiers" contract was failing on two of the three
    // authored bearings.
    //
    // The mass now comes from a ridged multifractal evaluated in world space, so
    // summits and cols fall where the geology puts them and the skyline changes
    // with bearing. The radial envelopes survive only as a toe ramp that holds
    // the playable edge flat and lets the range rise out of it.
    const massifWarpX = broadNoise.fbm(x * 0.00023 + 41, z * 0.00021 - 23, { octaves: 2 }) * 470;
    const massifWarpZ = detailNoise.fbm(x * 0.00021 - 37, z * 0.00024 + 13, { octaves: 2 }) * 420;
    const rx = wx + massifWarpX;
    const rz = wz + massifWarpZ;
    const massifSkeleton = ridgedMultifractal(broadNoise, rx * 0.00038, rz * 0.00034,
      { octaves: 4, lacunarity: 2.03, gain: 0.34 });
    // The mid-scale band is weighted heavily on purpose. The 2.6 km skeleton
    // only completes about one cycle across the visible shell, so whether a
    // given bearing shows a second summit is down to where that one cycle
    // happens to land -- and on the secondary wall it landed as a single ramp.
    // A ~1.1 km component undulates roughly three times along any ray, which
    // makes depth tiers a property of the model rather than of the seed.
    const massifFolds = ridgedMultifractal(detailNoise, rx * 0.00088 + 7, rz * 0.00080 - 5,
      { octaves: 3, lacunarity: 2.07, gain: 0.32 });
    const massifRidge = massifSkeleton * 0.68 + massifFolds * 0.32;
    // Saturating the envelope well inside the mesh means that from ~2.4 km out
    // the profile is owned entirely by the ridge field, which is what puts
    // summits and cols along a ray instead of a ramp. The ramp is a plain
    // smoothstep rather than the smootherstep used elsewhere: its peak
    // derivative is 1.5/W instead of 1.875/W, and multiplying an 800 m amplitude
    // by a radial ramp makes that ramp one of the largest single contributors to
    // the sampler's bounded-slope contract.
    const massifBand = smoothstep01(380, 2050, radial);
    const massifAmplitude = 690 * composition.peakScale
      * (0.36 + 0.64 * (0.30 + 0.70 * Math.max(dominant, secondary * 0.86)))
      * (1 - valley * 0.50);
    const massifRelief = massifBand * massifRidge * massifAmplitude;

    const basinLift = foot * 7
      // A single snow-capped summit on the downrange shoulder, seen through the
      // authored U-window. Deliberately off the aiming line so the opening
      // bearing itself stays the low window.
      + heroPeak * 210
      // Lift the near shoulder into a sequence of foothill forms.  These tiers
      // deliberately rise above the playable conifer edge, while the
      // bearing-weighted masks keep the valley opening low.
      + nearShoulder * 84
      + middleWall * 156
      + farMassif * 28
      // The crest lobes are no longer free-standing rings. Each is gated by the
      // world ridge skeleton, so a lobe can only lift where the geology already
      // has a crest there; where it does not, the lobe leaves a col.
      + nearCrest * 146 * (0.30 + massifRidge * 0.70)
      + middleCrest * 136 * (0.26 + massifRidge * 0.74)
      // A deep col before the far ridge. It has to out-run the envelope's own
      // climb rate or the profile stays a ramp: at 40 m it was swamped by the
      // massif gaining ~50 m per 100 m of range on the same bearing, which is
      // why one authored bearing had no second tier at all.
      - farSaddle * 142
      + farCrest * 172 * (0.22 + massifRidge * 0.78)
      + massifRelief;
    // Preserve an off-axis massif without reintroducing a single smooth blob.
    // Trimmed hard. These are pure radial ramps weighted by bearing, so they
    // fill in exactly the cols the crest lobes and the ridge field are trying to
    // open, and they were a large part of why one bearing could not produce a
    // second tier at any saddle amplitude.
    const asymmetry = dominant * (mountain * 28 + highMass * 15) * composition.peakScale
      + secondary * (mountain * 18 + highMass * 10);
    const worldHeight = basinLift + relief + asymmetry - 15;
    const height = edgeHeight * (1 - blend) + worldHeight * blend;

    if (heightOnly) return height;

    const altitude = Math.max(0, height);
    // Bring the tree-to-mineral transition into the lower wall. The old 175–265 m
    // cutoff left a broad, continuously dark forest shelf between the playable
    // basin and the first readable rock faces in address/approach views.
    // Forest does not terminate as one horizontal elevation contour. Reuse the
    // broad rolling field to make alternating meadow clearings and conifer toes;
    // the seeded result is stable and costs no extra material or render pass.
    const lowlandVariation = smootherstep(0.24, 0.76, rolling * 0.5 + 0.5);
    const treeline = (1 - smootherstep(35, 122, altitude))
      * (0.48 + lowlandVariation * 0.52);
    const snow = smootherstep(composition.snowline - 24, composition.snowline + 72, altitude)
      * (0.42 + smootherstep(0.50, 0.84, ridges) * 0.58);
    // Albedo is NOT built here. It used to be: roughly thirty sequential
    // Color.lerp() calls per vertex, baked into a `color` attribute and then
    // interpolated across 30 m (Band A) and 24 m (Band B) triangles. That threw
    // away every classification decision at a scale larger than a house before
    // it ever reached a pixel, and sequential lerps average rather than compose,
    // so the result converged on one khaki regardless of the geology underneath.
    // The shader owns the surface response now (see worldMaterial); this sampler
    // returns only the broad, world-anchored classification channels that gate
    // it, and the height field that displaces the mesh.
    // Height-periodic strata were the source of the dark horizontal bands in the
    // fixed pond view. Lithology follows a warped world field instead, so it does
    // not track contour height or form stacked shells.
    const strata = clamp(0.52 + detailNoise.fbm((x + gullyWarp) * 0.0018,
      (z - gullyWarp * 0.45) * 0.0016, { octaves: 3 }) * 0.34
      + faceRibs * 0.14 - gullyMask * 0.10, 0.12, 0.92);
    // Mineral faces should arrive in the middle wall as broken outcrops, not as
    // one gray cap at the far skyline.  Use the same authored tier signals that
    // shape the mesh, so albedo and relief agree under one daylight response.
    const wallExposure = clamp(
      nearShoulder * 0.16 + middleWall * 0.26 + nearCrest * 0.18 + middleCrest * 0.16
        + wallOutcrop * 0.78,
      0, 1,
    );
    const rockBreakup = (smootherstep(0.42, 0.88, folded) + wallExposure * 0.34)
      * (1 - treeline);
    const scree = (smootherstep(0.38, 0.88, Math.abs(drainage)) * 0.72
      + chuteField * 0.34 + talusFan * 0.24) * (1 - treeline) * 0.30;
    const cliffCut = clamp(cliffField
      * (mountain * 0.82 + highMass * 0.95) * enclosure
      + wallExposure * (0.10 + mountain * 0.24), 0, 1);
    // Exposed mineral begins below the skyline, not only on the high massif. This
    // makes the lower wall a mixed foothill face instead of one near-black band.
    const exposureByAltitude = 0.36 + smootherstep(35, 150, altitude) * 0.64;
    const rockExposure = clamp((rockBreakup * strata + dominantRidge * 0.48 + secondaryRidge * 0.24
      + faceRibs * 0.34 + gullyMask * 0.44 + cliffCut * 0.52 + wallOutcrop * 0.58) * exposureByAltitude
      + mountain * 0.18, 0, 1);
    // Let the lowest toe retain meadow pockets while the glacial ribs emerge
    // farther up the opening wall. This radial easing is only the existing
    // landform classification; it does not flatten or mask the saddle itself.
    const mineralPlaneGain = smootherstep(620, 800, radial);
    return { height, treeline, snow, radial, azimuth,
      // The valley cut lowers altitude-driven exposure, so carry the actual
      // resistant rib/buttress classification into the channel explicitly.
      // This preserves mineral faces on the saddle without painting a rock mask
      // over its meadow/drainage floor.
      rock: clamp(rockExposure + (landformRib * 0.12 + buttressRib * 0.42
        + mesoRib * 0.60 + nearSpurA * 0.16 + nearSpurB * 0.12
        + hierarchyRib * 0.54) * mineralPlaneGain, 0, 1),
      scree: scree + gullyMask * 0.28 + chuteField * 0.22 + talusFan * 0.38
        + wallWash * 0.46 + landformDrain * 0.32 + buttressDrain * 0.22 + glacialChute * 0.18
        + hierarchyDrainage * 0.40,
      // Bench/outcrop tiers share the cliff channel so the material's analytic
      // normal and roughness response follows the actual authored planes.
      cliff: clamp(cliffCut + landformRib * 0.16 + buttressRib * 0.12
        + benchBand * benchSpur * 0.16 + outcropBand * outcropSpur * 0.28
        + shoulderPlane * 0.16 + nearSpurA * 0.12 + nearSpurB * 0.09
        + hierarchyRib * 0.28, 0, 1), bedding: strata,
      chute: chuteField + landformDrain * 0.24 + buttressDrain * 0.16, talus: talusFan,
      bench: benchBand * benchSpur + hierarchyBenchPlane * 0.45, outcrop: outcropBand * outcropSpur,
      wash: wallWash + benchWash + shoulderDrain * 0.22 + hierarchyDrainage * 0.28,
      structuralSpur: spurRelief + hierarchyRelief,
      drainageCut: drainageCut + shoulderDrain * 0.20 + hierarchyDrainage * 0.58,
      mesoRib: mesoRib + shoulderPlane * 0.42,
      mesoIncision: mesoIncision + shoulderDrain * 0.34,
      mesoTalus: mesoTalus + shoulderDrain * 0.24,
      shoulderPlane, shoulderDrain, hierarchyRib, hierarchyDrainage, hierarchyBenchPlane, openingWindow,
      openingFloorWindow, nearSpurA, nearSpurB, glacialChute };
  };
  sampler.heightAt = (x, z) => sampler(x, z, true);
  // Surface response is per-pixel in worldMaterial, so no albedo is baked into
  // the mesh. The sampler still owns the classification channels that gate it.
  sampler.bakesVertexColor = false;
  return sampler;
}

function sampleMaritime(terrain, bounds, noise, x, z, extent) {
  const cx = clamp(x, bounds.minX, bounds.maxX);
  const cz = clamp(z, bounds.minZ, bounds.maxZ);
  const distance = Math.hypot(x - cx, z - cz);
  const blend = smootherstep(0, 150, distance);
  const far = clamp(distance / extent, 0, 1);
  const edgeHeight = terrain.heightAt(cx, cz);
  const broad = noise.fbm(x * 0.0031, z * 0.0031, { octaves: 4 }) * (7 + 8 * far);
  const ridge = noise.ridged(x * 0.0018, z * 0.0022, { octaves: 3 }) * (5 + 13 * far);
  const backLift = z < bounds.minZ ? smootherstep(40, extent * 0.8, bounds.minZ - z) * 8 : 0;
  const height = edgeHeight * (1 - blend) + (broad + ridge - 5 + backLift) * blend;
  const color = new Color(0x3d5136).lerp(new Color(0x667263), 0.25 + far * 0.5);
  color.multiplyScalar(0.88 + noise.noise2(x * 0.018, z * 0.018) * 0.07);
  return { height, color, rock: far * 0.25, snow: 0, scree: far * 0.12 };
}

// The baked square covers the outer alpine rings (about 7.6 km across). Clamp
// rather than repeat at its edge: repetition would make a visible tiled horizon
// and would violate the continuous world-space composition contract.
const NORTH_CASCADES_WORLD_HALF_X = 3800;
const NORTH_CASCADES_WORLD_HALF_Z = 3800;

function sampleNorthCascadesDem(x, z) {
  // The 128² public DEM covers 7.6 km, so one cell is 59 m. The previous
  // five-tap box prefilter spanned +/-240 m — four cells — which removed
  // essentially every ridge the table was bundled to provide and left broad
  // swells. It existed to hide bilinear interpolation creases: bilinear is only
  // C0, so a coarse table sampled at 24 m vertex spacing shows the diamond
  // seams of its own grid.
  //
  // Fixing the interpolation instead of blurring the data is the trade Hollow
  // makes in TerrainHeightCommon.hlsl, which reaches for Catmull-Rom rather than
  // accepting hardware bilinear on its heightmap. The quintic coordinate remap
  // below (Perlin's smootherstep, as in iq's "improved texture interpolation")
  // is the cheap version: it costs no extra taps, is C2 at cell boundaries, and
  // therefore needs no denoising pass at all. A single one-cell tap is retained
  // only to take the edge off isolated source pixels.
  const filterRadius = 118;
  return sampleNorthCascadesDemRaw(x, z) * 0.60
    + (sampleNorthCascadesDemRaw(x + filterRadius, z)
      + sampleNorthCascadesDemRaw(x - filterRadius, z)
      + sampleNorthCascadesDemRaw(x, z + filterRadius)
      + sampleNorthCascadesDemRaw(x, z - filterRadius)) * 0.10;
}

function sampleNorthCascadesDemRaw(x, z) {
  const u = clamp(x / (NORTH_CASCADES_WORLD_HALF_X * 2) + 0.5, 0, 1);
  // Source rows run north-to-south while this world uses increasing z as
  // down-range. Invert v so the sampled strike remains geographically legible.
  const v = 1 - clamp(z / (NORTH_CASCADES_WORLD_HALF_Z * 2) + 0.5, 0, 1);
  const fx = u * (NORTH_CASCADES_DEM.width - 1);
  const fy = v * (NORTH_CASCADES_DEM.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(NORTH_CASCADES_DEM.width - 1, x0 + 1);
  const y1 = Math.min(NORTH_CASCADES_DEM.height - 1, y0 + 1);
  // Quintic remap of the cell-local coordinate. Both first and second
  // derivatives vanish at the cell boundary, so the reconstructed surface has no
  // interpolation crease and its analytic normals stay continuous.
  const qx = fx - x0;
  const qy = fy - y0;
  const tx = qx * qx * qx * (qx * (qx * 6 - 15) + 10);
  const ty = qy * qy * qy * (qy * (qy * 6 - 15) + 10);
  const values = NORTH_CASCADES_DEM.values;
  const row = NORTH_CASCADES_DEM.width;
  const top = values[y0 * row + x0] * (1 - tx) + values[y0 * row + x1] * tx;
  const bottom = values[y1 * row + x0] * (1 - tx) + values[y1 * row + x1] * tx;
  return (top * (1 - ty) + bottom * ty) / 65535;
}

// Band A reaches 1.4 km from the playable edge at 30 m spacing; Band B carries
// the massif from there to 3.3 km, staying inside the 3.8 km DEM half-extent and
// well inside the 6 km camera far plane.
const ALPINE_BAND_A_OUTER = 1400;
const ALPINE_BAND_A_SPACING = 30;
const ALPINE_BAND_B_OUTER = 3300;
// 384 columns puts ~23 m of arc at the inner edge and ~54 m at the far rim, which
// keeps the silhouette smooth against the sky (the documented faceting risk).
const ALPINE_BAND_B_COLUMNS = 384;
const ALPINE_BAND_B_ROWS = 6;
// Eight azimuth segments give per-segment bounding spheres, so a golfer-height
// 40-degree camera frustum-culls all but two or three of them.
const ALPINE_BAND_B_SEGMENTS = 8;
// The two bands meet on Band A's rectangular boundary, but Band A samples that
// line on a 30 m x/z grid while the ribbon samples it by azimuth. Those vertices
// do not coincide, so the join is a T-junction that can open pixel-wide slivers.
// A short curtain hanging below the shared edge fills them with the same
// material instead of sky; it is invisible everywhere else.
const ALPINE_BAND_B_SKIRT = 40;

// Distance from the basin center to Band A's rectangular outer boundary along one
// bearing. Starting the ribbon exactly here means the bands abut rather than
// overlap: coincident surfaces at 1.4 km are viewed at a grazing angle, where a
// few metres of interpolation difference between a 30 m and a ribbon mesh would
// tear into visible stripes.
function bandBoundaryRadius(rect, centerX, centerZ, azimuth) {
  const dx = Math.sin(azimuth);
  const dz = -Math.cos(azimuth);
  const tx = Math.abs(dx) < 1e-9 ? Infinity
    : (dx > 0 ? rect.maxX - centerX : rect.minX - centerX) / dx;
  const tz = Math.abs(dz) < 1e-9 ? Infinity
    : (dz > 0 ? rect.maxZ - centerZ : rect.minZ - centerZ) / dz;
  return Math.min(tx, tz);
}

function alpineMassifRibbon(bounds, sample) {
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const rect = {
    minX: bounds.minX - ALPINE_BAND_A_OUTER, maxX: bounds.maxX + ALPINE_BAND_A_OUTER,
    minZ: bounds.minZ - ALPINE_BAND_A_OUTER, maxZ: bounds.maxZ + ALPINE_BAND_A_OUTER,
  };
  const columns = ALPINE_BAND_B_COLUMNS;
  const azimuthAt = (column) => -Math.PI + (column / columns) * Math.PI * 2;
  const geometries = [];
  const perSegment = Math.ceil(columns / ALPINE_BAND_B_SEGMENTS);
  for (let start = 0; start < columns; start += perSegment) {
    const end = Math.min(columns, start + perSegment);
    // Segments share their boundary column, so adjacent bounding spheres overlap
    // by one column and the ribbon stays watertight when only some are drawn.
    const azimuths = [];
    for (let column = start; column <= end; column++) azimuths.push(azimuthAt(column));
    geometries.push(buildMassifSegment(azimuths, rect, centerX, centerZ, sample));
  }
  return geometries;
}

function buildMassifSegment(azimuths, rect, centerX, centerZ, sample) {
  const nc = azimuths.length;
  // Row 0 is the hidden skirt; rows 1..ALPINE_BAND_B_ROWS are the visible surface.
  const nr = ALPINE_BAND_B_ROWS + 1;
  const count = nc * nr;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const geology = new Float32Array(count * 4);
  const cover = new Float32Array(count * 4);
  // Surface quads, plus the skirt band emitted with both windings so the curtain
  // reads from any bearing without a second, two-sided material.
  const quads = (nr - 2) * (nc - 1);
  const indices = new Uint32Array(quads * 6 + (nc - 1) * 12);
  const sampleHeight = sample.heightAt || ((sx, sz) => sample(sx, sz).height);
  const normalStep = 8;

  for (let column = 0; column < nc; column++) {
    const azimuth = azimuths[column];
    const dx = Math.sin(azimuth);
    const dz = -Math.cos(azimuth);
    const inner = bandBoundaryRadius(rect, centerX, centerZ, azimuth);
    for (let row = 1; row < nr; row++) {
      // Ease the radial rows toward the inner edge: the near half of the ribbon
      // covers far more screen area than the hazed rim behind it.
      const t = (row - 1) / (ALPINE_BAND_B_ROWS - 1);
      const radius = inner + (ALPINE_BAND_B_OUTER - inner) * Math.pow(t, 1.4);
      const x = centerX + dx * radius;
      const z = centerZ + dz * radius;
      const {
        height, rock = 0, snow = 0, scree = 0, cliff = 0,
        treeline = 0, bedding = 0.5, bench = 0, outcrop = 0, wash = 0,
      } = sample(x, z);
      const vertex = row * nc + column;
      positions[vertex * 3] = x; positions[vertex * 3 + 1] = height; positions[vertex * 3 + 2] = z;
      geology[vertex * 4] = rock; geology[vertex * 4 + 1] = snow;
      geology[vertex * 4 + 2] = scree; geology[vertex * 4 + 3] = cliff;
      cover[vertex * 4] = treeline; cover[vertex * 4 + 1] = bedding;
      cover[vertex * 4 + 2] = Math.min(1, bench + outcrop); cover[vertex * 4 + 3] = Math.min(1, wash);
      // Same continuous-sampler normal and the same 8 m derivative span as the
      // Band A patches, so both bands face the shared sun identically and the
      // join cannot light as two separate shells.
      const nxWorld = sampleHeight(x - normalStep, z) - sampleHeight(x + normalStep, z);
      const nyWorld = normalStep * 2;
      const nzWorld = sampleHeight(x, z - normalStep) - sampleHeight(x, z + normalStep);
      const inverseLength = 1 / Math.hypot(nxWorld, nyWorld, nzWorld);
      normals[vertex * 3] = nxWorld * inverseLength;
      normals[vertex * 3 + 1] = nyWorld * inverseLength;
      normals[vertex * 3 + 2] = nzWorld * inverseLength;
      if (row !== 1) continue;
      // Skirt: the shared edge dropped straight down, inheriting the edge's
      // albedo/geology and facing back toward the basin.
      positions[column * 3] = x;
      positions[column * 3 + 1] = height - ALPINE_BAND_B_SKIRT;
      positions[column * 3 + 2] = z;
      geology[column * 4] = rock; geology[column * 4 + 1] = snow;
      geology[column * 4 + 2] = scree; geology[column * 4 + 3] = cliff;
      cover[column * 4] = treeline; cover[column * 4 + 1] = bedding;
      cover[column * 4 + 2] = Math.min(1, bench + outcrop); cover[column * 4 + 3] = Math.min(1, wash);
      normals[column * 3] = -dx; normals[column * 3 + 1] = 0; normals[column * 3 + 2] = -dz;
    }
  }

  let index = 0;
  for (let row = 0; row < nr - 1; row++) for (let column = 0; column < nc - 1; column++) {
    const a = row * nc + column;
    const b = a + 1;
    const c = a + nc;
    const d = c + 1;
    // Wound so the surface normal comes out up-facing for a ring parametrised by
    // (sin azimuth, -cos azimuth) with radius increasing outward.
    indices[index++] = a; indices[index++] = b; indices[index++] = c;
    indices[index++] = b; indices[index++] = d; indices[index++] = c;
    if (row !== 0) continue;
    indices[index++] = a; indices[index++] = c; indices[index++] = b;
    indices[index++] = b; indices[index++] = c; indices[index++] = d;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('backdropGeology', new Float32BufferAttribute(geology, 4));
  geometry.setAttribute('backdropCover', new Float32BufferAttribute(cover, 4));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function ringPatches(bounds, inner, outer) {
  const innerBounds = {
    minX: bounds.minX - inner, maxX: bounds.maxX + inner,
    minZ: bounds.minZ - inner, maxZ: bounds.maxZ + inner,
  };
  return [
    [bounds.minX - outer, innerBounds.minX, bounds.minZ - outer, bounds.maxZ + outer],
    [innerBounds.maxX, bounds.maxX + outer, bounds.minZ - outer, bounds.maxZ + outer],
    [innerBounds.minX, innerBounds.maxX, bounds.minZ - outer, innerBounds.minZ],
    [innerBounds.minX, innerBounds.maxX, innerBounds.maxZ, bounds.maxZ + outer],
  ].filter(([minX, maxX, minZ, maxZ]) => maxX - minX > 0.1 && maxZ - minZ > 0.1);
}

// One shared decode of the reviewed alpine mineral source
// (docs/alpine-granite provenance; hash-pinned in test/backdrop-terrain.test.mjs).
// Loaded lazily so the maritime biome and the node-side sampler tests never touch
// it, and cached so rebuilding the range does not re-decode a 1024x1024 PNG.
let _graniteAlbedo = null;
function loadGraniteAlbedo() {
  if (_graniteAlbedo) return _graniteAlbedo;
  if (typeof document === 'undefined') return null;
  _graniteAlbedo = new TextureLoader().load('assets/textures/alpine_granite_albedo_v1.png');
  _graniteAlbedo.wrapS = RepeatWrapping;
  _graniteAlbedo.wrapT = RepeatWrapping;
  _graniteAlbedo.colorSpace = SRGBColorSpace;
  _graniteAlbedo.minFilter = LinearMipmapLinearFilter;
  _graniteAlbedo.anisotropy = 8;
  return _graniteAlbedo;
}

// Linear working-space components for an authored sRGB hex.
function linearRGB(hex) {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

// Displacement-weighted material blend, ported in spirit from
// Hollow-TerrainSystem's splat shader (SampleOMPV, Shaders/Includes/OMPV.hlsl).
// A linear lerp between two surfaces fades them across a soft gradient, which is
// what made the old snowline a grey wash and the old rock/forest boundary a
// contour band. Weighting by each surface's local relief instead makes whichever
// one stands proud win the pixel, so boundaries interlock along real ribs and
// hollows. Written as pure arithmetic: three r185 silently drops the writes from
// every branch after the first in an If/Else stack, so there are no conditionals
// anywhere in this material.
// The epsilon guards the DENOMINATOR only. Adding it to each term instead (as a
// naive transcription does) makes a zero nominal weight return 0.5 whenever the
// opposing surface sits more than `transition` above this one, because both terms
// clamp to zero and the two epsilons then divide into one half. That is a
// snowline at sea level, which is exactly what the first build produced.
function heightBlend(weight, heightA, heightB, transition) {
  const top = heightA.max(heightB);
  const a = heightA.sub(top).add(transition).max(0).mul(float(1.0).sub(weight));
  const b = heightB.sub(top).add(transition).max(0).mul(weight);
  return b.div(a.add(b).max(1e-5)).clamp(0.0, 1.0);
}

// A world-anchored noise field plus its WORLD-space gradient.
//
// The previous material derived every bump from screen-space dFdx/dFdy of a world-space
// noise. Those are SCREEN-space derivatives: the world distance they span is
// whatever one pixel happens to cover, which at 2 km is roughly 10 m and at the
// course edge is centimetres. The perturbation therefore exploded with distance
// and at grazing angles, which is what drew the dark streaky banding across the
// far faces. Sampling the field at a fixed offset in metres instead makes the
// gradient a property of the terrain rather than of the projection — the same
// reasoning as HeightToNormal in Hollow's TerrainHeightCommon.hlsl, which steps
// by a fixed texel offset rather than by a pixel.
function worldField(world, frequency, seedZ, epsilon) {
  const at = (x, z) => mx_noise_float(vec3(x.mul(frequency), z.mul(frequency), seedZ));
  const center = at(world.x, world.z);
  return {
    value: center.mul(0.5).add(0.5),
    gradX: at(world.x.add(epsilon), world.z).sub(center).div(epsilon),
    gradZ: at(world.x, world.z.add(epsilon)).sub(center).div(epsilon),
  };
}

// Distant scenery shares the scene's one atmosphere. Applying the shared aerial
// perspective after lighting keeps transmittance physically ordered (the sun and
// sky light the rock first, then the camera ray mixes toward the same horizon
// colour the sky and fog already use) and replaces the fixed grey-teal veil this
// material used to blend in on its own, which was a per-layer colour grade in all
// but name. Scene FogExp2 is disabled on this material so one fragment never gets
// two unrelated depth fades.
class AtmosphericTerrainMaterial extends MeshStandardNodeMaterial {
  setupOutput(builder, outputNode) {
    if (!this.terrainEnvironment) return super.setupOutput(builder, outputNode);
    const toCamera = cameraPosition.sub(positionWorld);
    return vec4(
      this.terrainEnvironment.aerialPerspective(outputNode.rgb, toCamera, toCamera.length()),
      outputNode.a,
    );
  }
}

function worldMaterial(name, biome, graniteTexture = null, { environment = null, snowline = 400 } = {}) {
  const alpine = biome === 'temperate-alpine';
  // The maritime continuation still bakes a cheap per-vertex albedo; only the
  // alpine shell classifies per pixel, because only it is a mountain.
  const material = new AtmosphericTerrainMaterial({
    color: 0xffffff, vertexColors: !alpine, roughness: 0.94, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  if (environment) {
    material.terrainEnvironment = environment;
    material.fog = false;
  }
  const world = positionWorld;
  const geology = attribute('backdropGeology', 'vec4');
  const seed = alpine ? 17.31 : 29.17;

  if (!alpine) {
    // Maritime: unchanged low-cost response. One broad lithology field over the
    // baked vertex colour is all this band has ever needed.
    const lithology = mx_noise_float(vec3(world.x.mul(0.0041), world.z.mul(0.0037), seed))
      .mul(0.5).add(0.5);
    const slope = float(1.0).sub(smoothstep(0.38, 0.86, normalWorld.y));
    material.colorNode = vertexColor().mul(lithology.sub(0.5).mul(0.24).add(1.0));
    material.roughnessNode = mix(float(0.99), float(0.86), slope.mul(0.4).add(geology.x.mul(0.3)));
    material.name = name;
    return material;
  }

  // ---------------------------------------------------------------------------
  // Alpine: everything below runs per pixel.
  //
  // The vertex stream carries only BROAD regional gates — the authored geology
  // classification interpolated across 30 m (Band A) and 24 m (Band B) triangles.
  // Those set where a surface type is plausible. All of the structure a viewer
  // actually reads as rock — bedding, ribs, gully shadowing, the snowline's
  // ragged edge, grain — is evaluated here, at pixel resolution, from world
  // position and the analytic surface normal.
  // ---------------------------------------------------------------------------
  const cover = attribute('backdropCover', 'vec4');   // treeline, bedding, bench/outcrop, wash
  const rockGate = geology.x;
  const snowGate = geology.y;
  const screeGate = geology.z;
  const cliffGate = geology.w;
  const treeGate = cover.x;
  const beddingGate = cover.y;
  const benchGate = cover.z;
  const washGate = cover.w;

  const altitude = world.y;
  const upness = normalWorld.y.clamp(0.0, 1.0);
  // Real slope from the analytic sampler normals, in 0..1. This is the single
  // most informative per-pixel signal the old material barely used.
  const slope = float(1.0).sub(upness);

  // Three physical scales of world-anchored relief. Wavelengths are chosen
  // against what a pixel subtends: at 2.5 km and 55 degrees FOV one pixel is
  // about 3 m, so the 180 m and 42 m fields carry the far massif's face
  // structure and the 7 m field only matters inside Band A.
  const macro = worldField(world, 1 / 620, seed + 3.0, 24.0);
  const meso = worldField(world, 1 / 165, seed + 29.0, 9.0);
  const fine = worldField(world, 1 / 41, seed + 53.0, 2.5);
  const grain = worldField(world, 1 / 8.5, seed + 71.0, 0.6);

  // Bedding: a warped, non-height-periodic stratification. Anchored to a rotated
  // world axis so it cuts ACROSS the faces like real strata instead of drawing
  // contour rings around the basin at constant elevation.
  const beddingAxis = world.x.mul(0.34).add(world.z.mul(0.20)).add(altitude.mul(0.55));
  const bedding = mx_noise_float(vec3(
    beddingAxis.mul(1 / 95), world.z.sub(world.x.mul(0.4)).mul(1 / 340), seed + 67.0,
  )).mul(0.5).add(0.5);

  // Resistant ribs vs. incised gullies. This is the relief field that drives both
  // the height blends and the normal perturbation, so albedo, shading and the
  // material boundaries all agree about where the rock stands proud.
  const ribs = meso.value.mul(0.55).add(fine.value.mul(0.30)).add(bedding.mul(0.15));
  const rockRelief = ribs.mul(0.72).add(cliffGate.mul(0.28)).clamp(0.0, 1.0);

  // --- rock -----------------------------------------------------------------
  // Steep ground is bare, high ground is bare, and the authored classification
  // says where outcrops break through regardless. The boundary is then broken by
  // the rib field so it is a ragged mineral edge, not a smooth altitude ramp.
  const slopeExposure = smoothstep(0.26, 0.66, slope);
  // Absolute metres, not a fraction of the snowline: this is the band between
  // the tree line and the snow, and it is the only place bare granite reads.
  // Without it the massif goes straight from forest green to snow white.
  // The onset altitude is JITTERED by a broad world field. A band keyed to bare
  // altitude is a horizontal contour stripe wrapped around the massif, which is
  // the single most obvious tell that terrain was classified by elevation. A
  // +/-90 m wander over ~600 m of world makes the same transition read as a
  // ragged tree line following the ground.
  const bandJitter = macro.value.sub(0.5).mul(180.0);
  const altitudeExposure = smoothstep(150.0, 430.0, altitude.add(bandJitter));
  const rockNominal = rockGate.mul(0.85)
    .add(cliffGate.mul(0.55))
    .add(benchGate.mul(0.35))
    .add(slopeExposure.mul(0.80))
    .add(altitudeExposure.mul(0.70))
    .sub(treeGate.mul(0.85))
    .clamp(0.0, 1.0);
  const vegetationRelief = treeGate.mul(0.45).add(macro.value.mul(0.30)).add(0.28).clamp(0.0, 1.0);
  const rockMask = heightBlend(rockNominal, vegetationRelief, rockRelief, 0.34);

  // --- snow -----------------------------------------------------------------
  // Two things the old altitude lerp got wrong: snow does not hold on a cliff,
  // and it does not stop at a horizontal line. Slope sheds it and aspect biases
  // it (a property of the surface, not a second light source).
  //
  // Snow is deliberately NOT height-blended. A height blend saturates: once the
  // two relief fields differ by more than the transition width, the surface with
  // the greater relief takes the whole sample, so any non-zero nominal weight
  // becomes total coverage. That is the right behaviour for interlocking two
  // materials that both belong at a location, and completely wrong for placing a
  // snowline -- it turned a 0.3 weight spread over a 260 m altitude band into a
  // white mountain from the address view. Coverage is thresholded instead, so
  // partial cover exists and the ribs/drift fields only make the edge ragged.
  const snowBand = smoothstep(snowline - 30.0, snowline + 230.0, altitude.add(bandJitter.mul(0.8)));
  const snowShed = float(1.0).sub(smoothstep(0.40, 0.78, slope));
  const aspect = normalWorld.z.negate().mul(0.5).add(0.5);
  const snowPotential = snowBand.mul(snowShed).mul(aspect.mul(0.35).add(0.72))
    .add(snowGate.mul(0.16));
  // Wind scours the ribs and loads the lee hollows, so snow accumulates against
  // the inverse of the rock relief plus a broad drift field.
  const snowDrift = float(1.0).sub(ribs).mul(0.62).add(macro.value.mul(0.38)).clamp(0.0, 1.0);
  const snowMask = smoothstep(0.34, 0.62,
    snowPotential.mul(0.86).add(snowDrift.mul(0.26)).sub(ribs.mul(0.28)));

  // --- scree ----------------------------------------------------------------
  // Rubble collects below the faces on moderate slopes; it cannot cling to a
  // cliff and it sits under, not over, the snow.
  const screeNominal = screeGate.mul(1.35).add(washGate.mul(0.85))
    .mul(float(1.0).sub(smoothstep(0.52, 0.86, slope)))
    .mul(float(1.0).sub(snowMask))
    .clamp(0.0, 1.0);
  const screeMask = smoothstep(0.18, 0.72, screeNominal.mul(0.70).add(fine.value.mul(0.30)));

  // --- endmembers -----------------------------------------------------------
  // Five surfaces, chosen between rather than averaged. The old chain ran about
  // thirty sequential lerps toward a dozen different warm soils; sequential lerps
  // average, and the mean of a dozen olives and tans is the uniform khaki that
  // made the massif read as landfill.
  const conifer = linearRGB(0x55684e);        // deep, blue-shifted alpine forest
  const meadowGrass = linearRGB(0x93a171);    // dry high meadow and benches
  // Granite is a MID grey, not a light one. At 0xa3a9ad the bare rock came out
  // brighter than most of the sky's lower half and read as an unbroken
  // snowfield from every camera -- the massif looked white long after the
  // snowline had been raised, because almost none of that white was snow.
  // Distant sunlit granite belongs well below snow in value; snow is supposed
  // to be the brightest thing on the hill by a clear margin.
  const graniteLit = linearRGB(0x82868c);     // cool mid granite
  const graniteDark = linearRGB(0x3f4650);    // shaded bedding within one lithology
  const screeRubble = linearRGB(0x8a8074);    // weathered warm-grey talus
  const snowLit = linearRGB(0xe4ecf1);        // bright, cold, actually reads as snow
  const snowShade = linearRGB(0x9fb3c4);      // cool shadow side of the same snow

  // Vegetated substrate.
  const meadowShare = smoothstep(0.35, 0.75,
    float(1.0).sub(treeGate).mul(0.55).add(macro.value.mul(0.45))
      .add(smoothstep(60.0, 220.0, altitude).mul(0.35)));
  let albedo = mix(conifer, meadowGrass, meadowShare);

  // Mineral substrate: one lithology whose VALUE comes from bedding and local
  // relief. Rock reads as rock because its light and dark are structured, not
  // because it is a different hue.
  const beddingValue = bedding.mul(0.55).add(beddingGate.mul(0.20)).add(ribs.mul(0.25));
  let mineral = mix(graniteDark, graniteLit, smoothstep(0.22, 0.82, beddingValue));
  mineral = mix(mineral, screeRubble, screeMask.mul(0.85));

  if (graniteTexture) {
    // A biplanar world projection keeps mineral scale stable on near-vertical
    // faces while costing two filtered samples (top + a diagonal side basis),
    // rather than three triplanar taps. The diagonal basis avoids a hard X/Z seam
    // without a branch or an additional draw/pass. The source is neutral-lighting
    // albedo, so the shared daylight remains solely responsible for form.
    //
    // Weights follow Hollow's triplanar blend (PhotoTerrainFragment.hlsl): the
    // offset subtraction before the power is what stops the top projection from
    // bleeding onto steep faces and smearing the texture into vertical streaks.
    const projectionScale = 1 / 34;
    const topSample = texture(graniteTexture, vec2(world.x, world.z).mul(projectionScale)).rgb;
    const sideSample = texture(graniteTexture,
      vec2(world.x.add(world.z.mul(0.7071)), world.y).mul(projectionScale).add(vec2(0.23, 0.47))).rgb;
    const weight = normalWorld.abs().sub(0.18).max(0.0).pow(vec3(4.0));
    const sideWeight = weight.x.add(weight.z);
    const weightSum = sideWeight.add(weight.y).max(0.001);
    const granite = sideSample.mul(sideWeight).add(topSample.mul(weight.y)).div(weightSum);
    // Keep only the source's relative structure, not its absolute value: divide
    // out its own luminance so the authored granite endmember still sets the
    // palette and the texture supplies detail.
    const graniteMean = granite.x.mul(0.2126).add(granite.y.mul(0.7152)).add(granite.z.mul(0.0722)).max(0.04);
    // Widened. At a 0.66-1.44 clamp over a pow of 1.10 the source contributed a
    // few percent of contrast, which is invisible at 2 km through aerial
    // perspective -- the one texture the massif has was effectively not there.
    const graniteGrade = granite.div(graniteMean).pow(vec3(1.35))
      .mul(graniteMean.mul(0.72).add(0.66)).clamp(0.55, 1.70);
    mineral = mineral.mul(graniteGrade);
  }

  albedo = mix(albedo, mineral, rockMask);
  albedo = mix(albedo, mix(snowShade, snowLit, smoothstep(0.30, 0.85, upness)), snowMask);

  // --- normals --------------------------------------------------------------
  // World-space gradients, so the perturbation is a fixed physical slope at every
  // distance. Each field is gated to the surface it belongs to: rock gets rib and
  // grain structure, snow is smoothed, vegetation stays soft.
  const rockDetail = rockMask.mul(float(1.0).sub(snowMask));
  // Each multiplier is the field's RELIEF AMPLITUDE IN METRES, because worldField
  // already divides by its sampling offset and therefore returns a true per-metre
  // gradient. Treating it as a unitless "strength" instead put the perturbation at
  // roughly 1.5 against a unit normal, which randomised the surface orientation
  // outright: every face caught some sun, the massif blew out to a flat pale
  // sheet, and no amount of darkening the albedo could bring it back.
  //
  // The amplitudes are mountain-scale, not pebble-scale: a rock face carries
  // tens of metres of relief at the 150 m scale, so 16 m there is conservative.
  // Dropping them to a literal few metres removes the perturbation entirely and
  // leaves a featureless grey shape, which is the opposite failure.
  const bump = vec3(
    meso.gradX.mul(16.0).add(fine.gradX.mul(5.5).add(grain.gradX.mul(0.35))),
    0.0,
    meso.gradZ.mul(16.0).add(fine.gradZ.mul(5.5).add(grain.gradZ.mul(0.35))),
  ).mul(rockDetail.mul(0.85).add(screeMask.mul(0.25)).add(0.06));
  material.normalNode = transformNormalToView(normalWorld.add(bump).normalize());

  // Matte dielectric throughout. Snow is slightly glossier than weathered rock,
  // vegetation is the roughest thing on the hill.
  const mineralRough = mix(float(0.97), float(0.80), rockMask.mul(0.7).add(slope.mul(0.3)));
  material.roughnessNode = mix(mineralRough, float(0.86), snowMask);
  material.colorNode = albedo;
  material.name = name;
  return material;
}

function buildPatch(minX, maxX, minZ, maxZ, spacing, sample) {
  const nx = Math.max(2, Math.ceil((maxX - minX) / spacing) + 1);
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / spacing) + 1);
  const positions = new Float32Array(nx * nz * 3);
  const geology = new Float32Array(nx * nz * 4);
  const cover = new Float32Array(nx * nz * 4);
  // Only the maritime sampler still bakes albedo per vertex; the alpine shell
  // classifies per pixel in worldMaterial, so it emits no colour stream at all.
  const colors = sample.bakesVertexColor === false ? null : new Float32Array(nx * nz * 3);
  const normals = new Float32Array(nx * nz * 3);
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let vertex = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = minZ + (maxZ - minZ) * iz / (nz - 1);
    for (let ix = 0; ix < nx; ix++) {
      const x = minX + (maxX - minX) * ix / (nx - 1);
      const {
        height, color, rock = 0, snow = 0, scree = 0, cliff = 0,
        treeline = 0, bedding = 0.5, bench = 0, outcrop = 0, wash = 0,
      } = sample(x, z);
      positions[vertex * 3] = x; positions[vertex * 3 + 1] = height; positions[vertex * 3 + 2] = z;
      if (colors) {
        colors[vertex * 3] = color.r; colors[vertex * 3 + 1] = color.g; colors[vertex * 3 + 2] = color.b;
      }
      geology[vertex * 4] = rock;
      geology[vertex * 4 + 1] = snow;
      geology[vertex * 4 + 2] = scree;
      geology[vertex * 4 + 3] = cliff;
      cover[vertex * 4] = treeline;
      cover[vertex * 4 + 1] = bedding;
      cover[vertex * 4 + 2] = Math.min(1, bench + outcrop);
      cover[vertex * 4 + 3] = Math.min(1, wash);
      // Derive the normal from the authoritative continuous height sampler, not
      // from triangles local to this patch.  Patch-local computeVertexNormals()
      // gives shared boundary vertices different normals and turns an otherwise
      // continuous backdrop into visibly faceted, separately lit tiles. A fixed
      // physical derivative span also keeps lighting stable across LOD bands.
      const normalStep = 8;
      // Height-only taps follow the identical sampler and derivative span, but
      // skip the vertex colour/geology work that is not consumed by a normal.
      // Maritime samplers have no specialized path and retain the old behavior.
      const sampleHeight = sample.heightAt || ((sx, sz) => sample(sx, sz).height);
      const left = sampleHeight(x - normalStep, z);
      const right = sampleHeight(x + normalStep, z);
      const near = sampleHeight(x, z - normalStep);
      const far = sampleHeight(x, z + normalStep);
      const nxWorld = left - right;
      const nyWorld = normalStep * 2;
      const nzWorld = near - far;
      const inverseLength = 1 / Math.hypot(nxWorld, nyWorld, nzWorld);
      normals[vertex * 3] = nxWorld * inverseLength;
      normals[vertex * 3 + 1] = nyWorld * inverseLength;
      normals[vertex * 3 + 2] = nzWorld * inverseLength;
      vertex += 1;
    }
  }
  let index = 0;
  for (let iz = 0; iz < nz - 1; iz += 1) for (let ix = 0; ix < nx - 1; ix += 1) {
    const a = iz * nx + ix; const b = a + 1; const c = a + nx; const d = c + 1;
    // Alternate the diagonal so a distant patch cannot acquire a single repeated
    // triangulation direction under grazing light. The height samples stay exactly
    // the same; this only removes a faceting bias in the render-only continuation.
    if ((ix + iz) & 1) {
      indices[index++] = a; indices[index++] = c; indices[index++] = d;
      indices[index++] = a; indices[index++] = d; indices[index++] = b;
    } else {
      indices[index++] = a; indices[index++] = c; indices[index++] = b;
      indices[index++] = b; indices[index++] = c; indices[index++] = d;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('backdropGeology', new Float32BufferAttribute(geology, 4));
  geometry.setAttribute('backdropCover', new Float32BufferAttribute(cover, 4));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// Musgrave ridged multifractal.
//
// `Noise.ridged()` is `1 - |fbm|`: it sums all octaves and folds ONCE, at the
// end. That produces a field clustered near 1 with smooth, swollen tops — the
// "swollen plateau" the sampler's own comments keep working around, and the
// reason the previous author had to threshold it with smootherstep and then use
// it only as a low-amplitude envelope.
//
// Folding PER OCTAVE is what makes a mountain: |n| creases the field at every
// zero crossing, so each scale contributes a crest line rather than a bump.
// Squaring sharpens the crest and flattens the valley floor. Carrying `weight`
// forward is the cheap erosion analogue — an octave can only deposit detail
// where the coarser scale already had a ridge, so valleys stay smooth, faces
// stay clean, and the range reads as self-similar rock instead of uniform noise.
//
// gain * lacunarity is kept below 1 so the slope contribution of successive
// octaves decays; that is what keeps the field inside the sampler's bounded
// slope/curvature contract while still being visibly sharp.
function ridgedMultifractal(noise, x, z, {
  octaves = 5, lacunarity = 2.03, gain = 0.46, offset = 0.92, sharpness = 2.2,
} = {}) {
  let frequency = 1;
  let amplitude = 0.5;
  let weight = 1;
  let sum = 0;
  let norm = 0;
  for (let index = 0; index < octaves; index++) {
    // ImprovedNoise returns well inside [-1, 1] in practice; the 1.35 restores a
    // usable dynamic range so `offset - |n|` actually reaches zero at the creases
    // instead of bottoming out at a high plateau.
    const raw = clamp(noise.noise2(x * frequency, z * frequency) * 1.35, -1, 1);
    // Exponent 1.6 rather than a square. Squaring is the textbook form, but the
    // crest derivative scales with it, and at 700 m of amplitude that alone put
    // the field outside the sampler's bounded-slope contract. 1.6 keeps a
    // recognisably knife-edged crest for about 20% less gradient.
    // The max() is load-bearing: `offset` is below 1, so |raw| exceeds it near
    // the noise extremes and a fractional exponent over a negative base is NaN.
    // The textbook square silently absorbs that; 1.6 does not.
    let signal = Math.pow(Math.max(0, offset - Math.abs(raw)), 1.6);
    signal *= weight;
    weight = clamp(signal * sharpness, 0, 1);
    sum += signal * amplitude;
    norm += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return clamp(sum / (norm * Math.pow(offset, 1.6)), 0, 1);
}

function angularLobe(angle, center, width) {
  const delta = Math.atan2(Math.sin(angle - center), Math.cos(angle - center));
  return Math.exp(-(delta * delta) / (2 * width * width));
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
// C1 easing. Its peak derivative is 1.5/W against smootherstep's 1.875/W, which
// matters wherever a large amplitude is multiplied by a radial ramp.
function smoothstep01(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function smootherstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
