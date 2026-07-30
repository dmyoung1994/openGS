import {
  WebGPURenderer, Scene, PerspectiveCamera, FogExp2, Color,
  ACESFilmicToneMapping, PCFSoftShadowMap,
  EquirectangularReflectionMapping, PostProcessing,
} from 'three';
import { pass, screenUV, saturation, mrt, output, velocity } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

// Owns the WebGPU renderer, scene, camera, HDRI environment, and the frame loop.
// Migrated from WebGLRenderer + EffectComposer to WebGPURenderer so the grass can
// be generated/animated in real compute shaders (TSL). Post-processing (bloom +
// cinematic grade) is being reintroduced through the node PostProcessing system;
// until then we render directly, which still applies tone-mapping and sRGB.
export class SceneManager {
  constructor(container) {
    this.container = container;
    this.renderer = new WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(0x9ec6e0);
    // Exponential aerial-perspective haze, tuned to bite over the grass LOD
    // dissolve band (~70-120m) so far grass/ground melt into a horizon-matched
    // haze — nothing to "pop." Kept gentle near the camera (exp^2) so mid-range
    // detail and the tree line stay readable.
    this.scene.fog = new FogExp2(0xcdd8e0, 0.0026);

    this.camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 4000);
    this.camera.position.set(0, 2, 8);

    this._setupPost();

    this._updates = [];
    this._elapsed = 0;
    this._ready = false;
    window.addEventListener('resize', () => this._onResize());
  }

  // Node post-processing: subtle bloom on genuine highlights, a saturation lift
  // and a soft vignette. The renderer's ACES tone-map + sRGB output are applied
  // to the final node automatically (outputColorTransform), so the grade lives in
  // linear light before the filmic curve — a graded-broadcast finish, not a filter.
  _setupPost() {
    // TRAA (temporal AA) resolves the sub-pixel shimmer of thin grass blades that
    // MSAA can't. It needs MSAA OFF and an MRT scene pass exposing color +
    // velocity (motion vectors) plus depth so it can reproject the history.
    const scenePass = pass(this.scene, this.camera, { samples: 0 });
    scenePass.setMRT(mrt({ output, velocity }));
    const color = scenePass.getTextureNode();
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');
    const aa = traa(color, depth, vel, this.camera);

    // Cinematic finish on top of the anti-aliased beauty: gentle bloom, a
    // saturation lift, and a soft vignette. ACES + sRGB applied last automatically.
    const bloomPass = bloom(aa, 0.22, 0.6, 0.85);
    let rgb = aa.rgb.add(bloomPass);
    rgb = saturation(rgb, 1.12);
    const d = screenUV.sub(0.5);
    const vignette = d.dot(d).mul(2.4 * 0.3).oneMinus();
    rgb = rgb.mul(vignette);

    this.postProcessing = new PostProcessing(this.renderer);
    this.postProcessing.outputNode = rgb;
  }

  // Load an equirectangular HDRI and use it both as the image-based lighting
  // environment and the sky background. WebGPURenderer consumes the equirect map
  // directly (no PMREM prefilter needed for our purposes).
  async loadEnvironment(url, { asBackground = true } = {}) {
    const hdr = await new HDRLoader().loadAsync(url);
    hdr.mapping = EquirectangularReflectionMapping;
    this.scene.environment = hdr;
    this.scene.environmentIntensity = 1.0;
    if (asBackground) {
      this.scene.background = hdr;
      this.scene.backgroundBlurriness = 0.0;
      this.scene.backgroundIntensity = 1.0;
    }
    return hdr;
  }

  onUpdate(fn) { this._updates.push(fn); return this; }

  // WebGPU needs async device init before the first render. We kick it off, then
  // drive the frame loop via setAnimationLoop (which the renderer prefers).
  start() {
    this.renderer.init().then(() => {
      this._ready = true;
      let last = performance.now();
      this.renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        this._elapsed += dt;
        for (const fn of this._updates) fn(dt, this._elapsed);
        this.postProcessing.renderAsync();
      });
    });
    return this;
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
