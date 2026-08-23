import { DirectionalLight, HemisphereLight, Vector3 } from 'three';

// Renderer-relative calibration at the authored 85 klux reference state. The
// key remains intentionally dominant: open-sky colour comes from the analytic
// sky/PMREM, while this small hemispherical return keeps occluded bark and turf
// chromatic without becoming a second directional light.
const KEY_INTENSITY_AT_REFERENCE = 3.35;
const HEMISPHERE_INTENSITY_AT_REFERENCE = 0.40;

// Sun (directional, shadow-casting) plus a sky/ground hemisphere fill. The analytic
// atmosphere and this rig share one authored solar direction; the hemisphere supplies
// the diffuse skylight wrap while the key defines form and ground shadows.
//
// The shadow frustum is kept tight around the play area (and re-centered on the
// ball in flight via follow()) so the 4K shadow map spends its resolution where
// the camera actually looks — crisp contact shadows at the tee.
export class Lighting {
  constructor(scene, sunDir = new Vector3(-0.5, 0.85, 0.3).normalize(), environmentTier) {
    if (!environmentTier?.shadowMapSize) throw new Error('Lighting requires the resolved environment device tier.');
    // Bootstrap values last only until SceneManager installs the authoritative
    // EnvironmentGpuBindings. From that point the authored illuminance, chromaticity,
    // and direction drive this actual shadow-casting key.
    this.sun = new DirectionalLight(0xffffff, 3.25);
    this._focus = new Vector3(0, 0, 0);
    this._lastShadowFocus = new Vector3(0, 0, 0);
    this._nextFocus = new Vector3();
    this._shadowFocusValid = false;
    this._lastFollowAt = -Infinity;
    this._offset = sunDir.clone().multiplyScalar(140);
    this.sun.position.copy(this._offset);
    this.sun.castShadow = true;
    // The sun and world casters are static between explicit simulation/course
    // changes. Keep the completed map resident instead of rebuilding the 2K/4K
    // depth texture on every beauty frame. All mutation sites call
    // invalidateShadow() (follow() does so itself), and the initial frame starts
    // dirty so there is never an unshadowed compatibility/placeholder frame.
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.sun.shadow.mapSize.set(environmentTier.shadowMapSize, environmentTier.shadowMapSize);
    this.sun.shadow.camera.near = 5;
    this.sun.shadow.camera.far = 700;
    // Frustum wide enough to cover the visible fairway/tree line so raking-light
    // shadows actually fall across what the camera sees (not just the tee).
    const s = 150;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2;         // readable penumbra without erasing tree/terrain shadow structure
    this.sun.shadow.intensity = 0.66;   // preserve chromatic turf under dense canopy casters
    // Layer 1 is reserved for GPU-only shadow proxies.  ShadowNode preserves this
    // explicit 0|1 mask instead of copying the beauty camera's layer mask, while
    // ordinary world casters on layer 0 continue to render into the same map.
    this.sun.shadow.camera.layers.enable(1);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // The prefiltered analytic sky supplies the real PBR fill. A restrained
    // hemisphere term remains for diffuse and thin/translucent materials: the
    // previous 0.09 left the underside of tree crowns and trunks at crushed
    // black once the key was occluded. Keep this well below the directional key
    // so it restores open-sky colour without flattening the raking shadows.
    this.hemi = new HemisphereLight(0xb9d3e8, 0x566047, 0.14);
    scene.add(this.hemi);
    this._environmentUnsubscribe = null;
    this._daylightRevision = -1;
    this.scene = scene;
    scene.userData.environmentLighting = this;
  }

