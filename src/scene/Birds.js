import {
  BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial,
  SphereGeometry, DoubleSide,
} from 'three';
import { createRng, deriveSeed } from '../util/random.js';

// Distant, purpose-built bird silhouettes. Wings have a swept leading edge and
// tapered primaries; their metre-scale geometry is independent of tree assets.
function wingGeometry() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    0.05, 0, -0.12, 0.38, 0.025, -0.03, 0.79, 0, 0.20,
    0.05, 0, -0.12, 0.79, 0, 0.20, 0.61, -0.01, 0.20,
    0.05, 0, -0.12, 0.61, -0.01, 0.20, 0.38, -0.015, 0.17,
    0.05, 0, -0.12, 0.38, -0.015, 0.17, 0.06, 0, 0.15,
  ], 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function birdFlightAt(time, bird, out = {}) {
  const angle = time * bird.rate + bird.phase;
  out.x = bird.x + Math.cos(angle) * bird.radius;
  out.z = bird.z + Math.sin(angle) * bird.radius * 0.65;
  out.y = bird.altitude + Math.sin(angle * 2 + bird.phase) * 2.5;
  // Local forward is -Z; yaw follows the ellipse tangent, with a gentle bank.
  out.yaw = Math.atan2(Math.sin(angle), -Math.cos(angle) * 0.65);
  out.bank = -0.16 + Math.sin(angle * 2) * 0.055;
  const cycle = time * 0.18 + bird.phase;
  const envelope = Math.max(0, Math.sin(cycle)) ** 6;
  out.flap = Math.sin(time * 9 + bird.phase) * envelope * 0.50;
  return out;
}

export class Birds {
  constructor({ course, terrain, environment }) {
    this.group = new Group();
    this.group.name = 'ambient-birds';
    this.environment = environment;
    const rng = createRng(deriveSeed(course.environmentSeed, 'ambient-birds'));
    const { minX, maxX, minZ, maxZ } = course.bounds;
    const coastal = course.biome === 'temperate-maritime';
    const bodyGeometry = new SphereGeometry(1, 10, 6);
    const wing = wingGeometry();
    const material = new MeshStandardMaterial({
      color: coastal ? 0xb9c0bd : 0x393b35, roughness: 0.92, side: DoubleSide,
    });
    this.birds = Array.from({ length: 5 }, (_, index) => {
      const root = new Group();
      const body = new Mesh(bodyGeometry, material);
      body.scale.set(0.075, 0.08, 0.28);
      const left = new Mesh(wing, material);
      const right = new Mesh(wing, material);
      right.scale.x = -1;
      root.add(body, left, right);
      root.scale.setScalar(coastal ? 0.9 : 0.7);
      this.group.add(root);
      const x = minX + (maxX - minX) * (0.15 + rng() * 0.70);
      const z = minZ + (maxZ - minZ) * (0.15 + rng() * 0.55);
      const radius = 24 + rng() * 22;
      // Sample the full orbit's terrain so even steep course slopes stay below it.
      let ground = -Infinity;
      for (let i = 0; i < 24; i++) {
        const a = i / 24 * Math.PI * 2;
        ground = Math.max(ground, terrain.heightAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius * 0.65));
      }
      return { root, left, right, x, z, radius,
        altitude: ground + 24 + index * 4, phase: rng() * Math.PI * 2,
        rate: (5 + rng() * 2) / radius, pose: {},
      };
    });
    this.update();
  }

  update() {
    const time = this.environment.time.value;
    for (const bird of this.birds) {
      const pose = birdFlightAt(time, bird, bird.pose);
      bird.root.position.set(pose.x, pose.y, pose.z);
      bird.root.rotation.set(0, pose.yaw, pose.bank, 'YXZ');
      bird.left.rotation.z = 0.10 + pose.flap;
      bird.right.rotation.z = -0.10 - pose.flap;
    }
  }
}
