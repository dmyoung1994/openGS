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
    // Warm key light. Slightly golden so turf and skin of the ball catch a sunlit
    // hue rather than the flat white of a pure IBL.
    this.sun = new DirectionalLight(0xffe9c4, 3.1);
    this._offset = sunDir.clone().multiplyScalar(140);
    this.sun.position.copy(this._offset);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 460;
    const s = 78;                       // tight frustum -> crisp near shadows
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.028;
    this.sun.shadow.radius = 4;         // PCFSoft penumbra — soft-edged, not hard
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky/ground hemisphere fill. Kept subtle so the sun's direction and shadows
    // still read, but enough cool sky bounce up-facing surfaces and warm ground
    // bounce into the shadows to avoid dead-black occlusion.
    this.hemi = new HemisphereLight(0xbcd6ea, 0x54662f, 0.45);
    scene.add(this.hemi);

    // A dim, cool counter-fill from the opposite side keeps shadowed foliage from
    // going muddy without washing out the key. No shadows (fill only).
    this.fill = new DirectionalLight(0xaecbe8, 0.35);
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
