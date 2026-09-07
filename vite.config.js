import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { courseAgent } from './vite-plugin-course-agent.js';
import { courseLibraryPlugin } from './scripts/lib/course-library.mjs';

// Point ONLY the exact bare specifier `three` at the WebGPU superset build. Using
// a /^three$/ regex (not a plain string) is essential: a string alias also
// rewrites subpaths like `three/webgpu`, `three/tsl`, and `three/addons/*`, which
// recurses and breaks resolution. Subpaths resolve normally via package exports.
// The webgpu build is self-contained, so aliasing bare `three` to it gives every
// module a single consistent three instance with the node/TSL system available.
const threeWebGPU = fileURLToPath(
  new URL('./node_modules/three/build/three.webgpu.js', import.meta.url),
);

const courseManifestPath = fileURLToPath(new URL('./course.json', import.meta.url));
const courseProjectManifestPath = fileURLToPath(new URL('./course.project.json', import.meta.url));
const beachRangeManifestPath = fileURLToPath(new URL('./beach-range.json', import.meta.url));

// The course manifest is authored beside the source tree so the local course
// agent can update it, but production still requires that exact manifest. Emit
// it as a validated build asset; a missing or malformed source manifest aborts
// the build instead of producing a renderer that invents substitute course data.
function requiredCourseManifest() {
  return {
    name: 'required-course-manifest',
    apply: 'build',
    buildStart() {
      const source = readFileSync(courseManifestPath, 'utf8');
      const projectSource = readFileSync(courseProjectManifestPath, 'utf8');
      const beachSource = readFileSync(beachRangeManifestPath, 'utf8');
      JSON.parse(source);
      JSON.parse(projectSource);
      JSON.parse(beachSource);
      this.emitFile({ type: 'asset', fileName: 'course.json', source });
      this.emitFile({ type: 'asset', fileName: 'course.project.json', source: projectSource });
      this.emitFile({ type: 'asset', fileName: 'beach-range.json', source: beachSource });
    },
  };
}

// The putting scene is the loading presentation, so discover its real assets in
// HTML before the engine module graph executes. Match Three's image/fetch request
// destination and anonymous CORS mode so the eventual loaders reuse these bytes.
function loadingGreenPreloads() {
  const images = [
    ...['blendkit_fairway', 'blendkit_green', 'roughdetail'].flatMap((name) => (
      ['alb', 'nrh'].map((suffix) => `/assets/textures/${name}_${suffix}.png`)
    )),
    ...['diff', 'nor_gl', 'rough'].map((kind) => `/assets/materials/dirt/dirt_${kind}_1k.jpg`),
    '/assets/materials/flagstick/premium_walnut_albedo_1k.png',
    '/assets/ball/golfball_nor.png',
  ];
  return {
    name: 'loading-green-preloads',
    transformIndexHtml(_html, { path }) {
      if (!['/', '/index.html', '/range.html', '/creator.html', '/play.html'].includes(path)) return [];
      return [...images, '/assets/ball/golfball.glb'].map((href) => ({
        tag: 'link',
        attrs: { rel: 'preload', href, as: href.endsWith('.glb') ? 'fetch' : 'image', crossorigin: 'anonymous' },
        // Keep the existing charset declaration within HTML's first 1024 bytes.
        injectTo: 'head',
      }));
    },
  };
}

export default defineConfig({
  publicDir: 'public',
  // The engine capture/evaluation APIs and the developer-facing range both use
  // 5173 as the canonical live endpoint. Vite's default is to silently walk to
  // 5174, 5175, ... when that port is occupied; over a long visual iteration this
  // can leave several copies of the same workspace alive and a browser attached to
  // a stale module graph. Fail loudly instead so there is exactly one canonical
  // range server to reload and diagnose.
  // The workspace-writing Course Creator is deliberately loopback-only. A remote
  // LAN client must never be able to reach the Codex sidecar merely by forging an
  // Origin header that matches this development server.
  server: { port: 5173, host: '127.0.0.1', strictPort: true },
  // First-class landing, range, creator, play, and isolated asset-viewer pages.
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        range: fileURLToPath(new URL('./range.html', import.meta.url)),
        creator: fileURLToPath(new URL('./creator.html', import.meta.url)),
        play: fileURLToPath(new URL('./play.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: [{ find: /^three$/, replacement: threeWebGPU }],
  },
  // Course Builder sidecar: serves /course.json, exposes POST /api/build (runs the
  // local design agent), and live-reloads the course on file change.
  plugins: [courseAgent(), requiredCourseManifest(), loadingGreenPreloads(), courseLibraryPlugin()],
});
