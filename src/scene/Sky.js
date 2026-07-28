import {
  Mesh, SphereGeometry, BackSide, ShaderMaterial, Vector3, Color,
} from 'three';

// A gradient sky dome with a soft sun glow. Cheap (one big inward sphere, all
// in the fragment shader) and gives the scene an honest outdoor light wrap.
export class Sky {
  constructor(sunDir = new Vector3(-0.5, 0.85, 0.3).normalize()) {
    this.uniforms = {
      uSunDir: { value: sunDir.clone().normalize() },
      uTop: { value: new Color(0x2a6bb0) },
      uHorizon: { value: new Color(0xcfe0ec) },
      uSun: { value: new Color(0xfff4d6) },
    };
    const geo = new SphereGeometry(2000, 32, 16);
    const mat = new ShaderMaterial({
      uniforms: this.uniforms,
      side: BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 uSunDir, uTop, uHorizon, uSun;
        void main(){
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 sky = mix(uHorizon, uTop, pow(h, 0.8));
          float s = max(dot(normalize(vDir), uSunDir), 0.0);
          vec3 glow = uSun * (pow(s, 8.0) * 0.4 + pow(s, 200.0) * 1.4);
          gl_FragColor = vec4(sky + glow, 1.0);
        }
      `,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
  }
}
