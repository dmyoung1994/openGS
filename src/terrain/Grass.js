import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute,
  Mesh, ShaderMaterial, Color, Vector2, Vector3, DoubleSide, Sphere,
} from 'three';

// GPU-instanced grass. Every blade is one instance of a shared few-segment
// strip; all wind motion, bending, and shading happen in the vertex/fragment
// shaders driven by a single uTime uniform. The CPU only runs once, at build
// time, to scatter the blades onto the terrain. This is the heavy visual layer
// and it must stay entirely GPU-animated.
//
// options:
//   terrain    Terrain (for height + surface filtering)
//   region     { minX, maxX, minZ, maxZ }
//   count      number of blades to attempt
//   allow      (surfaceName) => bool   which surfaces get grass
//   height     [min, max] blade height meters
export class Grass {
  constructor({ terrain, region, count = 160000, allow, height = [0.06, 0.16] }) {
    this.terrain = terrain;
    this.uniforms = {
      uTime: { value: 0 },
      uWindDir: { value: new Vector2(0.8, 0.6).normalize() },
      uWindStrength: { value: 0.12 },
      uGust: { value: 0.0 },
      uSunDir: { value: new Vector3(-0.5, 0.9, 0.35).normalize() },
      uSunColor: { value: new Color(0xfff4d9).multiplyScalar(1.35) },
      uAmbient: { value: new Color(0x8fb7c9).multiplyScalar(0.8) },
    };
    this.mesh = this._build(region, count, allow || (() => true), height);
  }

  _build(region, count, allow, [hmin, hmax]) {
    const SEG = 5; // height segments -> smooth bezier curve
    const rows = SEG + 1;
    // Base blade strip: x in {-0.5, 0.5}, y = t in [0,1]. All width tapering,
    // curvature, and rounded-normal shading happen in the vertex shader.
    const basePos = [];
    const baseUvY = [];
    for (let r = 0; r < rows; r++) {
      const y = r / SEG;
      basePos.push(-0.5, y, 0, 0.5, y, 0);
      baseUvY.push(y, y);
    }
    const idx = [];
    for (let r = 0; r < SEG; r++) {
      const a = r * 2, b = r * 2 + 1, c = r * 2 + 2, d = r * 2 + 3;
      idx.push(a, c, b, b, c, d);
    }

    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(basePos), 3));
    geo.setAttribute('uvY', new BufferAttribute(new Float32Array(baseUvY), 1));
    geo.setIndex(idx);

    // Scatter instances.
    const offsets = [];
    const orient = [];
    const scale = [];
    const colorv = [];
    const phase = [];
    const stiff = [];
    const lean = [];
    const col = new Color();
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const x = region.minX + Math.random() * (region.maxX - region.minX);
      const z = region.minZ + Math.random() * (region.maxZ - region.minZ);
      const surf = this.terrain.surfaceAt(x, z);
      if (!allow(surf)) continue;
      const y = this.terrain.heightAt(x, z);
      offsets.push(x, y, z);
      orient.push(Math.random() * Math.PI * 2);

      const tall = surf === 'rough' || surf === 'deepRough';
      // Clumping: smooth low-frequency variation makes tufts and thin patches
      // instead of a uniform carpet.
      const clump = 0.5 + 0.5 * Math.sin(x * 0.35 + 1.3) * Math.cos(z * 0.31 - 0.7)
                        + 0.25 * Math.sin(x * 0.11 - z * 0.13);
      const baseH = tall ? hmax * 1.9 : hmin + Math.random() * (hmax - hmin);
      const h = baseH * (0.6 + 0.7 * Math.max(0, Math.min(1, clump)));
      const w = 0.008 + Math.random() * 0.012;
      scale.push(w, h);

      // Colour: mostly healthy green, some darker shaded blades, a few dry ones.
      const r = Math.random();
      if (r < 0.09) col.set(0xbcb56a);                       // dry / sun-bleached
      else if (r < 0.32) col.set(tall ? 0x3f5f24 : 0x4f7a2e); // shaded
      else col.set(tall ? 0x5f8a37 : 0x77aa47);              // healthy
      col.multiplyScalar(0.8 + Math.random() * 0.45);
      colorv.push(col.r, col.g, col.b);

      // Rest lean: a gentle, per-blade curve so nothing is a straight spike.
      const la = Math.random() * Math.PI * 2;
      const lm = 0.18 + Math.random() * 0.4;
      lean.push(Math.cos(la) * lm, Math.sin(la) * lm);

      phase.push(Math.random() * Math.PI * 2);
      stiff.push(0.7 + Math.random() * 0.6);
      placed++;
    }

    geo.setAttribute('aOffset', new InstancedBufferAttribute(new Float32Array(offsets), 3));
    geo.setAttribute('aOrient', new InstancedBufferAttribute(new Float32Array(orient), 1));
    geo.setAttribute('aScale', new InstancedBufferAttribute(new Float32Array(scale), 2));
    geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(colorv), 3));
    geo.setAttribute('aPhase', new InstancedBufferAttribute(new Float32Array(phase), 1));
    geo.setAttribute('aStiff', new InstancedBufferAttribute(new Float32Array(stiff), 1));
    geo.setAttribute('aLean', new InstancedBufferAttribute(new Float32Array(lean), 2));
    geo.instanceCount = placed;

    // Bounding sphere so frustum culling doesn't drop the whole field.
    const cx = (region.minX + region.maxX) / 2;
    const cz = (region.minZ + region.maxZ) / 2;
    geo.boundingSphere = new Sphere(
      new Vector3(cx, 0, cz),
      Math.hypot(region.maxX - region.minX, region.maxZ - region.minZ),
    );

    const mat = new ShaderMaterial({
      uniforms: this.uniforms,
      side: DoubleSide,
      vertexShader: GRASS_VERT,
      fragmentShader: GRASS_FRAG,
    });

    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = true;
    mesh.name = 'grass';
    this._placed = placed;
    return mesh;
  }

  update(t) {
    this.uniforms.uTime.value = t;
    // Slow, breathing gust envelope.
    this.uniforms.uGust.value = 0.5 + 0.5 * Math.sin(t * 0.35);
  }
}

