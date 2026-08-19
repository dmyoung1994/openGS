import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('authored alpine daylight uses one lower lateral source for every consumer', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const match = source.match(/const SUN = new Vector3\(([-+\d.]+),\s*([-+\d.]+),\s*([-+\d.]+)\)\.normalize\(\)/);
  assert.ok(match, 'main must declare an authored normalized SUN direction');
  const raw = match.slice(1).map(Number);
  const length = Math.hypot(...raw);
  const elevation = Math.asin(raw[1] / length);
  assert.ok(elevation > 0.50 && elevation < 0.75,
    'late-morning alpine sun should remain plausible while casting a useful rake');
  assert.ok(Math.abs(raw[0] / length) > 0.60,
    'sun must retain a lateral component for readable cross-route shadows');
  assert.match(source, /range\.terrain\.uSunDir\.value\.copy\(SUN\)/,
    'terrain micro-shadow direction must consume the authored SUN');
  assert.match(source, /elevationRadians: Math\.asin\(SUN\.y\)/,
    'environment snapshot elevation must derive from the same SUN');
});

