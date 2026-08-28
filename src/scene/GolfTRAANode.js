// Derived from Three.js r185 TRAANode (MIT). Kept local so the golf renderer can
// tune temporal reconstruction without patching dependencies or carrying another backend.
import { HalfFloatType, Vector2, RenderTarget, RendererUtils, QuadMesh, NodeMaterial, TempNode, NodeUpdateType, Matrix4, DepthTexture, FloatType } from 'three/webgpu';
import { add, float, If, Fn, max, texture, uniform, uv, vec2, vec4, luminance, convertToTexture, passTexture, velocity, getViewPosition, perspectiveDepthToViewZ, orthographicDepthToViewZ, viewZToPerspectiveDepth, struct, mix, smoothstep, logarithmicDepthToViewZ, viewZToOrthographicDepth } from 'three/tsl';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();

let _rendererState;

/**
 * A special node that applies TRAA (Temporal Reprojection Anti-Aliasing).
 *
 * References:
 * - {@link https://alextardif.com/TAA.html}
 * - {@link https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/}
 *
 * Note: MSAA must be disabled when TRAA is in use.
 *
 * @augments TempNode
 * @three_import import { traa } from 'three/addons/tsl/display/TRAANode.js';
 */
class TRAANode extends TempNode {

	static get type() {

		return 'TRAANode';

	}

	/**
	 * Constructs a new TRAA node.
	 *
	 * @param {TextureNode} beautyNode - The texture node that represents the input of the effect.
	 * @param {TextureNode} depthNode - A node that represents the scene's depth.
	 * @param {TextureNode} velocityNode - A node that represents the scene's velocity.
	 * @param {Camera} camera - The camera the scene is rendered with.
	 * @param {?TextureNode} backgroundNode - Legacy clear-weather background texture.
	 * @param {?TextureNode} cloudNode - Depth-aware cloud transport (RGB scatter, A transmittance).
	 * @param {?WeatherSky} cloudSky - Explicit analytic sky source for clear-depth pixels.
	 * @param {?TextureNode} cloudSourceNode - Quarter-resolution source depth metadata.
	 */
	constructor( beautyNode, depthNode, velocityNode, camera, backgroundNode = null, cloudNode = null, cloudSky = null, cloudSourceNode = null ) {

		super( 'vec4' );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isTRAANode = true;

		/**
		 * The `updateBeforeType` is set to `NodeUpdateType.FRAME` since the node renders
		 * its effect once per frame in `updateBefore()`.
		 *
		 * @type {string}
		 * @default 'frame'
		 */
		this.updateBeforeType = NodeUpdateType.FRAME;

		/**
		 * The texture node that represents the input of the effect.
		 *
		 * @type {TextureNode}
		 */
		this.beautyNode = beautyNode;

		/**
		 * A node that represents the scene's velocity.
		 *
		 * @type {TextureNode}
		 */
		this.depthNode = depthNode;

		/**
		 * A node that represents the scene's velocity.
		 *
		 * @type {TextureNode}
		 */
		this.velocityNode = velocityNode;

		/**
		 * The camera the scene is rendered with.
		 *
		 * @type {Camera}
		 */
		this.camera = camera;

		/**
		 * Independently rendered atmosphere. Compositing it here, before temporal
		 * accumulation, lets camera jitter integrate fractional coverage at every
		 * geometry-to-sky silhouette. A binary depth select after TRAA throws that
		 * coverage away and recreates crawling one-pixel tree/horizon edges.
		 *
		 * @type {?TextureNode}
		 */
		this.backgroundNode = backgroundNode;

		/**
		 * Depth-aware cloud transport. RGB is scattered radiance and alpha is
		 * transmittance, never a background replacement.
		 */
		this.cloudNode = cloudNode;
		this.cloudSky = cloudSky;
		this.cloudSourceNode = cloudSourceNode;
		if ( this.cloudNode && !this.cloudSky ) {

			throw new TypeError( 'TRAA cloud transport requires an analytic WeatherSky source.' );

		}
		if ( this.cloudNode && ( ! this.cloudSourceNode || typeof this.cloudSourceNode.load !== 'function' ) ) {

			throw new TypeError( 'TRAA cloud transport requires source depth metadata.' );

		}

		/** A reset/cut rejects history in the resolve shader for exactly one frame. */
		this._historyValid = uniform( 0 );
		/** Stationary-camera jitter samples accumulated, capped at one full cycle. */
		this._historyAge = uniform( 0 );

		/**
		 * When the difference between the current and previous depth goes above this threshold,
		 * the history is considered invalid.
		 *
		 * @type {number}
		 * @default 0.0005
		 */
		this.depthThreshold = 0.0005;

		/**
		 * The depth difference within the 3×3 neighborhood to consider a pixel as an edge.
		 *
		 * @type {number}
		 * @default 0.001
		 */
		this.edgeDepthDiff = 0.0001;

		/**
		 * The history becomes invalid as the pixel length of the velocity approaches this value.
		 *
		 * @type {number}
		 * @default 128
		 */
		this.maxVelocityLength = 128;

		/**
		 * Whether to decrease the weight on the current frame when the velocity is more subpixel.
		 * This reduces blurriness under motion, but can introduce a square pattern artifact.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.useSubpixelCorrection = true;

		/** Minimum current-frame contribution for static history. */
		this.staticCurrentWeight = 0.008;

		/**
		 * The jitter index selects the current camera offset value.
		 *
		 * @private
		 * @type {number}
		 * @default 0
		 */
		this._jitterIndex = 0;
		/**
		 * Camera jitter supplies fractional pixel coverage in both static and moving
		 * views. Camera translation alone cannot antialias the currently presented
		 * frame, so SceneManager keeps this enabled through broadcast flight while
		 * velocity reprojection rejects invalid history.
		 */
		this.cameraJitterEnabled = true;
		this._jitterAppliedThisFrame = false;

		/**
		 * A uniform node holding the inverse resolution value.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._invSize = uniform( new Vector2() );

		/**
		 * The render target that represents the history of frame data.
		 *
		 * @private
		 * @type {?RenderTarget}
		 */
		this._historyRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );
		this._historyRenderTarget.texture.name = 'TRAANode.history';
		// The two color surfaces ping-pong so the freshly resolved image becomes the
		// next history without a full-resolution resolve->history copy each frame.
		// TRAA's fullscreen resolve has depthBuffer:false, so per-target depth
		// attachments would only be copy destinations, never render attachments.

