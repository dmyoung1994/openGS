import {
  InstancedBufferGeometry, BufferAttribute, Mesh, MeshStandardNodeMaterial,
  Sphere, Vector3, Vector2, Color, DoubleSide,
} from 'three';
import {
  instanceIndex, positionGeometry, uniform, mrt,
  vec2, vec3, vec4, float, mix, smoothstep, transformNormalToView,
} from 'three/tsl';
import { turfBase } from '../terrain/turfColor.js';
import { footprintUsesNearTurfGeometry, usesNearTurfGeometry } from './NearTurfPolicy.js';

// Supplemental real blade GEOMETRY for close views of rough and deep rough.
//
// Carpeting the whole fairway in blades was tried and looked bad: spread over hundreds
// of square metres you can only afford a few hundred blades/m^2, and sparse individual
// blades read as scattered debris. Mown surfaces therefore use only their dense PBR /
// parallax texture. Rough already has a continuous GPU blade field; these much denser
// patches only improve its ball-contact silhouette and macro camera views.
//
// Two instances are used (see main.js): a small permanent one anchored to the ball so
// long grass can overlap its contact silhouette, and a larger camera-anchored one that
// covers close rough views. Both are hidden on every mown surface and at mowing lines.
export class BallLie {
  constructor({ terrain, camera, motionHistory, environment, count = 520, radius = 0.105, inner = 0.013, follow = 'ball' }) {
    this.terrain = terrain;
    this._camera = camera;
    if (!motionHistory) throw new Error('BallLie requires SceneManager motionHistory for TRAA velocity.');
    if (!environment?.windAt || !environment?.time || !environment?.previousTime) {
      throw new Error('BallLie requires shared EnvironmentGpuBindings.');
    }
    this.motionHistory = motionHistory;
    this.environment = environment;
    this.follow = follow;
    this.count = count;

    // First-order fit of the ground plane under the patch. Over tens of centimetres a
    // linear slope is exact enough, and it keeps blade bases planted on a sloping lie
    // instead of hovering on the uphill side.
    this.uGrad = uniform(new Vector2(0, 0));
    this.uRadius = uniform(radius);
    this.uInner = uniform(inner);
    this.uHeight = uniform(0.060);       // long-grass height, metres — set per surface
    this.uFade = uniform(1);             // collapses the blades as they stop being worth drawing
    this.uNearCut = uniform(0.11);       // metres — blades nearer the lens than this collapse
    this.uColor = uniform(new Vector3(1, 1, 1));
    // Exact prior-frame inputs for the procedural position. The renderer tracks
    // previous mesh/camera matrices, but not time-varying material deformation.
    this.uPreviousGrad = uniform(new Vector2(0, 0));
    this.uPreviousRadius = uniform(radius);
    this.uPreviousInner = uniform(inner);
    this.uPreviousHeight = uniform(0.060);
    this.uPreviousFade = uniform(1);
    this.uPreviousNearCut = uniform(0.11);
    this.uCameraPosition = uniform(new Vector3());
    this.uPreviousCameraPosition = uniform(new Vector3());
    this.uOrigin = uniform(new Vector3());
    this.uPreviousOrigin = uniform(new Vector3());
    this._motionReady = false;

    this.mesh = new Mesh(this._geometry(), this._material());
    this.mesh.name = `turf-near-${follow}`;
    this.mesh.castShadow = false;        // thousands of blades of shadow-map cost, for nothing
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;     // it's always near the camera; culling it is wasted work
    this.visible = true;
    this._c = new Color();      // turfBase() works in Color space; the uniform is a Vector3
  }

