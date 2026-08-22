import {
  Group, Mesh, CylinderGeometry, BoxGeometry,
  MeshStandardMaterial, InstancedMesh,
  Object3D, Color, Vector3, DoubleSide, CanvasTexture,
  TextureLoader, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter,
} from 'three';
import { Terrain } from '../terrain/Terrain.js';
import { Grass } from '../terrain/Grass.js';
import { loadTreePrototype, loadTreeImpostor, buildTreeBeautyLod, TreeShadowProxy } from './Trees.js';
import { createGolfBallMesh } from './GolfBall.js';
import { disposeMaterialTextures, disposeWebGPUGeometries } from './WebGPUResourceDisposal.js';
import { Noise } from '../util/noise.js';
import { createRng, deriveSeed, normalizeSeed } from '../util/random.js';
import { resolveEnvironmentPlacements } from '../environment/EnvironmentPlacement.js';
import { getCatalogAsset } from '../environment/EnvironmentCatalog.js';
import { WaterSurface } from './WaterSurface.js';
import { buildEnvironmentProps } from './EnvironmentProps.js';
import { BackdropTerrain } from './BackdropTerrain.js';
import { GeneratedFoliageForest } from './GeneratedFoliageTree.js';
import { loadFoliageAlias } from '../foliage/FoliagePackResolver.js';
import { buildRangePerimeterFoliage } from '../foliage/RangePerimeterFoliage.js';
import {
  bunkerGradeAt, roundedHazardFeature, signedDistanceToFeature,
} from '../course/featureGeometry.js';

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
  constructor(scene, camera, course, { renderer, motionHistory, lighting, environmentTier, environment, environmentCatalog,
    foliageCandidateAlias = null, localFoliagePackRegistry = null } = {}) {
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
    const requestedFoliage = foliageCandidateAlias ?? course.environment.foliageAliases
      ?? course.environment.foliageAlias ?? null;
    this.foliageAliases = Object.freeze(Array.isArray(requestedFoliage)
      ? [...requestedFoliage] : requestedFoliage ? [requestedFoliage] : []);
    this.foliageAlias = this.foliageAliases[0] ?? null;
    this.allowCandidateFoliage = Boolean(foliageCandidateAlias);
    this.localFoliagePackRegistry = localFoliagePackRegistry;
    this.group = new Group();
    scene.add(this.group);

    this.noise = new Noise(7);
    // Feature arrays come straight from the course spec. Greens carry a named
    // internal contour; bunkers carve depressions (pot = deep steep revetted pit);
    // ponds are dished water basins. See _height/_surface for how they bake.
    this.targets = course.greens;
    // Target furniture is deliberately shared within a Range rebuild: the
    // authored yardage labels remain separate textures, while poles, posts,
    // cloth volumes, bases, and marker bodies reuse their geometry/material
    // buckets instead of allocating one mesh asset per target.
    this._targetPropAssets = null;
    this.bunkers = course.bunkers.map((feature, index) => {
      const rounded = roundedHazardFeature(feature, { kind: 'bunker', index });
      const sandFeature = rounded.pot ? null : Object.freeze({
        x: rounded.x, z: rounded.z, r: rounded.r, shape: rounded._sandShape,
      });
      return Object.freeze({
        ...rounded,
        ...bunkerDrainageAxis(this.noise, rounded, index),
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
          ...(b.pot ? { shape: b.shape, inset: b.r * 0.28 } : { shape: b._sandShape }),
        })),
        waters: this.ponds.map((p) => ({
          x: p.x, z: p.z, r: p.r, ...(p.shape ? { shape: p.shape } : {}),
        })),
        corridor: this.corridor,                                     // halfWidth = c0 + (-z)*k, then rough band
        tee: { x: this.tee.boxHalfX, z0: this.tee.z0, z1: this.tee.z1 },
        fringeW: this.fringeW,
      },
      motionHistory,
      renderer,
    });
    this.group.add(this.terrain.mesh);
    this.backdrop = new BackdropTerrain({
      terrain: this.terrain,
      bounds: course.bounds,
      seed: this.environmentSeed,
      biome: course.biome,
      // The backdrop shares the scene's one atmosphere rather than blending in a
      // fixed haze colour of its own; see worldMaterial in BackdropTerrain.js.
      environment,
      renderer,
    });
    this.group.add(this.backdrop.group);
    this.terrain.waterHeightAt = (x, z) => this.waterHeightAt(x, z);
    this.environmentPlacements = resolveEnvironmentPlacements(course, environmentCatalog, this.terrain);
    // Resolve one immutable tree record set for both the visible forest and the
    // grass bake. Canopy suppression therefore follows the exact authored roots
    // and scaled catalog crown bounds rather than a second procedural forest mask.
    const allTreePlacements = this._treePlacements();
    // A practice range has its own perimeter planting logic. Generated foliage
    // must not inherit course-vibe coordinates or a thinned side-line curtain.
    const treePlacements = this.foliageAliases.length
      ? buildRangePerimeterFoliage({
        bounds: course.bounds, seed: this.environmentSeed, foliageAliases: this.foliageAliases,
      })
      : allTreePlacements;

    // Camera-relative grass (WebGPU / TSL). A world-cell-anchored field of ~1M
    // blades follows the camera every frame, sampling terrain height + surface
    // from GPU textures, with density/height LOD falling off with distance. So
    // wherever you look — tee, mid-fairway, a green after a shot — there's turf.
    this.grass = new Grass({
      terrain: this.terrain, camera: this.camera, renderer, motionHistory, environment,
      radius: environmentTier.grassRadius,
      canopyPlacements: treePlacements,
    });
    this.group.add(this.grass.mesh);

    this._buildTee();
    this._buildTargets();
    this._buildWater();
    const treesReady = this._buildTreeLine(treePlacements);
    const environmentPropsReady = this._buildEnvironmentProps();
    const ballReady = this._buildBall();
    // Replacing a course removes and recreates static shadow casters. Mark the
    // retained directional map dirty immediately; the async tree proxy marks it
    // again when its new GPU record set is ready.
    this.lighting?.invalidateShadow();
    // The environment benchmark waits for this before it begins its shader warm-up.
    // Every visible asset is required. Bunker sand is part of the authoritative
    // terrain material rather than a second, independently tessellated surface.
    this.assetsReady = Promise.all([
      this.terrain.assetsReady, this.backdrop.assetsReady,
      treesReady, environmentPropsReady, ballReady,
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
    // Collision-authoritative course form. One lateral drainage swale, offset
    // maintained-ground benches, and elongated low rolls create readable terrain
    // shadows from golfer height. Every primitive is metre-scaled and aperiodic;
    // the low-amplitude fBm breaks their shoulders without becoming random moguls.
    let h = courseLandformHeight(this.noise, x, z);

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

    // Two painted tee markers, set just behind the ball line. A low truncated
    // cylinder reads as a rubber/painted marker and has a real ground contact,
    // unlike the former floating sphere silhouette.
    const assets = this._targetProps();
    const markerMesh = new InstancedMesh(assets.markerGeometry, assets.markerMaterial, 2);
    const markerDummy = new Object3D();
    [-1.8, 1.8].forEach((sx, index) => {
      markerDummy.position.set(sx, this.terrain.heightAt(sx, 3.2) + 0.05, 3.2);
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

  _targetProps() {
    if (this._targetPropAssets) return this._targetPropAssets;
    this._targetPropAssets = {
      // Scale-correct painted hardware: thicker poles/bases retain a grounded
      // silhouette at golfer height while staying in the existing instanced
      // draw buckets. These are lit dielectric surfaces, never black cutouts.
      poleGeometry: new CylinderGeometry(0.026, 0.034, 2.4, 10),
      poleMaterial: new MeshStandardMaterial({ color: 0x929a88, roughness: 0.68, metalness: 0.02 }),
      flagGeometry: makeTargetFlagGeometry(),
      flagMaterial: new MeshStandardMaterial({ color: 0xd9d5c5, vertexColors: true, side: DoubleSide, roughness: 0.9, metalness: 0 }),
      flagBaseGeometry: new CylinderGeometry(0.13, 0.10, 0.07, 16),
      flagBaseMaterial: new MeshStandardMaterial({ color: 0x4b5544, roughness: 0.88 }),
      signGeometry: new BoxGeometry(1.08, 0.48, 0.055),
      postGeometry: new CylinderGeometry(0.035, 0.045, 0.40, 10),
      postMaterial: new MeshStandardMaterial({ color: 0x747c6c, roughness: 0.82 }),
      signMaterials: new Map(),
      markerGeometry: new CylinderGeometry(0.105, 0.078, 0.10, 16),
      markerMaterial: new MeshStandardMaterial({ color: 0x8f987d, roughness: 0.78, metalness: 0 }),
    };
    return this._targetPropAssets;
  }

  _buildTargets() {
    const assets = this._targetProps();
    const count = this.targets.length;
    const poleMesh = new InstancedMesh(assets.poleGeometry, assets.poleMaterial, count);
    const flagMesh = new InstancedMesh(assets.flagGeometry, assets.flagMaterial, count);
    const baseMesh = new InstancedMesh(assets.flagBaseGeometry, assets.flagBaseMaterial, count);
    const postMesh = new InstancedMesh(assets.postGeometry, assets.postMaterial, count * 2);
    const dummy = new Object3D();
    const flagColors = [0xf0eee5, 0xc8d0c4, 0xefe6cf, 0xaeb9ad];
    this.targets.forEach((t, index) => {
      const y = this.terrain.heightAt(t.x, t.z);
      dummy.position.set(t.x, y + 1.2, t.z);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(index, dummy.matrix);
      dummy.position.set(t.x + 0.36, y + 2.15, t.z);
      dummy.updateMatrix();
      flagMesh.setMatrixAt(index, dummy.matrix);
      flagMesh.setColorAt(index, new Color(flagColors[Math.round(t.yards / 50) % flagColors.length]));
      dummy.position.set(t.x, y + 0.025, t.z);
      dummy.updateMatrix();
      baseMesh.setMatrixAt(index, dummy.matrix);
      const signZ = t.z + t.r + 4;
      const signY = this.terrain.heightAt(t.x, signZ);
      for (const postX of [-0.48, 0.48]) {
        dummy.position.set(t.x + postX, signY + 0.18, signZ);
        dummy.updateMatrix();
        postMesh.setMatrixAt(index * 2 + (postX > 0 ? 1 : 0), dummy.matrix);
      }
      this.group.add(this._placard(t.x, signY, signZ, `${t.yards}`));
    });
    for (const mesh of [poleMesh, flagMesh, baseMesh, postMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    flagMesh.instanceColor.needsUpdate = true;
    const drawBuckets = Object.freeze({ flagPoles: 1, flagCloth: 1, flagBases: 1, signBoards: count, signPosts: 1, teeMarkers: 1 });
    this.group.userData.targetPropDiagnostics = Object.freeze({
      drawBuckets,
      signDraws: count,
      instances: Object.freeze({ flagPoles: count, flagCloth: count, flagBases: count, signBoards: count, signPosts: count * 2, teeMarkers: 2 }),
      targetDraws: count + 5,
    });
  }

  targetPropDiagnostics() {
    return this.group.userData.targetPropDiagnostics || Object.freeze({
      drawBuckets: Object.freeze({}), signDraws: 0, instances: Object.freeze({}), targetDraws: 0,
    });
  }

  _placard(x, y, z, text) {
    // These signs spend most of their life minified and oblique. A 256 × 128 source
    // leaves only a handful of source pixels across a glyph by 100–200 yards, then TRAA
    // quite correctly filters that unstable signal. Give the mip chain enough real
    // glyph coverage to converge to crisp text instead of trying to sharpen it later.
    const SCALE = 4;
    const canvas = document.createElement('canvas');
    canvas.width = 256 * SCALE; canvas.height = 128 * SCALE;
    const ctx = canvas.getContext('2d');
    // A painted olive housing keeps the face readable under real shadow while
    // retaining restrained contrast against the maintained turf backdrop.
    ctx.fillStyle = '#707969'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#b0b6a5'; ctx.lineWidth = 5 * SCALE; ctx.strokeRect(4 * SCALE, 4 * SCALE, canvas.width - 8 * SCALE, canvas.height - 8 * SCALE);
    ctx.fillStyle = '#f0ebdc';
    ctx.font = `700 ${70 * SCALE}px ui-serif, Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128 * SCALE, 68 * SCALE);
    ctx.font = `600 ${18 * SCALE}px system-ui, sans-serif`;
    ctx.fillText('YARDS', 128 * SCALE, 116 * SCALE);
    const tex = new CanvasTexture(canvas);
    tex.name = `yardage-placard-${text}`;
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = 16;
    const assets = this._targetProps();
    let signMaterial = assets.signMaterials.get(text);
    if (!signMaterial) {
      signMaterial = new MeshStandardMaterial({ map: tex, side: DoubleSide, roughness: 0.84, metalness: 0 });
      assets.signMaterials.set(text, signMaterial);
    } else {
      tex.dispose();
    }
    const sign = new Mesh(assets.signGeometry, signMaterial);
    // Board bottom overlaps the post tops, while both posts terminate at the
    // authored terrain datum instead of floating behind a billboard plane.
    sign.position.set(x, y + 0.50, z);
    sign.castShadow = true;
    sign.receiveShadow = true;
    return sign;
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
    if (!this.renderer || !this.scene) throw new Error('Range water reflection capture requires its renderer and scene.');
    let captures = 0;
    for (const surface of this._water || []) {
      if (surface.captureReflection(this.renderer, this.scene, {
        camera: this.camera, force, backgroundNode,
      })) captures++;
    }
    return captures;
  }

  waterReflectionDiagnostics() {
    return (this._water || []).map((surface) => surface.reflectionDiagnostics());
  }

  _treePlacements() {
    const trees = this.environmentPlacements.filter((placement) => (
      getCatalogAsset(this.environmentCatalog, placement.assetId).category === 'tree'
      && getCatalogAsset(this.environmentCatalog, placement.assetId).impostor.kind === 'baked-atlas'
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

  // Load the processed licensed near geometry and its source-baked far atlas. Both
  // are part of the range readiness contract; rendering never begins with a
  // substitute. One species is one classifier: a GPU batch draws a single canonical
  // prototype, so a mixed tree line resolves to one TreeBeautyLod + shadow proxy per
  // catalog asset rather than one merged batch.
  async _buildTreeLine(placements = this._treePlacements()) {
    if (!placements.length) return;
    if (this.foliageAliases.length) {
      const grouped = new Map(this.foliageAliases.map((alias) => [alias, []]));
      for (const placement of placements) {
        if (!grouped.has(placement.foliageAlias)) {
          throw new Error(`Range perimeter foliage produced undeclared alias "${placement.foliageAlias}".`);
        }
        grouped.get(placement.foliageAlias).push(placement);
      }
      const activeGroups = [...grouped].filter(([, records]) => records.length);
      const packs = await Promise.all(activeGroups.map(([alias]) => loadFoliageAlias(alias, {
        renderer: this.renderer, textureMode: 'ktx2', allowCandidate: this.allowCandidateFoliage,
        local: this.localFoliagePackRegistry,
      })));
      this.trees = new Group();
      this.trees.name = `trees-generated:${activeGroups.map(([alias]) => alias).join('+')}`;
      this.treeBeauties = activeGroups.map(([alias, records], index) => {
        const pack = packs[index];
        const nativeHeight = pack.manifest.species?.nativeHeightMeters ?? 19.5;
        const generatedPlacements = records.map((placement) => Object.freeze({
          ...placement,
          y: this.terrain.heightAt(placement.x, placement.z) - 0.04,
          scale: placement.targetHeight / nativeHeight,
          rotY: placement.rotationY,
        }));
        const forest = new GeneratedFoliageForest({
          pack, placements: generatedPlacements, environment: this.environment,
          camera: this.camera, motionHistory: this.motionHistory, renderer: this.renderer,
          seed: deriveSeed(this.environmentSeed, `generated-foliage:${alias}`),
          // Five independently seeded skeletons are the renderer's bounded maximum.
          // Two identities still formed obvious A/B repeats in perimeter groves;
          // yaw and scale cannot disguise identical leader and scaffold topology.
          identityCount: 5,
        });
        this.trees.add(forest.group);
        return forest;
      });
      this.treeShadows = [];
      this.group.add(this.trees);
      this.lighting?.invalidateShadow();
      return;
    }
    const byAsset = new Map();
    for (const placement of placements) {
      if (!byAsset.has(placement.assetId)) byAsset.set(placement.assetId, []);
      byAsset.get(placement.assetId).push(placement);
    }
    // Authored order is deterministic (placements are resolved from the sorted
    // course spec), so species batches build in a stable order across reloads.
    const species = [...byAsset.entries()].map(([assetId, assetPlacements]) => {
      const asset = getCatalogAsset(this.environmentCatalog, assetId);
      if (asset.lods.length !== 2 || asset.lods[0].level !== 0 || asset.lods[1].level !== 1 || asset.impostor.kind !== 'baked-atlas') {
        throw new Error(`${asset.id} requires verified catalog LOD derivatives and a source-baked impostor atlas.`);
      }
      return { asset, placements: assetPlacements };
    });
    // Every species' geometry and atlas load in parallel; a mixed line must not
    // serialise startup behind the first prototype.
    const loaded = await Promise.all(species.map(async ({ asset }) => Promise.all([
      loadTreePrototype(asset.lods[0].url),
      loadTreePrototype(asset.lods[1].url),
      loadTreeImpostor(asset.impostor),
    ])));
    this.trees = new Group();
    this.trees.name = 'trees';
    this.treeBeauties = [];
    this.treeShadows = [];
    species.forEach(({ asset, placements: assetPlacements }, index) => {
      const [proto, midProto, impostorTexture] = loaded[index];
      // One GPU classifier owns every tree of this species. It emits compacted LOD0
      // and LOD1 geometry through the foreground/middle distance, then the
      // runtime-lit multi-view atlas. Every representation derives from the
      // verified licensed source.
      const beauty = buildTreeBeautyLod(proto, midProto, asset.impostor, impostorTexture, assetPlacements, {
        // Seeding per species keeps each batch's tint/age variation independent
        // and stable when another species is added or removed from the course.
        seed: deriveSeed(this.environmentSeed, `tree-beauty-lod:${asset.id}`),
        renderer: this.renderer,
        camera: this.camera,
        motionHistory: this.motionHistory,
        environment: this.environment,
        wind: asset.wind,
        lodNear: this.environmentTier.trees.lodNear,
        lodFar: this.environmentTier.trees.lodFar,
      });
      this.trees.add(beauty.group);
      // The beauty meshes never cast. One GPU-compacted, layer-isolated source-atlas
      // caster per species is the complete tree shadow path; it projects that
      // species' real silhouette rather than an unrelated procedural canopy mask.
      const shadow = new TreeShadowProxy({
        renderer: this.renderer,
        light: this.lighting?.sun,
        records: beauty.shadowRecords,
        impostorTexture,
        impostor: asset.impostor,
      });
      this.trees.add(shadow.mesh);
      this.treeBeauties.push(beauty);
      this.treeShadows.push(shadow);
    });
    this.group.add(this.trees);
  }

  // Single-species accessors retained for the diagnostic/benchmark call sites that
  // predate the mixed tree line. Anything that must cover the whole forest reads
  // `treeBeauties` / `treeShadows`.
  get treeBeauty() { return this.treeBeauties?.[0] ?? null; }

  get treeShadow() { return this.treeShadows?.[0] ?? null; }

  async _buildEnvironmentProps() {
    this.environmentProps = await buildEnvironmentProps({
      catalog: this.environmentCatalog,
      placements: this.environmentPlacements,
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
    for (const shadow of this.treeShadows || []) treeOwned.add(shadow.mesh);
    const beautyGroups = new Set((this.treeBeauties || []).map((beauty) => beauty.group));
    const backdropOwned = new Set();
    this.backdrop?.group?.traverse((object) => backdropOwned.add(object));
    this.group.traverse((o) => {
      if (o === this.grass?.mesh || treeOwned.has(o) || beautyGroups.has(o.parent) || backdropOwned.has(o)) return;
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
    for (const surface of this._water || []) surface.dispose();
    this.backdrop?.dispose();
    this.terrain?.dispose();
    this.grass = null;
    this.treeShadows = null;
    this.treeBeauties = null;
    this.terrain = null;
    this.trees = null;
    this.environmentProps = null;
    this.backdrop = null;
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
function bunkerDrainageAxis(noise, bunker, index) {
  const step = 0.6;
  const gx = (courseLandformHeight(noise, bunker.x + step, bunker.z)
    - courseLandformHeight(noise, bunker.x - step, bunker.z)) / (step * 2);
  const gz = (courseLandformHeight(noise, bunker.x, bunker.z + step)
    - courseLandformHeight(noise, bunker.x, bunker.z - step)) / (step * 2);
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

// One shared, genuinely volumetric cloth profile for every target. The former
// rectangular slab was thick enough to read as a board but had no cloth falloff.
// A restrained free-edge taper and 2.6 cm billow preserve a stable silhouette and
// PBR normals at range without per-target geometry, animation, or another draw.
function makeTargetFlagGeometry() {
  const width = 0.68;
  const geometry = new BoxGeometry(width, 0.40, 0.016, 4, 2, 1);
  const position = geometry.attributes.position;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const t = clamp01((x + width * 0.5) / width);
    const y = position.getY(index) * (1 - 0.10 * t);
    const z = position.getZ(index) + Math.sin(t * Math.PI) * 0.026;
    position.setXYZ(index, x, y, z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.name = 'target-flag-cloth-shared';
  return geometry;
}
