import {
  Group, Mesh, CylinderGeometry, BufferGeometry, BufferAttribute,
  MeshStandardMaterial, MeshPhysicalMaterial, InstancedMesh,
  Object3D, Vector3, DoubleSide, CanvasTexture,
  TextureLoader, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter,
  RepeatWrapping, ClampToEdgeWrapping,
} from 'three';
import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import {
  loadTreePrototype, getVerifiedTreeLod0, getVerifiedTreeLodPair,
  buildTreeBeautyLod0, buildTreeBeautyMeshLod, TreeShadowLod0, TreeShadowLod,
} from './Trees.js';
import { createGolfBallMesh } from './GolfBall.js';
import { disposeMaterialTextures, disposeWebGPUGeometries } from './WebGPUResourceDisposal.js';
import { Noise } from '../util/noise.js';
import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';
import { resolveEnvironmentPlacements } from '../environment/EnvironmentPlacement.js';
import { getCatalogAsset } from '../environment/EnvironmentCatalog.js';
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
import { ProceduralTreeForest, proceduralTreeCanopyRadius } from './ProceduralTrees.js';
import { createCreatorCanvasFrame } from './CreatorCanvasFrame.js';
import { createCreatorFringeGrass } from './CreatorFringeGrass.js';
import { createCreatorCanvasOutline } from '../course/CreatorCanvas.js';
import { createCreatorCup, GOLF_HOLE_RADIUS_M } from './CreatorCup.js';

const _tex = new TextureLoader();

