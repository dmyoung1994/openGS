import {
  HalfFloatType, RenderTarget, Vector2, TempNode, QuadMesh, NodeMaterial,
  RendererUtils, NodeUpdateType,
} from 'three/webgpu';
import {
  Fn, uv, passTexture, uniform, vec2, vec4, luminance, smoothstep, mix,
  convertToTexture,
} from 'three/tsl';

const quad = new QuadMesh();
const drawingBufferSize = new Vector2();
let rendererState;

// Fused two-dimensional bloom. A bilinear quincunx at quarter resolution replaces the
// former horizontal + vertical targets. Four diagonal samples cover both axes in one
// tap each; the full-resolution upsample turns that footprint into a soft circular
// glare while avoiding four redundant source reads per low-resolution pixel.
const OFFSET = 1.35;
const CENTER_WEIGHT = 0.28;
const DIAGONAL_WEIGHT = 0.18;

export class GolfBloomNode extends TempNode {
  static get type() { return 'GolfBloomNode'; }

  constructor(inputNode, strength = 0.11, threshold = 0.9, resolutionScale = 0.25) {
    super('vec4');
    this.inputNode = convertToTexture(inputNode);
    this.strength = uniform(strength);
    this.threshold = uniform(threshold);
    this.smoothWidth = uniform(0.04);
    this.resolutionScale = resolutionScale;
    this._invSize = uniform(new Vector2(1, 1));
    this._target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this._target.texture.name = 'GolfBloom.fused2D';
    this._target.texture.generateMipmaps = false;
    this._textureOutput = passTexture(this, this._target.texture);
    this._material = null;
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  getTextureNode() { return this._textureOutput; }

  setSize(width, height) {
    const w = Math.max(Math.round(width * this.resolutionScale), 1);
    const h = Math.max(Math.round(height * this.resolutionScale), 1);
    this._invSize.value.set(1 / w, 1 / h);
    this._target.setSize(w, h);
  }

  updateBefore(frame) {
    const { renderer } = frame;
    rendererState = RendererUtils.resetRendererState(renderer, rendererState);
    renderer.getDrawingBufferSize(drawingBufferSize);
    this.setSize(drawingBufferSize.width, drawingBufferSize.height);
    renderer.setRenderTarget(this._target);
    quad.material = this._material;
    quad.name = 'Golf Bloom [ Fused 2D ]';
    quad.render(renderer);
    RendererUtils.restoreRendererState(renderer, rendererState);
  }

  setup(builder) {
    const source = this.inputNode;
    const bloom = Fn(() => {
      const coord = uv();
      const delta = this._invSize.mul(OFFSET);
      const bright = (sample) => {
        const weight = smoothstep(this.threshold, this.threshold.add(this.smoothWidth), luminance(sample.rgb));
        return mix(vec4(0), sample, weight).rgb;
      };
      const sum = bright(source.sample(coord)).mul(CENTER_WEIGHT).toVar();
      for (const offset of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        sum.addAssign(bright(source.sample(coord.add(delta.mul(vec2(offset[0], offset[1]))))).mul(DIAGONAL_WEIGHT));
      }
      return vec4(sum.mul(this.strength), 1);
    });
    this._material ||= new NodeMaterial();
    this._material.name = 'GolfBloom_fused2D';
    this._material.fragmentNode = bloom().context(builder.getSharedContext());
    this._material.needsUpdate = true;
    return this._textureOutput;
  }

  dispose() {
    this._target.dispose();
    this._material?.dispose();
  }
}

export const golfBloom = (inputNode, strength, threshold, resolutionScale) =>
  new GolfBloomNode(inputNode, strength, threshold, resolutionScale);