		/**
		 * The render target for the resolve.
		 *
		 * @private
		 * @type {?RenderTarget}
		 */
		this._resolveRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );
		this._resolveRenderTarget.texture.name = 'TRAANode.resolve';

		// Keep one depth surface for the previous frame. The old implementation
		// attached a separate depth texture to each ping-pong color target even
		// though neither target was depth-tested; after the swap only the current
		// history depth was copied and sampled. A standalone texture preserves the
		// exact depth copy/sample contract while removing one full-resolution depth
		// allocation and both unused target attachments.
		this._previousDepthTexture = new DepthTexture( 1, 1 );
		this._previousDepthTexture.name = 'TRAANode.previousDepth';

		/**
		 * Material used for the resolve step.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._resolveMaterial = new NodeMaterial();
		this._resolveMaterial.name = 'TRAA.resolve';

		/**
		 * The result of the effect is represented as a separate texture node.
		 *
		 * @private
		 * @type {PassTextureNode}
		 */
		this._textureNode = passTexture( this, this._resolveRenderTarget.texture );
		this._historyTextureNode = null;

		/**
		 * Used to save the original/unjittered projection matrix.
		 *
		 * @private
		 * @type {Matrix4}
		 */
		this._originalProjectionMatrix = new Matrix4();

		/**
		 * A uniform node holding the camera's near and far.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._cameraNearFar = uniform( new Vector2() );

		/**
		 * A uniform node holding the camera world matrix.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraWorldMatrix = uniform( new Matrix4() );

		/**
		 * A uniform node holding the camera world matrix inverse.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraWorldMatrixInverse = uniform( new Matrix4() );

		/**
		 * A uniform node holding the camera projection matrix inverse.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraProjectionMatrixInverse = uniform( new Matrix4() );

		/**
		 * A uniform node holding the previous frame's view matrix.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._previousCameraWorldMatrix = uniform( new Matrix4() );

		/**
		 * A uniform node holding the previous frame's projection matrix inverse.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._previousCameraProjectionMatrixInverse = uniform( new Matrix4() );

		/**
		 * A texture node for the previous depth buffer.
		 *
		 * @private
		 * @type {TextureNode}
		 */
		// Created lazily in setup after the live drawing-buffer dimensions are known;
		// this avoids a 1x1 placeholder allocation being retained by renderer.info.
		this._previousDepthNode = null;

		/**
		 * Sync the post processing stack with the TRAA node.
		 *
		 * @private
		 * @type {boolean}
		 */
		this._needsPostProcessingSync = false;

		/**
		 * The node used to render the scene's velocity.
		 *
		 * @private
		 * @type {?VelocityNode}
		 */
		this._velocityNode = null;

	}

	/**
	 * Returns the result of the effect as a texture node.
	 *
	 * @return {PassTextureNode} A texture node that represents the result of the effect.
	 */
	getTextureNode() {

		return this._textureNode;

	}

	/**
	 * Sets the size of the effect.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 */
	setSize( width, height ) {

		this._historyRenderTarget.setSize( width, height );
		this._resolveRenderTarget.setSize( width, height );

		this._invSize.value.set( 1 / width, 1 / height );

	}

	/**
	 * Defines the TRAA's current jitter as a view offset
	 * to the scene's camera.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 */
	setViewOffset( width, height ) {

		// Never let a stale temporal offset leak across frame boundaries.
		// `clearViewOffset()` is idempotent and restores the exact authored lens.
		this.camera.clearViewOffset();

		// save original/unjittered projection matrix for velocity pass

		this.camera.updateProjectionMatrix();
		this._originalProjectionMatrix.copy( this.camera.projectionMatrix );

		this._velocityNode.setProjectionMatrix( this._originalProjectionMatrix );

		//

		this._jitterAppliedThisFrame = this.cameraJitterEnabled;
		if ( this.cameraJitterEnabled === false ) return;

		const viewOffset = {

			fullWidth: width,
			fullHeight: height,
			offsetX: 0,
			offsetY: 0,
			width: width,
			height: height

		};

		const jitterOffset = _haltonOffsets[ this._jitterIndex ];

		this.camera.setViewOffset(

			viewOffset.fullWidth, viewOffset.fullHeight,

			viewOffset.offsetX + jitterOffset[ 0 ] - 0.5, viewOffset.offsetY + jitterOffset[ 1 ] - 0.5,

			viewOffset.width, viewOffset.height

		);

	}

	/**
	 * Clears the view offset from the scene's camera.
	 */
	clearViewOffset() {

		this.camera.clearViewOffset();

		this._velocityNode.setProjectionMatrix( null );

		// Only a frame that actually used a projection sample advances the sequence.
		if ( this._jitterAppliedThisFrame ) {

			this._jitterIndex ++;
			this._jitterIndex = this._jitterIndex % _haltonOffsets.length;

		}
		this._jitterAppliedThisFrame = false;

	}

	/**
	 * This method is used to render the effect once per frame.
	 *
	 * @param {NodeFrame} frame - The current node frame.
	 */
	updateBefore( frame ) {

		const { renderer } = frame;

		// A camera move starts a new jitter accumulation sequence. Wind/deformation has
		// per-pixel velocity and does not reset this global camera-age counter.
		if ( ! this.camera.matrixWorld.equals( this._cameraWorldMatrix.value ) ) {

			this._historyAge.value = 0;

		}

		// store previous frame matrices before updating current ones

		this._previousCameraWorldMatrix.value.copy( this._cameraWorldMatrix.value );
		this._previousCameraProjectionMatrixInverse.value.copy( this._cameraProjectionMatrixInverse.value );

		// update camera matrices uniforms

		this._cameraNearFar.value.set( this.camera.near, this.camera.far );
		this._cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this._cameraWorldMatrixInverse.value.copy( this.camera.matrixWorldInverse );
		this._cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

		// keep the TRAA in sync with the dimensions of the beauty node

		const beautyRenderTarget = ( this.beautyNode.isRTTNode ) ? this.beautyNode.renderTarget : this.beautyNode.passNode.renderTarget;

		const width = beautyRenderTarget.texture.width;
		const height = beautyRenderTarget.texture.height;

		//

		if ( this._needsPostProcessingSync === true ) {

			this.setViewOffset( width, height );

			this._needsPostProcessingSync = false;

		}

		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		//

		const needsRestart = this._historyRenderTarget.width !== width || this._historyRenderTarget.height !== height;
		this.setSize( width, height );

		// every time when the dimensions change we need fresh history data

		if ( needsRestart === true ) {

			this._historyValid.value = 0;
			this._historyAge.value = 0;
			if ( renderer.reversedDepthBuffer === true ) this._previousDepthTexture.type = FloatType;

			// make sure render targets are initialized after the resize which triggers a dispose()

			renderer.initRenderTarget( this._historyRenderTarget );
			renderer.initRenderTarget( this._resolveRenderTarget );

			// A DepthTexture is not resized by RenderTarget.setSize() because it is
			// intentionally no longer owned by either color target. Recreate the
			// standalone previous-depth surface only on a real size change.
			this._previousDepthTexture.image.width = width;
			this._previousDepthTexture.image.height = height;
			this._previousDepthTexture.needsUpdate = true;
			renderer.initTexture( this._previousDepthTexture );

			// make sure to reset the history with the contents of the beauty buffer otherwise subsequent frames after the
			// resize will fade from a darker color to the correct one because the history was cleared with black.

			renderer.copyTextureToTexture( beautyRenderTarget.texture, this._historyRenderTarget.texture );

		}

		// resolve

		renderer.setRenderTarget( this._resolveRenderTarget );
		_quadMesh.material = this._resolveMaterial;
		_quadMesh.name = 'TRAA';
		_quadMesh.render( renderer );
		renderer.setRenderTarget( null );

		// Ping-pong the full-resolution temporal surfaces. The resolve just written
		// becomes history for the next frame, while the old history is reused as the
		// next resolve destination. This removes one full-frame copy submission per
		// frame without changing the resolve shader or temporal weighting.
		const previousHistory = this._historyRenderTarget;
		this._historyRenderTarget = this._resolveRenderTarget;
		this._resolveRenderTarget = previousHistory;
		this._historyTextureNode.value = this._historyRenderTarget.texture;
		this._textureNode.value = this._historyRenderTarget.texture;
		this._historyValid.value = 1;
		this._historyAge.value = Math.min( 32, this._historyAge.value + 1 );

		// Copy current depth to previous depth buffer

		const size = renderer.getDrawingBufferSize( _size );

		// only allow the depth copy if the dimensions of the history render target match with the drawing
		// render buffer and thus the depth texture of the scene. For some reasons, there are timing issues
		// with WebGPU resulting in different size of the drawing buffer and the beauty render target when
		// resizing the browser window. This does not happen with the WebGL backend

		if ( this._historyRenderTarget.height === size.height && this._historyRenderTarget.width === size.width ) {

			const currentDepth = this.depthNode.value;
			renderer.copyTextureToTexture( currentDepth, this._previousDepthTexture );
			if ( this._previousDepthNode ) this._previousDepthNode.value = this._previousDepthTexture;

		}

		// restore

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	/**
	 * This method is used to setup the effect's render targets and TSL code.
	 *
	 * @param {NodeBuilder} builder - The current node builder.
	 * @return {PassTextureNode}
	 */
	setup( builder ) {

		// Bind the standalone depth node only after the renderer exposes the actual
		// backing dimensions. This keeps its first GPU allocation at full size,
		// matching the two color targets and the scene depth source.
		const drawingBufferSize = builder.renderer.getDrawingBufferSize( _size );
		this._previousDepthTexture.image.width = drawingBufferSize.width;
		this._previousDepthTexture.image.height = drawingBufferSize.height;
		this._previousDepthNode ??= texture( this._previousDepthTexture );

		const renderPipeline = builder.context.renderPipeline;

		if ( renderPipeline ) {

			this._needsPostProcessingSync = true;

			renderPipeline.context.onBeforeRenderPipeline = () => {

				const size = builder.renderer.getDrawingBufferSize( _size );
				this.setViewOffset( size.width, size.height );

			};

			renderPipeline.context.onAfterRenderPipeline = () => {

				this.clearViewOffset();

			};

		}

		if ( builder.renderer.reversedDepthBuffer === true ) {

			this._previousDepthTexture.type = FloatType;

		}

		if ( builder.context.velocity !== undefined ) {

			this._velocityNode = builder.context.velocity;

		} else {

			this._velocityNode = velocity;

		}

		const logarithmicToPerspectiveDepth = ( depth ) => {

			const { x: near, y: far } = this._cameraNearFar;
			const viewZ = logarithmicDepthToViewZ( depth, near, far );
			return viewZToPerspectiveDepth( viewZ, near, far );

		};

		const currentDepthStruct = struct( {

			closestDepth: 'float',
			closestPositionTexel: 'vec2',
			farthestDepth: 'float',

		} );

		// Samples a five-tap cross and returns the closest and farthest depths. The
		// cardinal footprint catches every one-pixel silhouette while avoiding four
		// diagonal depth/beauty fetches in each of the two neighborhood stages.
		const sampleCurrentDepth = Fn( ( [ positionTexel ] ) => {

			const closestDepth = float( 2 ).toVar();
			const closestPositionTexel = vec2( 0 ).toVar();
			const farthestDepth = float( - 1 ).toVar();

			for ( const [ x, y ] of [ [ 0, 0 ], [ - 1, 0 ], [ 1, 0 ], [ 0, - 1 ], [ 0, 1 ] ] ) {

				const neighbor = positionTexel.add( vec2( x, y ) ).toVar();
				let depth = this.depthNode.load( neighbor ).r;
				if ( builder.renderer.reversedDepthBuffer ) depth = depth.oneMinus();
				if ( builder.renderer.logarithmicDepthBuffer ) depth = logarithmicToPerspectiveDepth( depth );
				depth = depth.toVar();

				If( depth.lessThan( closestDepth ), () => {

					closestDepth.assign( depth );
					closestPositionTexel.assign( neighbor );

				} );

				If( depth.greaterThan( farthestDepth ), () => {

					farthestDepth.assign( depth );

				} );

			}

			return currentDepthStruct( closestDepth, closestPositionTexel, farthestDepth );

		} );

		// Samples a previous depth and reproject it using the current camera matrices.
		const samplePreviousDepth = ( uv ) => {

			let depth = this._previousDepthNode.sample( uv ).r;
			// The copied history depth retains the backend's reversed-Z encoding. Current
			// neighborhood samples are converted above, so the previous sample must be
			// converted too before reconstruction; comparing opposite conventions rejected
			// valid history at every distant silhouette on Metal/WebGPU.
			if ( builder.renderer.reversedDepthBuffer ) depth = depth.oneMinus();
			if ( builder.renderer.logarithmicDepthBuffer ) depth = logarithmicToPerspectiveDepth( depth );
			const positionView = getViewPosition( uv, depth, this._previousCameraProjectionMatrixInverse );
			const positionWorld = this._previousCameraWorldMatrix.mul( vec4( positionView, 1 ) ).xyz;
			const viewZ = this._cameraWorldMatrixInverse.mul( vec4( positionWorld, 1 ) ).z;
			return this.camera.isOrthographicCamera
				? viewZToOrthographicDepth( viewZ, this._cameraNearFar.x, this._cameraNearFar.y )
				: viewZToPerspectiveDepth( viewZ, this._cameraNearFar.x, this._cameraNearFar.y );

		};

		// Optimized version of AABB clipping.
		// Reference: https://github.com/playdeadgames/temporal
		const clipAABB = Fn( ( [ currentColor, historyColor, minColor, maxColor ] ) => {

			const pClip = maxColor.rgb.add( minColor.rgb ).mul( 0.5 );
			const eClip = maxColor.rgb.sub( minColor.rgb ).mul( 0.5 ).add( 1e-7 );
			const vClip = historyColor.sub( vec4( pClip, currentColor.a ) );
			const vUnit = vClip.xyz.div( eClip );
			const absUnit = vUnit.abs();
			const maxUnit = max( absUnit.x, absUnit.y, absUnit.z );
			return maxUnit.greaterThan( 1 ).select(
				vec4( pClip, currentColor.a ).add( vClip.div( maxUnit ) ),
				historyColor
			);

		} ).setLayout( {
			name: 'clipAABB',
			type: 'vec4',
			inputs: [
				{ name: 'currentColor', type: 'vec4' },
				{ name: 'historyColor', type: 'vec4' },
				{ name: 'minColor', type: 'vec4' },
				{ name: 'maxColor', type: 'vec4' }
			]
		} );

		// Performs variance clipping.
		// See: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf
		const sampleComparableDepth = ( positionTexel ) => {

			let depth = this.depthNode.load( positionTexel ).r;
			if ( builder.renderer.reversedDepthBuffer ) depth = depth.oneMinus();
			if ( builder.renderer.logarithmicDepthBuffer ) depth = logarithmicToPerspectiveDepth( depth );
			return depth;

		};

		// Cloud transport is rendered after Scene MRT but before this resolve. Build
		// the same explicit world ray used by the cloud quad for analytic background
		// fill; positionWorldDirection would resolve against the wrong fullscreen
		// camera here.
		const worldDirectionForUv = ( sampleUV ) => {

			const ndc = vec2(
				sampleUV.x.mul( 2 ).sub( 1 ),
				sampleUV.y.mul( - 2 ).add( 1 ),
			);
			const viewDirection = this._cameraProjectionMatrixInverse
				.mul( vec4( ndc, 1, 1 ) ).xyz.normalize();
			return this._cameraWorldMatrix
				.mul( vec4( viewDirection, 0 ) ).xyz.normalize();

		};

		const cameraWorldPosition = this._cameraWorldMatrix.mul( vec4( 0, 0, 0, 1 ) ).xyz;

		const sampleDepthAwareCloud = ( sampleUV, sceneDepth, finiteGeometry ) => {

			const lowResSize = this.cloudNode.size();
			const lowResCoordinate = sampleUV.mul( lowResSize ).sub( 0.5 )
				.clamp( vec2( 0 ), lowResSize.sub( 1 ) );
			const lowResBase = lowResCoordinate.floor();
			const lowResFraction = lowResCoordinate.fract();
			const fullViewPosition = getViewPosition(
				sampleUV, sceneDepth, this._cameraProjectionMatrixInverse,
			);
			const fullWorldPosition = this._cameraWorldMatrix
				.mul( vec4( fullViewPosition, 1 ) ).xyz;
			const fullOpaqueDistance = finiteGeometry.select(
				fullWorldPosition.sub( cameraWorldPosition ).length(), 0,
			);
			const distanceTolerance = fullOpaqueDistance.mul( 0.04 ).max( 6 );
			const fallbackTolerance = fullOpaqueDistance.mul( 0.12 ).max( 24 );

			const compatibleTransport = vec4( 0, 0, 0, 0 ).toVar();
			const compatibleWeight = float( 0 ).toVar();
			const compatibleCount = float( 0 ).toVar();
			const nearestCompatibleTransport = vec4( 0, 0, 0, 0 ).toVar();
			const nearestCompatibleMetric = float( 1e9 ).toVar();
			const nearestCompatibleFound = float( 0 ).toVar();

			for ( const [ x, y ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

				const tapTexel = lowResBase.add( vec2( x, y ) )
					.clamp( vec2( 0 ), lowResSize.sub( 1 ) );
				const tapTransport = this.cloudNode.load( tapTexel );
				const tapSource = this.cloudSourceNode.load( tapTexel );
				const tapFinite = tapSource.r.greaterThan( 0.5 );
				const classCompatible = tapFinite.notEqual( finiteGeometry ).not();
				const tapDistanceDelta = tapSource.g.sub( fullOpaqueDistance ).abs();
				const distanceCompatible = tapDistanceDelta.lessThan( distanceTolerance );
				// Sky never consumes a finite/geometry-clamped tap. Finite pixels require
				// both class and opaque-distance agreement for normal bilinear reconstruction.
				const compatible = finiteGeometry
					.select( classCompatible.and( distanceCompatible ), classCompatible );
				const weight = ( x === 0 ? lowResFraction.x.oneMinus() : lowResFraction.x )
					.mul( y === 0 ? lowResFraction.y.oneMinus() : lowResFraction.y );

				If( compatible, () => {

					compatibleTransport.addAssign( tapTransport.mul( weight ) );
					compatibleWeight.addAssign( weight );
					compatibleCount.addAssign( 1 );

				} );

				// Bounded nearest-compatible fallback handles a narrow edge where no tap
				// passes strict distance agreement, while still obeying source class.
				const fallbackMetric = finiteGeometry.select( tapDistanceDelta, 0 );
				If( classCompatible.and( fallbackMetric.lessThan( nearestCompatibleMetric ) ), () => {

					nearestCompatibleTransport.assign( tapTransport );
					nearestCompatibleMetric.assign( fallbackMetric );
					nearestCompatibleFound.assign( 1 );

				} );

			}

			const ordinaryBilinear = this.cloudNode.sample( sampleUV );
			const compatibleAverage = compatibleTransport.div( compatibleWeight.max( 0.0001 ) );
			const boundedFallback = nearestCompatibleMetric.lessThan( fallbackTolerance )
				.and( nearestCompatibleFound.greaterThan( 0.5 ) );
			const hasNormalBilinear = compatibleCount.greaterThan( 3.5 );
			const neutralTransport = vec4( 0, 0, 0, 1 );
			return hasNormalBilinear.select(
				ordinaryBilinear,
				compatibleWeight.greaterThan( 0.0001 ).select(
					compatibleAverage,
					boundedFallback.select( nearestCompatibleTransport, neutralTransport ),
				),
			);

		};

		const sampleCloudComposite = ( positionTexel, textureSize, skyRadianceOverride = null ) => {

			const sampleUV = positionTexel.add( 0.5 ).div( textureSize );
			const sceneColor = this.beautyNode.load( positionTexel ).max( 0 );
			// The depth read is unconditional for every full-resolution TRAA pixel.
			// It decides whether the opaque scene or analytic sky is the incoming
			// radiance, while the cloud layer always composes physically in front.
			const sceneDepth = sampleComparableDepth( positionTexel );
			const finiteGeometry = sceneDepth.lessThan( 0.999999 );
			const cloudLayer = sampleDepthAwareCloud( sampleUV, sceneDepth, finiteGeometry );
			const cloudScatter = cloudLayer.rgb;
			const cloudTransmittance = cloudLayer.a;
			// The center pixel's sky is shared by the four variance neighbors. Sky
			// changes slowly over that footprint; reusing it avoids five analytic
			// atmosphere evaluations per moving TRAA pixel without changing cloud
			// transport or depth coverage.
			const analyticSky = ( skyRadianceOverride || this.cloudSky.skyRadiance(
				worldDirectionForUv( sampleUV ), { includeSun: true },
			) ).max( 0 );
			const sceneRadiance = finiteGeometry.select( sceneColor.rgb, analyticSky );
			// This is the only cloud/scene composition rule: opaque geometry remains
			// visible through front clouds, and behind-geometry cloud samples were
			// already rejected by the depth-clamped cloud interval.
			const compositedRadiance = sceneRadiance.mul( cloudTransmittance ).add( cloudScatter );
			return vec4( compositedRadiance, 1 );

		};

		const sampleCurrentColor = ( positionTexel, textureSize, skyRadianceOverride = null ) => {

			const sceneColor = this.beautyNode.load( positionTexel ).max( 0 );
			if ( this.cloudNode ) return sampleCloudComposite( positionTexel, textureSize, skyRadianceOverride );
			if ( ! this.backgroundNode ) return sceneColor;
			const sampleUV = positionTexel.add( 0.5 ).div( textureSize );
			const backgroundColor = this.backgroundNode.sample( sampleUV );
			return sampleComparableDepth( positionTexel )
				.lessThan( 0.999999 )
				.select( sceneColor, backgroundColor )
				.max( 0 );

		};

		const varianceClipping = Fn( ( [ positionTexel, currentColor, historyColor, gamma, textureSize ] ) => {

			// Match the depth edge detector's five-tap cross. Diagonals duplicate the
			// same local range for ordinary edges but cost four extra beauty, depth, and
			// atmosphere fetches at every full-resolution pixel. Static thin edges retain
			// their completed Halton average below, so their stability does not depend on
			// inflating this moving-history clip neighborhood.
			const offsets = this.cloudNode ? [] : [
				[ 1, 0 ],
				[ 0, - 1 ],
				[ 0, 1 ],
				[ - 1, 0 ]
			];

			const moment1 = currentColor.toVar();
			const moment2 = currentColor.pow2().toVar();

			for ( const [ x, y ] of offsets ) {

				// Every neighborhood sample must use the same depth-based background
				// composition as the center pixel. Sampling raw beauty here treats sky as
				// black and gives old terrain history an invalid but very broad clipping
				// range at moving silhouettes.
				const neighbor = sampleCurrentColor( positionTexel.add( vec2( x, y ) ), textureSize );
				moment1.addAssign( neighbor );
				moment2.addAssign( neighbor.pow2() );

			}

			const N = float( offsets.length + 1 );
			const mean = moment1.div( N );
			const variance = moment2.div( N ).sub( mean.pow2() ).max( 0 ).sqrt().mul( gamma );
			const minColor = mean.sub( variance );
			const maxColor = mean.add( variance );
			return clipAABB( mean.clamp( minColor, maxColor ), historyColor, minColor, maxColor );

		} );

		// Returns the amount of subpixel (expressed within [0, 1]) in the velocity.
		const subpixelCorrection = Fn( ( [ velocityUV, textureSize ] ) => {

			const velocityTexel = velocityUV.mul( textureSize );
			const phase = velocityTexel.fract().abs();
			const weight = max( phase, phase.oneMinus() );
			return weight.x.mul( weight.y ).oneMinus().div( 0.75 );

		} ).setLayout( {
			name: 'subpixelCorrection',
			type: 'float',
			inputs: [
				{ name: 'velocityUV', type: 'vec2' },
				{ name: 'textureSize', type: 'ivec2' }
			]
		} );

		// Flicker reduction based on luminance weighing.
		const flickerReduction = Fn( ( [ currentColor, historyColor, currentWeight ] ) => {

			const historyWeight = currentWeight.oneMinus();
			const compressedCurrent = currentColor.mul( float( 1 ).div( ( max( currentColor.r, currentColor.g, currentColor.b ).add( 1 ) ) ) );
			const compressedHistory = historyColor.mul( float( 1 ).div( ( max( historyColor.r, historyColor.g, historyColor.b ).add( 1 ) ) ) );

			const luminanceCurrent = luminance( compressedCurrent.rgb );
			const luminanceHistory = luminance( compressedHistory.rgb );

			currentWeight.mulAssign( float( 1 ).div( luminanceCurrent.add( 1 ) ) );
			historyWeight.mulAssign( float( 1 ).div( luminanceHistory.add( 1 ) ) );

			return add( currentColor.mul( currentWeight ), historyColor.mul( historyWeight ) ).div( max( currentWeight.add( historyWeight ), 0.00001 ) ).toVar();

		} );

		this._historyTextureNode ??= texture( this._historyRenderTarget.texture );
		const historyNode = this._historyTextureNode;

		const resolve = Fn( () => {

			const uvNode = uv();
			const textureSize = this.beautyNode.size(); // Assumes all the buffers share the same size.
			const positionTexel = uvNode.mul( textureSize );

			// sample the closest and farthest depths in the current buffer

			const currentDepth = sampleCurrentDepth( positionTexel );
			const closestDepth = currentDepth.get( 'closestDepth' );
			const closestPositionTexel = currentDepth.get( 'closestPositionTexel' );
			const farthestDepth = currentDepth.get( 'farthestDepth' );

			// convert the NDC offset to UV offset

			const velocitySample = this.velocityNode.load( closestPositionTexel );
			const offsetUV = velocitySample.xy.mul( vec2( 0.5, - 0.5 ) );
			const reactiveThinGeometry = velocitySample.z.greaterThan( 0.5 );

			// sample the previous depth

			const historyUV = uvNode.sub( offsetUV );
			const motionFactor = uvNode.sub( historyUV ).mul( textureSize).length().div( this.maxVelocityLength ).saturate();
			const previousDepth = samplePreviousDepth( historyUV );

			// History is valid only when the reprojected surface still occupies this
			// pixel. Sky/geometry crossings are always rejected: that is the hard rule
			// that prevents old ground from surviving in newly exposed sky. At an edge
			// between finite geometry depths, only explicitly tagged thin/reactive material
			// may retain clipped history to integrate fractional coverage. Other objects
			// keep strict depth rejection, so a moving ball or bunker edge cannot inherit
			// unrelated background history.

			const isValidUV = historyUV.greaterThanEqual( 0 ).all().and( historyUV.lessThanEqual( 1 ).all() );
			const centerDepth = sampleComparableDepth( positionTexel );
			// Compare linear view-space metres, not nonlinear perspective-depth units.
			// A fixed depth-buffer epsilon is overly strict nearby and too permissive at
			// distance, which both misses far grass edges and retains finite-object ghosts.
			const depthToViewZ = ( depth ) => this.camera.isOrthographicCamera
				? orthographicDepthToViewZ( depth, this._cameraNearFar.x, this._cameraNearFar.y )
				: perspectiveDepthToViewZ( depth, this._cameraNearFar.x, this._cameraNearFar.y );
			const centerViewZ = depthToViewZ( centerDepth );
			const previousViewZ = depthToViewZ( previousDepth );
			const closestViewZ = depthToViewZ( closestDepth );
			const farthestViewZ = depthToViewZ( farthestDepth );
			const depthToleranceM = centerViewZ.abs().mul( this.depthThreshold ).max( 0.03 );
			const edgeToleranceM = centerViewZ.abs().mul( this.edgeDepthDiff ).max( 0.015 );
			const depthMismatch = centerViewZ.sub( previousViewZ ).abs().greaterThan( depthToleranceM );
			const isDepthEdge = farthestViewZ.sub( closestViewZ ).abs().greaterThan( edgeToleranceM );
			const centerIsSky = centerDepth.greaterThanEqual( 0.999999 );
			const previousIsSky = previousDepth.greaterThanEqual( 0.999999 );
			// Zero-motion sky/silhouette coverage is just the Halton sample pattern and
			// must accumulate. Any real reprojection motion restores strict rejection so
			// newly exposed sky can never inherit old terrain.
			const crossedSkyBoundary = centerIsSky.notEqual( previousIsSky )
				.and( motionFactor.greaterThanEqual( 0.001 ) );
			const effectivelyStatic = motionFactor.lessThan( 0.001 );
			// A frozen sky has no finite depth/velocity signal, so the ordinary
			// variance clip treats deterministic Halton coverage as cloud motion and
			// reintroduces one-frame luma deltas. Retain the same running-average
			// weighting used for static thin geometry, but only while the camera and
			// reprojected sky are stationary; moving views still use strict history.
			const staticSkyCoverage = centerIsSky.and( effectivelyStatic );
			const mayIntegrateEdgeCoverage = isDepthEdge
				.and( reactiveThinGeometry.or( effectivelyStatic ) );
			const isDisocclusion = crossedSkyBoundary
				.or( depthMismatch.and( mayIntegrateEdgeCoverage.not() ) );
			const hasValidHistory = isValidUV
				.and( isDisocclusion.not() )
				.and( this._historyValid.greaterThan( 0.5 ) );

			// sample the current and previous colors

			const backgroundColor = this.backgroundNode ? this.backgroundNode.sample( uvNode ) : vec4( 0 );
			let currentColor = this.beautyNode.sample( uvNode );
			if ( this.cloudNode ) {

				// The center sample must use the same depth-aware transport composition
				// as the variance neighborhood. Leaving it as raw MRT beauty turns every
				// clear-depth pixel black because cloudy weather intentionally disables
				// the scene background.
				currentColor = sampleCloudComposite( positionTexel, textureSize );

			} else if ( this.backgroundNode ) {

				// The sky varies slowly over a 3x3 full-resolution footprint, so one
				// filtered quarter-resolution sample is shared by the center and variance
				// neighborhood. Depth still supplies exact per-pixel coverage.
				currentColor = sampleComparableDepth( positionTexel )
					.lessThan( 0.999999 )
					.select( currentColor, backgroundColor );

			}
			const historyColor = historyNode.sample( uvNode.sub( offsetUV ) );

			// increase the weight towards the current frame under motion

			const currentWeight = float( this.staticCurrentWeight ).toVar();
			const staticBlend = smoothstep( 0.001, 0.01, motionFactor ).oneMinus();
			const thinStaticBlend = isDepthEdge.or( staticSkyCoverage ).select( staticBlend, float( 0 ) );

			if ( this.useSubpixelCorrection ) {

				// Increase the minimum weight towards the current frame when the velocity is more subpixel.
				currentWeight.addAssign( subpixelCorrection( offsetUV, textureSize ).mul( 0.25 ) );

			}

			currentWeight.assign( hasValidHistory.select( currentWeight.add( motionFactor ).saturate(), 1 ) );
			// Accumulate one exact running average over the complete Halton cycle, then
			// retain it while this depth edge is genuinely static. Camera motion resets
			// age on the CPU; deformation velocity selects the normal moving path here.
			const staticThinWeight = this._historyAge.lessThan( 31.5 )
				.select( float( 1 ).div( this._historyAge.add( 1 ) ), float( 0 ) );
			currentWeight.assign( mix( currentWeight, staticThinWeight, thinStaticBlend ) );

			// Perform neighborhood clipping/clamping. We use variance clipping here.

			// A stationary, non-edge pixel already has a valid history and no new
			// information to clamp. Running the five-tap neighborhood (four beauty
			// reads plus four depth reads) there was pure duplicate work: it cannot
			// reject a disocclusion because the depth/velocity tests above have already
			// accepted the history. Keep the full clip for moving pixels, where it
			// protects against deformation/camera reprojection, and for finite moving
			// edges. Static edges intentionally use the completed Halton average below;
			// skipping the clip in that case preserves thin-blade coverage and avoids
			// reintroducing the old edge crawl.
			const movingVarianceGamma = mix( 0.5, 1.0, motionFactor.oneMinus().pow2() );
			const varianceGamma = mix( movingVarianceGamma, 4.0, staticBlend );
			const needsVarianceClip = hasValidHistory.and(
				effectivelyStatic.not().or( isDepthEdge.and( thinStaticBlend.lessThan( 0.5 ) ) )
			);
			const clippedHistoryColor = historyColor.toVar();
			If( needsVarianceClip, () => {
				clippedHistoryColor.assign( varianceClipping( positionTexel, currentColor, historyColor, varianceGamma, textureSize ) );
			} );
			// A fully static depth edge is the signal TRAA is meant to integrate. Re-clipping
			// that history to each jittered coverage sample makes blades crawl forever.
			// Blend this exception away over the first ~1.3 px of real reprojection motion;
			// sky crossings and invalid depth still force currentWeight to one above.
			const resolvedHistoryColor = mix( clippedHistoryColor, historyColor, thinStaticBlend );

			// flicker reduction based on luminance weighing

			const output = flickerReduction( currentColor, resolvedHistoryColor, currentWeight );

			return output;

		} );

		// materials

		this._resolveMaterial.colorNode = resolve();

		return this._textureNode;

	}

	/**
	 * Frees internal resources. This method should be called
	 * when the effect is no longer required.
	 */
	dispose() {

		this._historyRenderTarget.dispose();
		this._resolveRenderTarget.dispose();
		this._previousDepthTexture.dispose();

		this._resolveMaterial.dispose();

	}

}

export default TRAANode;

function _halton( index, base ) {

	let fraction = 1;
	let result = 0;
	while ( index > 0 ) {

		fraction /= base;
		result += fraction * ( index % base );
		index = Math.floor( index / base );

	}

	return result;

}

const _haltonOffsets = /*@__PURE__*/ Array.from(
	{ length: 32 },
	( _, index ) => [ _halton( index + 1, 2 ), _halton( index + 1, 3 ) ]
);

/**
 * TSL function for creating a TRAA node for Temporal Reprojection Anti-Aliasing.
 *
 * @tsl
 * @function
 * @param {TextureNode} beautyNode - The texture node that represents the input of the effect.
 * @param {TextureNode} depthNode - A node that represents the scene's depth.
 * @param {TextureNode} velocityNode - A node that represents the scene's velocity.
 * @param {Camera} camera - The camera the scene is rendered with.
 * @returns {TRAANode}
 */
export const traa = (
	beautyNode,
	depthNode,
	velocityNode,
	camera,
	backgroundNode = null,
	cloudNode = null,
	cloudSky = null,
	cloudSourceNode = null,
) => new TRAANode(
	convertToTexture( beautyNode ), depthNode, velocityNode, camera,
	backgroundNode, cloudNode, cloudSky, cloudSourceNode,
);