  configureEnvironment(environment) {
    if (!environment?.sunDirection?.value || !environment?.sunColor?.value
      || !environment?.sunIlluminanceScale || !environment?.horizonColor?.value) {
      throw new TypeError('Lighting requires shared daylight EnvironmentGpuBindings.');
    }
    this._environmentUnsubscribe?.();
    const apply = () => {
      if (this._daylightRevision === environment.daylightRevision) return;
      this._daylightRevision = environment.daylightRevision;
      this._offset.copy(environment.sunDirection.value).normalize().multiplyScalar(140);
      this.sun.color.setRGB(
        environment.sunColor.value.x,
        environment.sunColor.value.y,
        environment.sunColor.value.z,
      );
      // Keep the key decisively ahead of sky bounce so terrain relief and real
      // caster shadows survive the tone-map shoulder. The authored illuminance still scales the
      // complete rig; this is only the renderer-relative conversion.
      // Calibrate the renderer-relative key against the shared sky return so the
      // authored 85 klux state produces a visible direct lobe without driving
      // pale turf into the tone-map shoulder. All source changes still travel through
      // the one EnvironmentGpuBindings snapshot.
      this.sun.intensity = KEY_INTENSITY_AT_REFERENCE * Math.max(0, environment.sunIlluminanceScale.value);
      const horizon = environment.horizonColor.value;
      const zenith = environment.zenithColor.value;
      this.hemi.color.setRGB(
        horizon.x * 0.34 + zenith.x * 0.66,
        horizon.y * 0.34 + zenith.y * 0.66,
        horizon.z * 0.34 + zenith.z * 0.66,
      );
      // Ground bounce follows the same horizon chromaticity, with a small
      // neutral lift so bark and turf do not turn blue/green-black in shadow.
      this.hemi.groundColor.setRGB(
        horizon.x * 0.34 + 0.018,
        horizon.y * 0.34 + 0.022,
        horizon.z * 0.29 + 0.016,
      );
      // Open-sky diffuse is a material part of outdoor illumination, not a tiny
      // cosmetic fill. Keep it decisively below the key, but high enough that a
      // north-facing rock face or trunk retains chromatic detail instead of
      // collapsing to charcoal. It still shares the analytic sky palette and
      // cannot cast a conflicting shadow or introduce a second sun direction.
      // Sky fill remains real diffuse bounce, but it must stay subordinate to the
      // directional key or the fairway loses its slope/shadow value structure.
      this.hemi.intensity = HEMISPHERE_INTENSITY_AT_REFERENCE
        * Math.sqrt(Math.max(0, environment.sunIlluminanceScale.value));
      this.sun.position.set(
        this._focus.x + this._offset.x,
        this._offset.y,
        this._focus.z + this._offset.z,
      );
      this.sun.target.position.set(this._focus.x, 0, this._focus.z);
      this.sun.target.updateMatrixWorld();
      this.invalidateShadow(true);
    };
    apply();
    this._environmentUnsubscribe = environment.onChange(apply);
    return this;
  }

  // Keep the shadow frustum centered on a point of interest (e.g., the ball) so
  // the shot always casts a real, resolved shadow no matter how far it flies.
  follow(x, z) {
    this._nextFocus.set(x, 0, z);
    const moved = !this._shadowFocusValid || this._focus.distanceToSquared(this._nextFocus) > 36;
    this._focus.set(x, 0, z);
    // The ball is uploaded before follow() on flight frames. Rebuilding a 2K
    // shadow atlas for both calls makes the map race the beauty pass and produces
    // the characteristic end-of-shot flash. Recenter only after a meaningful
    // focus move; small motion is below one texel in this 300 m frustum.
    if (moved) {
      // Keep the light transform paired with the retained depth atlas. Moving
      // the light without rebuilding its map is worse than holding the previous
      // focus: the shader would sample old texels through a new projection and
      // produce crawling/flickering shadows at the end of a shot.
      this.sun.position.set(x + this._offset.x, this._offset.y, z + this._offset.z);
      this.sun.target.position.set(x, 0, z);
      this.sun.target.updateMatrixWorld();
      this._lastShadowFocus.copy(this._focus);
      this._shadowFocusValid = true;
      this.sun.shadow.needsUpdate = true;
    }
    this._lastFollowAt = globalThis.performance?.now?.() ?? Date.now();
  }

  // The single authoritative invalidation entry point for caster/course changes.
  // Three clears this bit only after the next directional shadow render completes.
  invalidateShadow(force = false) {
    // During a moving-ball frame, syncBallMesh() calls this immediately before
    // follow(). The follow call owns the recenter decision; suppressing this
    // duplicate avoids two competing shadow-map invalidations in one flight.
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (!force && now - this._lastFollowAt < 100) return;
    this.sun.shadow.needsUpdate = true;
  }

  dispose() {
    this._environmentUnsubscribe?.();
    if (this.scene.userData.environmentLighting === this) delete this.scene.userData.environmentLighting;
    this.scene.remove(this.sun, this.sun.target, this.hemi);
  }
}