  // Four-row strip — the same blade primitive the main grass system uses.
  _geometry() {
    const SEG = 3, rows = SEG + 1;
    const pos = [];
    for (let r = 0; r < rows; r++) { const y = r / SEG; pos.push(-0.5, y, 0, 0.5, y, 0); }
    const idx = [];
    for (let r = 0; r < SEG; r++) {
      const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(new BufferAttribute(new Uint16Array(idx), 1));
    geo.instanceCount = this.count;
    geo.boundingSphere = new Sphere(new Vector3(0, 0.05, 0), 4);
    return geo;
  }

  _material() {
    const hash = (n, s) => n.mul(12.9898).add(s).sin().mul(43758.5453).fract();
    const i = float(instanceIndex);
    const h1 = hash(i, 0.0), h2 = hash(i, 1.7), h3 = hash(i, 3.3);
    const h4 = hash(i, 5.1), h5 = hash(i, 7.7), h6 = hash(i, 9.3);

    // Keep the primitive's normalized blade coordinates separate from positionLocal:
    // positionNode later replaces positionLocal with the displaced terrain-relative
    // position, whose Y may be negative and is not a valid 0..1 shading parameter.
    const t = positionGeometry.y.toVarying('vLieBladeT');
    const side = positionGeometry.x;
    // Clumping: blades share a coarse cell's extra height and lean, so the patch reads
    // as tufted turf rather than an even bristle brush. This is the single thing that
    // most separates convincing grass from a scattered-sliver look.
    // This returns local geometry for either time slice. The prior branch below uses
    // the same hash, clump, lens fade, facing width, and wind bend as the current one;
    // only frame-history uniforms differ.
    const bladePosition = (time, grad, radius, inner, cutHeight, fade, nearCut, camera, origin) => {
    // Even-area disc sampling (sqrt on the radius) so the patch isn't crowded at the
    // centre and bald at the rim.
    const r = mix(inner, radius, h1.sqrt());
    const th = h2.mul(6.2831853);
    const bx = r.mul(th.cos()), bz = r.mul(th.sin());
    const clump = hash(bx.mul(47.0).floor().add(bz.mul(47.0).floor().mul(31.0)), 2.3);
    const orient = h4.mul(6.2831853).add(clump.mul(2.2));
    const cA = orient.cos(), sA = orient.sin();
    const H = cutHeight.mul(float(0.6).add(h3.mul(0.6)).add(clump.mul(0.35)));

    // Collapse blades that are almost touching the lens. `origin` is explicit rather
    // than modelWorldMatrix so the prior path uses the patch's actual prior location.
    const baseWorld = origin.add(vec3(bx, 0.0, bz));
    const camDist = baseWorld.sub(camera).length();
    const nearFade = smoothstep(nearCut.mul(0.55), nearCut, camDist);
    const height = H.mul(fade).mul(nearFade);

    // Width tapers to the tip, and widens at grazing view angles so an edge-on blade
    // never thins to a sub-pixel sliver and shimmers.
    const w0 = mix(0.0011, 0.0019, h5).mul(float(1.0).sub(smoothstep(0.55, 1.0, t)));
    const facing = vec2(sA.negate(), cA);
    const toCam = camera.xz.sub(baseWorld.xz);
    const viewDir = toCam.div(toCam.length().max(0.001));
    const edge = float(1.0).sub(facing.dot(viewDir).abs());
    const w = w0.mul(float(1.0).add(edge.mul(edge).mul(1.3)));

    // Lay-over + wind, t^2 so bend accumulates toward the tip rather than the base.
    const lean = vec2(clump.mul(6.28).cos(), clump.mul(6.28).sin())
      .mul(float(0.22).add(h3.mul(0.3)));
    const wind = this.environment.windAt(baseWorld, time);
    const bend = lean.mul(height)
      .add(wind.xz.mul(height).mul(0.035))
      .mul(t.mul(t));

    const px = side.mul(w);
    const baseY = bx.mul(grad.x).add(bz.mul(grad.y));
    return {
      p: vec3(
      bx.add(px.mul(cA)).add(bend.x),
      baseY.add(t.mul(height)),
      bz.add(px.mul(sA)).add(bend.y),
      ),
      cA,
      sA,
    };
    };

    const current = bladePosition(
      this.environment.time, this.uGrad, this.uRadius, this.uInner,
      this.uHeight, this.uFade, this.uNearCut, this.uCameraPosition, this.uOrigin,
    );
    const previous = bladePosition(
      this.environment.previousTime, this.uPreviousGrad,
      this.uPreviousRadius, this.uPreviousInner, this.uPreviousHeight,
      this.uPreviousFade, this.uPreviousNearCut, this.uPreviousCameraPosition,
      this.uPreviousOrigin,
    );
    const { p, cA, sA } = current;

    const mat = new MeshStandardNodeMaterial({ side: DoubleSide, metalness: 0.0, roughness: 0.42 });
    mat.positionNode = p;
    // The patch moves and bends procedurally, so the generic VelocityNode's raw card
    // previous position is invalid. Emit the MRT velocity from exact old/new world
    // geometry and SceneManager's unjittered camera history instead.
    const mh = this.motionHistory;
    const currentWorld = this.uOrigin.add(p);
    const previousWorld = this.uPreviousOrigin.add(previous.p);
    const currentClip = mh.currentProjection.mul(mh.currentView).mul(vec4(currentWorld, 1.0));
    const previousClip = mh.previousProjection.mul(mh.previousView).mul(vec4(previousWorld, 1.0));
    const currentNdc = currentClip.xy.div(currentClip.w);
    const previousNdc = previousClip.xy.div(previousClip.w);
    mat.mrtNode = mrt({ velocity: currentNdc.sub(previousNdc).toVarying('vLieVelocity') });
    // Rounded blade normal so the sun catches an edge, rather than every blade lighting
    // as a flat card.
    const round = side.mul(1.4);
    mat.normalNode = transformNormalToView(
      vec3(round.mul(cA).sub(sA.mul(0.35)), 0.55, round.mul(sA).add(cA.mul(0.35))).normalize(),
    );
    // Darker at the base (canopy occlusion) plus per-blade pigment jitter — the same
    // kind of variation baked into the ground's detail albedo, so the two agree.
    const ao = mix(0.55, 1.0, t);
    mat.colorNode = this.uColor.mul(float(0.86).add(h6.mul(0.28))).mul(ao);
    return mat;
  }

  // `focus` is where the patch sits. update() writes the mesh transform, the local
  // ground slope, and the per-surface cut height.
  update(t, fx, fz, surfaceName, { radius, fade } = {}) {
    if (this._motionReady) {
      this.uPreviousGrad.value.copy(this.uGrad.value);
      this.uPreviousRadius.value = this.uRadius.value;
      this.uPreviousInner.value = this.uInner.value;
      this.uPreviousHeight.value = this.uHeight.value;
      this.uPreviousFade.value = this.uFade.value;
      this.uPreviousNearCut.value = this.uNearCut.value;
      this.uPreviousCameraPosition.value.copy(this.uCameraPosition.value);
      this.uPreviousOrigin.value.copy(this.uOrigin.value);
    }
    void t; // deformation time comes exclusively from EnvironmentFrameState.
    if (radius !== undefined) this.uRadius.value = radius;
    if (fade !== undefined) this.uFade.value = fade;

    const g = this.terrain;
    this.uOrigin.value.set(fx, g.heightAt(fx, fz), fz);
    this.mesh.position.copy(this.uOrigin.value);
    const e = 0.25;
    this.uGrad.value.set(
      (g.heightAt(fx + e, fz) - g.heightAt(fx - e, fz)) / (2 * e),
      (g.heightAt(fx, fz + e) - g.heightAt(fx, fz - e)) / (2 * e),
    );

    const supported = usesNearTurfGeometry(surfaceName);
    this.uHeight.value = supported ? LIE_H[surfaceName] : LIE_H.rough;
    turfBase(supported ? surfaceName : 'rough', this._c);
    this.uColor.value.set(this._c.r, this._c.g, this._c.b);
    // Camera is sampled after the director/free-camera update (main.js update order).
    this.uCameraPosition.value.copy(this._camera.position);
    if (!this._motionReady) {
      this.uPreviousGrad.value.copy(this.uGrad.value);
      this.uPreviousRadius.value = this.uRadius.value;
      this.uPreviousInner.value = this.uInner.value;
      this.uPreviousHeight.value = this.uHeight.value;
      this.uPreviousFade.value = this.uFade.value;
      this.uPreviousNearCut.value = this.uNearCut.value;
      this.uPreviousCameraPosition.value.copy(this.uCameraPosition.value);
      this.uPreviousOrigin.value.copy(this.uOrigin.value);
      this._motionReady = true;
    }
    // A centre-only classification lets a rough patch spill a circular fringe over a
    // nearby mowing line. Require the entire sampled footprint to remain long grass.
    this.mesh.visible = this.visible
      && supported
      && this.uFade.value > 0.01
      && footprintUsesNearTurfGeometry(g, fx, fz, this.uRadius.value);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// Blade length by lie, metres. Taller than the ground shader's canopy depths on
// purpose: these are the blades that have to reach UP past the ball's lower edge, and
// a canopy that only matched the mowing height would sit entirely below it.
const LIE_H = {
  rough: 0.060, deepRough: 0.085,
};
