import { LinearFilter, Matrix4, Vector2, Vector3 } from 'three';
import {
  HalfFloatType, NodeMaterial, NodeUpdateType, QuadMesh, RenderTarget,
  RendererUtils, TempNode,
} from 'three/webgpu';
import {
  Fn, mix, oneMinus, passTexture, smoothstep, texture, uniform, uv, vec2, vec4,
} from 'three/tsl';

const quad = new QuadMesh();
const drawingBufferSize = new Vector2();
let rendererState;

// The temporal target is also the cloud integration target. Keeping the current
// raymarch and the history resolve in one material removes the old
// sky-pass -> sample -> resolve chain (and its intermediate current-sky write).
// The two half-float targets are still ping-ponged so the resolved result becomes
// next frame's history without a copy.
export class CloudTemporalNode extends TempNode {
  static get type() { return 'CloudTemporalNode'; }

  constructor(weatherSky, camera, resolutionScale = 0.25) {
    super('vec4');
    if (!weatherSky || typeof weatherSky.radianceForRay !== 'function') {
      throw new TypeError('CloudTemporalNode requires a WeatherSky ray source.');
    }
    this.weatherSky = weatherSky;
    this.camera = camera;
    this.resolutionScale = resolutionScale;
    this._history = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this._resolve = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this._history.texture.minFilter = LinearFilter;
    this._history.texture.magFilter = LinearFilter;
    this._resolve.texture.minFilter = LinearFilter;
    this._resolve.texture.magFilter = LinearFilter;
    this._history.texture.needsUpdate = true;
    this._resolve.texture.needsUpdate = true;
    this._history.texture.name = 'WeatherCloud.history';
    this._resolve.texture.name = 'WeatherCloud.resolve';
    this._historyNode = texture(this._history.texture);
    this._outputNode = passTexture(this, this._history.texture);
    this._material = null;
    this._historyValid = uniform(0);
    this._renderSize = uniform(new Vector2(1, 1));
    this._currentProjection = uniform(new Matrix4());
    this._currentProjectionInverse = uniform(new Matrix4());
    this._currentView = uniform(new Matrix4());
    this._previousProjection = uniform(new Matrix4());
    this._previousView = uniform(new Matrix4());
    this._currentWorld = uniform(new Matrix4());
    this._previousWorld = uniform(new Matrix4());
    this._currentPosition = uniform(new Vector3());
    this._initializedCamera = false;
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  getTextureNode() { return this._outputNode; }

  reset() {
    // Do not copy current radiance into history. The first fused pass already
    // evaluates a valid current sample, and historyValid gates all old samples.
    this._historyValid.value = 0;
    this._initializedCamera = false;
  }

  setSize(width, height) {
    const nextWidth = Math.max(1, Math.floor(width * this.resolutionScale));
    const nextHeight = Math.max(1, Math.floor(height * this.resolutionScale));
    if (this._history.width === nextWidth && this._history.height === nextHeight) return false;
    this._history.setSize(nextWidth, nextHeight);
    this._resolve.setSize(nextWidth, nextHeight);
    this._renderSize.value.set(nextWidth, nextHeight);
    this.reset();
    return true;
  }

  updateBefore(frame) {
    const { renderer } = frame;
    renderer.getDrawingBufferSize(drawingBufferSize);
    const resized = this.setSize(drawingBufferSize.width, drawingBufferSize.height);

    const currentProjection = this.camera.projectionMatrix;
    const currentView = this.camera.matrixWorldInverse;
    const currentWorld = this.camera.matrixWorld;
    if (this._initializedCamera) {
      this._previousProjection.value.copy(this._currentProjection.value);
      this._previousView.value.copy(this._currentView.value);
      this._previousWorld.value.copy(this._currentWorld.value);
    } else {
      this._previousProjection.value.copy(currentProjection);
      this._previousView.value.copy(currentView);
      this._previousWorld.value.copy(currentWorld);
      this._initializedCamera = true;
    }
    this._currentProjection.value.copy(currentProjection);
    this._currentProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    this._currentView.value.copy(currentView);
    this._currentWorld.value.copy(currentWorld);
    this._currentPosition.value.setFromMatrixPosition(currentWorld);

    rendererState = RendererUtils.resetRendererState(renderer, rendererState);
    if (resized) {
      // setSize() may dispose/recreate GPU views. Initialize both targets, but
      // deliberately avoid the former source-target texture copy: historyValid=0
      // makes the first fused resolve current-only.
      renderer.initRenderTarget(this._history);
      renderer.initRenderTarget(this._resolve);
    }
    renderer.setRenderTarget(this._resolve);
    quad.material = this._material;
    quad.name = 'Weather clouds [ fused raymarch + temporal resolve ]';
    quad.render(renderer);
    renderer.setRenderTarget(null);
    RendererUtils.restoreRendererState(renderer, rendererState);

    const previousHistory = this._history;
    this._history = this._resolve;
    this._resolve = previousHistory;
    this._historyNode.value = this._history.texture;
    this._outputNode.value = this._history.texture;
    this._historyValid.value = 1;
  }

  setup(builder) {
    const resolve = Fn(() => {
      const currentUv = uv();
      const currentPixel = currentUv.mul(this._renderSize).floor();
      // Build the camera ray explicitly. A fullscreen quad has no scene camera
      // context, so relying on positionWorldDirection/cameraPosition here would
      // bind the wrong camera (or the quad's orthographic camera).
      // QuadMesh UVs use texture orientation (0,0 at the upper-left), while
      // clip-space Y points upward. Keep the explicit camera ray aligned with
      // the target texture; treating UV.y as clip Y mirrors the cloud layer
      // into the lower half of every shot.
      const ndc = vec2(
        currentUv.x.mul(2).sub(1),
        currentUv.y.mul(-2).add(1),
      );
      const viewDirection = this._currentProjectionInverse
        .mul(vec4(ndc, 1, 1)).xyz.normalize();
      const worldDirection = this._currentWorld
        .mul(vec4(viewDirection, 0)).xyz.normalize();
      const currentColor = this.weatherSky
        .radianceForRay(worldDirection, this._currentPosition, currentPixel)
        .toVar();

      // Reproject a finite far sky point through the previous camera. This keeps
      // camera translation parallax and gives history a real validity test instead
      // of blindly blending the prior low-resolution frame.
      const farPoint = this._currentWorld.mul(vec4(viewDirection.mul(10000), 1));
      const previousClip = this._previousProjection.mul(this._previousView).mul(farPoint);
      const previousNdc = previousClip.xy.div(previousClip.w);
      const previousUv = vec2(
        previousNdc.x.mul(0.5).add(0.5),
        previousNdc.y.mul(-0.5).add(0.5),
      );
      const inside = previousClip.w.greaterThan(0.001)
        .and(previousUv.x.greaterThanEqual(0))
        .and(previousUv.x.lessThanEqual(1))
        .and(previousUv.y.greaterThanEqual(0))
        .and(previousUv.y.lessThanEqual(1));
      const previous = this._historyNode;
      const historyColor = previous.sample(previousUv).toVar();
      // Alpha is cloud opacity from the raymarch. A changed opacity is a cloud
      // disocclusion (or an advected parcel crossing the ray), so reject history
      // before it can leave a ghost trail. This is transmittance-aware temporal reconstruction,
      // rather than a fixed color overwrite.
      const opacityAgreement = oneMinus(smoothstep(0.12, 0.42,
        currentColor.a.sub(historyColor.a).abs()));
      const historyWeight = this._historyValid.mul(0.86)
        .mul(inside.select(1, 0)).mul(opacityAgreement);
      return mix(currentColor, historyColor, historyWeight);
    });
    this._material ||= new NodeMaterial();
    this._material.name = 'WeatherCloud.fusedRaymarchTemporalResolve';
    this._material.fragmentNode = resolve().context(builder.getSharedContext());
    this._material.needsUpdate = true;
    return this._outputNode;
  }

  dispose() {
    this._history.dispose();
    this._resolve.dispose();
    this._material?.dispose();
  }
}
