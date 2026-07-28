import { BufferGeometry, BufferAttribute, Line, LineBasicMaterial, Color } from 'three';

// The broadcast "shot tracer" ribbon that draws the ball's path as it flies.
// A single preallocated line whose draw range grows; trivial CPU cost.
export class Tracer {
  constructor(scene, max = 4000) {
    this.max = max;
    this.positions = new Float32Array(max * 3);
    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geo.setDrawRange(0, 0);
    this.mat = new LineBasicMaterial({ color: new Color(0xffd34d), transparent: true, opacity: 0.9 });
    this.line = new Line(this.geo, this.mat);
    this.line.frustumCulled = false;
    scene.add(this.line);
    this.count = 0;
  }

  reset() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
    this.mat.opacity = 0.9;
  }

  push(p) {
    if (this.count >= this.max) return;
    const i = this.count * 3;
    this.positions[i] = p.x;
    this.positions[i + 1] = p.y;
    this.positions[i + 2] = p.z;
    this.count++;
    this.geo.setDrawRange(0, this.count);
    this.geo.attributes.position.needsUpdate = true;
  }

  fade(dt) {
    if (this.mat.opacity > 0) this.mat.opacity = Math.max(0, this.mat.opacity - dt * 0.15);
  }
}
