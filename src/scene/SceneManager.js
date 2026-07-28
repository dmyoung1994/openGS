import {
  WebGLRenderer, Scene, PerspectiveCamera, Fog, Color, Vector2,
  ACESFilmicToneMapping, PCFSoftShadowMap, PMREMGenerator,
  EquirectangularReflectionMapping,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// Owns the renderer, scene, camera, HDRI environment, and the post-processed
// frame loop. Image-based lighting from a real HDRI is what grounds everything
// in believable light; the composer adds the cinematic finish (bloom + filmic
// tone-map + anti-aliasing).
export class SceneManager {
  constructor(container) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(0x9ec6e0);
    this.scene.fog = new Fog(0xbcd4e6, 260, 900);

    this.camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 4000);
    this.camera.position.set(0, 2, 8);

    this._pmrem = new PMREMGenerator(this.renderer);
    this._setupComposer();

    this._updates = [];
    this._last = performance.now();
    this._elapsed = 0;
    window.addEventListener('resize', () => this._onResize());
  }

  // Load an equirectangular HDRI: use it both as the lighting environment
  // (via PMREM prefiltering) and as the sky background.
  async loadEnvironment(url, { asBackground = true } = {}) {
    const hdr = await new RGBELoader().loadAsync(url);
    hdr.mapping = EquirectangularReflectionMapping;
    const envMap = this._pmrem.fromEquirectangular(hdr).texture;
    this.scene.environment = envMap;
    if (asBackground) {
      this.scene.background = hdr;           // show the real sky
      this.scene.backgroundBlurriness = 0.0;
      this.scene.backgroundIntensity = 1.0;
    }
    return envMap;
  }

  _setupComposer() {
    const size = new Vector2(window.innerWidth, window.innerHeight);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Gentle bloom: only genuine highlights (sun, sky, spec) glow.
    this.bloom = new UnrealBloomPass(size, 0.35, 0.6, 0.85);
    this.composer.addPass(this.bloom);

    // Filmic tone-map + sRGB output.
    this.composer.addPass(new OutputPass());

    // FXAA last (MSAA is unavailable through the composer).
    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaa.material.uniforms.resolution.value.set(
      1 / (size.x * this.renderer.getPixelRatio()),
      1 / (size.y * this.renderer.getPixelRatio()),
    );
    this.composer.addPass(this.fxaa);
  }

  onUpdate(fn) { this._updates.push(fn); return this; }

  start() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min((now - this._last) / 1000, 0.1);
      this._last = now;
      this._elapsed += dt;
      for (const fn of this._updates) fn(dt, this._elapsed);
      this.composer.render();
    };
    this._raf = requestAnimationFrame(loop);
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
  }
}
