import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('foliage lab exposes bounded production-material and sun inspection controls', async () => {
  const [html, viewer, assets, generated] = await Promise.all([
    readFile(new URL('../viewer.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewer/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewer/assets.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scene/GeneratedFoliageTree.js', import.meta.url), 'utf8'),
  ]);

  for (const name of ['alphaTest', 'roughness', 'normalShape', 'transmission', 'mip']) {
    assert.match(html, new RegExp(`data-query="${name}"`));
  }
  for (const name of ['alphaTest', 'roughness', 'normalShape', 'transmission']) {
    assert.match(assets, new RegExp(`boundedQueryNumber\\('${name}'`));
  }
  assert.match(html, /A2C N\/A/);
  assert.match(viewer, /alphaToCoverageSupported: false/);
  assert.match(html, /data-sun="fixed"/);
  assert.match(html, /data-sun="moving"/);
  assert.match(viewer, /environment\.sunDirection\.value\.copy\(labSunDirection\)/);
  assert.match(viewer, /lighting\.sun\.shadow\.needsUpdate = true/);
  assert.match(viewer, /Number\(button\.dataset\.value\)/,
    'equivalent numeric spellings must keep the active control visibly pressed');
  assert.match(generated, /labControls\?\.alphaTest \?\? 0\.20/);
  assert.match(generated, /labControls\?\.roughnessStrength \?\? 1/);
  assert.match(generated, /labControls\?\.normalShaping \?\? 0/);
  assert.match(generated, /labControls\?\.transmissionStrength \?\? 1/);
  assert.match(generated, /material\.alphaTest = showSupportGeometry \? 0 : alphaTest/);
  assert.match(html, /data-subject="atlas"/);
  assert.match(html, /data-subject="cards"/);
  assert.match(html, /data-subject="mip"/);
  assert.match(assets, /texture\(pack\.atlas\)\.level\(mipLevel\)/);
  assert.match(assets, /clusterNames: pack\.metadata\.clusters\.map/);
});
