// Makes the vendored Three.js resolvable as the bare specifier "three" under
// Node (for tests), mirroring what the browser import map does at runtime.
// Runs automatically before `npm test`. Safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/link-three.js -> project root is two levels up from this file.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'node_modules', 'three');
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(
  path.join(dir, 'package.json'),
  JSON.stringify({ name: 'three', version: '0.169.0', type: 'module', exports: './three.module.js' }, null, 2),
);

const link = path.join(dir, 'three.module.js');
const target = path.join(root, 'vendor', 'three.module.js');
try { fs.unlinkSync(link); } catch {}
fs.symlinkSync(path.relative(dir, target), link);
console.log('linked three ->', path.relative(root, target));
