import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EnvironmentNode, Texture } from 'three/webgpu';
import { texture } from 'three/tsl';
import { SharedEnvironmentGrassPhongMaterial } from '../src/terrain/Grass.js';

test('grass uses native PMREM diffuse irradiance, not a reflected-colour multiplier', async () => {
  const material = new SharedEnvironmentGrassPhongMaterial();
  const environmentNode = texture(new Texture());
  const node = material.setupEnvironment({ environmentNode });
  assert.ok(node instanceof EnvironmentNode);
  assert.equal(node.envNode, environmentNode);
  assert.equal(material.setupEnvironment({ environmentNode: null }), null);
  const source = await readFile(new URL('../src/terrain/Grass.js', import.meta.url), 'utf8');
  assert.match(source, /super\.setup\( builder \);\s*builder\.context\.irradiance\.addAssign\( builder\.context\.iblIrradiance \)/);
  assert.doesNotMatch(source, /new BasicEnvironmentNode/);
  material.dispose();
});