// The driving range: a generous fairway fanning down range (-Z) with a set of
// target greens at marked yardages, framed by rough and a tree line. Also owns
// the ball mesh. Everything that scales (grass, trees) is GPU-instanced.
export class Range {
  // `course` is a normalized spec (see src/course/course.js) of FEATURES only —
  // greens, bunkers, ponds, the fairway corridor, the tee. The engine bakes the
  // terrain from these (heightFn/surfaceFn below); nothing here edits raw heights.
  // That is what lets the whole course be (re)built from a prompt-driven course.json
  // with no terrain-editing surface exposed to the user.
  constructor(scene, camera, course, { renderer, motionHistory, lighting, environmentTier, environment, environmentCatalog, creatorCanvas = false } = {}) {
    if (!environmentTier?.grassRadius || !environmentTier?.trees) {
      throw new Error('Range requires the resolved environment device tier.');
    }
    this.scene = scene;
    this.camera = camera;
    this.course = course;
    this.environmentSeed = normalizeSeed(course.environmentSeed);
    this.renderer = renderer;
    this.lighting = lighting;
    this.motionHistory = motionHistory;
    this.environmentTier = environmentTier;
    if (!environment?.windAt) throw new Error('Range requires shared EnvironmentGpuBindings.');
    if (!environmentCatalog?.byId) throw new Error('Range requires the verified environment catalog.');
    this.environment = environment;
    this.environmentCatalog = environmentCatalog;
    this.creatorCanvas = creatorCanvas === true;
    this.creatorCanvasOutline = this.creatorCanvas ? createCreatorCanvasOutline(course) : null;
    // Quality can be selected before asynchronous tree GLBs finish decoding.
    // Retain the requested policy so every species applies it atomically when its
    // exact authored prototype becomes available.
    this.treeWorkloadPolicy = 'ultra';
    this.group = new Group();
    scene.add(this.group);

    this.noise = new Noise(7);
    // Feature arrays come straight from the course spec. Greens carry a named
    // internal contour; bunkers carve depressions (pot = deep steep revetted pit);
    // ponds are dished water basins. See _height/_surface for how they bake.
    this.targets = course.greens;
    this.landforms = course.landforms || [];
    // Target furniture is deliberately shared within a Range rebuild: one cloth
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
    this.tee = course.tee;
    this.corridor = course.corridor;
    this.fringeW = course.fringeW;
    // Water is a constant datum, not a height sampled from the pond centre.
    // Resolve it from the authored shoreline before Terrain starts sampling;
    // this avoids a Terrain -> Range -> Terrain recursion and keeps rebuilds
    // deterministic when the outline is irregular.
    this._pondWaterLevels = new Map(
      this.ponds.map((pond) => [pond, pondWaterDatum(pond, (x, z) => this._baseHeight(x, z))]),
    );
    this.biomeField = compileBiomeTransitionField(course);

    this.terrain = new Terrain({
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
        greens: this.targets.map((t) => ({ x: t.x, z: t.z, r: t.r, ...(t.shape ? { shape: t.shape } : {}) })),
        sands: this.bunkers.map((b) => ({
          x: b.x, z: b.z, r: b.r,
          ...(b.pot ? { shape: b.shape, inset: b.r * 0.28, pot: true } : { shape: b._sandShape }),
        })),
        waters: this.ponds.map((p) => ({
          x: p.x, z: p.z, r: p.r, ...(p.shape ? { shape: p.shape } : {}),
        })),
        corridor: this.corridor,                                     // halfWidth = c0 + (-z)*k, then rough band
        tee: this.creatorCanvas ? null : { x: this.tee.boxHalfX, z0: this.tee.z0, z1: this.tee.z1 },
        fringeW: this.fringeW,
      },
      motionHistory,
      renderer,
      biomeField: this.biomeField,
      analyticHeightFn: (x, z) => this._height(x, z),
      analyticPatchContains: (x, z, padding = 0) => this.bunkers.some((bunker) => (
        bunker.pot && signedDistanceToFeature(bunker, x, z) > -padding
      )),
      finiteCanvas: this.creatorCanvas,
      finiteOutline: this.creatorCanvasOutline,
      // The creator top mesh terminates at this regulation opening. The recessed
      // liner added with the pin is therefore visible through real missing turf
      // geometry, not through a dark decal or a cylinder hidden below a solid plane.
      finiteCutout: this.creatorCanvas ? {
        x: this.targets[0]?.x ?? 0,
        z: this.targets[0]?.z ?? 0,
        radius: GOLF_HOLE_RADIUS_M,
      } : null,
      variationSeed: this.environmentSeed,
    });
    if (this.creatorCanvas) {
      // Presentation exposure only: the same authored PBR maps and shared daylight
      // remain authoritative, but the isolated maquette has no surrounding world to
      // bounce light back into its turf or earthen edge.
      this.terrain.uVal.value = 1.30;
      this.terrain.uSat.value = 1.05;
    }
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
    this.backdrop = this.creatorCanvas ? null : new BackdropTerrain({
      terrain: this.terrain,
      bounds: course.bounds,
      seed: this.environmentSeed,
      biome: course.biome,
      biomeField: this.biomeField,
      // The backdrop shares the scene's one atmosphere rather than blending in a
      // fixed haze colour of its own; see worldMaterial in BackdropTerrain.js.
      environment,
      renderer,
    });
    if (this.backdrop) this.group.add(this.backdrop.group);
    this.terrain.waterHeightAt = (x, z) => this.waterHeightAt(x, z);
    this.environmentPlacements = resolveEnvironmentPlacements(course, environmentCatalog, this.terrain, this.biomeField);
    // Resolve one immutable tree record set for both the visible forest and the
    // grass bake. Canopy suppression therefore follows the exact authored roots
    // and scaled catalog crown bounds rather than a second procedural forest mask.
    const catalogTreePlacements = this._treePlacements();
    const syntheticTreePlacements = this._syntheticTreePlacements();
    const canopyPlacements = [...catalogTreePlacements, ...syntheticTreePlacements];

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

    if (this.creatorCanvas) {
      this._buildCreatorPin();
    } else {
      this._buildTee();
      this._buildTargets();
      this._buildWater();
    }
    this.waterReflection = this.creatorCanvas ? null : new PlanarWaterReflection({
      renderer,
      scene,
      camera: this.camera,
      surfaces: this._water || [],
      environmentTier,
      qualityContract: () => globalThis.window?.golf?.quality?.policySnapshot?.() ?? null,
      forceAnalyticOnHandheld: true,
    });
    const treesReady = this.creatorCanvas ? Promise.resolve() : this._buildTreeLine(catalogTreePlacements, syntheticTreePlacements);
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

    // Flat, level tee.
    const teeFlat = Math.exp(-((x * x) / 40 + ((z - 2) * (z - 2)) / 60));
    h = h * (1 - teeFlat) + 0.02 * teeFlat;
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
    // Closely mown natural teeing ground.
    if (Math.abs(x - this.tee.x) < this.tee.boxHalfX && z < this.tee.z1 && z > this.tee.z0) return 'tee';

