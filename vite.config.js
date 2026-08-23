import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { courseAgent } from './vite-plugin-course-agent.js';

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
const premiumRangeManifestPath = fileURLToPath(new URL('./premium-range.json', import.meta.url));

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
      const premiumSource = readFileSync(premiumRangeManifestPath, 'utf8');
      JSON.parse(source);
      JSON.parse(premiumSource);
      this.emitFile({ type: 'asset', fileName: 'course.json', source });
      this.emitFile({ type: 'asset', fileName: 'premium-range.json', source: premiumSource });
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
  server: { port: 5173, host: true, strictPort: true },
  // Two entry points: the game, and viewer.html — an isolated per-asset preview so a
  // ball / turf tile / bunker can be iterated on without the whole course loaded.
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: [{ find: /^three$/, replacement: threeWebGPU }],
  },
  // Course Builder sidecar: serves /course.json, exposes POST /api/build (runs the
  // local design agent), and live-reloads the course on file change.
  plugins: [courseAgent(), requiredCourseManifest()],
});
