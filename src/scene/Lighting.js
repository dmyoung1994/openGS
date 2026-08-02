import { DirectionalLight, HemisphereLight, Color, Vector3 } from 'three';

// Sun (directional, shadow-casting) plus a sky/ground hemisphere fill. The HDRI
// environment supplies most of the ambient wrap; this rig adds the *directional*
// key that defines form, warmth, and ground shadows — the thing a pure IBL scene
// lacks. Tuned for a warm late-morning course light.
//
// The shadow frustum is kept tight around the play area (and re-centered on the
// ball in flight via follow()) so the 4K shadow map spends its resolution where
// the camera actually looks — crisp contact shadows at the tee.
export class Lighting {
  constructor(scene, sunDir = new Vector3(-0.5, 0.85, 0.3).normalize()) {
    // Warm golden-afternoon key. Stronger and warmer than a flat midday white so
    // the turf and objects catch a directional sunlit hue and long shadows model
    // the terrain — the core of the cinematic (vs. flat) look.
    this.sun = new DirectionalLight(0xffdca6, 3.5);
    this._offset = sunDir.clone().multiplyScalar(140);
    this.sun.position.copy(this._offset);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);   // 2K is plenty with the soft PCF penumbra; 4K was a big fill cost
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
    this.sun.shadow.radius = 3;         // PCFSoft penumbra — soft-edged, not hard
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky/ground hemisphere fill — pulled DOWN so shadows read deep and contrasty
    // (the earlier high fill flattened everything). Just enough cool sky bounce to
    // keep shadowed sides from crushing to black.
    this.hemi = new HemisphereLight(0xbcd6ea, 0x54662f, 0.26);
    scene.add(this.hemi);

    // A dim, cool counter-fill from the opposite side keeps shadowed foliage from
    // going muddy without washing out the key. No shadows (fill only).
    this.fill = new DirectionalLight(0xaecbe8, 0.16);
    this.fill.position.set(-this._offset.x, this._offset.y * 0.6, -this._offset.z);
    scene.add(this.fill);
  }

  // Keep the shadow frustum centered on a point of interest (e.g., the ball) so
  // the shot always casts a real, resolved shadow no matter how far it flies.
  follow(x, z) {
    this.sun.position.set(x + this._offset.x, this._offset.y, z + this._offset.z);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }
}
