import {
  BasicEnvironmentNode, InstancedBufferGeometry, BufferAttribute, Mesh, MeshPhongNodeMaterial,
  DataTexture, RedFormat, UnsignedByteType, NearestFilter,
  Color, DoubleSide, IndirectStorageBufferAttribute, Matrix4, StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector2, Vector3,
} from 'three/webgpu';
import {
  Fn, If, atomicAdd, atomicLoad, atomicStore, float, int, instanceIndex, ivec2, mrt, mx_noise_float,
  mix, positionGeometry, smoothstep, storage, textureLevel, textureLoad, transformNormalToView,
  uniform, uvec2, uvec3, uint, vec2, vec3, vec4, varying, workgroupArray,
  workgroupBarrier, workgroupId, localId,
} from 'three/tsl';
import { disposeComputeNodes, disposeWebGPUAttributes } from '../scene/WebGPUResourceDisposal.js';
import { turfBladeBase } from './turfColor.js';

// SceneManager supplies the shared PMREM through the builder rather than setting a
// material-local envMap. Keep Phong on that same real environment path so this
// cheaper foliage model does not silently lose the course's shared daylight.
class SharedEnvironmentGrassPhongMaterial extends MeshPhongNodeMaterial {
  setupEnvironment( builder ) {
    const explicitEnvironment = super.setupEnvironment( builder );
    if ( explicitEnvironment ) return explicitEnvironment;
    return builder.environmentNode ? new BasicEnvironmentNode( builder.environmentNode ) : null;
  }
}

// WebGPU-only grass renderer.
//
// There is deliberately one runtime path: classify tiles on the GPU, compact live
// blades in GPU workgroups, and submit one indexed indirect draw.  Keeping an old
// tile-mesh path as a "safe" alternative would make every visual or temporal fix
// two renderers deep and would hide failures on the only renderer we ship.
//
// The compact record is intentionally immutable/stable in world space.  Its output
// slot is not stable (workgroups complete in arbitrary order), but `stableId` is the
// world-cell candidate id and the current/previous vertex functions derive the exact
// same blade from that record.  This is what keeps TRAA velocities correct without
// CPU readback or a CPU-side visibility list.
const TILE_SIZE = 8;
const GRID = 192;
const CELL = TILE_SIZE / GRID;
const CANDIDATE_JITTER_MARGIN = CELL * 0.45;
const CANDIDATES_PER_TILE = GRID * GRID;
const WORKGROUP = 256;
const GROUPS_PER_TILE = CANDIDATES_PER_TILE / WORKGROUP;
const BLADE_SEGMENTS = 3;
// Two crossed ribbons per instance keep the rough canopy volumetric at oblique
// angles without adding a second draw. Each ribbon still uses the same indexed
// tapered blade profile and the same stable record/velocity path.
const BLADE_INDEX_COUNT = BLADE_SEGMENTS * 12;

// 786432 records * 52 bytes = 39 MiB. This is a fixed GPU reservation, not a
// per-frame allocation. The tile frustum classifier keeps normal views well below
// it. Overflow is never clamped: the GPU zeros the indirect instance count and sets
// a diagnostic word, making the fault visibly loud rather than silently dropping a
// nondeterministic suffix of grass.
const MAX_VISIBLE_BLADES = 786_432;

const BLADE_H = { rough: 0.20, deepRough: 0.32 };
const SURFACE_TRANSITION_M = 1.5;
// Rough is rendered as a dense stand of broad leaf ribbons. These are deliberately
// wider than the former 4.2–11 mm slivers: perceived coverage is not allowed to be
// "optimized" by making blades thinner. The width remains in a plausible 7.5–18 mm
// mm visual ribbon range for this instanced cross-section, while height/lean retain
// the authored long-grass variation below.
const ROUGH_BLADE_WIDTH_MIN_M = 0.0075;
const ROUGH_BLADE_WIDTH_MAX_M = 0.018;
// Preserve the pre-optimization visual mass. The 192x192 candidate field and
// crossed ribbons need a high acceptance floor or oblique views expose the ground
// between blades even though the top-down count still looks dense.
const ROUGH_COVERAGE_MIN = 0.64;
const ROUGH_COVERAGE_MAX = 0.88;
const ROUGH_COLONY_FLOOR = 0.88;
// The already-sampled R8 grass mask carries one exact growable-surface bit and a
// seven-bit dense-canopy field. A single crown contributes at most 63/127: enough
// for a restrained ~26% reduction only at its centre. Smooth overlap from multiple
// authored scaled crowns drives the strong 38–45% forest response. The 55% floor
// means even the densest overlap remains living understory rather than a cutout.
const GRASS_GROWABLE_BIT = 128;
const CANOPY_MASK_MAX = 127;
const CANOPY_CROWN_WEIGHT = 63;
const CANOPY_KERNEL_POWER = 0.5;
const CANOPY_DENSE_START = 0.05;
const CANOPY_DENSE_END = 0.85;
const CANOPY_DENSITY_FLOOR = 0.55;
// One continuous density curve replaces discrete "half/quarter" LOD shelves. Near
// blades use the full candidate field; a world-stable random threshold then retires
// individual blades gradually until the rough texture owns the distant appearance.
const DENSITY_NEAR_RADIUS = 0.18;
const DENSITY_FAR_RADIUS = 0.99;
const DENSITY_CURVE_POWER = 8.0;
const DENSITY_FEATHER = 0.05;
// `keepProb` is non-positive after roughly 0.44 * radius with the curve above;
// those candidates can never pass the stable hash acceptance test.  Classify tiles
// against that real compute horizon (plus the tile's circumradius) so the compact
// pass does not launch full 192² workgroups for tiles that can only produce zero
// records.  The margin is derived from the candidate footprint, not a camera LOD,
// so this cannot remove a blade that the density curve could keep.
const DENSITY_ACTIVE_RADIUS = 0.45;
const TILE_CIRCUMRADIUS = Math.SQRT2 * TILE_SIZE * 0.5 + CELL;
// The dense, view-independent field above remains untouched. A second term in the
// same stochastic acceptance curve carries a small population of those exact same
// world-cell blades into the complete perception-sensitive camera footprint. The
// accepted tail now reaches 96.8 m down-view and 64.5 m laterally at high tier, so
// low cameras cannot expose the former 31.8 m geometry cutoff. Close density, rooted
// width, candidate identity, draw count, and GPU capacity are unchanged.
const FAR_TIER_START_RADIUS = 0.36;
const FAR_TIER_TERMINAL_RADIUS = 2.25;
const FAR_TIER_LATERAL_SCALE = 1.50;
// The former 9% tail exposed a visibly bare band immediately after the dense base
// field ended around 19 m. A 22% world-cell population keeps the golfer-visible
// midfield continuous; quarter-rate far sampling still caps actual candidate work
// at one lane per 2x2 block and the quadratic tail retires it toward the horizon.
const FAR_TIER_PEAK_KEEP = 0.22;
const FAR_TIER_FORWARD_FEATHER = 0.08;
// Far-only tiles are beyond the complete base field, where a full 192x192
// candidate evaluation is substantial sub-pixel overdraw. Sample one stable lane
// from each 2x2 world-cell block and compensate the stochastic keep probability.
// This preserves expected coverage and the authored horizon while avoiding 75% of
// the hashes, terrain reads, ecological noise, wind, and record preparation there.
const FAR_ONLY_CANDIDATE_STRIDE = 4;
const DENSITY_TARGET_MAX_SCALE = 1.24 * ROUGH_COVERAGE_MAX;
// Active-tile records keep their existing far-only flag in bit zero, carry an
// upward-rounded conservative density ceiling in the next byte, and retain the
// immutable terrain tile index above it. Eight bits leave a maximum <1/255 guard
// slack while avoiding another GPU buffer or pass.
const ACTIVE_TILE_BOUND_BITS = 8;
const ACTIVE_TILE_RECORD_SHIFT = ACTIVE_TILE_BOUND_BITS + 1;
const ACTIVE_TILE_BOUND_MAX = ( 1 << ACTIVE_TILE_BOUND_BITS ) - 1;
const MAX_WIDTH_RAMP = 2.2;
// Avoid one synthetic neon-green population. Species/age grading below supplies
// the hue spread; this keeps the shared turf pigment vivid without clipping it.

