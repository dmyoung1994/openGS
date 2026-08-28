import {
  BackSide, CircleGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
} from 'three';

// The Rules of Golf specify a 108 mm diameter and at least 101.6 mm depth. The
// creator uses the regulation opening and a slightly deeper visible cavity so the
// white liner can sit below the soil/turf edge instead of reading as a painted dot.
export const GOLF_HOLE_DIAMETER_M = 0.108;
export const GOLF_HOLE_RADIUS_M = GOLF_HOLE_DIAMETER_M * 0.5;
export const GOLF_HOLE_MIN_DEPTH_M = 0.1016;
export const CREATOR_CUP_DEPTH_M = 0.12;

export function createCreatorCup({ x = 0, z = 0, surfaceY = 0 } = {}) {
  if (![x, z, surfaceY].every(Number.isFinite)) {
    throw new TypeError('Creator cup position must be finite.');
  }

  const group = new Group();
  group.name = 'creator-center-pin-cup';
  group.position.set(x, surfaceY, z);

  // Leave the upper 30 mm as dark exposed rootzone. The actual terrain aperture
  // owns the lip silhouette; this inward-facing wall supplies depth immediately
  // below it without adding a raised ring above the putting surface.
  const soilDepth = 0.03;
  const soilMaterial = new MeshStandardMaterial({
    color: 0x34281d,
    roughness: 0.98,
    metalness: 0,
    side: BackSide,
  });
  soilMaterial.name = 'creator-cup-exposed-rootzone';
  const soilWall = new Mesh(
    new CylinderGeometry(GOLF_HOLE_RADIUS_M, GOLF_HOLE_RADIUS_M, soilDepth, 48, 1, true),
    soilMaterial,
  );
  soilWall.name = 'creator-cup-rootzone-wall';
  soilWall.position.y = -soilDepth * 0.5;
  soilWall.receiveShadow = true;
  group.add(soilWall);

  const linerDepth = CREATOR_CUP_DEPTH_M - soilDepth;
  const linerMaterial = new MeshStandardMaterial({
    color: 0xe7e4d9,
    roughness: 0.78,
    metalness: 0,
    side: BackSide,
  });
  linerMaterial.name = 'creator-cup-white-liner';
  const linerWall = new Mesh(
    new CylinderGeometry(GOLF_HOLE_RADIUS_M * 0.965, GOLF_HOLE_RADIUS_M * 0.965, linerDepth, 48, 1, true),
    linerMaterial,
  );
  linerWall.name = 'creator-cup-liner-wall';
  linerWall.position.y = -soilDepth - linerDepth * 0.5;
  linerWall.receiveShadow = true;
  group.add(linerWall);

  const bottomMaterial = new MeshStandardMaterial({
    color: 0x171b17,
    roughness: 1,
    metalness: 0,
  });
  bottomMaterial.name = 'creator-cup-shadowed-bottom';
  const bottom = new Mesh(new CircleGeometry(GOLF_HOLE_RADIUS_M * 0.94, 48), bottomMaterial);
  bottom.name = 'creator-cup-bottom';
  bottom.rotation.x = -Math.PI * 0.5;
  bottom.position.y = -CREATOR_CUP_DEPTH_M;
  bottom.receiveShadow = true;
  group.add(bottom);

  group.userData.creatorCup = true;
  group.userData.diameterM = GOLF_HOLE_DIAMETER_M;
  group.userData.depthM = CREATOR_CUP_DEPTH_M;
  group.userData.geometryCutoutRequired = true;
  return group;
}