    // Target greens with a fringe collar.
    for (let targetIndex = 0; targetIndex < this.targets.length; targetIndex += 1) {
      const t = this.targets[targetIndex];
      if (!inFeatureBounds(this._targetBounds[targetIndex], x, z, this.fringeW)) continue;
      const sd = signedDistanceToFeature(t, x, z);
      if (sd > 0) return 'green';
      if (sd + this.fringeW > 0) return 'fringe';
    }

    // Water hazards take priority over anything they sit in.
    for (const p of this.ponds) {
      if (inFeatureBounds(p._bounds, x, z) && signedDistanceToFeature(p, x, z) > 0) return 'water';
    }

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

    // The fairway fans out; beyond it is rough, then deep rough near the trees.
    const halfWidth = this.corridor.c0 + (-z) * this.corridor.k; // widens down range
    const ax = Math.abs(x);
    if (ax > halfWidth + this.corridor.rough) return 'deepRough';
    if (ax > halfWidth) return 'rough';
    return 'fairway';
  }

  // ---- Props --------------------------------------------------------------

  _buildTee() {
    // The ball now rests directly on the rendered tee turf. Keeping this area free
    // of raised prop geometry also guarantees that the physics lie and visible
    // contact plane agree at address.

    // Two nearly flush tee markers sit just behind the ball line. Their shallow
    // profile keeps the address foreground clean instead of reading as a pair of
    // raised cups when the broadcast camera pitches down toward the ball.
    const assets = this._targetProps();
    const markerMesh = new InstancedMesh(assets.markerGeometry, assets.markerMaterial, 2);
    const markerDummy = new Object3D();
    [-1.8, 1.8].forEach((sx, index) => {
      markerDummy.position.set(sx, this.terrain.heightAt(sx, 3.2) + 0.0125, 3.2);
      markerDummy.updateMatrix();
      markerMesh.setMatrixAt(index, markerDummy.matrix);
    });
    markerMesh.instanceMatrix.needsUpdate = true;
    markerMesh.castShadow = true;
    markerMesh.receiveShadow = true;
    markerMesh.name = 'tee-markers-instanced';
    markerMesh.userData.instanceCount = 2;
    this.group.add(markerMesh);
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
      markerGeometry: new CylinderGeometry(0.11, 0.105, 0.025, 24),
      markerMaterial: new MeshStandardMaterial({ color: 0xb8bcae, roughness: 0.82, metalness: 0 }),
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
    const x = this.targets[0]?.x ?? 0;
    const z = this.targets[0]?.z ?? 0;
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
    const dummy = new Object3D();
    const flagColors = [0xf0eee5, 0xc8d0c4, 0xefe6cf, 0xaeb9ad];
    const anchors = [];
    this.targets.forEach((t, index) => {
      const y = this.terrain.heightAt(t.x, t.z);
      dummy.position.set(t.x, y + 1.16, t.z);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(index, dummy.matrix);
      dummy.position.set(t.x, y - 0.026, t.z);
      dummy.updateMatrix();
      cupMesh.setMatrixAt(index, dummy.matrix);
      anchors.push({ x: t.x, y: y + 2.34, z: t.z });
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

  _syntheticTreePlacements() {
    return (this.course.environment.syntheticTrees || []).map((placement) => Object.freeze({
      ...placement,
      rotY: placement.rotationY,
      canopyRadius: proceduralTreeCanopyRadius(placement),
    }));
  }

  // Load a verified authored LOD0+LOD1 pair wherever the catalog provides one.
  // A catalog asset that currently owns only exact authored LOD0 remains on that
  // source mesh; it is never replaced by an impostor, billboard, procedural tree,
  // or another species.
  async _buildTreeLine(placements = this._treePlacements(), syntheticPlacements = this._syntheticTreePlacements()) {
    if (!placements.length && !syntheticPlacements.length) return;
    const byAsset = new Map();
    for (const placement of placements) {
      if (!byAsset.has(placement.assetId)) byAsset.set(placement.assetId, []);
      byAsset.get(placement.assetId).push(placement);
    }
    // Authored order is deterministic (placements are resolved from the sorted
    // course spec), so species batches build in a stable order across reloads.
    const species = [...byAsset.entries()].map(([assetId, assetPlacements]) => {
      const asset = getCatalogAsset(this.environmentCatalog, assetId);
      const hasLod1 = asset.lods.some((lod) => lod.level === 1);
      const { lod0, lod1 = null } = hasLod1
        ? getVerifiedTreeLodPair(asset)
        : { lod0: getVerifiedTreeLod0(asset) };
      return { asset, lod0, lod1, placements: assetPlacements };
    });
    // Every species' authored pair loads in parallel; a mixed line must not
    // serialise startup behind the first prototype or construct a partial forest.
    const loaded = await Promise.all(species.map(async ({ asset, lod0, lod1 }) => (
      lod1
        ? Promise.all([loadTreePrototype(lod0.url, asset), loadTreePrototype(lod1.url, asset)])
        : [await loadTreePrototype(lod0.url, asset), null]
    )));
    this.trees = new Group();
    this.trees.name = 'trees';
    this.treeBeauties = [];
    this.treeShadows = [];
    species.forEach(({ asset, placements: assetPlacements }, index) => {
      const [lod0, lod1] = loaded[index];
      const treeBudget = this.environmentTier.trees;
      const sharedOptions = {
        assetId: asset.id,
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
      const beauty = lod1
        ? buildTreeBeautyMeshLod(lod0, lod1, assetPlacements, sharedOptions)
        : buildTreeBeautyLod0(lod0, assetPlacements, sharedOptions);
      beauty.setWorkloadPolicy(this.treeWorkloadPolicy);
      this.trees.add(beauty.group);
      // The paired shadow renderer keeps a complete light-owned list of the
      // verified authored LOD1 geometry. Camera compaction therefore cannot erase
      // an off-camera tree whose shadow still lands inside the current view.
      const shadow = lod1
        ? new TreeShadowLod({ light: this.lighting?.sun, beauty })
        : new TreeShadowLod0({ light: this.lighting?.sun, beauty });
      this.trees.add(shadow.mesh);
      this.treeBeauties.push(beauty);
      this.treeShadows.push(shadow);
    });
    if (syntheticPlacements.length) {
      const forest = new ProceduralTreeForest({
        placements: syntheticPlacements,
        camera: this.camera,
        terrain: this.terrain,
        seed: this.environmentSeed,
      });
      forest.setWorkloadPolicy(this.treeWorkloadPolicy);
      this.trees.add(forest.group, forest.shadow.mesh);
      this.treeBeauties.push(forest);
      this.treeShadows.push(forest.shadow);
    }
    this._treeBeautyCollection = null;
    this.group.add(this.trees);
  }

  setTreeWorkloadPolicy(policy = 'ultra') {
    this.treeWorkloadPolicy = policy;
    for (const beauty of this.treeBeauties || []) beauty.setWorkloadPolicy(policy);
    // Tree policy can move the visible LOD handoff, so refresh the retained map;
    // its complete authored caster residency itself remains camera-independent.
    if (this.treeBeauties?.length) this.lighting?.invalidateShadow();
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
    if (this.grass) this.grass.update(t, this.camera);
    this.flagCloth?.update();
    this.waterReflection?.update();
  }

  // Tear the whole course out of the scene so a new one can be built from an edited
  // course spec (the live-rebuild path). Frees GPU resources so repeated agent
  // rebuilds don't leak geometries/materials/textures.
  dispose() {
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
    // Target prop buckets are owned by this Range rebuild. Clear the cache after
    // releasing the traversed meshes/materials so a retained diagnostic reference
    // cannot keep yardage textures or shared geometry alive.
    this._targetPropAssets = null;
    this._targetPropsReady = null;
    // Terrain/grass node graphs contain texture and storage bindings that are not
    // enumerable material fields. Their explicit ownership releases each shared GPU
    // resource exactly once after the scene materials have been detached.
    // `waterHeightAt` is an injected arrow closure over this Range. Three may retain
    // a disposed Terrain briefly in pipeline caches, so sever it explicitly just like
    // Terrain.dispose() severs heightFn/surfaceFn; otherwise the whole old Range stays
    // reachable through Terrain -> callback -> Range.
    if (this.terrain) this.terrain.waterHeightAt = null;
    this.grass?.dispose();
    for (const shadow of this.treeShadows || []) shadow.dispose();
    for (const beauty of this.treeBeauties || []) beauty.dispose();
    this.waterReflection?.dispose();
    for (const surface of this._water || []) surface.dispose();
    this.backdrop?.dispose();
    this.terrain?.dispose();
    this.grass = null;
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
