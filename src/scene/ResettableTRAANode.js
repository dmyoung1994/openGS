import TRAANode from './GolfTRAANode.js';
import { convertToTexture } from 'three/tsl';

// Three's TRAANode correctly restarts when its buffers change size, but it has no
// public camera-cut reset. Rebuilding the whole post graph to manufacture fresh
// history leaks every other pass-owned render target. This subclass keeps the graph
// stable and invalidates history in-shader for one resolve; that also preserves the
// atmosphere now carried inside the temporal color rather than flashing raw beauty.
export class ResettableTRAANode extends TRAANode {
  constructor(beautyNode, depthNode, velocityNode, camera, backgroundNode = null) {
    super(convertToTexture(beautyNode), depthNode, velocityNode, camera, backgroundNode);
  }

  reset() {
    this._jitterIndex = 0;
    this._historyValid.value = 0;
    this._historyAge.value = 0;
  }
}

export const resettableTraa = (beautyNode, depthNode, velocityNode, camera, backgroundNode = null) =>
  new ResettableTRAANode(beautyNode, depthNode, velocityNode, camera, backgroundNode);
