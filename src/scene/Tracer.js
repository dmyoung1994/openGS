import {
  BufferGeometry, BufferAttribute, Mesh, MeshBasicNodeMaterial,
  AdditiveBlending, Vector3,
} from 'three';
import {
  attribute, positionLocal, cameraPosition, uniform, varying, vec3, float, smoothstep, mix,
} from 'three/tsl';

// The broadcast "shot tracer": a glowing camera-facing ribbon that draws the
// ball's path as it flies. Rebuilt for WebGPU as a TSL NodeMaterial. Two verts
// per centerline point are pushed apart along a billboard perpendicular
// (cross(pathDir, viewDir)) in a positionNode, so the ribbon always faces the
// camera. Additive blending + a hot white head cooling to an orange tail give it
// the ProTracer glow; bloom in the post pipeline makes it sing.
export class Tracer {
  constructor(scene, max = 4000) {
    this.max = max;
    this.count = 0;
    this._prev = new Vector3();

    this.positions = new Float32Array(max * 2 * 3);
    this.dirs = new Float32Array(max * 2 * 3);
    const sides = new Float32Array(max * 2);
    const index = new Float32Array(max * 2);
    for (let i = 0; i < max; i++) {
      sides[i * 2] = -1; sides[i * 2 + 1] = 1;
      index[i * 2] = i; index[i * 2 + 1] = i;
    }
    const idx = new Uint32Array((max - 1) * 6);
    for (let s = 0; s < max - 1; s++) {
      const a = s * 2, b = s * 2 + 1, c = s * 2 + 2, d = s * 2 + 3, o = s * 6;
      idx[o] = a; idx[o + 1] = b; idx[o + 2] = c;
      idx[o + 3] = c; idx[o + 4] = b; idx[o + 5] = d;
    }

    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geo.setAttribute('aDir', new BufferAttribute(this.dirs, 3));
    this.geo.setAttribute('aSide', new BufferAttribute(sides, 1));
    this.geo.setAttribute('aIndex', new BufferAttribute(index, 1));
    this.geo.setIndex(new BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);

    this.uCount = uniform(1);
    this.uOpacity = uniform(1);
    this.uRadius = uniform(0.16);   // ribbon half-width, meters

    this.line = new Mesh(this.geo, this._material());
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    scene.add(this.line);
  }

  _material() {
    const center = positionLocal;                 // centerline point (world)
    const dir = attribute('aDir', 'vec3');
    const sideV = attribute('aSide', 'float');
    const idx = attribute('aIndex', 'float');
    const tN = idx.div(this.uCount.max(1.0));     // 0 tail -> 1 head

    const toCam = cameraPosition.sub(center);
    const perp = dir.normalize().cross(toCam.normalize()).normalize();
    // Taper toward the tail; grow a little with distance so far tracer stays
    // visible despite perspective shrink.
    const taper = float(0.35).add(tN.mul(0.65));
    const distScale = float(1.0).add(toCam.length().mul(0.01)).min(3.0);
    const off = perp.mul(sideV).mul(this.uRadius.mul(taper).mul(distScale));
    const pos = center.add(off);

    const vSide = varying(sideV);
    const vT = varying(tN);
    const edge = float(1.0).sub(vSide.abs());     // 1 core, 0 at ribbon edges

    // Head (near ball) burns white, cooling to orange down the tail.
    let col = mix(vec3(1.0, 0.54, 0.17), vec3(1.0, 0.88, 0.30), smoothstep(0.0, 0.5, vT));
    col = mix(col, vec3(1.0, 1.0, 1.0), smoothstep(0.55, 1.0, vT));
    col = col.add(vec3(1.0, 1.0, 1.0).mul(edge.pow(5.0).mul(0.8)));

    const alpha = smoothstep(0.0, 0.9, edge)
      .mul(smoothstep(0.0, 0.12, vT))
      .mul(this.uOpacity);

    const mat = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    mat.positionNode = pos;
    mat.colorNode = col;
    mat.opacityNode = alpha;
    return mat;
  }

  reset() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
    this.uOpacity.value = 1.0;
  }

  push(p) {
    if (this.count >= this.max) return;
    const i = this.count;
    const v0 = i * 6, v1 = v0 + 3;
    this.positions[v0] = p.x; this.positions[v0 + 1] = p.y; this.positions[v0 + 2] = p.z;
    this.positions[v1] = p.x; this.positions[v1 + 1] = p.y; this.positions[v1 + 2] = p.z;
    if (i > 0) {
      const dx = p.x - this._prev.x, dy = p.y - this._prev.y, dz = p.z - this._prev.z;
      const pv0 = (i - 1) * 6, pv1 = pv0 + 3;
      for (const b of [v0, v1, pv0, pv1]) {
        this.dirs[b] = dx; this.dirs[b + 1] = dy; this.dirs[b + 2] = dz;
      }
    }
    this._prev.set(p.x, p.y, p.z);
    this.count++;
    this.uCount.value = Math.max(1, this.count - 1);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aDir.needsUpdate = true;
    if (this.count >= 2) this.geo.setDrawRange(0, (this.count - 1) * 6);
  }

  fade(dt) {
    if (this.uOpacity.value > 0) this.uOpacity.value = Math.max(0, this.uOpacity.value - dt * 0.14);
  }
}
