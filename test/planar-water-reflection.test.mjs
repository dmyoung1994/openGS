import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, Vector4,
  WebGPUCoordinateSystem,
} from 'three';
import {
  PlanarWaterReflection,
  inferInitialWaterQualityMode,
} from '../src/scene/PlanarWaterReflection.js';

function rendererStub({ webgpu = true, renderThrows = false } = {}) {
  const state = {
    target: null,
    initCount: 0,
    renderCount: 0,
    hiddenDuringRender: false,
    mrtWasCleared: false,
    lastReflectionMaterial: null,
    lastCamera: null,
  };
  return {
    ...state,
    isWebGPURenderer: webgpu,
    coordinateSystem: WebGPUCoordinateSystem,
    initialized: true,
    backend: {
      isWebGPUBackend: webgpu,
      isWebGLBackend: !webgpu,
      isFallbackAdapter: false,
    },
    getDrawingBufferSize(target) {
      target.set(800, 400);
      return target;
    },
    initRenderTarget(target) {
      this.initCount += 1;
      target.userData = { initialized: true };
    },
    getRenderTarget() { return this.target; },
    setRenderTarget(target) { this.target = target; },
    render(scene, camera) {
      this.renderCount += 1;
      this.lastCamera = camera;
      this.hiddenDuringRender = scene.getObjectByName('pond-water').visible === false;
      const reflected = scene.getObjectByName('reflected-object');
      this.lastReflectionMaterial = reflected?.material ?? null;
      this.mrtWasCleared = reflected?.material?.mrtNode === null;
      if (renderThrows) throw new Error('test reflection render failure');
    },
  };
}

function fixture(mode = 'quality', rendererOptions = {}, { environment = null } = {}) {
  const scene = new Scene();
  const renderer = rendererStub(rendererOptions);
  const camera = new PerspectiveCamera(40, 2, 0.1, 1000);
  camera.coordinateSystem = renderer.coordinateSystem;
  camera.position.set(0, 4, 8);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const mesh = new Mesh(
    new BoxGeometry(10, 0.04, 10),
    new MeshBasicMaterial(),
  );
  mesh.name = 'pond-water';
  scene.add(mesh);
  const reflectedMaterial = new MeshBasicMaterial();
  const reflectedMrtNode = { velocity: true };
  const treeEnvironment = { name: 'tree-environment' };
  const terrainEnvironment = { name: 'terrain-environment' };
  reflectedMaterial.mrtNode = reflectedMrtNode;
  reflectedMaterial.treeEnvironment = treeEnvironment;
  reflectedMaterial.terrainEnvironment = terrainEnvironment;
  const reflectedMesh = new Mesh(new BoxGeometry(1, 1, 1), reflectedMaterial);
  reflectedMesh.name = 'reflected-object';
  reflectedMesh.position.set(0, 1, 0);
  scene.add(reflectedMesh);
  const surface = {
    level: 0,
    mesh,
    environment,
    input: null,
    setReflectionInput(input) {
      this.input = {
        source: input.valid && (input.mode === 'ultra' || input.mode === 'quality')
          ? 'planar' : 'analytic-sky',
        ...input,
      };
    },
  };
  const pass = new PlanarWaterReflection({
    renderer,
    scene,
    camera,
    surfaces: [surface],
    qualityMode: mode,
    navigatorLike: {},
  });
  return {
    scene, camera, mesh, reflectedMesh, reflectedMrtNode,
    treeEnvironment, terrainEnvironment, surface, renderer, pass,
  };
}

test('preparation compiles exact reflection state and restores it on success and failure', async () => {
  for (const reject of [false, true]) {
    const f = fixture();
    const original = f.reflectedMesh.material;
    const oldTarget = { name: 'screen-owner' };
    f.renderer.target = oldTarget;
    let compiledMaterial;
    f.renderer.compileAsync = async (scene, camera) => {
      assert.equal(scene, f.scene);
      assert.equal(camera, f.pass._mirrorCamera);
      assert.notEqual(f.renderer.target, oldTarget);
      assert.equal(f.mesh.visible, false);
      compiledMaterial = f.reflectedMesh.material;
      assert.notEqual(compiledMaterial, original);
      assert.equal(compiledMaterial.mrtNode, null);
      await Promise.resolve();
      if (reject) throw new Error('compile rejected');
    };
    if (reject) await assert.rejects(f.pass.prepare(), /compile rejected/);
    else await f.pass.prepare();
    assert.equal(f.renderer.target, oldTarget);
    assert.equal(f.reflectedMesh.material, original);
    assert.equal(f.mesh.visible, true);
    assert.equal(f.renderer.renderCount, 0);
    assert.equal(f.pass._reflectionMaterialVariant(original), compiledMaterial);
    f.pass.dispose();
  }
});

