import TRAANode from './GolfTRAANode.js';
import { Vector2 } from 'three';
import { convertToTexture } from 'three/tsl';

const drawingBufferSize = new Vector2();

// Three's TRAANode correctly restarts when its buffers change size, but it has no
// public camera-cut reset. Rebuilding the whole post graph to manufacture fresh
// history leaks every other pass-owned render target. This subclass keeps the graph
// stable and invalidates history in-shader for one resolve; that also preserves the
// atmosphere now carried inside the temporal color rather than flashing raw beauty.
export class ResettableTRAANode extends TRAANode {
  constructor(
    beautyNode,
    depthNode,
    velocityNode,
    camera,
    backgroundNode = null,
    cloudNode = null,
    cloudSky = null,
    cloudSourceNode = null,
  ) {
    super(
      convertToTexture(beautyNode), depthNode, velocityNode, camera,
      backgroundNode, cloudNode, cloudSky, cloudSourceNode,
    );
    this._resetCount = 0;
    this._lastResetReason = 'initial';
    this._manualDepthHistoryCopies = 0;
  }

  reset(reason = 'unspecified') {
    this._jitterIndex = 0;
    this._historyValid.value = 0;
    this._historyAge.value = 0;
    this._resetCount = (this._resetCount ?? 0) + 1;
    this._lastResetReason = reason;
  }

  setSize(width, height) {
    const changed = this._historyRenderTarget.width !== width
      || this._historyRenderTarget.height !== height;
    super.setSize(width, height);
    if (changed) this.reset('source-size-change');
    return changed;
  }

  // The base TRAANode only copies previous depth when its history size equals
  // renderer.getDrawingBufferSize(). Dynamic internal resolution intentionally
  // violates that assumption. Keep the base resolve intact, then carry the
  // authoritative Scene MRT depth into the same-sized standalone history surface
  // for the next frame when source and output sizes differ.
  updateBefore(frame) {
    const { renderer } = frame;
    const beautyRenderTarget = this.beautyNode.isRTTNode
      ? this.beautyNode.renderTarget : this.beautyNode.passNode.renderTarget;
    const sourceWidth = beautyRenderTarget.texture.width;
    const sourceHeight = beautyRenderTarget.texture.height;
    const outputSize = renderer.getDrawingBufferSize(drawingBufferSize);
    const needsInternalDepthCopy = sourceWidth !== outputSize.width || sourceHeight !== outputSize.height;

    const result = super.updateBefore(frame);
    if (needsInternalDepthCopy
      && this._historyRenderTarget.width === sourceWidth
      && this._historyRenderTarget.height === sourceHeight
      && this.depthNode?.value
      && typeof renderer.copyTextureToTexture === 'function') {
      renderer.copyTextureToTexture(this.depthNode.value, this._previousDepthTexture);
      this._manualDepthHistoryCopies = (this._manualDepthHistoryCopies ?? 0) + 1;
    }
    return result;
  }

  readDiagnostics() {
    const sourceTarget = this.beautyNode?.isRTTNode
      ? this.beautyNode.renderTarget : this.beautyNode?.passNode?.renderTarget;
    return {
      history: {
        width: this._historyRenderTarget?.width ?? null,
        height: this._historyRenderTarget?.height ?? null,
        valid: (this._historyValid?.value ?? 0) > 0.5,
        age: this._historyAge?.value ?? 0,
        resetCount: this._resetCount ?? 0,
        lastResetReason: this._lastResetReason ?? null,
      },
      source: {
        width: sourceTarget?.texture?.width ?? null,
        height: sourceTarget?.texture?.height ?? null,
      },
      previousDepth: {
        width: this._previousDepthTexture?.image?.width ?? null,
        height: this._previousDepthTexture?.image?.height ?? null,
        manualInternalResolutionCopies: this._manualDepthHistoryCopies ?? 0,
      },
      reconstruction: 'source-resolution-temporal-resolve',
    };
  }
}

export const resettableTraa = (
  beautyNode,
  depthNode,
  velocityNode,
  camera,
  backgroundNode = null,
  cloudNode = null,
  cloudSky = null,
  cloudSourceNode = null,
) => new ResettableTRAANode(
  beautyNode, depthNode, velocityNode, camera, backgroundNode, cloudNode, cloudSky, cloudSourceNode,
);
