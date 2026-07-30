import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Point ONLY the exact bare specifier `three` at the WebGPU superset build. Using
// a /^three$/ regex (not a plain string) is essential: a string alias also
// rewrites subpaths like `three/webgpu`, `three/tsl`, and `three/addons/*`, which
// recurses and breaks resolution. Subpaths resolve normally via package exports.
// The webgpu build is self-contained, so aliasing bare `three` to it gives every
// module a single consistent three instance with the node/TSL system available.
const threeWebGPU = fileURLToPath(
  new URL('./node_modules/three/build/three.webgpu.js', import.meta.url),
);

export default defineConfig({
  publicDir: 'public',
  server: { port: 5173, host: true },
  build: { target: 'esnext' },
  resolve: {
    alias: [{ find: /^three$/, replacement: threeWebGPU }],
  },
});