test('mobile and analytic contracts allocate no reflection targets', () => {
  const mobile = fixture('mobile');
  assert.equal(mobile.pass.update(), 0);
  assert.equal(mobile.renderer.initCount, 0);
  assert.equal(mobile.renderer.renderCount, 0);
  assert.equal(mobile.surface.input.depthTexture.isDepthTexture, true);
  assert.deepEqual([mobile.surface.input.depthTexture.image.width, mobile.surface.input.depthTexture.image.height], [1, 1]);
  assert.equal(mobile.pass.diagnostics().source, 'analytic-sky');
  assert.equal(mobile.pass.surfaceDiagnostics(mobile.surface).allocatedTargets, 0);
  assert.equal(mobile.surface.input.source, 'analytic-sky');
  mobile.pass.dispose();

  const analytic = fixture('analytic');
  analytic.pass.update();
  assert.equal(analytic.renderer.initCount, 0);
  assert.equal(analytic.surface.input.source, 'analytic-sky');
  analytic.pass.dispose();
});

test('quality pass uses quarter resolution, hides water, and honors cadence', () => {
  const { pass, reflectedMesh, reflectedMrtNode, surface, renderer,
    treeEnvironment, terrainEnvironment } = fixture('quality');
  const originalVersion = reflectedMesh.material.version;
  assert.equal(pass.update(), 1);
  assert.equal(renderer.initCount, 2, 'one current and one history target are allocated');
  assert.equal(renderer.renderCount, 1);
  assert.equal(renderer.hiddenDuringRender, true);
  assert.equal(renderer.mrtWasCleared, true, 'direct reflection render must suppress scene velocity MRT output');
  assert.ok(renderer.lastCamera?.isPerspectiveCamera, 'reflection camera was supplied to direct render');
  const firstReflectionMaterial = renderer.lastReflectionMaterial;
  assert.notEqual(firstReflectionMaterial, reflectedMesh.material, 'reflection uses a cached material variant');
  assert.equal(firstReflectionMaterial.mrtNode, null);
  assert.equal(firstReflectionMaterial.treeEnvironment, treeEnvironment);
  assert.equal(firstReflectionMaterial.terrainEnvironment, terrainEnvironment);
  assert.equal(reflectedMesh.material.mrtNode, reflectedMrtNode, 'original MRT node is restored after capture');
  assert.equal(reflectedMesh.material.version, originalVersion, 'capture does not churn the authored material version');
  const project = (y) => new Vector4(0, y, 0, 1)
    .applyMatrix4(renderer.lastCamera.matrixWorldInverse)
    .applyMatrix4(renderer.lastCamera.projectionMatrix);
  const aboveWater = project(1);
  const belowWater = project(-1);
  assert.ok(aboveWater.w > 0 && aboveWater.z >= -1e-5 && aboveWater.z <= aboveWater.w + 1e-5,
    'the oblique WebGPU clip plane must retain geometry above the water');
  assert.ok(belowWater.w > 0 && belowWater.z < -1e-5,
    'the oblique WebGPU clip plane must reject geometry below the water');
  assert.deepEqual({ width: surface.input.width, height: surface.input.height }, { width: 200, height: 100 });
  assert.equal(surface.input.source, 'planar');
  assert.equal(surface.input.depthAvailable, true);
  assert.equal(surface.input.currentValid, true);
  assert.equal(surface.input.depthTexture.isDepthTexture, true);
  assert.equal(pass.update(), 0, 'quarter-resolution Quality reuses history between captures');
  assert.equal(renderer.renderCount, 1);
  assert.equal(pass.update(), 0, 'Quality keeps the same history for a third presented frame');
  assert.equal(renderer.renderCount, 1);
  assert.equal(pass.update(), 1);
  assert.equal(renderer.renderCount, 2);
  assert.equal(renderer.lastReflectionMaterial, firstReflectionMaterial, 'cached variant is reused on the next capture');
  assert.equal(pass.surfaceDiagnostics(surface).skippedCount, 2);
  assert.equal(surface.mesh.visible, true, 'water visibility is restored after capture');
  pass.dispose();
});

