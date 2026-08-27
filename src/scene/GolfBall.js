import {
  Mesh, MeshPhysicalNodeMaterial, BufferGeometry, Vector2, TextureLoader, ClampToEdgeWrapping,
  MathUtils,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ballPresentationScale } from './BallPresentation.js';

const _tex = new TextureLoader();
const _loader = new GLTFLoader();

const NORMAL_MAP_URL = '/assets/ball/golfball_nor.png';
const GLB_URL = '/assets/ball/golfball.glb';
let _normalAsset = null;
let _geometryAssetPromise = null;
const _drawingBufferSize = new Vector2();

// ---------------------------------------------------------------------------
// Golf ball mesh (WebGPU / TSL via MeshPhysicalNodeMaterial).
//
// Hero object: the camera gets to ~5 cm from this thing at address, so it is
// the one surface in the scene that has to survive a genuine macro shot.
//
// Two layers make it read as a real ball rather than a white sphere:
//
//  1. DIMPLES from a 2048^2 tangent-space normal map (public/assets/ball/),
//     extracted from a BlenderKit golf-ball asset by scripts/extract_golfball.py.
//     The map is laid out over SIX CUBE-PROJECTED UV ISLANDS, which is why we
//     also ship the asset's mesh instead of using SphereGeometry: an equirect
//     sphere UV would pinch the dimples to nothing at the poles and pull a
//     visible seam down one side. The GLB is a true sphere (a rounded cube run
//     through subsurf + a cast-to-sphere) with exactly radial vertex normals,
//     so all the shape you see is the normal map doing its job.
//
//  2. A CLEARCOAT over a slightly rough urethane base. A golf ball cover is
//     ionomer/urethane under a thin clear finish: the base gives the soft, wide
//     falloff across the body, the coat gives the small hard sun glint. Both
//     layers get the dimple normal (the coat is sprayed *onto* the dimples, so
//     leaving the coat geometric would put a perfectly smooth highlight on a
//     dimpled body — the single biggest "plastic" tell).
//
// No brand marks: the source asset's colour map is a Titleist/Pro V1 sheet and
// is deliberately not shipped. The albedo here is a flat optic white.
// ---------------------------------------------------------------------------

function loadNormalMap() {
  if (_normalAsset) return _normalAsset;
  // flipY=false because the GLB carries glTF-convention UVs (origin top-left);
  // TextureLoader would otherwise upload the map upside down and invert every
  // dimple. Clamped, not repeated — the six islands must not wrap into each other.
  let nor;
  const ready = new Promise((resolve, reject) => {
    nor = _tex.load(
      NORMAL_MAP_URL,
      () => resolve(nor),
      undefined,
      (error) => reject(error || new Error(`Ball normal map failed to load: ${NORMAL_MAP_URL}`)),
    );
  });
  nor.flipY = false;
  nor.wrapS = nor.wrapT = ClampToEdgeWrapping;
  nor.anisotropy = 8;
  nor.name = 'golf-ball-dimple-normal';
  nor.userData.sharedWebGPUAsset = true;
  _normalAsset = { texture: nor, ready };
  return _normalAsset;
}

function buildMaterial(nor) {
  return new MeshPhysicalNodeMaterial({
    color: 0xf0f1ee,                       // ~0.87 linear: optic white, faintly cool
    roughness: 0.32, metalness: 0.0,
    normalMap: nor, normalScale: new Vector2(1.0, 1.0),
    clearcoat: 1.0, clearcoatRoughness: 0.07,
    clearcoatNormalMap: nor, clearcoatNormalScale: new Vector2(1.0, 1.0),
    envMapIntensity: 1.0,
  });
}

// Resolve the required baked GLB geometry. `isDisposed` is polled after the async
// load resolves so a scene teardown cannot attach resources to an obsolete course.
function loadSharedBallGeometry() {
  if (_geometryAssetPromise) return _geometryAssetPromise;
  _geometryAssetPromise = _loader.loadAsync(GLB_URL).then((gltf) => {
    let geo = null;
    gltf.scene.traverse((o) => { if (o.isMesh && !geo) geo = o.geometry; });
    if (!geo) throw new Error(`Ball GLB contains no mesh geometry: ${GLB_URL}`);
    geo.computeTangents();
    geo.userData.sharedWebGPUAsset = true;
    return geo;
  });
  return _geometryAssetPromise;
}

async function loadBallGeometry(mesh, isDisposed) {
  const geo = await loadSharedBallGeometry();
  if (isDisposed()) return;
  // three's node path reads tangents from an `attribute('tangent')`; without
  // one it falls back to a screen-space derivative frame, which is noisy at
  // grazing angles. The GLB is indexed with position/normal/uv, so we can
  // build a real per-vertex frame that matches how the map was baked.
  const old = mesh.geometry;
  mesh.geometry = geo;
  old.dispose();
}

// Build a stable scene object synchronously, but keep it non-renderable until every
// required ball asset is ready. There is no substitute sphere or flat-normal path.
//
// `isDisposed()` should report whether the owning scene has since been torn
// down, so a load that resolves after teardown is a no-op.
export function createGolfBallMesh({ isDisposed = () => false } = {}) {
  const normal = loadNormalMap();
  const mat = buildMaterial(normal.texture);
  const mesh = new Mesh(new BufferGeometry(), mat);
  mesh.visible = false;
  mesh.castShadow = true;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    void scene;
    // Shadow cameras render the regulation silhouette. The visibility assist is
    // exclusively a presentation-camera treatment and must never enlarge the
    // ball's physical-looking cast shadow.
    if (!camera.isPerspectiveCamera) {
      mesh.scale.setScalar(1);
      return;
    }
    renderer.getDrawingBufferSize(_drawingBufferSize);
    const scale = ballPresentationScale({
      distance: camera.position.distanceTo(mesh.position),
      verticalFovRadians: MathUtils.degToRad(camera.fov || 40),
      viewportHeight: _drawingBufferSize.y,
    });
    mesh.scale.setScalar(scale);
  };
  mesh.userData.assetsReady = Promise.all([
    normal.ready,
    loadBallGeometry(mesh, isDisposed),
  ]).then(() => {
    if (!isDisposed()) mesh.visible = true;
    return mesh;
  });
  return mesh;
}
