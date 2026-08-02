import {
  WebGPURenderer, Scene, PerspectiveCamera, FogExp2, Color,
  ACESFilmicToneMapping, PCFSoftShadowMap,
  EquirectangularReflectionMapping, PostProcessing,
} from 'three';
import { pass, screenUV, saturation, mrt, output, velocity, vec3, mix, luminance, smoothstep } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
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
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(0x9ec6e0);
    // Exponential aerial-perspective haze, tuned to bite over the grass LOD
    // dissolve band (~70-120m) so far grass/ground melt into a horizon-matched
    // haze — nothing to "pop." Kept gentle near the camera (exp^2) so mid-range
    // detail and the tree line stay readable.
    this.scene.fog = new FogExp2(0xd8d0bd, 0.0013);

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

    // Ground-truth ambient occlusion with normals RECONSTRUCTED FROM DEPTH
    // (normalNode = null) — no per-material normal MRT, so it works with our unlit
    // grass. Contact shadows in the crevices (tree/grass bases, bunker edges,
    // terrain folds) ground everything and add the depth a flat-lit scene lacks.
    const aoPass = ao(depth, null, this.camera);
    aoPass.radius.value = 0.6;
    aoPass.scale.value = 1.5;
    // GTAO writes the occlusion in a single (red) channel — use it as a scalar so
    // it darkens all channels, not just red.
    const litAO = color.mul(aoPass.getTextureNode().r);

    // Anti-alias the AO'd beauty, then the cinematic finish: restrained bloom
    // (only the brightest sky/spec) and a slight de-saturation pull the look off
    // "candy green" toward a filmic, realistic grade.
    const aa = traa(litAO, depth, vel, this.camera);
    const bloomPass = bloom(aa, 0.11, 0.6, 0.9);
    let rgb = aa.rgb.add(bloomPass);
    rgb = saturation(rgb, 1.02);
    // Gentle contrast around linear mid-grey for a filmic, less-flat look.
    rgb = rgb.sub(0.18).mul(1.1).add(0.18).max(0.0);
    // Golden-hour split-tone: warm the highlights toward amber, push the shadows
    // slightly teal — a cohesive warm palette instead of cold minty green.
    const lum = luminance(rgb);
    const warmHi = rgb.mul(vec3(1.07, 1.0, 0.88));
    const coolLo = rgb.mul(vec3(0.94, 0.99, 1.06));
    rgb = mix(coolLo, warmHi, smoothstep(0.05, 0.5, lum));
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
    // Pull the IBL fill down so the warm directional key and its shadows dominate
    // — deeper, more contrasty light (less flat/overcast).
    this.scene.environmentIntensity = 0.82;
    if (asBackground) {
      this.scene.background = hdr;
      // Soften the cartoon cumulus and dim the sky so a bright bluebird midday
      // HDRI doesn't fight the warm low sun on the ground.
      this.scene.backgroundBlurriness = 0.05;
      this.scene.backgroundIntensity = 0.8;
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
        // `bypassPost` (diagnostic toggle) renders the scene straight to screen,
        // skipping the GTAO+TRAA+bloom stack, to gauge how much post-processing
        // costs vs scene geometry.
        if (this.bypassPost) this.renderer.renderAsync(this.scene, this.camera);
        else this.postProcessing.renderAsync();
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
