// Diagnostic only: compare native GPU analytic sky radiance with the exact
// production PMREM texture at matching directions and at its diffuse mip.
import { spawnSync } from 'node:child_process';

async function probe() {
  const entries = performance.getEntriesByType('resource');
  const moduleUrl = (name) => {
    const entry = entries.find(item => new URL(item.name).pathname.endsWith(`/${name}.js`));
    if (!entry) throw new Error(`Production module URL missing: ${name}`);
    return entry.name;
  };
  const { MeshBasicNodeMaterial, QuadMesh, RenderTarget, FloatType, RGBAFormat } = await import(moduleUrl('three_webgpu'));
  const { Fn, If, vec3, vec4, float, pmremTexture, screenCoordinate } = await import(moduleUrl('three_tsl'));
  const { sm, range } = window.golf;
  const environment = range.environment;
  const directions = [
    ['zenith', [0, 1, 0]], ['view-horizon', [-.05, .005, 1]],
    ['sunward', environment.sunDirection.value.toArray()],
    ['opposite', environment.sunDirection.value.toArray().map((v,i)=>i===1?v:-v)],
    ['down', [0,-1,0]],
  ];
  const target = new RenderTarget(3, directions.length, {type:FloatType,format:RGBAFormat,depthBuffer:false});
  const material = new MeshBasicNodeMaterial({toneMapped:false});
  // Native PMREM sampling owns material/environment rotation uniforms, so use a
  // real diagnostic quad material rather than a compute context lacking them.
  material.envMap = sm.scene.environment;
  material.fragmentNode = Fn(() => {
    const result = vec3(0).toVar();
    directions.forEach(([,direction], i) => {
      const ray = vec3(...direction).normalize();
      If(screenCoordinate.y.floor().equal(i), () => {
        If(screenCoordinate.x.lessThan(1), () => { result.assign(environment.skyRadiance(ray, {includeSun:false})); })
          .ElseIf(screenCoordinate.x.lessThan(2), () => { result.assign(pmremTexture(sm.scene.environment,ray,float(0))); })
          .Else(() => { result.assign(pmremTexture(sm.scene.environment,ray,float(1))); });
      });
    });
    return vec4(result,1);
  })();
  const quad = new QuadMesh(material);
  const previousTarget = sm.renderer.getRenderTarget();
  try {
    sm.renderer.setRenderTarget(target);
    quad.render(sm.renderer);
    sm.renderer.setRenderTarget(previousTarget);
    const data = await sm.renderer.readRenderTargetPixelsAsync(target,0,0,3,directions.length);
    // Native WebGPU readback retains 256-byte aligned rows (three RGBA32F
    // pixels are 48 bytes); padding is not another rendered pixel.
    const rowStride = Math.ceil(3 * 4 * 4 / 256) * 256 / 4;
    const rgb = pixel => {
      const offset = Math.floor(pixel / 3) * rowStride + (pixel % 3) * 4;
      return Array.from(data.slice(offset,offset+3));
    };
    const luma = values => values[0]*.2126+values[1]*.7152+values[2]*.0722;
    const samples = directions.map(([name,direction], i) => {
      const analytic = rgb(i*3), pmremSharp = rgb(i*3+1), pmremDiffuse = rgb(i*3+2);
      return { name, direction, analytic, pmremSharp, pmremDiffuse,
        analyticLuma:luma(analytic), sharpLuma:luma(pmremSharp), diffuseLuma:luma(pmremDiffuse) };
    });
    if (samples.some(s=>![...s.analytic,...s.pmremSharp,...s.pmremDiffuse].every(Number.isFinite))) {
      throw new Error('Non-finite native sky/PMREM readback');
    }
    return { samples, pmremIntensity:sm.scene.environmentIntensity,
      exposure:sm.renderer.toneMappingExposure, textureType:sm.scene.environment.type,
      textureColorSpace:sm.scene.environment.colorSpace,
      textureSize:sm.scene.environment.image,
      timeline:window.golf.timeline.snapshot() };
  } finally {
    sm.renderer.setRenderTarget(previousTarget);
    material.dispose();
    target.dispose();
  }
}

const result = spawnSync(process.execPath, [
  'scripts/shot.mjs','--game','--route=/play.html?course=grasslands-reference',
  '--presentation-mode=ultra','--presentation-scale=1','--gpu-live',
  '--frames=16','--frame-timing=1','--cam=0,0,-35','--terrain-lift=6',
  '--look=-7,0,105','--look-terrain-lift=5','--fov=65','--size=900x1200',
  `--eval=(${probe.toString()})()`,
  '--out=/tmp/grasslands-pmrem-probe.png','--qa-report=/tmp/grasslands-pmrem-probe.json',
], {stdio:'inherit',cwd:new URL('..',import.meta.url)});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
