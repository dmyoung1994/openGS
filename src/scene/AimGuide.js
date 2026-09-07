import {
  BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial,
} from 'three';

const HEIGHT_OFFSET = 0.045;
const LINE_WIDTH = 0.055;
const DASH_LENGTH = 0.65;
const DASH_GAP = 0.70;
const TARGET_RADIUS = 0.70;

export function buildAimGuidePositions(origin, target, heightAt) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1 || typeof heightAt !== 'function') return new Float32Array();
  const forwardX = dx / distance;
  const forwardZ = dz / distance;
  const rightX = -forwardZ * LINE_WIDTH * .5;
  const rightZ = forwardX * LINE_WIDTH * .5;
  const positions = [];
  const point = (along, side) => {
    const x = origin.x + forwardX * along + rightX * side;
    const z = origin.z + forwardZ * along + rightZ * side;
    return [x, heightAt(x, z) + HEIGHT_OFFSET, z];
  };
  const pushQuad = (a, b, c, d) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);

  for (let start = .8; start < distance - .4; start += DASH_LENGTH + DASH_GAP) {
    const end = Math.min(start + DASH_LENGTH, distance - .4);
    const sections = Math.max(1, Math.ceil((end - start) / 1.1));
    for (let section = 0; section < sections; section += 1) {
      const a = start + (end - start) * section / sections;
      const b = start + (end - start) * (section + 1) / sections;
      pushQuad(point(a, -1), point(a, 1), point(b, 1), point(b, -1));
    }
  }

  const ringSegments = 32;
  const ringWidth = LINE_WIDTH * 1.25;
  for (let index = 0; index < ringSegments; index += 1) {
    const a = index * Math.PI * 2 / ringSegments;
    const b = (index + 1) * Math.PI * 2 / ringSegments;
    const ringPoint = (angle, radius) => {
      const x = target.x + Math.cos(angle) * radius;
      const z = target.z + Math.sin(angle) * radius;
      return [x, heightAt(x, z) + HEIGHT_OFFSET, z];
    };
    pushQuad(
      ringPoint(a, TARGET_RADIUS - ringWidth), ringPoint(a, TARGET_RADIUS + ringWidth),
      ringPoint(b, TARGET_RADIUS + ringWidth), ringPoint(b, TARGET_RADIUS - ringWidth),
    );
  }
  return new Float32Array(positions);
}

export class AimGuide {
  constructor(scene) {
    this._terrain = null;
    this._signature = '';
    this.geometry = new BufferGeometry();
    this.material = new MeshBasicMaterial({
      color: 0xbad58e,
      transparent: true,
      opacity: .72,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'terrain-aim-guide';
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  update({ terrain, origin, target, visible }) {
    this.mesh.visible = Boolean(visible && terrain && origin && target);
    if (!this.mesh.visible) return;
    const signature = `${origin.x},${origin.z}:${target.x},${target.z}`;
    if (terrain === this._terrain && signature === this._signature) return;
    const positions = buildAimGuidePositions(origin, target, terrain.heightAt.bind(terrain));
    const next = new BufferGeometry();
    next.setAttribute('position', new BufferAttribute(positions, 3));
    this.mesh.geometry = next;
    this.geometry.dispose();
    this.geometry = next;
    this._terrain = terrain;
    this._signature = signature;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
