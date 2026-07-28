import { DirectionalLight, HemisphereLight, Vector3 } from 'three';

// Sun (directional, shadow-casting) plus a sky/ground hemisphere fill. The
// shadow frustum is sized for the play area near the tee.
export class Lighting {
  constructor(scene, sunDir = new Vector3(-0.5, 0.85, 0.3).normalize()) {
    this.sun = new DirectionalLight(0xfff2d6, 2.6);
    this._offset = sunDir.clone().multiplyScalar(120);
    this.sun.position.copy(this._offset);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 400;
    const s = 90;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // The HDRI environment supplies most of the ambient/fill; keep the
    // hemisphere light subtle so the sun's direction and shadows read.
    this.hemi = new HemisphereLight(0xbcd6ea, 0x415a2c, 0.25);
    scene.add(this.hemi);
  }

  // Keep the shadow frustum centered on a point of interest (e.g., the ball).
  follow(x, z) {
    this.sun.position.set(x + this._offset.x, this._offset.y, z + this._offset.z);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }
}