// Full-geometry grass in the spirit of the Ghost of Tsushima / hexaquo Godot
// technique, adapted to WebGL instancing:
//   * each blade is a smooth curve (rest lean + wind, quadratic in height),
//   * blades carry a *rounded* normal across their width so they shade like a
//     rounded surface, not a flat card (the single biggest realism factor),
//   * back-lit translucency lets the sun glow through the canopy.
const GRASS_VERT = /* glsl */`
  attribute vec3 aOffset;
  attribute float aOrient;
  attribute vec2 aScale;   // width, height
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aStiff;
  attribute vec2 aLean;    // rest-curve direction * amount (world XZ)
  attribute float uvY;

  uniform float uTime;
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform float uGust;

  varying vec3 vColor;
  varying float vY;
  varying vec3 vNormal;

  mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

  void main() {
    float t = uvY;
    float side = position.x;                 // -0.5 or +0.5
    float w = aScale.x * (1.0 - smoothstep(0.55, 1.0, t)); // taper to a point
    float H = aScale.y;

    // Straight blade facing +Z with a rounded (cylindrical) normal across width.
    vec3 p = vec3(side * w, t * H, 0.0);
    float round = 0.7;
    vec3 n = normalize(vec3(side * 2.0 * round, 0.0, 1.0));

    // Orient around Y.
    vec2 pxz = rot(aOrient) * p.xz; p.x = pxz.x; p.z = pxz.y;
    vec2 nxz = rot(aOrient) * n.xz; n.x = nxz.x; n.z = nxz.y;

    // Bend: rest lean + wind sway, curving quadratically with height.
    float wave = sin(uTime * 1.6 + dot(aOffset.xz, uWindDir) * 0.35 + aPhase);
    float wind = (uWindStrength * (0.6 + uGust * 0.6)) * wave / aStiff;
    vec2 bendXZ = (aLean + uWindDir * wind * 2.2) * (t * t) * H;
    p.xz += bendXZ;

    // As the blade leans over, tilt its normal upward so lighting follows.
    float slope = length(aLean + uWindDir * wind * 2.2) * t;
    n = normalize(vec3(n.x, n.y + slope * 1.4, n.z));

    vColor = aColor;
    vY = t;
    vNormal = n;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aOffset + p, 1.0);
  }
`;

const GRASS_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 uSunDir;
  varying vec3 vColor;
  varying float vY;
  varying vec3 vNormal;

  void main() {
    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;         // light both sides of the blade

    float ndl = max(dot(N, uSunDir), 0.0);
    float wrap = ndl * 0.55 + 0.45;      // soft wrap lighting
    // Translucency: sun glowing through the blade toward the camera.
    float trans = pow(max(dot(-N, uSunDir), 0.0), 2.0) * 0.5;
    // Root-to-tip occlusion.
    float ao = mix(0.32, 1.0, vY * vY);

    vec3 light = uAmbient + uSunColor * wrap + uSunColor * trans;
    vec3 c = vColor * light * ao;
    c += vColor * pow(vY, 4.0) * 0.18;   // tip sheen
    gl_FragColor = vec4(c, 1.0);
  }
`;
