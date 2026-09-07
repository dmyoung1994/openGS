import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { Fn, reference, renderGroup, texture, vec2 } from 'three/tsl';

// Four bilinear comparison taps keep a stable feather without evaluating a
// per-pixel rotated disk. Radius remains adjustable in shadow-map texels.
const featheredShadow = Fn(({ depthTexture, shadowCoord, shadow }) => {
  const radius = reference('radius', 'float', shadow).setGroup(renderGroup);
  const size = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const step = radius.div(size);
  return [[-0.75, -0.25], [0.25, -0.75], [0.75, 0.25], [-0.25, 0.75]]
    .map(([x, y]) => texture(depthTexture, shadowCoord.xy.add(vec2(x, y).mul(step))).compare(shadowCoord.z))
    .reduce((sum, sample) => sum.add(sample)).mul(0.25);
});

// Native Three r185 cascades own frustum fitting, texel snapping, and blending.
// This adapter supplies our lifecycle and a live cascade for volumetric shafts.
export class CameraShadows extends CSMShadowNode {
  constructor(light, camera, renderer) {
    super(light, { cascades: 3, maxFar: 1000, lightMargin: 200 });
    this.fade = true;
    this._init({ camera, renderer });
    this.lights.forEach((cascade, index) => {
      cascade.isDirectionalLight = true;
      cascade.shadow.autoUpdate = true;
      cascade.shadow.filterNode = featheredShadow;
      cascade.shadow.camera.layers.enable(1);
      cascade.shadow.camera.far = 3000;
      cascade.shadow.bias = -0.000015 * (index + 1);
      cascade.shadow.camera.updateProjectionMatrix();
    });
    this._projectionSignature = '';
    this._deviceMapSize = light.shadow.mapSize.x;
    this._groundReach = 1000;
    this.cameraClearance = 0;
  }

  setWorkloadPolicy(mode) {
    this._groundReach = mode === 'battery' ? 500 : mode === 'balanced' ? 750 : 1000;
    this._updateRange();
    const cap = mode === 'battery' ? 1024 : mode === 'balanced' ? 1536 : this._deviceMapSize;
    const size = Math.min(this._deviceMapSize, cap);
    const radius = mode === 'battery' ? 2 : mode === 'balanced' ? 1.5 : 1;
    for (const { shadow } of this.lights) {
      shadow.mapSize.set(size, size);
      shadow.radius = radius;
    }
  }

  _updateRange() {
    // Elevated overview cameras still need ground receivers. Coarse altitude
    // bands avoid refitting the footprint for every small camera-height change.
    const maxFar = this._groundReach + Math.max(0, Math.floor((this.cameraClearance - 50) / 50) * 50);
    if (maxFar !== this.maxFar) {
      this.maxFar = maxFar;
      this.updateFrustums();
    }
  }

  updateBefore(frame) {
    this._updateRange();
    const camera = this.camera;
    // TRAA's subpixel offsets must not resize the stable cascade footprints.
    const signature = `${camera.fov}:${camera.aspect}:${camera.near}:${camera.far}:${camera.zoom}`;
    if (signature !== this._projectionSignature) {
      this.updateFrustums();
      this._projectionSignature = signature;
    }
    super.updateBefore(frame);
  }

  dispose() {
    for (const node of this._shadowNodes) node.dispose();
    super.dispose();
  }
}
