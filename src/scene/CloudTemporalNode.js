import { LinearFilter, Matrix4, Vector2, Vector3 } from 'three';
import {
  HalfFloatType, NodeMaterial, NodeUpdateType, QuadMesh, RenderTarget,
  RendererUtils, TempNode,
} from 'three/webgpu';
import {
  Fn, getViewPosition, logarithmicDepthToViewZ, mix, oneMinus, passTexture,
  float, mrt, smoothstep, texture, uniform, uv, vec2, vec4, viewZToPerspectiveDepth,
} from 'three/tsl';

const quad = new QuadMesh();
const drawingBufferSize = new Vector2();
let rendererState;

// Cloud transport remains RGBA16F (RGB scatter, A transmittance). A separate
// quarter-resolution attachment carries source-depth metadata so upsampling can
// reject geometry-clamped transport without repurposing a scatter/T channel.
// R = finite source class (1) vs background (0), G = opaque world-ray distance
// in metres; B/A are reserved and written as zero.
const CLOUD_TRANSPORT_ATTACHMENT = 'cloudTransport';
const CLOUD_SOURCE_ATTACHMENT = 'cloudSourceDepth';

// The temporal target is also the cloud integration target. Keeping the current
// raymarch and the history resolve in one material removes the old
// sky-pass -> sample -> resolve chain (and its intermediate current-sky write).
// The two half-float targets are still ping-ponged so the resolved result becomes
// next frame's history without a copy.
export class CloudTemporalNode extends TempNode {
  static get type() { return 'CloudTemporalNode'; }

  constructor(weatherSky, camera, resolutionScale = 0.25, sceneDepthNode = null) {
    super('vec4');
    if (!weatherSky || typeof weatherSky.radianceForRay !== 'function') {
      throw new TypeError('CloudTemporalNode requires a WeatherSky ray source.');
    }
    if (!sceneDepthNode || typeof sceneDepthNode.sample !== 'function') {
      throw new TypeError('CloudTemporalNode requires the authoritative Scene MRT depth node.');
    }
    this.weatherSky = weatherSky;
    this.camera = camera;
    this.sceneDepthNode = sceneDepthNode;
    this.resolutionScale = resolutionScale;
    this._history = new RenderTarget(1, 1, {
      depthBuffer: false, type: HalfFloatType, count: 2,
    });
    this._resolve = new RenderTarget(1, 1, {
      depthBuffer: false, type: HalfFloatType, count: 2,
    });
    this._nameAttachments(this._history, 'history');
    this._nameAttachments(this._resolve, 'resolve');
    this._history.texture.minFilter = LinearFilter;
    this._history.texture.magFilter = LinearFilter;
    this._resolve.texture.minFilter = LinearFilter;
    this._resolve.texture.magFilter = LinearFilter;
    this._history.textures[1].minFilter = LinearFilter;
    this._history.textures[1].magFilter = LinearFilter;
    this._resolve.textures[1].minFilter = LinearFilter;
    this._resolve.textures[1].magFilter = LinearFilter;
    this._history.texture.needsUpdate = true;
    this._resolve.texture.needsUpdate = true;
    this._historyNode = texture(this._history.texture);
    this._historySourceNode = texture(this._history.textures[1]);
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
    this._currentNearFar = uniform(new Vector2());
    this._initializedCamera = false;
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  getTextureNode() { return this._outputNode; }

  getSourceMetadataNode() { return this._historySourceNode; }

  setResolutionScale(resolutionScale) {
    const next = Number(resolutionScale);
    if (!Number.isFinite(next) || next < 0.0625 || next > 1) {
      throw new RangeError('CloudTemporalNode resolutionScale must be between 0.0625 and 1.');
    }
    if (Math.abs(next - this.resolutionScale) < 1e-6) return false;
    this.resolutionScale = next;
    // The next updateBefore resizes both ping-pong targets and starts current-only;
    // history from a differently sampled grid must not survive a scale change.
    this.reset();
    return true;
  }

  _nameAttachments(target, phase) {
    target.textures[0].name = CLOUD_TRANSPORT_ATTACHMENT;
    target.textures[1].name = CLOUD_SOURCE_ATTACHMENT;
    target.textures[0].userData.cloudAttachment = `${phase}-transport`;
    target.textures[1].userData.cloudAttachment = `${phase}-source-depth`;
  }

  readDiagnostics() {
    return Object.freeze({
      enabled: true,
      resolutionScale: this.resolutionScale,
      depthSource: 'scene-mrt-depth',
      depthSampledEveryPixel: true,
      opaqueDistance: 'reconstructed-world-ray-distance',
      rayInterval: 'opaque-clamped-or-full-aabb',
      outputRepresentation: 'scattered-radiance+transmittance',
      compositeStage: 'existing-final-pass-after-traa',
      passOrder: Object.freeze(['Scene MRT', 'Weather clouds [ fused raymarch + temporal resolve ]', 'TRAA', 'Final']),
      history: 'quarter-res-fused-ping-pong',
      sourceMetadata: 'quarter-res-mrt-rgba16f(depth-class,distance)',
      cloudUpsampling: 'depth-aware-2x2-compatible-taps',
      temporalRepresentative: 'density-scatter-weighted-world-point-in-marched-interval',
      temporalRejection: 'source-depth-class-distance+transmittance',
    });
  }

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
    this._currentNearFar.value.set(this.camera.near, this.camera.far);

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
    this._historySourceNode.value = this._history.textures[1];
    this._outputNode.value = this._history.texture;
    this._historyValid.value = 1;
  }