// Four normalized scalars in one existing u32 record lane. Wind uses [-16,16] m/s;
// camera LOD uses [fade, width/6.6] pairs. The maximum geometric quantization is
// below 1.1 mm on a 32 cm blade and does not alter candidate identity or density.
function packUnorm4x8( value ) {
  const byte = ( component ) => uint( component.clamp( 0.0, 1.0 ).mul( 255.0 ).add( 0.5 ) );
  return byte( value.x )
    .bitOr( byte( value.y ).shiftLeft( uint( 8 ) ) )
    .bitOr( byte( value.z ).shiftLeft( uint( 16 ) ) )
    .bitOr( byte( value.w ).shiftLeft( uint( 24 ) ) );
}

function unpackUnorm4x8( value ) {
  return vec4(
    float( value.bitAnd( uint( 255 ) ) ),
    float( value.shiftRight( uint( 8 ) ).bitAnd( uint( 255 ) ) ),
    float( value.shiftRight( uint( 16 ) ).bitAnd( uint( 255 ) ) ),
    float( value.shiftRight( uint( 24 ) ).bitAnd( uint( 255 ) ) ),
  ).div( 255.0 );
}

function bladeHeight( name ) { return BLADE_H[ name ] || 0; }

// Bake a camera-independent overlap field directly into the low seven bits of the
// existing grass byte. Splatting into that final byte avoids another texture, CPU
// field, GPU allocation, or shader fetch. The second remap is monotone and bounded;
// world-space continuity comes from smooth crown kernels and irregular authored
// overlap, not camera/ball distance or a periodic procedural mask.
export function bakeDenseCanopyMask( data, nx, nz, { minX, minZ, spacing }, placements = [] ) {
  if ( !( data instanceof Uint8Array ) || data.length !== nx * nz ) {
    throw new Error( 'Dense canopy bake requires the existing one-byte-per-texel grass field.' );
  }
  for ( const placement of placements ) {
    const radius = Number( placement.canopyRadius );
    if ( !Number.isFinite( placement.x ) || !Number.isFinite( placement.z )
      || !Number.isFinite( radius ) || radius <= 0 ) continue;
    const ix0 = Math.max( 0, Math.floor( ( placement.x - radius - minX ) / spacing ) );
    const ix1 = Math.min( nx - 1, Math.ceil( ( placement.x + radius - minX ) / spacing ) );
    const iz0 = Math.max( 0, Math.floor( ( placement.z - radius - minZ ) / spacing ) );
    const iz1 = Math.min( nz - 1, Math.ceil( ( placement.z + radius - minZ ) / spacing ) );
    for ( let iz = iz0; iz <= iz1; iz ++ ) {
      const wz = minZ + iz * spacing;
      for ( let ix = ix0; ix <= ix1; ix ++ ) {
        const wx = minX + ix * spacing;
        const normalizedDistance = Math.hypot( wx - placement.x, wz - placement.z ) / radius;
        if ( normalizedDistance >= 1 ) continue;
        // Conifer shade/light interception remains meaningful across the crown
        // projection, not only at the trunk. The square-root shoulder broadens
        // the smooth response inside the exact catalog radius without extending
        // the footprint by a single texel beyond that authored crown.
        const inward = Math.pow( 1 - normalizedDistance, CANOPY_KERNEL_POWER );
        const smoothCrown = inward * inward * ( 3 - 2 * inward );
        const index = iz * nx + ix;
        // The strongest local crown owns suppression. Summing every overlap made
        // the denser 136-tree perimeter erase nearly half the same grass roots
        // repeatedly and exposed the terrain between otherwise dense blades.
        data[ index ] = Math.max( data[ index ],
          Math.round( smoothCrown * CANOPY_CROWN_WEIGHT ) );
      }
    }
  }
  for ( let index = 0; index < data.length; index ++ ) {
    const overlap = data[ index ] / CANOPY_MASK_MAX;
    const t = Math.max( 0, Math.min( 1,
      ( overlap - CANOPY_DENSE_START ) / ( CANOPY_DENSE_END - CANOPY_DENSE_START ) ) );
    data[ index ] = Math.round( t * t * ( 3 - 2 * t ) * CANOPY_MASK_MAX );
  }
  return data;
}

// One curve owns both stochastic thinning and the terminal fade. The shaped falloff
// keeps the near field full while moving most of the cost inward;
// at the far radius `keepProb` reaches -feather, so every candidate is exactly zero.
// The high-tier radius is authored by EnvironmentDeviceTier; the bounded compact
// buffer remains the hard safety limit rather than relying on a particular tier value.
function densityAtDistance( radius, distance ) {
  const progress = distance.sub( radius.mul( DENSITY_NEAR_RADIUS ) )
    .div( radius.mul( DENSITY_FAR_RADIUS - DENSITY_NEAR_RADIUS ) ).clamp( 0.0, 1.0 );
  // The exponent is exactly eight: an explicit squaring chain preserves the same
  // curve without lowering a general-purpose pow in current and previous vertices.
  const falloff = float( 1 ).sub( progress );
  const falloff2 = falloff.mul( falloff );
  const falloff4 = falloff2.mul( falloff2 );
  const keepProb = falloff4.mul( falloff4 )
    .mul( 1.08 + DENSITY_FEATHER ).sub( DENSITY_FEATHER );
  return { progress, keepProb };
}

// Sparse projected-error tail. `dx/dz` and the forward axis are camera-relative,
// but the candidate threshold remains the immutable world-cell hash, so translating
// or rotating the camera changes only LOD residency and never the blade layout.
// The quadratic terminal falloff is continuous and reaches exactly zero at 2.25R.
function farTierKeepAt( radius, dx, dz, cameraForward ) {
  const along = dx.mul( cameraForward.x ).add( dz.mul( cameraForward.y ) );
  const lateral = dx.mul( cameraForward.y ).sub( dz.mul( cameraForward.x ) );
  const scaledLateral = lateral.mul( FAR_TIER_LATERAL_SCALE );
  const footprintDistance = along.mul( along ).add( scaledLateral.mul( scaledLateral ) ).sqrt();
  const progress = footprintDistance.sub( radius.mul( FAR_TIER_START_RADIUS ) )
    .div( radius.mul( FAR_TIER_TERMINAL_RADIUS - FAR_TIER_START_RADIUS ) ).clamp( 0.0, 1.0 );
  const tail = float( 1 ).sub( progress );
  const forwardGate = smoothstep( 0.0, radius.mul( FAR_TIER_FORWARD_FEATHER ), along );
  return tail.mul( tail ).mul( FAR_TIER_PEAK_KEEP ).mul( forwardGate );
}

const BLADE_COLOR = {};
for ( const name of Object.keys( BLADE_H ) ) {
  BLADE_COLOR[ name ] = turfBladeBase( name, new Color() ).clone();
}

