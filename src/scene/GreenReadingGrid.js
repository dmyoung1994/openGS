import { BufferGeometry, Float32BufferAttribute, Group, LineSegments, Vector3 } from 'three';
import { LineBasicNodeMaterial } from 'three/webgpu';
import { attribute, uniform, smoothstep, mix, color } from 'three/tsl';

// Display scale only: a 4% fall travels 0.48 m/s along its downhill grid axis.
export const GRID_FLOW_SCALE = 12;

export function createGreenReadingGrid(terrain, green) {
  const group = new Group();
  group.name = 'green-reading-grid';
  const positions = [], flow = [], slopes = [];
  const boundary = green.shape ?? [
    { x: green.x - green.r, z: green.z - green.r },
    { x: green.x + green.r, z: green.z + green.r },
  ];
  const minX = Math.floor(Math.min(...boundary.map(p => p.x)) - 1);
  const maxX = Math.ceil(Math.max(...boundary.map(p => p.x)) + 1);
  const minZ = Math.floor(Math.min(...boundary.map(p => p.z)) - 1);
  const maxZ = Math.ceil(Math.max(...boundary.map(p => p.z)) + 1);
  const onGreen = (x, z) => terrain.surfaceAt(x, z) === 'green';
  const normal = new Vector3();
  const vertex = (x, z, axis, origin, speed) => {
    terrain.normalAt(x, z, normal);
    const ny = Math.max(normal.y, 0.001);
    positions.push(x, terrain.heightAt(x, z) + 0.025, z);
    flow.push((axis === 'x' ? x : z) - origin, speed);
    slopes.push(Math.hypot(normal.x, normal.z) / ny);
  };
  const segment = (x, z, endX, endZ, axis) => {
    if (!onGreen(x, z) || !onGreen(endX, endZ) || !onGreen((x + endX) / 2, (z + endZ) / 2)) return;
    const origin = Math.floor(axis === 'x' ? x : z);
    terrain.normalAt(axis === 'x' ? origin + 0.5 : x, axis === 'z' ? origin + 0.5 : z, normal);
    const speed = normal[axis] / Math.max(normal.y, 0.001) * GRID_FLOW_SCALE;
    vertex(x, z, axis, origin, speed); vertex(endX, endZ, axis, origin, speed);
  };
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z < maxZ; z += 0.125) segment(x, z, x, z + 0.125, 'z');
  }
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x < maxX; x += 0.125) segment(x, z, x + 0.125, z, 'x');
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('gridFlow', new Float32BufferAttribute(flow, 2));
  geometry.setAttribute('gridSlope', new Float32BufferAttribute(slopes, 1));
  const time = uniform(0);
  const motion = attribute('gridFlow', 'vec2');
  const slope = attribute('gridSlope', 'float');
  // Pulses live on the grid lines. Each axis carries the local downhill component;
  // a level axis remains still. Colour interpolates continuously across 0–6%.
  const phase = motion.x.sub(time.mul(motion.y)).fract();
  const pulse = smoothstep(0.05, 0.16, phase).mul(smoothstep(0.32, 0.48, phase).oneMinus());
  const moving = smoothstep(0, 0.002, motion.y.abs());
  const material = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  material.colorNode = mix(
    mix(color(0x8ce9da), color(0xffdc81), slope.div(0.03).clamp()),
    color(0xff947a), slope.sub(0.03).div(0.03).clamp(),
  );
  material.opacityNode = mix(0.35, pulse.mul(0.75).add(0.18), moving);
  group.add(new LineSegments(geometry, material));
  group.update = elapsed => { time.value = elapsed; };
  return group;
}