  setup(builder) {
    // Fn() returns a value VarNode, so keep source metadata in graph variables and
    // compose the actual MRT at the fragment root below. Returning mrt() directly
    // from Fn hides the output struct behind a VarNode in Three r185/WGSL.
    const sourceMetadataClass = float(0).toVar();
    const sourceMetadataDistance = float(0).toVar();
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
      // The cloud pass is downstream of Scene MRT. Every cloud fragment samples
      // the authoritative depth, including clear/background pixels; there is no
      // geometry-only branch that can accidentally restore a background card.
      // Depth is converted to the renderer's perspective convention before
      // reconstructing a world point and Euclidean camera-ray distance.
      // Keep the center fetch explicit: this is the authoritative depth sample
      // for the current cloud pixel, not a cached scene/background predicate.
      // Own one exact full-resolution depth texel per quarter-resolution cloud
      // pixel. Filtering depth across a ridge invents fractional geometry and
      // produces bright omission halos during transport reconstruction.
      const sceneDepthSize = this.sceneDepthNode.size();
      const sceneDepthTexel = currentUv.mul(sceneDepthSize).floor()
        .clamp(vec2(0), sceneDepthSize.sub(1));
      let sceneDepth = this.sceneDepthNode.load(sceneDepthTexel).r.toVar();
      if (builder.renderer.reversedDepthBuffer) sceneDepth.assign(sceneDepth.oneMinus());
      if (builder.renderer.logarithmicDepthBuffer) {
        const viewZ = logarithmicDepthToViewZ(
          sceneDepth, this._currentNearFar.x, this._currentNearFar.y,
        );
        sceneDepth.assign(viewZToPerspectiveDepth(
          viewZ, this._currentNearFar.x, this._currentNearFar.y,
        ));
      }
      const opaqueViewPosition = getViewPosition(
        currentUv, sceneDepth, this._currentProjectionInverse,
      );
      const opaqueWorldPosition = this._currentWorld
        .mul(vec4(opaqueViewPosition, 1)).xyz;
      const opaqueRayDistance = opaqueWorldPosition
        .sub(this._currentPosition).length();
      const opaqueHit = sceneDepth.lessThan(0.999999)
        .and(opaqueRayDistance.greaterThan(0.001)).select(1, 0);
      // The legacy radianceForRay wrapper remains available for complete-sky
      // callers; this pass intentionally consumes its transport-only sibling.
      // The march state also exposes a density/scatter-weighted representative
      // distance inside the actual [entry, clampedExit] interval.
      const marchState = {};
      const currentColor = this.weatherSky
        .cloudTransportForRay(
          worldDirection,
          this._currentPosition,
          currentPixel,
          opaqueRayDistance,
          opaqueHit,
          marchState,
        )
        .toVar(); // radianceForRay compatibility remains available outside this transport pass.

      // Reproject a representative world point inside the marched cloud interval.
      // A fixed distant point is wrong for varied cloud depth and advection, and can
      // make a nearby parcel borrow history from a distant one.
      const representativeDistance = marchState.representativeDistance
        .clamp(marchState.rayEntry, marchState.rayExitForMarch);
      const representativePoint = this._currentPosition
        .add(worldDirection.mul(representativeDistance));
      // Keep the historical variable name only as a compatibility alias; this is
      // the marched representative point, never a fixed far sky point.
      const farPoint = representativePoint;
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
      // Source metadata is point-sampled with load(), never bilinearly filtered:
      // a low-res geometry-clamped texel must not become a fractional sky class.
      const historySourceTexel = previousUv.mul(this._renderSize).floor()
        .clamp(vec2(0), this._renderSize.sub(1));
      const historySource = this._historySourceNode.load(historySourceTexel);
      const sourceClassAgreement = historySource.r.sub(opaqueHit).abs()
        .lessThan(0.5).select(1, 0);
      const currentSourceDistance = opaqueHit.greaterThan(0.5)
        .select(opaqueRayDistance, 0);
      const sourceDistanceDelta = historySource.g.sub(currentSourceDistance).abs();
      const sourceDistanceTolerance = opaqueRayDistance.mul(0.035).max(8);
      const sourceDistanceAgreement = opaqueHit.greaterThan(0.5)
        .select(oneMinus(smoothstep(
          sourceDistanceTolerance, sourceDistanceTolerance.mul(2), sourceDistanceDelta,
        )), 1);
      const sourceDepthAgreement = sourceClassAgreement.mul(sourceDistanceAgreement);
      sourceMetadataClass.assign(opaqueHit);
      sourceMetadataDistance.assign(currentSourceDistance);
      // Alpha is cloud transmittance from the raymarch. A changed transmittance
      // is a cloud disocclusion (or an advected parcel crossing the ray), so
      // reject history before it can leave a ghost trail. Keep the legacy alias
      // in the graph name because diagnostics/tools refer to opacity agreement.
      const transmittanceAgreement = oneMinus(smoothstep(0.20, 0.55,
        currentColor.a.sub(historyColor.a).abs()));
      const opacityAgreement = transmittanceAgreement;
      // Fade history for large projected parcel/camera motion so advection does not
      // leave a streak even when source depth and T happen to agree briefly.
      const reprojectionMotion = previousUv.sub(currentUv).mul(this._renderSize).length();
      const motionAgreement = oneMinus(smoothstep(2.5, 8.0, reprojectionMotion));
      // This is transmittance-aware temporal reconstruction, not a fixed color overwrite.
      const historyWeight = this._historyValid.mul(0.94)
        .mul(inside.select(1, 0)).mul(sourceDepthAgreement)
        .mul(opacityAgreement).mul(motionAgreement);
      const resolvedColor = mix(currentColor, historyColor, historyWeight);
      // Transport and source metadata are composed into separate MRT attachments
      // at the fragment root below; scatter/T remain physically intact.
      return resolvedColor;
    });
    this._material ||= new NodeMaterial();
    this._material.name = 'WeatherCloud.fusedRaymarchTemporalResolve';
    this._material.fog = false;
    const resolvedTransport = resolve();
    this._material.fragmentNode = mrt({
      [CLOUD_TRANSPORT_ATTACHMENT]: resolvedTransport,
      [CLOUD_SOURCE_ATTACHMENT]: vec4(
        sourceMetadataClass,
        sourceMetadataDistance,
        0,
        0,
      ),
    });
    this._material.needsUpdate = true;
    return this._outputNode;
  }

  dispose() {
    this._history.dispose();
    this._resolve.dispose();
    this._material?.dispose();
  }
}