export class Grass {
  constructor( { terrain, camera, renderer, motionHistory, environment, canopyPlacements = [], tileSize = TILE_SIZE, gridPerTile = GRID, radius = 30 } ) {
    if ( tileSize !== TILE_SIZE || gridPerTile !== GRID ) {
      throw new Error( `Grass uses a fixed ${TILE_SIZE}m / ${GRID} GPU candidate layout; runtime variants are not supported.` );
    }
    if ( !renderer || !renderer.isWebGPURenderer ) {
      throw new Error( 'Grass requires the WebGPU renderer. There is no compatibility renderer.' );
    }
    if ( !motionHistory ) throw new Error( 'Grass requires SceneManager motionHistory for TRAA velocity.' );
    if ( !environment?.windAt || !environment?.time || !environment?.previousTime ) {
      throw new Error( 'Grass requires shared EnvironmentGpuBindings.' );
    }

    this.terrain = terrain;
    this.camera = camera;
    this.renderer = renderer;
    this.motionHistory = motionHistory;
    this.environment = environment;
    this.radius = radius;
    this._motionReady = false;
    this._cameraForwardScratch = new Vector3();

    // Terrain owns the one authoritative GPU height texture.  Recreating the same
    // R32F image here needlessly consumes a second WebGPU allocation (and risks the
    // render and blade surfaces drifting if either upload changes).
    const { dataTex } = this._bakeTextures( terrain, canopyPlacements );
    const heightTex = terrain.heightTexture;
    const zoneTex = terrain.zoneTexture;
    if ( ! heightTex || ! zoneTex ) throw new Error( 'Grass requires Terrain height and zone textures.' );
    this._const = {
      heightTex, zoneTex, dataTex,
      nx: terrain.nx, nz: terrain.nz,
      minX: terrain.bounds.minX, minZ: terrain.bounds.minZ,
      sizeX: terrain.bounds.maxX - terrain.bounds.minX,
      sizeZ: terrain.bounds.maxZ - terrain.bounds.minZ,
      roughWidth: terrain.zones.corridor.rough,
      fringeWidth: terrain.zones.fringeW,
      bladeColor: BLADE_COLOR,
    };

    // These are camera inputs only, never a CPU visibility result. The compute path
    // owns all frustum/distance/surface decisions.
    this.uCameraPosition = uniform( camera.position.clone() );
    this.uPreviousCameraPosition = uniform( camera.position.clone() );
    camera.getWorldDirection( this._cameraForwardScratch );
    const initialForwardLength = Math.hypot( this._cameraForwardScratch.x, this._cameraForwardScratch.z ) || 1;
    const initialForward = new Vector2(
      this._cameraForwardScratch.x / initialForwardLength,
      this._cameraForwardScratch.z / initialForwardLength,
    );
    this.uCameraForwardXZ = uniform( initialForward.clone() );
    this.uPreviousCameraForwardXZ = uniform( initialForward.clone() );
    this.uViewProjection = uniform( new Matrix4() );
    this.uRadius = uniform( radius );
    this.uSpecular = uniform( 0.045 );

    const tileMetadata = this._makeTileOrigins();
    this._tileOrigins = tileMetadata.origins;
    this._tileHeightBounds = tileMetadata.heightBounds;
    // StorageBufferNode does not proxy BufferAttribute.count; the GPU allocation's
    // authoritative element count lives on the attribute itself.
    this._tileCount = this._tileOrigins.value.count;
    this._makeGpuState();

    this.mesh = new Mesh( this._geometry(), this._material() );
    this.mesh.name = 'grass-gpu-indirect';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  _bakeTextures( terrain, canopyPlacements ) {
    const { nx, nz } = terrain;

    // Candidate classification only needs a growable bit; cut height is derived
    // from the authoritative zone SDF below. Reuse the remaining seven bits for
    // dense authored-canopy overlap, retaining the same R8 allocation and fetch.
    const data = new Uint8Array( nx * nz );
    bakeDenseCanopyMask( data, nx, nz, {
      minX: terrain.bounds.minX,
      minZ: terrain.bounds.minZ,
      spacing: terrain.spacing,
    }, canopyPlacements );
    const { minX, minZ } = terrain.bounds;
    for ( let z = 0; z < nz; z ++ ) {
      for ( let x = 0; x < nx; x ++ ) {
        const wx = minX + x * terrain.spacing;
        const wz = minZ + z * terrain.spacing;
        const name = terrain.surfaceAt( wx, wz );
        const i = z * nx + x;
        if ( bladeHeight( name ) > 0 ) data[ i ] |= GRASS_GROWABLE_BIT;
      }
    }
    const dataTex = new DataTexture( data, nx, nz, RedFormat, UnsignedByteType );
    dataTex.name = 'grass-growable-canopy-r8';
    dataTex.minFilter = dataTex.magFilter = NearestFilter;
    dataTex.generateMipmaps = false;
    dataTex.needsUpdate = true;
    return { dataTex };
  }

  _makeTileOrigins() {
    const { minX, maxX, minZ, maxZ } = this.terrain.bounds;
    const xs = Math.ceil( ( maxX - minX ) / TILE_SIZE );
    const zs = Math.ceil( ( maxZ - minZ ) / TILE_SIZE );
    const data = new Float32Array( xs * zs * 4 );
    const heightBounds = new Float32Array( xs * zs * 2 );
    const surfaceData = this._const.dataTex.image.data;
    const heightData = this.terrain.heights;
    const nx = this._const.nx, nz = this._const.nz;
    const spacing = this.terrain.spacing;
    let n = 0;
    for ( let z = 0; z < zs; z ++ ) {
      for ( let x = 0; x < xs; x ++ ) {
        const originX = minX + x * TILE_SIZE;
        const originZ = minZ + z * TILE_SIZE;
        // Exact immutable acceleration metadata: include the half-texel footprint
        // around every surface sample a candidate in this tile can resolve to.
        const ix0 = Math.max( 0, Math.floor( ( originX - minX ) / spacing - 0.5 ) );
        const ix1 = Math.min( nx - 1, Math.ceil( ( originX + TILE_SIZE - minX ) / spacing + 0.5 ) );
        const iz0 = Math.max( 0, Math.floor( ( originZ - minZ ) / spacing - 0.5 ) );
        const iz1 = Math.min( nz - 1, Math.ceil( ( originZ + TILE_SIZE - minZ ) / spacing + 0.5 ) );
        let occupied = 0;
        let minHeight = Infinity;
        let maxHeight = -Infinity;
        for ( let iz = iz0; iz <= iz1; iz ++ ) {
          for ( let ix = ix0; ix <= ix1; ix ++ ) {
            const sampleIndex = iz * nx + ix;
            const height = heightData[ sampleIndex ];
            minHeight = Math.min( minHeight, height );
            maxHeight = Math.max( maxHeight, height );
            if ( ( surfaceData[ sampleIndex ] & GRASS_GROWABLE_BIT ) !== 0 ) occupied = 1;
          }
        }
        const tileIndex = z * xs + x;
        // Bilinear height reconstruction stays inside the extrema of these exact
        // source samples. Include root tolerance below and the tallest authored
        // blade above so the frustum test encloses the complete visible canopy.
        heightBounds[ tileIndex * 2 ] = Number.isFinite( minHeight ) ? minHeight - 0.05 : 0;
        heightBounds[ tileIndex * 2 + 1 ] = Number.isFinite( maxHeight )
          ? maxHeight + BLADE_H.deepRough + 0.06 : BLADE_H.deepRough;
        data[ n ++ ] = originX;
        data[ n ++ ] = 0;
        data[ n ++ ] = originZ;
        data[ n ++ ] = occupied;
      }
    }
    return {
      origins: storage( new StorageBufferAttribute( data, 4 ), 'vec4', xs * zs ).toReadOnly(),
      heightBounds: storage( new StorageBufferAttribute( heightBounds, 2 ), 'vec2', xs * zs ).toReadOnly(),
    };
  }

  _makeGpuState() {
    // Tile list is GPU-compacted; there is no JS frustum list and no tile mesh churn.
    this._activeTiles = storage( new StorageBufferAttribute( new Uint32Array( this._tileCount ), 1, Uint32Array ), 'uint', this._tileCount );
    this._tileCounter = storage( new StorageBufferAttribute( new Uint32Array( 1 ), 1, Uint32Array ), 'uint', 1 ).toAtomic();
    this._visibleCounter = storage( new StorageBufferAttribute( new Uint32Array( 1 ), 1, Uint32Array ), 'uint', 1 ).toAtomic();
    this._overflow = storage( new StorageBufferAttribute( new Uint32Array( 1 ), 1, Uint32Array ), 'uint', 1 ).toAtomic();

    // One vec4 each for base+height, basis+shape and colour. The existing integer
    // state stream keeps the stable id in X, current/previous XZ wind in Y, and their
    // camera LOD pairs in Z. Computing these once per surviving blade is equivalent
    // to rebuilding them at every one of the blade's vertices, but removes millions
    // of repeated trig/sqrt/curve evaluations without adding another allocation.
    this._recordAnchor = storage( new StorageInstancedBufferAttribute( new Float32Array( MAX_VISIBLE_BLADES * 4 ), 4 ), 'vec4', MAX_VISIBLE_BLADES );
    this._recordShape = storage( new StorageInstancedBufferAttribute( new Float32Array( MAX_VISIBLE_BLADES * 4 ), 4 ), 'vec4', MAX_VISIBLE_BLADES );
    this._recordColor = storage( new StorageInstancedBufferAttribute( new Float32Array( MAX_VISIBLE_BLADES * 4 ), 4 ), 'vec4', MAX_VISIBLE_BLADES );
    this._recordId = storage( new StorageInstancedBufferAttribute( new Uint32Array( MAX_VISIBLE_BLADES * 3 ), 3, Uint32Array ), 'uvec3', MAX_VISIBLE_BLADES );

    this._candidateDispatchAttr = new IndirectStorageBufferAttribute( new Uint32Array( [ 0, 1, 1 ] ), 3 );
    this._candidateDispatch = storage( this._candidateDispatchAttr, 'uint', 3 );
    this._drawArgsAttr = new IndirectStorageBufferAttribute( new Uint32Array( [ BLADE_INDEX_COUNT, 0, 0, 0, 0 ] ), 5 );
    this._drawArgs = storage( this._drawArgsAttr, 'uint', 5 );

    this._clearCompute = this._buildClearCompute();
    this._tileCompute = this._buildTileCompute();
    this._tileFinalizeCompute = this._buildTileFinalizeCompute();
    this._candidateCompute = this._buildCandidateCompute();
    this._drawFinalizeCompute = this._buildDrawFinalizeCompute();
    this._clearCompute.name = 'Grass GPU reset';
    this._tileCompute.name = 'Grass tile classify';
    this._tileFinalizeCompute.name = 'Grass tile dispatch finalize';
    this._candidateCompute.name = 'Grass blade compact';
    this._drawFinalizeCompute.name = 'Grass indirect draw finalize';
  }

  _buildClearCompute() {
    return Fn( () => {
      atomicStore( this._tileCounter.element( uint( 0 ) ), uint( 0 ) );
      atomicStore( this._visibleCounter.element( uint( 0 ) ), uint( 0 ) );
      atomicStore( this._overflow.element( uint( 0 ) ), uint( 0 ) );
      this._candidateDispatch.element( uint( 0 ) ).assign( uint( 0 ) );
      this._candidateDispatch.element( uint( 1 ) ).assign( uint( 1 ) );
      this._candidateDispatch.element( uint( 2 ) ).assign( uint( 1 ) );
      this._drawArgs.element( uint( 0 ) ).assign( uint( BLADE_INDEX_COUNT ) );
      this._drawArgs.element( uint( 1 ) ).assign( uint( 0 ) );
      this._drawArgs.element( uint( 2 ) ).assign( uint( 0 ) );
      this._drawArgs.element( uint( 3 ) ).assign( uint( 0 ) );
      this._drawArgs.element( uint( 4 ) ).assign( uint( 0 ) );
    } )().compute( 1 );
  }

  _buildTileCompute() {
    const tileOrigins = this._tileOrigins;
    const tileHeightBounds = this._tileHeightBounds;
    const activeTiles = this._activeTiles;
    const tileCounter = this._tileCounter;
    const cam = this.uCameraPosition;
    const cameraForward = this.uCameraForwardXZ;
    const radius = this.uRadius;
    const viewProjection = this.uViewProjection;
    return Fn( () => {
      const tile = uint( instanceIndex );
      const origin = tileOrigins.element( tile );
      const verticalBounds = tileHeightBounds.element( tile );
      const dx = origin.x.add( TILE_SIZE * 0.5 ).sub( cam.x );
      const dz = origin.z.add( TILE_SIZE * 0.5 ).sub( cam.z );
      // Classify the whole 8 m tile, not just its centre. A centre-only test switches
      // square tiles on and off while orbiting, which exposes the compute grid even
      // though individual blades are world-stable. Corners plus a near-camera guard
      // admit a tile before any visible portion reaches the viewport.
      const pointVisible = ( ox, oy, oz ) => {
        const clip = viewProjection.mul( vec4( origin.x.add( ox ), oy, origin.z.add( oz ), 1.0 ) );
        return clip.w.greaterThan( 0.0 )
          .and( clip.x.abs().lessThan( clip.w.mul( 1.30 ) ) )
          .and( clip.y.abs().lessThan( clip.w.mul( 1.65 ) ) );
      };
      const nearCamera = dx.mul( dx ).add( dz.mul( dz ) ).lessThan( ( TILE_SIZE * 1.5 ) ** 2 );
      const inFrustum = nearCamera
        .or( pointVisible( 0.0, verticalBounds.x, 0.0 ) )
        .or( pointVisible( TILE_SIZE, verticalBounds.x, 0.0 ) )
        .or( pointVisible( 0.0, verticalBounds.x, TILE_SIZE ) )
        .or( pointVisible( TILE_SIZE, verticalBounds.x, TILE_SIZE ) )
        .or( pointVisible( 0.0, verticalBounds.y, 0.0 ) )
        .or( pointVisible( TILE_SIZE, verticalBounds.y, 0.0 ) )
        .or( pointVisible( 0.0, verticalBounds.y, TILE_SIZE ) )
        .or( pointVisible( TILE_SIZE, verticalBounds.y, TILE_SIZE ) );
      // Every surviving candidate lies within DENSITY_ACTIVE_RADIUS * radius of
      // the camera; include the complete tile footprint around that horizon. The
      // previous radius + 1.55*TILE_SIZE admitted a broad zero-output ring and made
      // the candidate compaction pass pay for ~37k dead lanes per tile.
      const nearbyBase = dx.mul( dx ).add( dz.mul( dz ) ).lessThan( radius.mul( DENSITY_ACTIVE_RADIUS ).add( TILE_CIRCUMRADIUS ).pow( 2 ) );
      // Conservative tile bound for the forward tail. Scaling the circumradius by
      // the ellipse's largest axis guarantees that no candidate with positive keep
      // probability is skipped, while the forward gate avoids a 360-degree ring.
      const along = dx.mul( cameraForward.x ).add( dz.mul( cameraForward.y ) );
      const lateral = dx.mul( cameraForward.y ).sub( dz.mul( cameraForward.x ) );
      const scaledLateral = lateral.mul( FAR_TIER_LATERAL_SCALE );
      const farMargin = TILE_CIRCUMRADIUS * FAR_TIER_LATERAL_SCALE;
      const nearbyFar = along.greaterThan( -TILE_CIRCUMRADIUS )
        .and( along.mul( along ).add( scaledLateral.mul( scaledLateral ) )
          .lessThan( radius.mul( FAR_TIER_TERMINAL_RADIUS ).add( farMargin ).pow( 2 ) ) );
      const nearby = nearbyBase.or( nearbyFar );
      const hasBladeSurface = origin.w.greaterThan( 0.5 );
      If( nearby.and( inFrustum ).and( hasBladeSurface ), () => {
        const slot = atomicAdd( tileCounter.element( uint( 0 ) ), uint( 1 ) );
        // Any candidate root is inside this 8m tile. Distance to its AABB is
        // therefore a lower bound on candidate distance, and the radial density
        // curve is monotone decreasing. The projected tail cannot exceed its peak.
        // Multiplying those bounds by the exact tuft/coverage maxima gives a
        // conservative hC ceiling for base, overlap, and far-only tiles alike.
        // Include the full authored ±0.45-cell jitter beyond the nominal tile AABB.
        // Candidate centres currently retain a half-cell inset, so this deliberately
        // over-bounds their real extent and remains safe if that inset is later changed.
        const tileBoundHalfExtent = TILE_SIZE * 0.5 + CANDIDATE_JITTER_MARGIN;
        const nearestDx = dx.abs().sub( tileBoundHalfExtent ).max( 0.0 );
        const nearestDz = dz.abs().sub( tileBoundHalfExtent ).max( 0.0 );
        const tileMinDistance = nearestDx.mul( nearestDx ).add( nearestDz.mul( nearestDz ) ).sqrt();
        const { keepProb: baseKeepUpper } = densityAtDistance( radius, tileMinDistance );
        // Bound the far tail at this tile's closest possible elliptical distance.
        // The former global peak made every distant tile evaluate extra hashes,
        // terrain fetches, and ecological noise even as its actual tail approached
        // zero. This one sqrt runs per tile, then rejects almost all terminal lanes
        // after their immutable acceptance hash in the candidate compute pass.
        const farFootprintDistance = along.mul( along )
          .add( scaledLateral.mul( scaledLateral ) ).sqrt();
        const farMinDistance = farFootprintDistance.sub( farMargin ).max( 0.0 );
        const farProgress = farMinDistance.sub( radius.mul( FAR_TIER_START_RADIUS ) )
          .div( radius.mul( FAR_TIER_TERMINAL_RADIUS - FAR_TIER_START_RADIUS ) ).clamp( 0.0, 1.0 );
        const farTail = float( 1 ).sub( farProgress );
        const farSamplingScale = nearbyBase.not()
          .select( float( FAR_ONLY_CANDIDATE_STRIDE ), float( 1 ) );
        const farKeepUpper = farTail.mul( farTail ).mul( FAR_TIER_PEAK_KEEP )
          .mul( farSamplingScale ).min( 1.0 );
        const densityUpper = baseKeepUpper.max( farKeepUpper )
          .mul( DENSITY_TARGET_MAX_SCALE ).clamp( 0.0, 1.0 );
        // Float-to-uint truncates downward; add one bucket before clamping so the
        // decoded threshold is always >= the analytic bound, never an approximation
        // that could remove a surviving blade.
        const densityUpperByte = uint( densityUpper.mul( ACTIVE_TILE_BOUND_MAX ) )
          .add( uint( 1 ) ).min( uint( ACTIVE_TILE_BOUND_MAX ) );
        // Low bit marks tiles outside the complete base-field footprint. Their
        // candidates can only survive the bounded forward tail.
        const farOnly = nearbyBase.not().select( uint( 1 ), uint( 0 ) );
        const record = tile.shiftLeft( uint( ACTIVE_TILE_RECORD_SHIFT ) )
          .bitOr( densityUpperByte.shiftLeft( uint( 1 ) ) ).bitOr( farOnly );
        activeTiles.element( slot ).assign( record );
      } );
    } )().compute( this._tileCount, [ WORKGROUP ] );
  }

  _buildTileFinalizeCompute() {
    return Fn( () => {
      const tiles = atomicLoad( this._tileCounter.element( uint( 0 ) ) );
      // Exact workgroup count for the next compute submission. This is indirect GPU
      // dispatch, not a CPU count or readback.
      this._candidateDispatch.element( uint( 0 ) ).assign( tiles.mul( uint( GROUPS_PER_TILE ) ) );
      this._candidateDispatch.element( uint( 1 ) ).assign( uint( 1 ) );
      this._candidateDispatch.element( uint( 2 ) ).assign( uint( 1 ) );
    } )().compute( 1 );
  }

  _sampleHeight( uvx, uvz ) {
    const c = this._const;
    const gx = uvx.mul( c.nx - 1 ).clamp( 0.0, c.nx - 1.001 );
    const gz = uvz.mul( c.nz - 1 ).clamp( 0.0, c.nz - 1.001 );
    const ix = gx.floor(), iz = gz.floor();
    const fx = gx.sub( ix ), fz = gz.sub( iz );
    const load = ( x, z ) => textureLoad( c.heightTex, ivec2( int( x ), int( z ) ) ).x;
    return mix( mix( load( ix, iz ), load( ix.add( 1 ), iz ), fx ), mix( load( ix, iz.add( 1 ) ), load( ix.add( 1 ), iz.add( 1 ) ), fx ), fz );
  }

  _buildCandidateCompute() {
    const c = this._const;
    // Do not mutate the writer node's access mode: the tile pass and this pass
    // share the underlying GPU attribute but need opposite access declarations.
    const activeTiles = storage( this._activeTiles.value, 'uint', this._tileCount ).toReadOnly();
    const tileOrigins = this._tileOrigins;
    const recordAnchor = this._recordAnchor;
    const recordShape = this._recordShape;
    const recordColor = this._recordColor;
    const recordId = this._recordId;
    const visibleCounter = this._visibleCounter;
    const overflow = this._overflow;
    const cam = this.uCameraPosition;
    const previousCam = this.uPreviousCameraPosition;
    const cameraForward = this.uCameraForwardXZ;
    const previousCameraForward = this.uPreviousCameraForwardXZ;
    const radius = this.uRadius;
    const scan = workgroupArray( 'uint', WORKGROUP ).setName( 'grassVisiblePrefix' );
    const base = workgroupArray( 'uint', 1 ).setName( 'grassVisibleBase' );
    const total = workgroupArray( 'uint', 1 ).setName( 'grassVisibleTotal' );
    const hash2 = ( v, seed ) => v.x.mul( 12.9898 ).add( v.y.mul( 78.233 ) ).add( seed ).sin().mul( 43758.5453 ).fract();

    return Fn( () => {
      const lid = localId.x;
      // The indirect X dimension is expressed in complete workgroups. Decode the
      // tile and local lane from those native ids instead of dividing/modding a
      // flattened global invocation by 36,864 for every candidate.
      const group = workgroupId.x;
      const activeSlot = group.div( uint( GROUPS_PER_TILE ) );
      const groupInTile = group.mod( uint( GROUPS_PER_TILE ) );
      const fullLocalCandidate = groupInTile.mul( uint( WORKGROUP ) ).add( lid );
      const activeRecord = activeTiles.element( activeSlot );
      const tile = activeRecord.shiftRight( uint( ACTIVE_TILE_RECORD_SHIFT ) );
      const farOnly = activeRecord.bitAnd( uint( 1 ) ).equal( uint( 1 ) );
      const densityUpper = float( activeRecord.shiftRight( uint( 1 ) )
        .bitAnd( uint( ACTIVE_TILE_BOUND_MAX ) ) ).div( ACTIVE_TILE_BOUND_MAX );
      const origin = tileOrigins.element( tile );
      // Keep the far decision coherent across an entire workgroup. A scattered
      // one-in-four lane predicate still makes Apple SIMD execute both sides of the
      // expensive branch. The first quarter of a far tile's workgroups instead map
      // their contiguous reduced index over every 2x2 block in the tile; remaining
      // workgroups take one uniform empty path. Near and overlap tiles retain the
      // original candidate index exactly.
      const samplesCandidate = farOnly.not().or( groupInTile.lessThan(
        uint( GROUPS_PER_TILE / FAR_ONLY_CANDIDATE_STRIDE ) ) );
      const reducedCandidate = groupInTile.mul( uint( WORKGROUP ) ).add( lid );
      const blocksPerRow = uint( GRID / 2 );
      const blockX = reducedCandidate.mod( blocksPerRow );
      const blockZ = reducedCandidate.div( blocksPerRow );
      const farPhase = tile.mul( uint( 1664525 ) ).add( uint( 1013904223 ) )
        .bitAnd( uint( FAR_ONLY_CANDIDATE_STRIDE - 1 ) );
      const farLocalCandidate = blockZ.mul( uint( 2 * GRID ) )
        .add( farPhase.shiftRight( uint( 1 ) ).mul( uint( GRID ) ) )
        .add( blockX.mul( uint( 2 ) ) ).add( farPhase.bitAnd( uint( 1 ) ) );
      const localCandidate = farOnly.select( farLocalCandidate, fullLocalCandidate );
      const lx = float( localCandidate.mod( uint( GRID ) ) );
      const lz = float( localCandidate.div( uint( GRID ) ) );
      const wcx = origin.x.div( CELL ).add( lx );
      const wcz = origin.z.div( CELL ).add( lz );
      const cell = vec2( wcx, wcz );
      const farSamplingScale = farOnly
        .select( float( FAR_ONLY_CANDIDATE_STRIDE ), float( 1 ) );
      const hC = float( 1 ).toVar();
      // Every tile carries an upward-rounded maximum density target. Compute the
      // immutable acceptance hash first, then avoid the other four trigonometric
      // hashes as well as jitter, terrain textures, noise, and ecological preparation
      // for lanes that cannot survive even the most favorable point in this tile.
      const hA = float( 0 ).toVar();
      const hB = float( 0 ).toVar();
      const hD = float( 0 ).toVar();
      const hE = float( 0 ).toVar();
      const worldX = float( 0 ).toVar();
      const worldZ = float( 0 ).toVar();
      const uvx = float( 0 ).toVar();
      const uvz = float( 0 ).toVar();
      const roughMask = float( 0 ).toVar();
      const hMax = float( 0 ).toVar();
      const ecological = float( 0 ).toVar();
      const tuft = float( 0 ).toVar();
      const heightClass = float( 0 ).toVar();
      const widthBase = float( ROUGH_BLADE_WIDTH_MIN_M ).toVar();
      const alive = uint( 0 ).toVar();
      If( samplesCandidate, () => {
        hC.assign( hash2( cell, 3.3 ) );
        const canPossiblyLive = hC.lessThan( densityUpper );
        If( canPossiblyLive, () => {
        hA.assign( hash2( cell, 0.0 ) );
        hB.assign( hash2( cell, 1.7 ) );
        hD.assign( hash2( cell, 5.1 ) );
        hE.assign( hash2( cell, 7.7 ) );
        worldX.assign( wcx.add( 0.5 ).mul( CELL ).add( hA.sub( 0.5 ).mul( CELL * 0.9 ) ) );
        worldZ.assign( wcz.add( 0.5 ).mul( CELL ).add( hB.sub( 0.5 ).mul( CELL * 0.9 ) ) );
        uvx.assign( worldX.sub( c.minX ).div( c.sizeX ) );
        uvz.assign( worldZ.sub( c.minZ ).div( c.sizeZ ) );
        const inBounds = uvx.greaterThan( 0.0 ).and( uvx.lessThan( 1.0 ) ).and( uvz.greaterThan( 0.0 ).and( uvz.lessThan( 1.0 ) ) );
        const data = textureLoad( c.dataTex, ivec2( int( uvx.mul( c.nx - 1 ).add( 0.5 ).clamp( 0.0, c.nx - 1 ) ), int( uvz.mul( c.nz - 1 ).add( 0.5 ).clamp( 0.0, c.nz - 1 ) ) ) );
        const packedGround = data.x.mul( 255.0 ).add( 0.5 ).floor();
        const canopyMask = packedGround.mod( GRASS_GROWABLE_BIT ).div( CANOPY_MASK_MAX );
        const growable = packedGround.greaterThanEqual( GRASS_GROWABLE_BIT );
        // The tile ceiling was rounded upward from the exact maximum base target.
        // Multiplying it by the same final canopy keep factor therefore remains an
        // upper bound on the final predicate. Reject dead surface/canopy lanes here,
        // before the zone fetch and three ecological noise evaluations. A zero mask
        // multiplies by exactly one, so surviving non-canopy lanes retain the exact
        // accepted evaluation path below.
        const canopyKeep = mix( 1.0, CANOPY_DENSITY_FLOOR, canopyMask );
        const surfaceDensityUpper = densityUpper.mul( canopyKeep );
        const canReachExactDensity = inBounds.and( growable )
          .and( hC.lessThan( surfaceDensityUpper ) );
        If( canReachExactDensity, () => {
        const zoneSD = textureLevel( c.zoneTex, vec2( uvx, uvz ), 0.0 );
        roughMask.assign( smoothstep( -SURFACE_TRANSITION_M, SURFACE_TRANSITION_M, zoneSD.r.add( c.roughWidth ) ) );
        const edgeWarp = mx_noise_float( vec3( worldX.mul( 0.045 ), worldZ.mul( 0.036 ), 317.0 ) )
          .sub( 0.5 ).mul( 2.8 );
        const edgeSD = zoneSD.r.add( edgeWarp );
        const clearForFairway = smoothstep( -2.4, 0.6, edgeSD );
        const clearForFringe = smoothstep( -SURFACE_TRANSITION_M, 0.0, zoneSD.g.add( c.fringeWidth ) );
        const clearForSand = smoothstep( -SURFACE_TRANSITION_M, 0.0, zoneSD.b );
        const clearForTee = smoothstep( -SURFACE_TRANSITION_M, 0.0, zoneSD.a );
        const cleared = clearForFairway.max( clearForFringe ).max( clearForSand ).max( clearForTee );
        hMax.assign( mix( BLADE_H.deepRough, BLADE_H.rough, roughMask )
          .mul( float( 1 ).sub( cleared ) ) );

        const dx = worldX.sub( cam.x );
        const dz = worldZ.sub( cam.z );
        const dist = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();
        const { keepProb: baseKeepProb } = densityAtDistance( radius, dist );
        const keepProb = baseKeepProb.toVar();
        If( baseKeepProb.lessThan( FAR_TIER_PEAK_KEEP ), () => {
          keepProb.maxAssign( farTierKeepAt( radius, dx, dz, cameraForward )
            .mul( farSamplingScale ).min( 1.0 ) );
        } );
        const macroCluster = mx_noise_float( vec3( worldX.mul( 0.075 ), worldZ.mul( 0.075 ), 31.7 ) ).mul( 0.5 ).add( 0.5 );
        const patchBreak = mx_noise_float( vec3( worldX.mul( 0.19 ), worldZ.mul( 0.19 ), 43.1 ) ).mul( 0.5 ).add( 0.5 );
        ecological.assign( mix( macroCluster, patchBreak, 0.28 ) );
        const colony = smoothstep( 0.25, 0.72, ecological );
        tuft.assign( smoothstep( 0.18, 0.84, mix( hE, ecological, roughMask ) ) );
        const tuftDensity = mix( 0.54, 1.24, tuft );
        const coverageRange = mix( ROUGH_COVERAGE_MIN, ROUGH_COVERAGE_MAX, ecological );
        const roughCoverage = coverageRange.mul( mix( ROUGH_COLONY_FLOOR, 1.0, colony ) );
        const densityTarget = keepProb.mul( tuftDensity ).mul( roughCoverage ).toVar();
        // Outside authored dense-canopy overlap this branch is false, leaving the
        // canonical density expression bit-for-bit intact. Inside connected forest
        // footprints it retires only stable world-cell candidates and never changes
        // blade width, height, reach, LOD radius, or camera-relative tail.
        If( canopyMask.greaterThan( 0.0 ), () => {
          densityTarget.mulAssign( mix( 1.0, CANOPY_DENSITY_FLOOR, canopyMask ) );
        } );
        const keepCandidate = hC.lessThan( densityTarget );
        heightClass.assign( mix( 0.62, 1.36, mix( hD, tuft, 0.55 ) )
          .mul( mix( 0.94, 1.06, ecological ) ) );
        const ecologicalWidth = mix( hE, tuft, 0.30 )
          .add( ecological.sub( 0.5 ).mul( 0.20 ) ).clamp( 0.0, 1.0 );
        widthBase.assign( mix( ROUGH_BLADE_WIDTH_MIN_M, ROUGH_BLADE_WIDTH_MAX_M, ecologicalWidth ) );
        alive.assign( inBounds.and( growable ).and( hMax.greaterThan( 0.002 ) )
          .and( keepCandidate ).select( uint( 1 ), uint( 0 ) ) );
        } );
        } );
      } );

      // Work-efficient Blelloch exclusive scan. It preserves the exact stable lane
      // order and one atomic reservation per 256 candidates, but performs 510 shared
      // adds instead of Hillis-Steele's 1,793. Barrier count is unchanged.
      scan.element( lid ).assign( alive );
      workgroupBarrier();
      for ( let offset = 1; offset < WORKGROUP; offset <<= 1 ) {
        const index = lid.add( uint( 1 ) ).mul( uint( offset * 2 ) ).sub( uint( 1 ) );
        If( index.lessThan( uint( WORKGROUP ) ), () => {
          scan.element( index ).addAssign( scan.element( index.sub( uint( offset ) ) ) );
        } );
        workgroupBarrier();
      }
      If( lid.equal( uint( 0 ) ), () => {
        total.element( uint( 0 ) ).assign( scan.element( uint( WORKGROUP - 1 ) ) );
        scan.element( uint( WORKGROUP - 1 ) ).assign( uint( 0 ) );
      } );
      workgroupBarrier();
      for ( let offset = WORKGROUP >> 1; offset >= 1; offset >>= 1 ) {
        const index = lid.add( uint( 1 ) ).mul( uint( offset * 2 ) ).sub( uint( 1 ) );
        If( index.lessThan( uint( WORKGROUP ) ), () => {
          const left = scan.element( index.sub( uint( offset ) ) ).toVar();
          scan.element( index.sub( uint( offset ) ) ).assign( scan.element( index ) );
          scan.element( index ).addAssign( left );
        } );
        workgroupBarrier();
      }
      If( lid.equal( uint( 0 ) ), () => {
        base.element( uint( 0 ) ).assign( atomicAdd( visibleCounter.element( uint( 0 ) ), total.element( uint( 0 ) ) ) );
      } );
      workgroupBarrier();

      const dst = base.element( uint( 0 ) ).add( scan.element( lid ) );
      If( alive.equal( uint( 1 ) ), () => {
        If( dst.lessThan( uint( MAX_VISIBLE_BLADES ) ), () => {
          const bladeColorNode = ( name ) => {
            const color = c.bladeColor[ name ];
            return vec3( color.r, color.g, color.b );
          };
          const surfaceColor = mix( bladeColorNode( 'deepRough' ), bladeColorNode( 'rough' ), roughMask );
          const groundY = this._sampleHeight( uvx, uvz );
          const baseHeight = hMax.mul( float( 0.38 ).add( hD.mul( 0.68 ) )
            .mul( mix( 0.72, 1.22, tuft ) ).mul( heightClass ) );
          // A low-frequency heading makes each colony feel wind-set while hA
          // keeps its blades from aligning into visible rows.
          const orient = hA.mul( 6.2831853 ).add( ecological.sub( 0.5 ).mul( 0.55 ) );
          const orientCos = orient.cos();
          const orientSin = orient.sin();
          const lean = smoothstep( 0.05, 0.25, hMax ).mul( mix( 0.30, 0.62, tuft ) )
            .mul( mix( 0.84, 1.18, hA ) ).mul( mix( 0.90, 1.10, ecological ) );
          // Species/age grading: mature blades carry warmer yellow-green pigment,
          // younger/wetter blades retain a cooler blue-green cast. This is albedo
          // variation only; no AO/emissive term is introduced for the grass pass.
          const age = mix( hD, ecological, 0.45 );
          const colourVariation = vec3(
            mix( 0.86, 1.16, age ),
            mix( 0.90, 1.08, mix( hE, age, 0.35 ) ),
            mix( 0.74, 1.03, mix( hD, hE, 0.50 ) ),
          );
          const colour = surfaceColor.mul( float( 0.72 ).add( hD.mul( 0.38 ) )
            .mul( mix( 0.84, 1.10, tuft ) ) ).mul( colourVariation );
          // Store world-stable rooted blade inputs. Camera-dependent current/previous
          // LOD state below is computed once per survivor and packed for exact temporal
          // reconstruction, so the velocity attachment represents prior geometry too.
          recordAnchor.element( dst ).assign( vec4( worldX, groundY, worldZ, baseHeight ) );
          recordShape.element( dst ).assign( vec4( orientCos, orientSin, widthBase, lean ) );
          recordColor.element( dst ).assign( vec4( colour, hC ) );
          // A stable candidate identity survives arbitrary workgroup completion order.
          // Wind is evaluated from the exact same rooted anchor/time as the former
          // vertex path, then packed into the already-present integer state stream.
          const windAnchor = vec3( worldX, groundY, worldZ );
          const currentWind = this.environment.windAt( windAnchor, this.environment.time ).xz;
          const previousWind = this.environment.windAt( windAnchor, this.environment.previousTime ).xz;
          const facing = vec2( orientSin.negate(), orientCos );
          const lodAt = ( cameraPosition, forwardAxis ) => {
            const lodDx = worldX.sub( cameraPosition.x );
            const lodDz = worldZ.sub( cameraPosition.z );
            const lodDistance = lodDx.mul( lodDx ).add( lodDz.mul( lodDz ) ).sqrt().max( 0.001 );
            const { progress, keepProb: baseLodKeep } = densityAtDistance( radius, lodDistance );
            const lodKeep = baseLodKeep.toVar();
            If( baseLodKeep.lessThan( FAR_TIER_PEAK_KEEP ), () => {
              lodKeep.maxAssign( farTierKeepAt( radius, lodDx, lodDz, forwardAxis )
                .mul( farSamplingScale ).min( 1.0 ) );
            } );
            const fade = smoothstep( hC.sub( DENSITY_FEATHER ), hC.add( DENSITY_FEATHER ), lodKeep );
            const viewDirection = vec2( lodDx.negate(), lodDz.negate() ).div( lodDistance );
            const edge = float( 1 ).sub( facing.dot( viewDirection ).abs() );
            const widthScale = mix( float( 1 ), MAX_WIDTH_RAMP, progress )
              .mul( fade ).mul( float( 1 ).add( edge.mul( edge ).mul( 2.0 ) ) );
            return vec2( fade, widthScale.div( MAX_WIDTH_RAMP * 3.0 ) );
          };
          const currentLod = lodAt( cam, cameraForward );
          // Position-only LOD is identical while the camera is stationary (including
          // projection jitter). Skip its second sqrt/curve/view solve in that common
          // case; a coherent uniform branch restores the exact previous-camera solve
          // on the first moving frame, so velocity fidelity is unchanged.
          const previousLod = currentLod.toVar();
          const footprintChanged = cam.x.notEqual( previousCam.x ).or( cam.z.notEqual( previousCam.z ) )
            .or( cameraForward.x.notEqual( previousCameraForward.x ) )
            .or( cameraForward.y.notEqual( previousCameraForward.y ) );
          If( footprintChanged, () => { previousLod.assign( lodAt( previousCam, previousCameraForward ) ); } );
          recordId.element( dst ).assign( uvec3(
            tile.mul( uint( CANDIDATES_PER_TILE ) ).add( localCandidate ),
            packUnorm4x8( vec4( currentWind, previousWind ).div( 32.0 ).add( 0.5 ) ),
            packUnorm4x8( vec4( currentLod, previousLod ) ),
          ) );
        } ).Else( () => {
          atomicStore( overflow.element( uint( 0 ) ), uint( 1 ) );
        } );
      } );
    } )().compute( 1, [ WORKGROUP ] );
  }

  _buildDrawFinalizeCompute() {
    return Fn( () => {
      const count = atomicLoad( this._visibleCounter.element( uint( 0 ) ) );
      const bad = atomicLoad( this._overflow.element( uint( 0 ) ) ).greaterThan( uint( 0 ) ).or( count.greaterThan( uint( MAX_VISIBLE_BLADES ) ) );
      If( bad, () => {
        // Deliberately do not clamp. A vanished grass canopy is an obvious failure,
        // while a silent partial canopy is temporal corruption disguised as success.
        atomicStore( this._overflow.element( uint( 0 ) ), uint( 1 ) );
        this._drawArgs.element( uint( 1 ) ).assign( uint( 0 ) );
      } ).Else( () => {
        this._drawArgs.element( uint( 1 ) ).assign( count );
      } );
      this._drawArgs.element( uint( 0 ) ).assign( uint( BLADE_INDEX_COUNT ) );
      this._drawArgs.element( uint( 2 ) ).assign( uint( 0 ) );
      this._drawArgs.element( uint( 3 ) ).assign( uint( 0 ) );
      this._drawArgs.element( uint( 4 ) ).assign( uint( 0 ) );
    } )().compute( 1 );
  }

  _geometry() {
    const pos = [];
    const uv = [];
    for ( let row = 0; row <= BLADE_SEGMENTS; row ++ ) {
      const y = row / BLADE_SEGMENTS;
      // z=0/1 selects the two crossed world-space blade planes in the vertex
      // function. Keeping this in the existing position attribute avoids a new
      // per-instance stream and preserves the one indirect draw.
      pos.push( -0.5, y, 0, 0.5, y, 0, -0.5, y, 1, 0.5, y, 1 );
      // Canonical ribbon UVs required by the production Phong lighting path. This
      // is a 16-vertex static attribute only: u follows side and v follows the
      // existing authored row, duplicated exactly across both crossed planes.
      uv.push( 0, y, 1, y, 0, y, 1, y );
    }
    const idx = [];
    for ( let row = 0; row < BLADE_SEGMENTS; row ++ ) {
      const a = row * 4, b = a + 1, c = a + 4, d = a + 5;
      const e = a + 2, f = a + 3, g = a + 6, h = a + 7;
      idx.push( a, c, b, b, c, d, e, g, f, f, g, h );
    }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute( 'position', new BufferAttribute( new Float32Array( pos ), 3 ) );
    geo.setAttribute( 'uv', new BufferAttribute( new Float32Array( uv ), 2 ) );
    geo.setIndex( new BufferAttribute( new Uint16Array( idx ), 1 ) );
    geo.instanceCount = MAX_VISIBLE_BLADES; // indirect args own the actual count.
    geo.setIndirect( this._drawArgsAttr );
    return geo;
  }

  _material() {
    const anchor = this._recordAnchor.toAttribute();
    const shape = this._recordShape.toAttribute();
    const colour = this._recordColor.toAttribute();
    // Keep the stable id in the vertex input layout even though current shading does
    // not vary colour by id. Its presence makes slot identity explicit for diagnostics
    // and future wind/state buffers.
    const state = this._recordId.toAttribute();
    const stableId = state.x;
    const bladeRow = positionGeometry.y;
    const t = bladeRow.toVarying( 'vGrassBladeT' );
    const side = positionGeometry.x;
    const plane = positionGeometry.z;
    // Share every camera-independent blade term between the current and previous
    // geometry evaluations. TSL can now emit one taper/basis/bend expression rather
    // than structurally rebuilding it for both MRT positions.
    // Geometry has only four fixed T rows (0, 1/3, 2/3, 1). These are the exact
    // authored upper-third profile values at those rows, avoiding smoothstep + a
    // non-integer pow for every current/history vertex while retaining its silhouette.
    const taper = t.lessThan( 0.5 ).select( float( 1.0 ),
      t.lessThan( 0.9 ).select( float( 0.9616200671 ), float( 0.06 ) ) );
    const leanDirection = vec2( shape.y, shape.x.negate() );
    const bendT = t.mul( t );
    const sideX = mix( shape.x, shape.y, plane );
    const sideZ = mix( shape.y, shape.x.negate(), plane );
    const packedWind = unpackUnorm4x8( state.y ).sub( 0.5 ).mul( 32.0 );
    const packedLod = unpackUnorm4x8( state.z );
    const bladePosition = ( wind, lodFade, normalizedWidth ) => {
      const H = anchor.w.mul( lodFade );
      // A coarse rough blade carries most of its width through the lower
      // two-thirds and tapers at the tip. Tapering from the root made every ribbon
      // a long uniform triangle and exaggerated wire silhouettes. The crossed
      // plane uses the same continuous upper-third profile and temporal history.
      const width = shape.z.mul( normalizedWidth.mul( MAX_WIDTH_RAMP * 3.0 ) ).mul( taper );
      // Cut-height/stiffness response: displacement is zero at the rooted base and
      // increases quadratically toward the tip. The same field/time is evaluated for
      // current and previous geometry so TRAA receives real deformation velocity.
      const authoredBend = leanDirection.mul( shape.w ).mul( bendT ).mul( H );
      const windBend = wind.mul( H ).mul( 0.028 ).mul( bendT );
      const bend = authoredBend.add(windBend);
      return vec3( anchor.x.add( side.mul( width ).mul( sideX ) ).add( bend.x ), anchor.y.add( t.mul( H ) ), anchor.z.add( side.mul( width ).mul( sideZ ) ).add( bend.y ) );
    };
    const current = bladePosition( packedWind.xy, packedLod.x, packedLod.y );
    const previous = bladePosition( packedWind.zw, packedLod.z, packedLod.w );
    const mh = this.motionHistory;
    const currentClip = mh.currentProjection.mul( mh.currentView ).mul( vec4( current, 1 ) );
    const previousClip = mh.previousProjection.mul( mh.previousView ).mul( vec4( previous, 1 ) );
    const velocityNode = currentClip.xy.div( currentClip.w ).sub( previousClip.xy.div( previousClip.w ) ).toVarying( 'vGrassVelocity' );

    // A broad, low-energy Phong lobe retains the real shared sun, shadows, and PMREM
    // while avoiding the dense crossed canopy's full microfacet material path.
    const mat = new SharedEnvironmentGrassPhongMaterial( {
      side: DoubleSide,
      shininess: 4.0,
      reflectivity: this.uSpecular.value,
    } );
    // State Y/Z already make the packed stream a real vertex dependency; X retains
    // stable identity without a redundant uint-to-float multiply/add in position.
    mat.positionNode = current;
    // Z marks thin reactive geometry. TRAA may retain clipped history at these finite
    // depth edges without granting the same exception to balls, bunkers, or terrain.
    mat.mrtNode = mrt( { velocity: vec3( velocityNode, 1.0 ) } );
    const round = side.mul( 0.82 );
    // Ribbon basis and round-profile terms are all vertex/instance data. The view
    // matrix is linear and every authored ribbon normal has the same pre-normalized
    // length, so transforming before interpolation is algebraically equivalent to
    // transforming the interpolated object normal. Hoist the matrix work to the 16
    // blade vertices and retain the one required post-interpolation normalize per
    // fragment; dense crossed-ribbon overdraw no longer pays a matrix multiply.
    const bladeNormalView = transformNormalToView( vec3(
      round.mul( sideX ).sub( sideZ.mul( 0.22 ) ),
      0.72,
      round.mul( sideZ ).add( sideX.mul( 0.22 ) ),
    ) ).toVarying( 'vGrassViewNormal' );
    mat.normalNode = bladeNormalView.normalize();
    // The colour curve only changes at the four authored blade rows. Evaluate those
    // values in the vertex stage and interpolate the resulting pigment, rather than
    // recomputing a quadratic for every fragment in the dense crossed canopy.
    const bladeLift = bladeRow.mul( 1.296 ).sub( bladeRow.mul( bladeRow ).mul( 0.296 ) ).clamp( 0.0, 1.0 );
    const bladeColor = colour.xyz.mul( mix( 0.88, 1.0, bladeLift ) )
      .toVarying( 'vGrassBladeColor' );
    mat.colorNode = bladeColor;
    mat.shininessNode = float( 4.0 );
    mat.specularNode = vec3( this.uSpecular.mul( 0.04 ) );
    // Prevent TSL from optimizing the stable-id stream away from the pipeline.
    mat.userData.grassStableId = stableId;
    return mat;
  }

  update( _time, camera = this.camera ) {
    const cam = camera;
    cam.updateMatrixWorld();
    if ( this._motionReady ) {
      this.uPreviousCameraPosition.value.copy( this.uCameraPosition.value );
      this.uPreviousCameraForwardXZ.value.copy( this.uCameraForwardXZ.value );
    }
    this.uCameraPosition.value.copy( cam.position );
    cam.getWorldDirection( this._cameraForwardScratch );
    const forwardLength = Math.hypot( this._cameraForwardScratch.x, this._cameraForwardScratch.z ) || 1;
    this.uCameraForwardXZ.value.set(
      this._cameraForwardScratch.x / forwardLength,
      this._cameraForwardScratch.z / forwardLength,
    );
    this.uViewProjection.value.multiplyMatrices( cam.projectionMatrix, cam.matrixWorldInverse );
    if ( !this._motionReady ) {
      this.uPreviousCameraPosition.value.copy( cam.position );
      this.uPreviousCameraForwardXZ.value.copy( this.uCameraForwardXZ.value );
    }
    this._motionReady = true;

    // Low chase/aim cameras need the full field most: shrinking it to 70% brought a
    // hard, camera-centred boundary into the foreground. Density and width LOD already
    // bound the distant cost, so radius must remain a stable world-space promise.
    this.uRadius.value = this.radius;
    // Ordered GPU submissions are required: each stage consumes only GPU-written
    // buffers from the prior stage. No count crosses the CPU/GPU boundary.
    this.renderer.compute( this._clearCompute );
    this.renderer.compute( this._tileCompute );
    this.renderer.compute( this._tileFinalizeCompute );
    this.renderer.compute( this._candidateCompute, this._candidateDispatchAttr );
    this.renderer.compute( this._drawFinalizeCompute );
  }

  // Explicit diagnostic readback for benchmark/debug tooling only. The production
  // frame path never calls this and never branches on CPU-visible grass state.
  async readDiagnostics() {
    const overflowData = new Uint32Array(await this.renderer.getArrayBufferAsync(this._overflow.value));
    const visibleData = new Uint32Array(await this.renderer.getArrayBufferAsync(this._visibleCounter.value));
    const activeTileData = new Uint32Array(await this.renderer.getArrayBufferAsync(this._tileCounter.value));
    return {
      overflow: overflowData[0],
      visibleCount: visibleData[0],
      capacity: MAX_VISIBLE_BLADES,
      activeTileCount: activeTileData[0],
      lodCameraPosition: this.uCameraPosition.value.toArray(),
      lodCameraForwardXZ: this.uCameraForwardXZ.value.toArray(),
      nominalRadius: this.radius,
      fullDensityRadius: this.radius * DENSITY_NEAR_RADIUS,
      baseTerminalRadius: this.radius * (
        DENSITY_NEAR_RADIUS + ( DENSITY_FAR_RADIUS - DENSITY_NEAR_RADIUS )
          * ( 1 - Math.pow( DENSITY_FEATHER / ( 1.08 + DENSITY_FEATHER ), 1 / DENSITY_CURVE_POWER ) )
      ),
      farTierStartRadius: this.radius * FAR_TIER_START_RADIUS,
      farTierTerminalRadius: this.radius * FAR_TIER_TERMINAL_RADIUS,
      farTierLateralRadius: this.radius * FAR_TIER_TERMINAL_RADIUS / FAR_TIER_LATERAL_SCALE,
    };
  }

  dispose() {
    disposeComputeNodes([
      this._clearCompute,
      this._tileCompute,
      this._tileFinalizeCompute,
      this._candidateCompute,
      this._drawFinalizeCompute,
    ]);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    disposeWebGPUAttributes(this.renderer, [
      this._tileOrigins.value,
      this._tileHeightBounds.value,
      this._activeTiles.value,
      this._tileCounter.value,
      this._visibleCounter.value,
      this._overflow.value,
      this._recordAnchor.value,
      this._recordShape.value,
      this._recordColor.value,
      this._recordId.value,
      this._candidateDispatchAttr,
      this._drawArgsAttr,
    ]);
    // `heightTex` and `zoneTex` are owned by Terrain and shared with its material.
    this._const.dataTex.dispose();
  }
}