test('mirrored pass uses terrain substrate instead of a source-camera blade list', () => {
  const { pass, renderer, reflectedMesh } = fixture('ultra');
  reflectedMesh.userData.planarReflectionDetail = 'terrain-substrate';
  const render = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    assert.equal(reflectedMesh.visible, false, 'source-camera blade detail must be hidden only during reflection');
    return render(scene, camera);
  };
  try {
    assert.equal(pass.update(), 1);
    assert.equal(reflectedMesh.visible, true, 'beauty visibility must be restored after reflection');
    assert.equal(pass.surfaceDiagnostics(pass._surfaceStates.keys().next().value)
      .visibilityGuard.roughReflectionSource, 'authoritative-terrain-substrate');
  } finally {
    pass.dispose();
  }
});

test('identical mirrored oblique preparation is deterministic', () => {
  const { pass } = fixture('ultra');
  try {
    pass.update();
    pass._prepareMirrorCamera(0);
    const first = [...pass._mirrorViewProjection.elements];
    pass._prepareMirrorCamera(0);
    assert.deepEqual(
      [...pass._mirrorViewProjection.elements],
      first,
      'reusing a stable camera must not mutate the world water normal or clip frustum',
    );
  } finally {
    pass.dispose();
  }
});

test('planar target follows production render scale without changing representation', () => {
  const { pass } = fixture('ultra');
  try {
    assert.deepEqual(pass._targetSize('ultra', 1), {
      width: 400, height: 200, resolutionScale: 0.5,
    });
    const scaled = pass._targetSize('ultra', 0.68);
    assert.equal(scaled.width, 272);
    assert.equal(scaled.height, 136);
    assert.ok(Math.abs(scaled.resolutionScale - 0.34) < 1e-9);
  } finally {
    pass.dispose();
  }
});

test('MRT suppression and water visibility restore when direct reflection render throws', () => {
  const { pass, mesh, reflectedMesh, reflectedMrtNode, renderer, surface } = fixture('ultra', { renderThrows: true });
  const originalVersion = reflectedMesh.material.version;
  pass.update();
  assert.equal(renderer.renderCount, 1);
  assert.equal(reflectedMesh.material.mrtNode, reflectedMrtNode);
  assert.equal(reflectedMesh.material.version, originalVersion);
  assert.equal(mesh.visible, true);
  assert.equal(surface.input.source, 'analytic-sky');
  assert.equal(pass.diagnostics().error.code, 'reflection-render-failed');
  pass.dispose();
});

test('camera cuts increment revision, reject old history, and force a capture', () => {
  const { pass, camera, surface, renderer } = fixture('ultra');
  pass.update();
  assert.equal(renderer.renderCount, 1);
  camera.position.set(0, 20, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  pass.update();
  assert.equal(renderer.renderCount, 2, 'a camera cut bypasses the normal cadence');
  assert.equal(surface.input.revision, 1);
  assert.equal(surface.input.historyValid, false);
  assert.equal(pass.surfaceDiagnostics(surface).clipGuard.strategy, 'oblique-projection-plane');
  assert.equal(pass.surfaceDiagnostics(surface).clipGuard.belowWaterGeometryClipped, true);
  pass.dispose();
});

test('strict WebGPU failure is fail-closed with exact diagnostics', () => {
  const fixtureData = fixture('ultra');
  fixtureData.renderer.isWebGPURenderer = false;
  fixtureData.renderer.backend.isWebGPUBackend = false;
  fixtureData.pass.update();
  assert.equal(fixtureData.renderer.initCount, 0);
  assert.equal(fixtureData.renderer.renderCount, 0);
  assert.equal(fixtureData.pass.diagnostics().error.code, 'strict-webgpu-required');
  assert.equal(fixtureData.surface.input.source, 'analytic-sky');
  fixtureData.pass.dispose();
});

test('initial water quality follows the existing environment capability ceiling', () => {
  assert.equal(inferInitialWaterQualityMode(
    { id: 'high' },
    { hardwareConcurrency: 16, deviceMemory: 32, userAgent: '', platform: '' },
  ), 'ultra');
  assert.equal(inferInitialWaterQualityMode(
    { id: 'high' },
    { hardwareConcurrency: 16, deviceMemory: 8, userAgent: '', platform: '' },
  ), 'ultra');
  assert.equal(inferInitialWaterQualityMode(
    { id: 'high' },
    { hardwareConcurrency: 6, deviceMemory: 8, userAgent: '', platform: '' },
  ), 'quality');
  assert.equal(inferInitialWaterQualityMode(
    { id: 'balanced' },
    { hardwareConcurrency: 8, deviceMemory: 16, userAgent: '', platform: '' },
  ), 'analytic');
  assert.equal(inferInitialWaterQualityMode(
    { id: 'high' },
    { hardwareConcurrency: 8, deviceMemory: 16, userAgent: 'iPhone', platform: '' },
  ), 'mobile');
});
