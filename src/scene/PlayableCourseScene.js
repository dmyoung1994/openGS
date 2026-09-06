import {
  Group, Mesh, CylinderGeometry, BufferGeometry, BufferAttribute,
  MeshStandardMaterial, MeshPhysicalMaterial, InstancedMesh,
  Object3D, Vector2, Vector3, DoubleSide,
  CanvasTexture, TextureLoader, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter,
  RepeatWrapping, ClampToEdgeWrapping,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import {
  loadTreePrototype, getVerifiedTreeLods, buildTreeBeautyMeshLod, TreeShadowLod,
} from './Trees.js';
import { createGolfBallMesh } from './GolfBall.js';
import { disposeMaterialTextures, disposeWebGPUGeometries } from './WebGPUResourceDisposal.js';
import { yieldToRendering } from '../util/yieldToRendering.js';
import { Noise } from '../util/noise.js';
import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';
import { resolveEnvironmentPlacements } from '../environment/EnvironmentPlacement.js';
import { getCatalogAsset } from '../environment/EnvironmentCatalog.js';
import { validateProceduralTreeClearance, CourseSchemaError } from '../course/course.js';
import { WaterSurface } from './WaterSurface.js';
import { PlanarWaterReflection } from './PlanarWaterReflection.js';
import { buildEnvironmentProps } from './EnvironmentProps.js';
import { BackdropTerrain } from './BackdropTerrain.js';
import { buildHazardPatchGeometry } from './Bunkers.js';
import { FlagClothSystem } from './FlagCloth.js';
import {
  bunkerGradeAt, roundedHazardFeature, signedDistanceToFeature,
} from '../course/featureGeometry.js';
import { compileBiomeTransitionField } from '../course/BiomeRegistry.js';
import { semanticLandformHeight } from '../course/SemanticLandforms.js';
import { ProceduralTreeForest, proceduralTreeCanopyRadius, proceduralTreeFlareRadius } from './ProceduralTrees.js';
import { createCreatorCanvasFrame } from './CreatorCanvasFrame.js';
import { createCreatorFringeGrass } from './CreatorFringeGrass.js';
import { createCreatorCanvasOutline } from '../course/CreatorCanvas.js';
import { createCreatorCup, GOLF_HOLE_RADIUS_M } from './CreatorCup.js';
import { nearestRouteSignedDistance } from '../course/RouteGeometry.js';
import { normalizeSurfaceMaterials } from '../course/course.js';
import { Birds } from './Birds.js';

const _tex = new TextureLoader();
const _gltf = new GLTFLoader();
const TEE_MARKER_LINE_OFFSET = 0.4;
const TEE_MARKER_MODEL_URL = '/assets/props/rangeform-tee-marker/rangeform-limestone-tee-marker.glb';
const TEE_MARKER_TEXTURE_URLS = Object.freeze({
  color: '/assets/materials/travertine_009/travertine_009_color_1k.jpg',
  normal: '/assets/materials/travertine_009/travertine_009_normal_gl_1k.jpg',
  roughness: '/assets/materials/travertine_009/travertine_009_roughness_1k.jpg',
  ao: '/assets/materials/travertine_009/travertine_009_ao_1k.jpg',
});
let _teeMarkerGeometryPromise = null;
let _teeMarkerTextures = null;

function loadSharedTeeMarkerGeometry() {
  if (_teeMarkerGeometryPromise) return _teeMarkerGeometryPromise;
  _teeMarkerGeometryPromise = _gltf.loadAsync(TEE_MARKER_MODEL_URL).then((gltf) => {
    let geometry = null;
    gltf.scene.traverse((object) => {
      if (object.isMesh && !geometry) geometry = object.geometry;
    });
    if (!geometry) throw new Error(`Tee-marker GLB contains no mesh geometry: ${TEE_MARKER_MODEL_URL}`);
    geometry.userData.sharedWebGPUAsset = true;
    return geometry;
  });
  return _teeMarkerGeometryPromise;
}

function loadSharedTeeMarkerTextures() {
  if (_teeMarkerTextures) return _teeMarkerTextures;
  const loaded = {};
  const pending = Object.entries(TEE_MARKER_TEXTURE_URLS).map(([name, url]) => new Promise((resolve, reject) => {
    const texture = _tex.load(url, () => resolve(texture), undefined, (error) => {
      reject(error || new Error(`Required tee-marker texture failed to load: ${url}`));
    });
    texture.name = `rangeform-tee-marker-${name}`;
    texture.flipY = false;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.userData.sharedWebGPUAsset = true;
    loaded[name] = texture;
  }));
  loaded.color.colorSpace = SRGBColorSpace;
  loaded.ao.channel = 1;
  _teeMarkerTextures = { ...loaded, ready: Promise.all(pending) };
  return _teeMarkerTextures;
}

// Reusable production composition for playable golf scenes. Range and CourseScene
// select different routing/lifecycle contracts while consuming these same terrain,
// hazard, water, vegetation, target, and ball-presentation primitives.
export class PlayableCourseScene {
  // `course` is a normalized spec (see src/course/course.js) of FEATURES only —
  // greens, bunkers, ponds, the fairway corridor, the tee. The engine bakes the
  // terrain from these (heightFn/surfaceFn below); nothing here edits raw heights.
  // That is what lets the whole course be (re)built from a prompt-driven course.json
  // with no terrain-editing surface exposed to the user.
  constructor(scene, camera, course, options = {}) {
    const steps = this._buildSteps(scene, camera, course, options);
    if (options.deferBuild) this._pendingBuild = steps;
    else while (!steps.next().done) { /* Synchronous authoring/test callers. */ }
  }

  static async create(scene, camera, course, options = {}) {
    const result = new this(scene, camera, course, { ...options, deferBuild: true });
    let value;
    try {
      for (;;) {
        const step = result._pendingBuild.next(value);
        if (step.done) break;
        value = await step.value;
        await yieldToRendering();
      }
      return result;
    } catch (error) {
      if (result.group) result.dispose();
      throw error;
    } finally { delete result._pendingBuild; }
  }

  *_buildSteps(scene, camera, course, { renderer, motionHistory, lighting, environmentTier, environment, environmentCatalog, creatorCanvas = false, sceneKind = 'course', deferBuild = false } = {}) {
    if (!environmentTier?.grassRadius || !environmentTier?.trees) {
      throw new Error('PlayableCourseScene requires the resolved environment device tier.');
    }
    this.scene = scene;
    this.camera = camera;
    this.course = course;
    this.sceneKind = sceneKind;
    this.environmentSeed = normalizeSeed(course.environmentSeed);
    this.renderer = renderer;
    this.lighting = lighting;
    this.motionHistory = motionHistory;
    this.environmentTier = environmentTier;
    if (!environment?.windAt) throw new Error('PlayableCourseScene requires shared EnvironmentGpuBindings.');
    if (!environmentCatalog?.byId) throw new Error('PlayableCourseScene requires the verified environment catalog.');
    this.environment = environment;
    this.environmentCatalog = environmentCatalog;
    this.creatorCanvas = creatorCanvas === true;
    this.creatorCanvasOutline = this.creatorCanvas ? createCreatorCanvasOutline(course) : null;
    // Quality can be selected before asynchronous tree GLBs finish decoding.
    // Retain the requested policy so every species applies it atomically when its
    // exact authored prototype becomes available.
    this.treeWorkloadPolicy = 'ultra';
    this.treePresentationAnchors = [];
    this.group = new Group();
    scene.add(this.group);

    this.noise = new Noise(7);
    // Feature arrays come straight from the course spec. Greens carry a named
    // internal contour; bunkers carve depressions (pot = deep steep revetted pit);
    // ponds are dished water basins. See _height/_surface for how they bake.
    this.targets = course.greens;
    this.routing = course.routing ?? null;
    this.activeHoleId = this.routing?.activeHoleId ?? null;
    this.routingHoles = this.routing?.holes ?? [];
    this.routeCorridors = this.routing
      ? [
        ...this.routingHoles.map((hole) => hole.route),
        ...this.routing.transitions.map((transition) => ({ points: transition.points, c0: transition.width, k: 0, rough: Math.max(1.5, transition.width * 0.75), kind: 'transition' })),
      ]
      : [];
    this.landforms = course.landforms || [];
    // Target furniture is deliberately shared within a playable-scene rebuild: one cloth
    // solver, one painted-number atlas/mesh, and merged poles/cups avoid allocating
    // a separate render asset per target.
    this._targetPropAssets = null;
    this._targetPropsReady = null;
    this.flagCloth = null;
    this.creatorPin = null;
    this.bunkers = course.bunkers.map((feature, index) => {
      const rounded = roundedHazardFeature(feature, { kind: 'bunker', index });
      const sandFeature = rounded.pot ? null : Object.freeze({
        x: rounded.x, z: rounded.z, r: rounded.r, shape: rounded._sandShape,
      });
      return Object.freeze({
        ...rounded,
        ...bunkerDrainageAxis(this.noise, rounded, index, this.landforms),
        _sandFeature: sandFeature,
      });
    });
    // Most terrain samples are far from authored features. Cache conservative
    // plan-view bounds once so the expensive polygon SDF only runs in a feature's
    // actual influence region; this is an exact broad-phase cull, not a visual or
    // physics approximation.
    this._targetBounds = this.targets.map((feature) => featureBounds(feature));
    this._bunkerBounds = this.bunkers.map((feature) => featureBounds(feature));
    // Cache each pond's centre-to-outline inset once.  The same signed outline
    // drives terrain, collision classification, water geometry, and placement;
    // keeping this scalar avoids re-walking the 24-sample smoothed polygon for
    // every heightfield sample.
    this.ponds = course.ponds.map((feature, index) => {
      const pond = roundedHazardFeature(feature, { kind: 'pond', index });
      return Object.freeze({
        ...pond,
        _centerInset: signedDistanceToFeature(pond, pond.x, pond.z),
        _bounds: featureBounds(pond),
      });
    });
    this.forestFloorAreas = course.forestFloorAreas ?? [];
    this.tee = course.tee;
    this.teePads = this.routing ? this.routingHoles.flatMap((hole) => hole.tees) : [];
    this.corridor = course.corridor;
    this.fringeW = course.fringeW;
    // Water is a constant datum, not a height sampled from the pond centre.
    // Resolve it from the authored shoreline before Terrain starts sampling;
    // this avoids a Terrain -> playable scene -> Terrain recursion and keeps rebuilds
    // deterministic when the outline is irregular.
    this._pondWaterLevels = new Map(
      this.ponds.map((pond) => [pond, pondWaterDatum(pond, (x, z) => this._baseHeight(x, z))]),
    );
    this.biomeField = compileBiomeTransitionField(course);

    const terrainConfig = {
      bounds: course.bounds,
      spacing: 0.6,          // fine physics/collision grid (accurate ball roll)
      // Match the render mesh to the baked height grid. Sampling a 0.6 m bilinear
      // heightfield on a 1 m mesh creates a 3 m beat in the visible rows at grazing
      // angles; that was the source of the regular fairway striping during startup.
      renderSpacing: 0.6,
      heightFn: (x, z) => this._height(x, z),
      surfaceFn: (x, z) => this._surface(x, z),
      // Geometric spec for the shader's analytic (smooth-curve) turf zones. Mirrors
      // the circles/corridor in _surface so the visual edges match gameplay zones.
      zones: {
        greens: this.targets.map((t, index) => ({
          x: t.x, z: t.z, r: t.r,
          fringeWidth: this._fringeWidthForGreen(index),
          ...(t.shape ? { shape: t.shape } : {}),
        })),
        sands: this.bunkers.map((b) => ({
          x: b.x, z: b.z, r: b.r,
          ...(b.pot ? { shape: b.shape, inset: b.r * 0.28, pot: true } : { shape: b._sandShape }),
        })),
        waters: this.ponds.map((p) => ({
          x: p.x, z: p.z, r: p.r, ...(p.shape ? { shape: p.shape } : {}),
        })),
        forestFloors: this.forestFloorAreas,
        corridor: this.corridor,                                     // halfWidth = c0 + (-z)*k, then rough band
        routes: this.routeCorridors,
        tees: this.creatorCanvas ? [] : this.teePads.map((tee) => ({ x: tee.x, z: tee.z, shape: tee.shape })),
        tee: this.creatorCanvas || this.routing ? null : { x: this.tee.boxHalfX, z0: this.tee.z0, z1: this.tee.z1 },
        fringeW: this.fringeW,
      },
      motionHistory,
      renderer,
      biomeField: this.biomeField,
      groundCover: course.groundCover,
      surfaceMaterials: course.surfaceMaterials,
      analyticHeightFn: (x, z) => this._height(x, z),
      analyticPatchContains: (x, z, padding = 0) => this.bunkers.some((bunker) => (
        bunker.pot && signedDistanceToFeature(bunker, x, z) > -padding
      )),
      finiteCanvas: this.creatorCanvas,
      cupCutout: sceneKind === 'play',
      finiteOutline: this.creatorCanvasOutline,
      // The creator top mesh terminates at this regulation opening. The recessed
      // liner added with the pin is therefore visible through real missing turf
      // geometry, not through a dark decal or a cylinder hidden below a solid plane.
      finiteCutout: this.creatorCanvas ? {
        x: this.targets[0]?.pin?.x ?? this.targets[0]?.x ?? 0,
        z: this.targets[0]?.pin?.z ?? this.targets[0]?.z ?? 0,
        radius: GOLF_HOLE_RADIUS_M,
      } : null,
      variationSeed: this.environmentSeed,
    };
    this.terrain = deferBuild ? yield Terrain.create(terrainConfig) : new Terrain(terrainConfig);
    yield;
    if (this.creatorCanvas) {
      // Presentation exposure only: the same authored PBR maps and shared daylight
      // remain authoritative, but the isolated maquette has no surrounding world to
      // bounce light back into its turf or earthen edge.
      this.terrain.uVal.value = 1.30;
      this.terrain.uSat.value = 1.05;
    }
    // Persisted surface authoring owns the final semantic values in every page
    // composition, including the creator showcase. Terrain maps this contract onto
    // its live uniforms without rebuilding geometry or GPU scene ownership.
    this.terrain.applySurfaceMaterials(course.surfaceMaterials);
    this.group.add(this.terrain.mesh);
    this.creatorCanvasFrame = this.creatorCanvas ? createCreatorCanvasFrame({
      outline: this.creatorCanvasOutline,
      heightAt: (x, z) => this.terrain.heightAt(x, z),
    }) : null;
    if (this.creatorCanvasFrame) this.group.add(this.creatorCanvasFrame);
    this.creatorFringeGrass = this.creatorCanvas ? createCreatorFringeGrass({
      green: this.targets[0],
      fringeWidth: this.fringeW,
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      seed: this.environmentSeed,
    }) : null;
    if (this.creatorFringeGrass) this.group.add(this.creatorFringeGrass);
    this._buildPotBunkerPatches();
    yield;
    const backdropOptions = {
      terrain: this.terrain,
      bounds: course.bounds,
      seed: this.environmentSeed,
      biome: course.biome,
      biomeField: this.biomeField,
      // The backdrop shares the scene's one atmosphere rather than blending in a
      // fixed haze colour of its own; see worldMaterial in BackdropTerrain.js.
      environment,
      renderer,
    };
    this.backdrop = this.creatorCanvas ? null : deferBuild
      ? yield BackdropTerrain.create(backdropOptions) : new BackdropTerrain(backdropOptions);
    if (this.backdrop) this.group.add(this.backdrop.group);
    yield;
    this.terrain.waterHeightAt = (x, z) => this.waterHeightAt(x, z);
    this.environmentPlacements = resolveEnvironmentPlacements(course, environmentCatalog, this.terrain, this.biomeField);
    // Resolve one immutable tree record set for both the visible forest and the
    // grass bake. Canopy suppression therefore follows the exact authored roots
    // and scaled catalog crown bounds rather than a second procedural forest mask.
    const catalogTreePlacements = this._treePlacements();
    const proceduralTreePlacements = this._proceduralTreePlacements();
    const canopyPlacements = [...catalogTreePlacements, ...proceduralTreePlacements];
    if (deferBuild) yield this.terrain.prepareCanopyPlacements(canopyPlacements);
    else this.terrain.setCanopyPlacements(canopyPlacements);
    yield;

    // Camera-relative grass (WebGPU / TSL). A world-cell-anchored field of ~1M
    // blades follows the camera every frame, sampling terrain height + surface
    // from GPU textures, with density/height LOD falling off with distance. So
    // wherever you look — tee, mid-fairway, a green after a shot — there's turf.
    this.grass = this.creatorCanvas ? null : new Grass({
      terrain: this.terrain, camera: this.camera, renderer, motionHistory, environment,
      radius: environmentTier.grassRadius,
      canopyPlacements,
    });
    if (this.grass) this.group.add(this.grass.mesh);
    yield;
    this.birds = this.creatorCanvas ? null : new Birds({ course, terrain: this.terrain, environment });
    if (this.birds) this.group.add(this.birds.group);

    if (this.creatorCanvas) {
      this._buildCreatorPin();
    } else {
      this._buildTee();
      this._buildTargets();
      this._buildWater();
    }
    yield;
    this.waterReflection = this.creatorCanvas ? null : new PlanarWaterReflection({
      renderer,
      scene,
      camera: this.camera,
      surfaces: this._water || [],
      environmentTier,
      qualityContract: () => globalThis.window?.golf?.quality?.policySnapshot?.() ?? null,
      forceAnalyticOnHandheld: true,
    });
    const treesReady = this.creatorCanvas ? Promise.resolve() : this._buildTreeLine(catalogTreePlacements, proceduralTreePlacements);
    const environmentPropsReady = this.creatorCanvas ? Promise.resolve() : this._buildEnvironmentProps();
    const ballReady = this._buildBall().then((mesh) => {
      // GolfBall intentionally reveals itself only after its required GLB and
      // normal map resolve. Re-assert canvas visibility after that async reveal.
      if (this.creatorCanvas) mesh.visible = false;
      return mesh;
    });
    // Replacing a course removes and recreates static shadow casters. Mark the
    // retained directional map dirty immediately; the async tree proxy marks it
    // again when its new GPU record set is ready.
    this.lighting?.invalidateShadow();
    // The environment benchmark waits for this before it begins its shader warm-up.
    // Every visible asset is required. Bunker sand is part of the authoritative
    // terrain material rather than a second, independently tessellated surface.
    const waterReady = Promise.all((this._water || []).map((surface) => surface.assetsReady));
    const backdropReady = this.creatorCanvas ? Promise.resolve() : this.backdrop.assetsReady;
    const waterReflectionReady = this.creatorCanvas ? Promise.resolve() : this.waterReflection.assetsReady;
    const creatorFrameReady = this.creatorCanvasFrame?.userData?.assetsReady || Promise.resolve();
    const targetPropsReady = this._targetPropsReady || Promise.resolve();
    this.assetsReady = Promise.all([
      this.terrain.assetsReady, backdropReady,
      treesReady, environmentPropsReady, ballReady, waterReady,
      waterReflectionReady, creatorFrameReady, targetPropsReady,
    ]);
  }

  // ---- Terrain definition -------------------------------------------------

  _height(x, z) {
    let h = this._baseHeight(x, z);
    for (const p of this.ponds) {
      if (!inFeatureBounds(p._bounds, x, z, 4)) continue;
      const sd = signedDistanceToFeature(p, x, z);
      const level = this._waterLevel(p);
      // The water plane is the top datum. Grade the basin monotonically down
      // from that exact shoreline, and return outside to natural grade over a
      // short erosion shoulder.
      h = pondGradeAt({ pond: p, signedDistance: sd, baseHeight: h, waterLevel: level });
    }
    return h;
  }

  _baseHeight(x, z) {
    if (this.creatorCanvas) return semanticLandformHeight(this.landforms, x, z);
    // Collision-authoritative course form. One lateral drainage swale, offset
    // maintained-ground benches, and elongated low rolls create readable terrain
    // shadows from golfer height. Every primitive is metre-scaled and aperiodic;
    // the low-amplitude fBm breaks their shoulders without becoming random moguls.
    let h = courseLandformHeight(this.noise, x, z);
    h += semanticLandformHeight(this.landforms, x, z);

    // Greens inherit the continuous course landform. Their authored irregular SDF
    // still owns gameplay, cut height, pigment, roughness, and fringe. There is no
    // additive per-green elevation pad: even an outline-aware shoulder produces
    // two conspicuous contour rings in the fixed overview camera.

    // Carve each bunker as a depression CUT INTO the grade — never a raised rim.
    // Real bunkers sit BELOW the surrounding turf: a flat sand floor that would
    // drain to the low point, walls rising back to grade, and a rim that is FLUSH
    // with the surrounding ground. The old code added a Gaussian grass ridge just
    // OUTSIDE the rim (h += lip) — a ring of raised turf around the hole — which is
    // exactly what made every bunker read as a meteor crater. Framing, where wanted,
    // belongs to the landform / green shoulders, not a ring around the pit.
    //   • regular: a flashed face — sand sweeps up a moderate wall to a grade rim.
    //   • pot:     a deep, near-vertical REVETTED pit — a small flat floor and steep
    //              turf walls straight up to a flush rim (no lip). The stacked-sod
    //              wall look is added by the shader on steep faces; the sand stays on
    //              the floor (see Bunkers.js's bunkerSandRadius).
    for (let bunkerIndex = 0; bunkerIndex < this.bunkers.length; bunkerIndex += 1) {
      const b = this.bunkers[bunkerIndex];
      if (!inFeatureBounds(this._bunkerBounds[bunkerIndex], x, z)) continue;
      const sd = signedDistanceToFeature(b, x, z);
      if (sd <= 0) continue;                               // outside the footprint → grade untouched
      h = bunkerGradeAt({
        bunker: b, signedDistance: sd, baseHeight: h, x, z,
      });
    }

    // Every routed tee is flattened at its authored site position. Legacy v3 keeps
    // its exact origin pad. The center datum comes from the same natural landform,
    // so an elevated tee remains elevated without a tilted hitting surface.
    if (this.routing) {
      for (const tee of this.teePads) {
        const extentX = Math.max(...tee.shape.map((point) => Math.abs(point.x - tee.x))) + 5;
        const extentZ = Math.max(...tee.shape.map((point) => Math.abs(point.z - tee.z))) + 5;
        const influence = Math.exp(-(((x - tee.x) ** 2) / (extentX ** 2) * 2.2 + ((z - tee.z) ** 2) / (extentZ ** 2) * 2.2));
        const datum = courseLandformHeight(this.noise, tee.x, tee.z) + semanticLandformHeight(this.landforms, tee.x, tee.z);
        h = h * (1 - influence) + datum * influence;
      }
    } else {
      const teeFlat = Math.exp(-((x * x) / 40 + ((z - 2) * (z - 2)) / 60));
      h = h * (1 - teeFlat) + 0.02 * teeFlat;
    }
    return h;
  }

  // Water surface elevation for a pond (the flat plane the water mesh sits at).
  _waterLevel(p) {
    return this._pondWaterLevels?.get(p) ?? -p.depth * 0.45;
  }

  _surface(x, z) {
    if (this.creatorCanvas) {
      const green = this.targets[0];
      if (!green) return 'fringe';
      return signedDistanceToFeature(green, x, z) > 0 ? 'green' : 'fringe';
    }
    // One precedence contract matches ZoneMap.zoneAt: water, tee, sand, green,
    // fringe, fairway, rough, deep rough.
    for (const p of this.ponds) {
      if (inFeatureBounds(p._bounds, x, z) && signedDistanceToFeature(p, x, z) > 0) return 'water';
    }

    if (this.routing) {
      for (const tee of this.teePads) if (pointInConvexShape(tee.shape, x, z)) return 'tee';
    } else if (Math.abs(x - this.tee.x) < this.tee.boxHalfX && z < this.tee.z1 && z > this.tee.z0) return 'tee';

    // Sand bunkers — a regular bunker keeps a world-stable 0.30–0.50 m turf
    // face between the exact grade-flush carve and its separately compiled sand
    // contour. The CPU lie and GPU SDF consume that same inner outline. A pot
    // bunker retains its wider revetted turf wall and small sand floor.
    for (let bunkerIndex = 0; bunkerIndex < this.bunkers.length; bunkerIndex += 1) {
      const b = this.bunkers[bunkerIndex];
      if (!inFeatureBounds(this._bunkerBounds[bunkerIndex], x, z)) continue;
      if (b.pot) {
        if (signedDistanceToFeature(b, x, z) > b.r * 0.28) return 'sand';
      } else if (signedDistanceToFeature(b._sandFeature, x, z) > 0) return 'sand';
    }


    for (let targetIndex = 0; targetIndex < this.targets.length; targetIndex += 1) {
      const t = this.targets[targetIndex];
      const fringeWidth = this._fringeWidthForGreen(targetIndex);
      if (!inFeatureBounds(this._targetBounds[targetIndex], x, z, fringeWidth)) continue;
      const sd = signedDistanceToFeature(t, x, z);
      if (sd > 0) return 'green';
      if (sd + fringeWidth > 0) return 'fringe';
    }

    if (this.routeCorridors.length) {
      let fairway = -Infinity;
      let rough = -Infinity;
      for (const route of this.routeCorridors) {
        const distance = nearestRouteSignedDistance([route], x, z);
        fairway = Math.max(fairway, distance);
        rough = Math.max(rough, distance + route.rough);
      }
      if (fairway > 0) return 'fairway';
      if (rough > 0) return 'rough';
      return 'deepRough';
    }

    const halfWidth = this.corridor.c0 + (-z) * this.corridor.k; // widens down range
    const ax = Math.abs(x);
    if (ax > halfWidth + this.corridor.rough) return 'deepRough';
    if (ax > halfWidth) return 'rough';
    return 'fairway';
  }

  // ---- Props --------------------------------------------------------------

  _fringeWidthForGreen(index) {
    const owner = this.routingHoles.find((hole) => index >= hole.greenStart && index < hole.greenStart + hole.greenCount);
    return owner?.fringeWidth ?? this.fringeW;
  }

  activeHole() {
    return this.routingHoles.find((hole) => hole.holeId === this.activeHoleId) ?? null;
  }

  activeAim() {
    return this.activeHole()?.aim ?? { x: 0, z: -1 };
  }

  _buildTee() {
    // The ball now rests directly on the rendered tee turf. Keeping this area free
    // of raised prop geometry also guarantees that the physics lie and visible
    // contact plane agree at address.

    // Two compact carved-stone markers sit just downrange of the ball. The selected
    // Rangeform crest is actual recessed geometry; the scene stays invisible until
    // its required GLB and complete travertine PBR set have loaded.
    const assets = this._targetProps();
    const stone = loadSharedTeeMarkerTextures();
    const tees = this.routing ? this.teePads : [{ ...this.tee, aim: { x: 0, z: -1 } }];
    const markerMaterial = new MeshStandardMaterial({
      map: stone.color,
      normalMap: stone.normal,
      normalScale: new Vector2(0.58, 0.58),
      roughnessMap: stone.roughness,
      roughness: 0.92,
      metalness: 0,
      aoMap: stone.ao,
      aoMapIntensity: 0.72,
      vertexColors: true,
    });
    markerMaterial.name = 'rangeform-warm-limestone-pbr';
    const markerMesh = new InstancedMesh(new BufferGeometry(), markerMaterial, tees.length * 2);
    markerMesh.visible = false;
    const markerDummy = new Object3D();
    let markerIndex = 0;
    for (const tee of tees) {
      const owner = this.routingHoles.find((hole) => hole.holeId === tee.holeId);
      const aim = owner?.aim ?? tee.aim ?? { x: 0, z: -1 };
      const right = { x: -aim.z, z: aim.x };
      for (const side of [-1.8, 1.8]) {
        const x = tee.x + aim.x * TEE_MARKER_LINE_OFFSET + right.x * side;
        const z = tee.z + aim.z * TEE_MARKER_LINE_OFFSET + right.z * side;
        markerDummy.position.set(x, this.terrain.heightAt(x, z), z);
        markerDummy.rotation.y = Math.atan2(aim.x, -aim.z);
        markerDummy.updateMatrix();
        markerMesh.setMatrixAt(markerIndex++, markerDummy.matrix);
      }
    }
    markerMesh.instanceMatrix.needsUpdate = true;
    markerMesh.castShadow = true;
    markerMesh.receiveShadow = true;
    markerMesh.name = 'tee-markers-instanced';
    markerMesh.userData.instanceCount = tees.length * 2;
    markerMesh.userData.assetId = 'rangeform-limestone-tee-marker';
    this.group.add(markerMesh);
    const markerReady = Promise.all([stone.ready, loadSharedTeeMarkerGeometry()]).then(([, geometry]) => {
      if (this._disposed) return;
      const placeholder = markerMesh.geometry;
      markerMesh.geometry = geometry;
      markerMesh.computeBoundingSphere();
      placeholder.dispose();
      markerMesh.visible = true;
      this.lighting?.invalidateShadow(true, { reason: 'tee-marker-ready' });
    });
    this._targetPropsReady = Promise.all([this._targetPropsReady, markerReady]);
  }

  _buildPotBunkerPatches() {
    const pots = this.bunkers.filter((bunker) => bunker.pot);
    if (!pots.length) return;
    const group = new Group();
    group.name = 'pot-bunker-fixed-detail-patches';
    for (const bunker of pots) {
      const mesh = new Mesh(
        buildHazardPatchGeometry(bunker, {
          radial: 192,
          rings: 40,
          heightAt: (x, z) => this.terrain.heightAt(x, z),
          normalAt: (x, z) => this.terrain.normalAt(x, z),
        }),
        this.terrain.createHazardPatchMaterial(),
      );
      mesh.name = 'pot-bunker-world-anchored-patch';
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.renderOrder = 1;
      mesh.layers.enable(2);
      group.add(mesh);
    }
    this.potBunkerPatches = group;
    this.group.add(group);
  }

  _targetProps() {
    if (this._targetPropAssets) return this._targetPropAssets;
    let resolveWood, rejectWood;
    const woodReady = new Promise((resolve, reject) => {
      resolveWood = resolve;
      rejectWood = reject;
    });
    const wood = _tex.load(
      '/assets/materials/flagstick/premium_walnut_albedo_1k.png',
      () => resolveWood(),
      undefined,
      (error) => {
        console.error('[flagstick] required premium walnut texture failed to load');
        rejectWood(error || new Error('Failed to load premium walnut flagstick texture'));
      },
    );
    wood.name = 'flagstick:generated-premium-walnut-albedo';
    wood.colorSpace = SRGBColorSpace;
    wood.wrapS = RepeatWrapping;
    wood.wrapT = ClampToEdgeWrapping;
    wood.minFilter = LinearMipmapLinearFilter;
    wood.magFilter = LinearFilter;
    wood.generateMipmaps = true;
    wood.anisotropy = 8;

    this._targetPropAssets = {
      // A slender 12--15 mm hardwood taper replaces the former 52--68 mm prop.
      // The 2.48 m stick still extends 8 cm below grade into the cup, while sixteen
      // radial faces keep the clear-coated silhouette round in the close creator view.
      poleGeometry: new CylinderGeometry(0.006, 0.0075, 2.48, 16),
      poleMaterial: new MeshPhysicalMaterial({
        map: wood,
        color: 0xffffff,
        roughness: 0.42,
        metalness: 0,
        clearcoat: 0.62,
        clearcoatRoughness: 0.24,
      }),
      cupGeometry: new CylinderGeometry(0.075, 0.075, 0.035, 20),
      cupMaterial: new MeshStandardMaterial({ color: 0x20251f, roughness: 0.96, metalness: 0 }),
      assetsReady: woodReady,
    };
    this._targetPropAssets.poleGeometry.name = 'premium-hardwood-flagstick-12-15mm';
    this._targetPropAssets.poleMaterial.name = 'premium-clear-coated-walnut-flagstick';
    this._targetPropsReady = woodReady;
    return this._targetPropAssets;
  }

  _buildCreatorPin() {
    const assets = this._targetProps();
    // The closer opening composition makes the production regulation dimensions
    // readable without turning the pin into an oversized maquette prop.
    const x = this.targets[0]?.pin?.x ?? this.targets[0]?.x ?? 0;
    const z = this.targets[0]?.pin?.z ?? this.targets[0]?.z ?? 0;
    const y = this.terrain.heightAt(x, z);
    const pin = new Group();
    pin.name = 'creator-center-pin';

    const pole = new Mesh(assets.poleGeometry, assets.poleMaterial);
    pole.name = 'creator-center-pin-pole';
    pole.position.set(x, y + 1.16, z);
    pole.castShadow = true;
    pole.receiveShadow = true;
    pin.add(pole);

    const cup = createCreatorCup({ x, z, surfaceY: y });
    pin.add(cup);

    this.flagCloth = new FlagClothSystem({
      anchors: [{ x, y: y + 2.34, z }],
      environment: this.environment,
      colors: [0xf24a3d],
    });
    this.flagCloth.mesh.name = 'creator-center-pin-cloth';
    pin.add(this.flagCloth.mesh);
    pin.userData.creatorPin = true;
    pin.userData.windSource = 'environment-frame-state';
    pin.userData.position = Object.freeze({ x, y, z });
    this.creatorPin = pin;
    this.group.add(pin);
  }

  _buildTargets() {
    const assets = this._targetProps();
    const count = this.targets.length;
    const poleMesh = new InstancedMesh(assets.poleGeometry, assets.poleMaterial, count);
    const cupMesh = new InstancedMesh(assets.cupGeometry, assets.cupMaterial, count);
    cupMesh.visible = this.sceneKind !== 'play'; // Play owns a recessed regulation cup at the active pin.
    const dummy = new Object3D();
    const flagColors = [0xf0eee5, 0xc8d0c4, 0xefe6cf, 0xaeb9ad];
    const anchors = [];
    this.targets.forEach((t, index) => {
      const pin = t.pin ?? t;
      const y = this.terrain.heightAt(pin.x, pin.z);
      dummy.position.set(pin.x, y + 1.16, pin.z);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(index, dummy.matrix);
      dummy.position.set(pin.x, y - 0.026, pin.z);
      dummy.updateMatrix();
      cupMesh.setMatrixAt(index, dummy.matrix);
      anchors.push({ x: pin.x, y: y + 2.34, z: pin.z });
    });
    for (const mesh of [poleMesh, cupMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.flagCloth = new FlagClothSystem({ anchors, environment: this.environment, colors: this.targets.map((t) => flagColors[Math.round(t.yards / 50) % flagColors.length]) });
    this.group.add(this.flagCloth.mesh);
    this.yardagePaint = this._paintedYardages();
    this.group.add(this.yardagePaint);
    const drawBuckets = Object.freeze({ flagPoles: 1, flagCloth: 1, recessedCups: 1, paintedYardages: 1, teeMarkers: 1 });
    this.group.userData.targetPropDiagnostics = Object.freeze({
      drawBuckets,
      signDraws: 0,
      instances: Object.freeze({ flagPoles: count, flagCloth: count, recessedCups: count, paintedYardages: count, teeMarkers: 2 }),
      targetDraws: 4,
    });
  }

  targetPropDiagnostics() {
    return this.group.userData.targetPropDiagnostics || Object.freeze({
      drawBuckets: Object.freeze({}), signDraws: 0, instances: Object.freeze({}), targetDraws: 0,
    });
  }

  _paintedYardages() {
    const cell = 384;
    const columns = Math.ceil(Math.sqrt(this.targets.length));
    const rows = Math.ceil(this.targets.length / columns);
    const canvas = document.createElement('canvas');
    canvas.width = columns * cell; canvas.height = rows * cell;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 18;
    ctx.font = '800 210px ui-serif, Georgia, serif';
    this.targets.forEach((target, index) => {
      const x = (index % columns + 0.5) * cell, y = (Math.floor(index / columns) + 0.5) * cell;
      ctx.strokeStyle = 'rgba(46,55,42,0.72)'; ctx.strokeText(`${target.yards}`, x, y);
      ctx.fillStyle = '#eee8d6'; ctx.fillText(`${target.yards}`, x, y);
    });
    const tex = new CanvasTexture(canvas);
    tex.name = 'painted-yardage-number-atlas';
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = 16;
    const positions = [], uvs = [], indices = [];
    this.targets.forEach((target, index) => {
      const z = target.z + target.r + 3.0;
      const width = Math.max(1.7, String(target.yards).length * 0.62), depth = 0.92;
      const corners = [[-width / 2, -depth / 2], [width / 2, -depth / 2], [-width / 2, depth / 2], [width / 2, depth / 2]];
      const base = positions.length / 3;
      for (const [dx, dz] of corners) positions.push(target.x + dx, this.terrain.heightAt(target.x + dx, z + dz) + 0.012, z + dz);
      const col = index % columns, row = Math.floor(index / columns);
      const u0 = col / columns, u1 = (col + 1) / columns;
      const v0 = 1 - (row + 1) / rows, v1 = 1 - row / rows;
      uvs.push(u0, v1, u1, v1, u0, v0, u1, v0);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    geometry.name = 'terrain-conforming-painted-yardages-merged';
    const material = new MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.16, side: DoubleSide, roughness: 0.96, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'painted-yardages-merged'; mesh.castShadow = false; mesh.receiveShadow = true;
    return mesh;
  }

  _buildWater() {
    for (const p of this.ponds) {
      const level = this._waterLevel(p);
      const surface = new WaterSurface({
        environment: this.environment, pond: p, level,
      });
      this.group.add(surface.mesh);
      this._water = this._water || [];
      this._water.push(surface);
    }
  }

  waterHeightAt(x, z) {
    for (const surface of this._water || []) if (surface.contains(x, z)) return surface.level;
    return null;
  }

  addWaterImpact(position, speed) {
    const surface = (this._water || []).find((candidate) => candidate.contains(position.x, position.z));
    if (!surface) throw new Error('Water impact did not resolve to an authored pond.');
    surface.addImpact(position, speed);
  }

  captureWaterReflections({ force = false, backgroundNode = null } = {}) {
    void backgroundNode;
    return this.waterReflection?.capture({ force }) ?? 0;
  }

  waterReflectionDiagnostics() {
    return (this._water || []).map((surface) => ({
      ...surface.reflectionDiagnostics(),
      planarPass: this.waterReflection?.surfaceDiagnostics(surface) ?? null,
    }));
  }

  _treePlacements() {
    const trees = this.environmentPlacements.filter((placement) => (
      getCatalogAsset(this.environmentCatalog, placement.assetId).category === 'tree'
    ));
    return trees.map((placement) => {
      const asset = getCatalogAsset(this.environmentCatalog, placement.assetId);
      return Object.freeze({
        ...placement,
        rotY: placement.rotationY,
        canopyRadius: asset.bounds.radius * placement.scale,
      });
    });
  }

  _proceduralTreePlacements() {
    const definitions = this.course.environment.proceduralTreeDefinitions || [];
    return (this.course.environment.proceduralTrees || []).map((placement) => Object.freeze({
      ...placement,
      rotY: placement.rotationY,
      canopyRadius: proceduralTreeCanopyRadius(placement, definitions),
      flareRadius: proceduralTreeFlareRadius(placement, definitions),
    }));
  }

  // Load a verified authored LOD0+LOD1 pair wherever the catalog provides one.
  // A catalog asset that currently owns only exact authored LOD0 remains on that
  // source mesh; it is never replaced by an impostor, billboard, procedural tree,
  // or another species.
  async _createTreeLine(placements, proceduralPlacements, {
    catalog = this.environmentCatalog,
    cacheBust = null,
    proceduralDefinitions = this.course.environment.proceduralTreeDefinitions, signal,
  } = {}) {
    if (!placements.length && !proceduralPlacements.length) return;
    const versionedUrl = (url) => cacheBust === null
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}live-tree=${encodeURIComponent(cacheBust)}`;
    const byAsset = new Map();
    for (const placement of placements) {
      if (!byAsset.has(placement.assetId)) byAsset.set(placement.assetId, []);
      byAsset.get(placement.assetId).push(placement);
    }
    // Authored order is deterministic (placements are resolved from the sorted
    // course spec), so species batches build in a stable order across reloads.
    const species = [...byAsset.entries()].map(([assetId, assetPlacements]) => {
      const asset = getCatalogAsset(catalog, assetId);
      const { lod0, lod1, lod2 } = getVerifiedTreeLods(asset);
      return { asset, lod0, lod1, lod2, placements: assetPlacements };
    });
    // Every species' authored pair loads in parallel; a mixed line must not
    // serialise startup behind the first prototype or construct a partial forest.
    const loaded = await Promise.all(species.map(async ({ asset, lod0, lod1, lod2 }) => Promise.all([
      loadTreePrototype(versionedUrl(lod0.url), {
        ...asset,
        alphaMaps: asset.alphaMaps?.map((map) => ({ ...map, url: versionedUrl(map.url) })) ?? [],
      }),
      loadTreePrototype(versionedUrl(lod1.url), {
          ...asset,
          alphaMaps: asset.alphaMaps?.map((map) => ({ ...map, url: versionedUrl(map.url) })) ?? [],
      }),
      lod2 ? loadTreePrototype(versionedUrl(lod2.url), {
        ...asset,
        alphaMaps: asset.alphaMaps?.map((map) => ({ ...map, url: versionedUrl(map.url) })) ?? [],
      }) : null,
    ])));
    const trees = new Group();
    trees.name = 'trees';
    const treeBeauties = [];
    const treeShadows = [];
    species.forEach(({ asset, placements: assetPlacements }, index) => {
      const [lod0, lod1, lod2] = loaded[index];
      const treeBudget = this.environmentTier.trees;
      const sharedOptions = {
        assetId: asset.id,
        visualLodCertification: Object.fromEntries(asset.lods.map((lod) => [
          `lod${lod.level}`, lod.visualMaxProjectedPixels ?? 0,
        ])),
        camera: this.camera,
        motionHistory: this.motionHistory,
        wind: asset.wind,
        environment: this.environment,
        renderer: this.renderer,
        seed: this.environmentSeed,
        lodNear: treeBudget.lodNear,
        lodFar: treeBudget.lodFar,
        lodTransitionDistance: Math.max(4, treeBudget.lodNear * 0.12),
      };
      const beauty = buildTreeBeautyMeshLod(lod0, lod1, lod2, assetPlacements, sharedOptions);
      beauty.setWorkloadPolicy(this.treeWorkloadPolicy);
      trees.add(beauty.group);
      // The paired shadow renderer keeps a complete light-owned list of the
      // verified authored LOD1 geometry. Camera compaction therefore cannot erase
      // an off-camera tree whose shadow still lands inside the current view.
      const shadow = new TreeShadowLod({ light: this.lighting?.sun, beauty });
      trees.add(shadow.mesh);
      treeBeauties.push(beauty);
      treeShadows.push(shadow);
    });
    if (proceduralPlacements.length) {
      const forest = await ProceduralTreeForest.create({
        definitions: proceduralDefinitions,
        signal,
        environment: this.environment,
        motionHistory: this.motionHistory,
        placements: proceduralPlacements,
        camera: this.camera,
        terrain: this.terrain,
        renderer: this.renderer,
        seed: this.environmentSeed,
      });
      forest.setWorkloadPolicy(this.treeWorkloadPolicy);
      trees.add(forest.group, forest.shadow.mesh);
      treeBeauties.push(forest);
      treeShadows.push(forest.shadow);
    }
    return { trees, treeBeauties, treeShadows };
  }

  async _buildTreeLine(placements = this._treePlacements(), proceduralPlacements = this._proceduralTreePlacements()) {
    const line = await this._createTreeLine(placements, proceduralPlacements);
    if (!line) return;
    this.trees = line.trees;
    this.treeBeauties = line.treeBeauties;
    this.treeShadows = line.treeShadows;
    this._treeBeautyCollection = null;
    this.group.add(this.trees);
  }

  async presentTreeCandidates(candidates, { anchor = null, reuseLayout = false, isCurrent = () => true, signal } = {}) {
    if (this._disposed) throw new Error('Cannot present tree candidates on a disposed course scene.');
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) throw new Error('Tree comparison requires 1-3 candidates.');
    const definitions = candidates.map(candidate => candidate.source === 'procedural' ? candidate.definition : null);
    let positions = reuseLayout && this._treePresentation?.anchors.length === candidates.length
      ? this._treePresentation.anchors.map(a => ({ x: a.worldPosition.x, z: a.worldPosition.z }))
      : this._treePresentationPositions(candidates.length, anchor, definitions);
    try {
      definitions.forEach((definition, i) => { if (definition) validateProceduralTreeClearance({ ...positions[i], scale: candidates[i].scale ?? 1 }, definition, { ...this.course, exclusions: this.course.environment.exclusions }); });
    } catch (error) {
      if (!(error instanceof CourseSchemaError)) throw error;
      positions = this._treePresentationPositions(candidates.length, anchor, definitions);
    }
    const catalogPlacements = [];
    const proceduralPlacements = [];
    const proceduralDefinitions = [];
    let maxHeight = 1;
    candidates.forEach((candidate, index) => {
      const point = positions[index];
      if (candidate.source === 'catalog') {
        const asset = getCatalogAsset(this.environmentCatalog, candidate.assetId);
        const scale = candidate.scale ?? 1;
        const targetHeight = asset.dimensions.height * scale;
        const y = this.terrain.heightAt(point.x, point.z);
        catalogPlacements.push({
          sourceId: `tree-presentation-${candidate.optionId}`, assetId: asset.id,
          x: point.x, y, z: point.z, rotY: 0, targetHeight,
        });
        point.height = targetHeight;
      } else if (candidate.source === 'procedural') {
        const definition = candidate.definition;
        if (!definition || definition.id == null) throw new Error(`Procedural tree candidate "${candidate.optionId}" has no loaded definition.`);
        if (!proceduralDefinitions.some(({ id }) => id === definition.id)) proceduralDefinitions.push(definition);
        const scale = candidate.scale ?? 1;
        proceduralPlacements.push({
          id: `tree-presentation-${candidate.optionId}`, definitionId: definition.id,
          x: point.x, z: point.z, rotationY: 0, scale, seed: index + 1,
          age: 1, health: 1, windExposure: 0.5,
        });
        point.height = (definition.parameters?.gScale ?? definition.grammar?.step * definition.grammar?.iterations ?? 12) * scale;
      } else throw new Error(`Unsupported tree candidate source "${candidate.source}".`);
      maxHeight = Math.max(maxHeight, point.height);
    });
    const line = await this._createTreeLine(catalogPlacements, proceduralPlacements, { proceduralDefinitions, signal });
    if (!line) throw new Error('Tree comparison produced no renderable candidates.');
    if (!isCurrent() || this._disposed) {
      for (const beauty of line.treeBeauties) beauty.dispose();
      return null;
    }
    const anchors = candidates.map((candidate, index) => {
      const point = positions[index];
      return Object.freeze({
        optionId: candidate.optionId,
        letter: String.fromCharCode(65 + index),
        label: candidate.label,
        worldPosition: Object.freeze({
          x: point.x,
          y: this.terrain.heightAt(point.x, point.z) + point.height + 2.5,
          z: point.z,
        }),
      });
    });
    await this.clearTreeCandidates();
    if (this._disposed) { for (const beauty of line.treeBeauties) beauty.dispose(); throw new Error('Course scene closed while generating trees'); }
    this._treePresentation = { line, anchors };
    this.treePresentationAnchors = anchors;
    this.group.add(line.trees);
    const xs = positions.map(({ x }) => x), zs = positions.map(({ z }) => z);
    return {
      center: { x: (Math.min(...xs) + Math.max(...xs)) * 0.5, z: (Math.min(...zs) + Math.max(...zs)) * 0.5 },
      span: Math.max(20, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)),
      height: maxHeight,
      anchors,
    };
  }

  _treePresentationPositions(count, anchor, definitions = []) {
    const bounds = this.course.bounds;
    const active = this.activeHole?.();
    const route = active?.route?.points ?? this.course.routing?.holes?.find(({ holeId }) => holeId === this.course.routing.activeHoleId)?.route?.points;
    const fallback = route?.[Math.floor((route.length - 1) * 0.55)] ?? { x: (bounds.minX + bounds.maxX) * 0.5, z: (bounds.minZ + bounds.maxZ) * 0.5 };
    const origin = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.z) ? anchor : fallback;
    const candidates = [];
    for (const radius of [28, 38, 50, 64, 78, 100, 130]) {
      for (let step = 0; step < 16; step += 1) {
        const angle = step * Math.PI / 8;
        const point = { x: origin.x + Math.cos(angle) * radius, z: origin.z + Math.sin(angle) * radius };
        if (point.x < bounds.minX + 8 || point.x > bounds.maxX - 8 || point.z < bounds.minZ + 8 || point.z > bounds.maxZ - 8) continue;
        if (!['rough', 'deepRough'].includes(this.terrain.surfaceAt(point.x, point.z))) continue;
        if (definitions[candidates.length]) {
          try { validateProceduralTreeClearance({ ...point, scale: 1 }, definitions[candidates.length], { ...this.course, exclusions: this.course.environment.exclusions }); }
          catch (error) { if (error instanceof CourseSchemaError) continue; throw error; }
        }
        if (candidates.some((prior) => Math.hypot(point.x - prior.x, point.z - prior.z) < 18)) continue;
        candidates.push(point);
        if (candidates.length === count) return candidates;
      }
    }
    throw new Error('No safe rough-area lineup exists for these tree candidates.');
  }

  async clearTreeCandidates() {
    const presentation = this._treePresentation;
    if (!presentation) return;
    this.group.remove(presentation.line.trees);
    this._treePresentation = null;
    this.treePresentationAnchors = [];
    // WebGPU command buffers may still reference the just-hidden instance storage.
    // Detach immediately, let the renderer rebuild two scene lists without it, then
    // release only after every submitted command has finished.
    if (typeof requestAnimationFrame === 'function') {
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    }
    await this.renderer?.backend?.device?.queue?.onSubmittedWorkDone?.();
    for (const shadow of presentation.line.treeShadows) shadow.dispose();
    for (const beauty of presentation.line.treeBeauties) beauty.dispose();
  }

  // Asset iteration must not reset the course, camera, ball, UI, or temporal
  // controller. Decode the replacement species batches off-scene, then swap the
  // complete tree line in one turn and release the previous GPU ownership only
  // after the new authored meshes exist.
  async reloadTreeAssets(catalog, { cacheBust = Date.now() } = {}) {
    if (this._disposed) throw new Error('Cannot live-reload trees on a disposed course scene.');
    const nextLine = await this._createTreeLine(
      this._treePlacements(), this._proceduralTreePlacements(), { catalog, cacheBust },
    );
    if (!nextLine) return this.treeWorkloadDiagnostics();
    const previous = {
      trees: this.trees,
      beauties: this.treeBeauties || [],
      shadows: this.treeShadows || [],
    };
    this.environmentCatalog = catalog;
    this.trees = nextLine.trees;
    this.treeBeauties = nextLine.treeBeauties;
    this.treeShadows = nextLine.treeShadows;
    this._treeBeautyCollection = null;
    this.group.add(this.trees);
    if (previous.trees) this.group.remove(previous.trees);
    for (const shadow of previous.shadows) shadow.dispose();
    for (const beauty of previous.beauties) beauty.dispose();
    this.lighting?.invalidateShadow();
    return this.treeWorkloadDiagnostics();
  }

  setTreeWorkloadPolicy(policy = 'ultra') {
    this.treeWorkloadPolicy = policy;
    for (const beauty of this.treeBeauties || []) beauty.setWorkloadPolicy(policy);
    // The beauty LOD handoff is camera-owned. The shadow renderer keeps a static,
    // complete authored LOD1 caster list, so changing beauty policy must not
    // invalidate and redraw the camera-independent shadow map.
    return this.treeWorkloadDiagnostics();
  }

  treeWorkloadDiagnostics() {
    const species = (this.treeBeauties || []).map((beauty) => ({
      assetId: beauty.assetId ?? null,
      lod0Only: beauty.workloadDiagnostics?.().reductionSupported === false,
      ...(beauty.workloadDiagnostics?.() ?? {}),
    }));
    return {
      requestedPolicy: typeof this.treeWorkloadPolicy === 'string'
        ? this.treeWorkloadPolicy
        : { ...this.treeWorkloadPolicy },
      ready: Boolean(this.treeBeauties),
      species,
      sourceCount: species.reduce((sum, entry) => sum + (entry.sourceCount ?? 0), 0),
      reducibleSpecies: species.filter((entry) => entry.reductionSupported === true).length,
      exactLod0OnlySpecies: species.filter((entry) => entry.reductionSupported === false).length,
      authoredSourceRecordsKept: species.every((entry) => entry.sourceRecordsKept !== false),
    };
  }

  // Compatibility facade for callers that predate mixed tree lines. Returning the
  // first species here made a range with eight valid catalog assets look like a
  // single-model scene to visibility toggles and diagnostics. The facade keeps the
  // old `treeBeauty` name but always covers every loaded species batch.
  get treeBeauty() {
    if (!this.treeBeauties?.length) return null;
    if (!this._treeBeautyCollection || this._treeBeautyCollection.source !== this.treeBeauties) {
      const beauties = this.treeBeauties;
      this._treeBeautyCollection = {
        source: beauties,
        group: this.trees,
        update: (camera) => { for (const beauty of beauties) beauty.update(camera); },
        setWorkloadPolicy: (policy) => this.setTreeWorkloadPolicy(policy),
        workloadDiagnostics: () => this.treeWorkloadDiagnostics(),
        residencyEstimate: (camera) => {
          const estimates = beauties.map((beauty) => beauty.residencyEstimate(camera));
          return {
            sourceCount: estimates.reduce((sum, estimate) => sum + estimate.sourceCount, 0),
            counts: {
              lod0: estimates.reduce((sum, estimate) => sum + estimate.counts.lod0, 0),
              lod1: estimates.reduce((sum, estimate) => sum + estimate.counts.lod1, 0),
              lod2: estimates.reduce((sum, estimate) => sum + (estimate.counts.lod2 ?? 0), 0),
              impostor: 0,
              rejected: 0,
            },
            projectedHeights: estimates.flatMap((estimate) => estimate.projectedHeights),
            forcedFullLod: estimates.every((estimate) => estimate.forcedFullLod),
            lod0Only: false,
            transitionCount: estimates.reduce((sum, estimate) => sum + (estimate.transitionCount ?? estimate.transitionMembership ?? 0), 0),
            classificationComplete: estimates.every((estimate) => estimate.classificationComplete),
            species: estimates.map((estimate) => ({ assetId: estimate.assetId, sourceCount: estimate.sourceCount })),
          };
        },
        readDiagnostics: async () => Promise.all(beauties.map((beauty) => beauty.readDiagnostics())),
      };
    }
    return this._treeBeautyCollection;
  }

  // Shadow diagnostics remain explicitly plural; each species owns a paired
  // authored-mesh residency facade, so there is no safe singular representative.
  get treeShadow() { return this.treeShadows?.[0] ?? null; }

  async _buildEnvironmentProps() {
    this.environmentProps = await buildEnvironmentProps({
      catalog: this.environmentCatalog,
      placements: this.environmentPlacements.filter((placement) => (
        getCatalogAsset(this.environmentCatalog, placement.assetId).category !== 'tree'
      )),
      environmentSeed: this.environmentSeed,
    });
    this.group.add(this.environmentProps);
    // Static prop meshes join the cached directional map only after their GLBs load.
    this.lighting?.invalidateShadow();
  }

  // Hero object — see GolfBall.js for the mesh build (dimple normal map,
  // clearcoat urethane shading, tangent handling). The camera gets to ~5 cm
  // from this thing at address, so it's the one surface that has to survive
  // a genuine macro shot.
  _buildBall() {
    this.ballMesh = createGolfBallMesh({ isDisposed: () => this._disposed });
    this.group.add(this.ballMesh);
    return this.ballMesh.userData.assetsReady;
  }

  update(t) {
    this.terrain.update(this.camera);
    for (const shadow of this.treeShadows || []) shadow.update();
    for (const beauty of this.treeBeauties || []) beauty.update(this.camera);
    for (const shadow of this._treePresentation?.line.treeShadows || []) shadow.update();
    for (const beauty of this._treePresentation?.line.treeBeauties || []) beauty.update(this.camera);
    if (this.grass) this.grass.update(t, this.camera);
    this.flagCloth?.update();
    this.birds?.update();
    this.waterReflection?.update();
  }

  snapshotSurfaceMaterials() {
    return this.terrain.snapshotSurfaceMaterials?.() ?? this.terrain.surfaceMaterialSnapshot();
  }

  applySurfaceMaterials(surfaceMaterials) {
    const normalized = normalizeSurfaceMaterials(surfaceMaterials);
    const applied = this.terrain.applySurfaceMaterials(normalized) ?? this.snapshotSurfaceMaterials();
    const snapshot = normalizeSurfaceMaterials(applied);
    this.course = Object.freeze({ ...this.course, surfaceMaterials: snapshot });
    return snapshot;
  }

  // Tear the whole course out of the scene so a new one can be built from an edited
  // course spec (the live-rebuild path). Frees GPU resources so repeated agent
  // rebuilds don't leak geometries/materials/textures.
  dispose() {
    this.clearTreeCandidates();
    this._disposed = true;
    this.scene.remove(this.group);
    const geometries = [];
    const materials = [];
    // Every tree batch owns its own GPU resources and releases them below; the
    // generic traversal must skip all of them, not just the first species'.
    const treeOwned = new Set();
    for (const shadow of this.treeShadows || []) shadow.mesh.traverse((object) => treeOwned.add(object));
    for (const beauty of this.treeBeauties || []) beauty.group.traverse((object) => treeOwned.add(object));
    const backdropOwned = new Set();
    this.backdrop?.group?.traverse((object) => backdropOwned.add(object));
    this.group.traverse((o) => {
      if (o === this.grass?.mesh || treeOwned.has(o) || backdropOwned.has(o)) return;
      if (o.geometry) geometries.push(o.geometry);
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      materials.push(...mats);
    });
    // Shared procedural geometries can be consumed by materials with different
    // attribute subsets. Explicitly release the complete geometry attribute set;
    // Three's first-render-object disposal listener only knows its own subset.
    disposeWebGPUGeometries(this.renderer, geometries);
    disposeMaterialTextures(materials);
    // Target prop buckets are owned by this playable-scene rebuild. Clear the cache after
    // releasing the traversed meshes/materials so a retained diagnostic reference
    // cannot keep yardage textures or shared geometry alive.
    this._targetPropAssets = null;
    this._targetPropsReady = null;
    // Terrain/grass node graphs contain texture and storage bindings that are not
    // enumerable material fields. Their explicit ownership releases each shared GPU
    // resource exactly once after the scene materials have been detached.
    // `waterHeightAt` is an injected arrow closure over this playable scene. Three may retain
    // a disposed Terrain briefly in pipeline caches, so sever it explicitly just like
    // Terrain.dispose() severs heightFn/surfaceFn; otherwise the whole old scene stays
    // reachable through Terrain -> callback -> playable scene.
    if (this.terrain) this.terrain.waterHeightAt = null;
    this.grass?.dispose();
    for (const shadow of this.treeShadows || []) shadow.dispose();
    for (const beauty of this.treeBeauties || []) beauty.dispose();
    this.waterReflection?.dispose();
    for (const surface of this._water || []) surface.dispose();
    this.backdrop?.dispose();
    this.terrain?.dispose();
    this.grass = null;
    this.birds = null;
    this.treeShadows = null;
    this.treeBeauties = null;
    this._treeBeautyCollection = null;
    this.terrain = null;
    this.trees = null;
    this.environmentProps = null;
    this.backdrop = null;
    this.creatorCanvasFrame = null;
    this.creatorFringeGrass = null;
    this.creatorCanvasOutline = null;
    this.creatorPin = null;
    this.flagCloth = null;
    this.waterReflection = null;
    this._water = null;
  }
}

// Deterministic structural landform shared by render and ball physics through the
// baked Terrain heightfield. This is exported only so slope/curvature contracts can
// sample the exact authored surface without constructing the WebGPU scene.
export function courseLandformHeight(noise, x, z) {
  const downrange = clamp01((-z - 8) / 316);
  // Broad geologic datum: enough variation to avoid a planar horizon, deliberately
  // lower-frequency and lower-amplitude than the former stacked-noise terrain.
  let h = noise.fbm(x * 0.0042, z * 0.0047, { octaves: 4 }) * (1.35 + 1.15 * downrange);
  h += noise.fbm(x * 0.012, z * 0.010, { octaves: 3 }) * (0.34 + 0.28 * downrange);

  // A shallow, curving drainage line crosses the playable corridor rather than
  // following its centre. Its 18–25 m half-width gives balls a credible lateral
  // feed without turning the fairway into a trough or creating a waterless ditch.
  const drainWindow = smoothWindow(z, -326, -24, 28);
  const drainageX = 22 - 0.052 * (z + 128) + 0.00020 * (z + 128) * (z + 128);
  const drainageWidth = 19 + 6 * downrange;
  const drainCross = Math.exp(-0.5 * ((x - drainageX) / drainageWidth) ** 2);
  h -= (0.82 + 0.42 * downrange) * drainCross * drainWindow;

  // Alternating benches create strategic stances and long light gradients. These
  // are broad lateral shelves gated by independent down-range windows, not pads
  // centred on targets and not repeated ridges.
  const leftBench = smoothWindow(z, -162, -52, 26)
    * smoothstep01((-x - 8) / 31);
  const rightBench = smoothWindow(z, -292, -154, 32)
    * smoothstep01((x - 6) / 34);
  h += leftBench * 0.92;
  h += rightBench * 1.04;

  // Four elongated rolls break up the otherwise constant foreground-to-target
  // grade. Unequal centres, radii, rotations, and signs avoid a periodic washboard.
  h += ellipticalRoll(x, z, -18, -70, 31, 48, 0.20, 0.55);
  h += ellipticalRoll(x, z, 21, -137, 35, 54, -0.16, -0.48);
  h += ellipticalRoll(x, z, -24, -214, 38, 58, -0.24, 0.62);
  h += ellipticalRoll(x, z, 14, -286, 34, 45, 0.18, -0.54);

  // A quiet overall fall toward the far drainage exit makes roll direction legible
  // while staying below one percent longitudinal grade.
  h -= downrange * 1.05;
  return h;
}

function ellipticalRoll(x, z, cx, cz, radiusAcross, radiusDownrange, rotation, amplitude) {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const across = (dx * c - dz * s) / radiusAcross;
  const along = (dx * s + dz * c) / radiusDownrange;
  return amplitude * Math.exp(-0.5 * (across * across + along * along));
}

function smoothWindow(value, low, high, shoulder) {
  return smoothstep01((value - low) / shoulder)
    * smoothstep01((high - value) / shoulder);
}

function smoothstep01(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function featureBounds(feature) {
  let minX = feature.x - feature.r;
  let maxX = feature.x + feature.r;
  let minZ = feature.z - feature.r;
  let maxZ = feature.z + feature.r;
  for (const point of feature.shape || []) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return Object.freeze({ minX, maxX, minZ, maxZ });
}

function inFeatureBounds(bounds, x, z, margin = 0) {
  return x >= bounds.minX - margin && x <= bounds.maxX + margin
    && z >= bounds.minZ - margin && z <= bounds.maxZ + margin;
}

function pointInConvexShape(points, x, z) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    if (Math.abs(cross) < 1e-8) continue;
    const next = Math.sign(cross);
    if (sign && next !== sign) return false;
    sign = next;
  }
  return true;
}

// Resolve the actual local fall line from the same collision-authoritative course
// form the bunker is cut into. The axis is cached on the compiled feature, so every
// height sample receives one stable direction without repeating gradient probes.
function bunkerDrainageAxis(noise, bunker, index, landforms = []) {
  const step = 0.6;
  const base = (x, z) => courseLandformHeight(noise, x, z) + semanticLandformHeight(landforms, x, z);
  const gx = (base(bunker.x + step, bunker.z) - base(bunker.x - step, bunker.z)) / (step * 2);
  const gz = (base(bunker.x, bunker.z + step) - base(bunker.x, bunker.z - step)) / (step * 2);
  const length = Math.hypot(gx, gz);
  if (length > 1e-5) return { _drainageX: -gx / length, _drainageZ: -gz / length };
  const fallback = (index + 1) * 2.399963229728653;
  return { _drainageX: Math.cos(fallback), _drainageZ: Math.sin(fallback) };
}

// Resolve one shoreline elevation for a pond from the same authored outline
// used by the terrain and water mesh.  A median is deliberate: a pond can sit on
// a gentle cross-slope, but one noisy shoreline sample must not tilt the whole
// water plane or make the opposite bank float.
export function pondWaterDatum(pond, baseHeight, sampleCount = 48) {
  const points = pondOutlineSamples(pond, sampleCount);
  const elevations = points.map(({ x, z }) => baseHeight(x, z));
  elevations.sort((a, b) => a - b);
  const middle = Math.floor(elevations.length * 0.5);
  return elevations.length % 2
    ? elevations[middle]
    : (elevations[middle - 1] + elevations[middle]) * 0.5;
}

// Pure grade function shared by focused geometry tests.  Positive SDF is the
// authored basin, negative SDF is the natural outside grade.
export function pondGradeAt({ pond, signedDistance, baseHeight, waterLevel }) {
  const inset = Math.max(0.1, pond._centerInset || pond.r);
  if (signedDistance >= 0) return waterLevel - pond.depth * smoothstep(0, inset, signedDistance);
  return mix(baseHeight, waterLevel, smoothstep(-4, 0, signedDistance));
}

function pondOutlineSamples(pond, sampleCount) {
  if (pond.shape?.length) {
    // Resample the closed authored curve instead of treating control vertices as
    // equally weighted observations. This makes one bad/noisy vertex affect only
    // its short neighbouring arc, not the median elevation of the whole shore.
    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const position = (i / sampleCount) * pond.shape.length;
      const index = Math.floor(position) % pond.shape.length;
      const next = (index + 1) % pond.shape.length;
      const t = position - Math.floor(position);
      samples.push({
        x: pond.shape[index].x * (1 - t) + pond.shape[next].x * t,
        z: pond.shape[index].z * (1 - t) + pond.shape[next].z * t,
      });
    }
    return samples;
  }
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const angle = (i / sampleCount) * Math.PI * 2;
    samples.push({ x: pond.x + Math.cos(angle) * pond.r, z: pond.z + Math.sin(angle) * pond.r });
  }
  return samples;
}

// Smooth Hermite ramp: 0 below edge0, 1 above edge1, eased between. Used to give
// bunker walls a defined shoulder without a hard (non-differentiable) step.
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a, b, amount) {
  return a * (1 - amount) + b * amount;
}
