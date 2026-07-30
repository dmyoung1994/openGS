// Obsolete under the Vite + npm-`three` toolchain: `three` is now a real
// dependency in node_modules, so Node resolves bare `three` imports natively and
// no vendored shim is needed. Kept as a guarded no-op so any stale reference
// (older npm scripts, an in-flight agent) doesn't clobber the installed package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installed = path.join(root, 'node_modules', 'three', 'build', 'three.module.js');

if (fs.existsSync(installed)) {
  console.log('three is installed via npm — link-three shim is a no-op.');
} else {
  console.warn('three not installed. Run: npm install');
}
