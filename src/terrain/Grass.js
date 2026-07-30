import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute,
  Mesh, MeshBasicNodeMaterial, Color, Vector2, Vector3, DoubleSide, Sphere,
  SRGBColorSpace,
} from 'three';
import {
  attribute, positionLocal, cameraPosition, uniform, vec2, vec3, float,
  smoothstep, mix, varying,
} from 'three/tsl';
import { surface } from '../physics/groundInteraction.js';

// GPU-instanced grass (WebGPU / TSL). Every blade is one instance of a shared
// few-segment strip; all bend, wind, distance-LOD, grazing-angle widening, and
// shading happen in a TSL NodeMaterial driven by uniform nodes. The CPU only
// runs once, at build time, to scatter the blades onto the terrain. This is the
// heavy visual layer and it must stay entirely GPU-animated.
//
// options:
//   terrain    Terrain (for height + surface filtering)
//   region     { minX, maxX, minZ, maxZ }
//   count      number of blades to attempt
//   allow      (surfaceName) => bool   which surfaces get grass
//   height     [min, max] blade height meters (used as a global scale knob;
//              the real per-blade height comes from the surface it lands on)
export class Grass {
  constructor({ terrain, region, count = 160000, allow, height = [0.06, 0.16] }) {
    this.terrain = terrain;
    // Warm sun / cool sky fill, tuned so the blade canopy sits at the same
    // luminance as the HDRI-lit PBR ground beneath it — ground and blades must
    // read as one turf, or the brighter ground shows through as a mismatched
    // patch where blades thin out.
    const sunColor = new Color(0xffefd2).multiplyScalar(1.9);
    const ambient = new Color(0x7c9db0).multiplyScalar(1.05);
    this.uTime = uniform(0);
    this.uGust = uniform(0);
    this.uWindDir = uniform(new Vector2(0.8, 0.6).normalize());
    this.uWindStrength = uniform(0.11);
    this.uSunDir = uniform(new Vector3(-0.5, 0.9, 0.35).normalize());
    this.uSunColor = uniform(new Vector3(sunColor.r, sunColor.g, sunColor.b));
    this.uAmbient = uniform(new Vector3(ambient.r, ambient.g, ambient.b));
    this.mesh = this._build(region, count, allow || (() => true), height);
  }

  _build(region, count, allow, [, hmax]) {
    const SEG = 4; // height segments -> smooth bezier curve (fewer = cheaper)
    const rows = SEG + 1;
    // Base blade strip: x in {-0.5, 0.5}, y = t in [0,1]. All width tapering,
    // curvature, and rounded-normal shading happen in the vertex shader.
    // y == t (0..1 up the blade), so positionLocal.y doubles as the uvY the
    // shader needs — no separate uvY attribute (WebGPU caps vertex buffers at 8).
    const basePos = [];
    for (let r = 0; r < rows; r++) {
      const y = r / SEG;
      basePos.push(-0.5, y, 0, 0.5, y, 0);
    }
    const idx = [];
    for (let r = 0; r < SEG; r++) {
      const a = r * 2, b = r * 2 + 1, c = r * 2 + 2, d = r * 2 + 3;
      idx.push(a, c, b, b, c, d);
    }

    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(basePos), 3));
    geo.setIndex(idx);

    // Scatter instances. Per-blade scalars are packed into one vec4 (aMisc) to
    // stay within WebGPU's 8-vertex-buffer limit.
    const offsets = [];
    const scale = [];
    const colorv = [];
    const lean = [];
    const misc = []; // vec4 per instance: [orient, phase, stiff, stripe]
    const col = new Color();
    // Global height knob so the constructor's `height` still means something:
    // everything scales relative to a 12cm reference without touching the
    // carefully-tuned per-surface ratios below.
    const gscale = hmax / 0.12;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const x = region.minX + Math.random() * (region.maxX - region.minX);
      // Importance-sample toward the near field (large z, right under the
      // address camera) so the fixed blade budget concentrates where the
      // camera actually looks. The far turf is carried by the textured ground,
      // so spending blades out there is wasted; skewing the sample instead
      // makes the immediate foreground dense for free.
      const zu = Math.pow(Math.random(), 0.6);   // skew toward 1 -> toward maxZ
      const z = region.minZ + zu * (region.maxZ - region.minZ);
      const surf = this.terrain.surfaceAt(x, z);
      if (!allow(surf)) continue;
      const spec = bladeSpec(surf);
      if (!spec) continue;                       // sand / water / path / hardpan

      // Distance thinning: keep the near field (where the camera sits at
      // address) dense enough that no ground shows between blades, and let the
      // textured ground carry the far field. This is also the main perf lever
      // for a ~900k request — far blades are culled outright.
      const dref = Math.hypot(x, z - 6);         // ~tee reference point
      const far = smooth(30, 95, dref);
      let keep = spec.keep * (1 - 0.45 * far);    // gentle; sampling bias does the rest

      // Low-frequency clumping -> tufts and bare patches. Fairway/green stay
      // mown-even; rough and deep rough clump hard (bare dirt between tufts).
      const clump = 0.5 + 0.5 * Math.sin(x * 0.35 + 1.3) * Math.cos(z * 0.31 - 0.7)
                        + 0.25 * Math.sin(x * 0.11 - z * 0.13);
      const clumpC = Math.max(0, Math.min(1, clump));
      if (spec.wispy > 0) keep *= (1 - spec.wispy * 0.5) + spec.wispy * clumpC;
      if (Math.random() > keep) continue;

      const y = this.terrain.heightAt(x, z);
      offsets.push(x, y, z);
      const orientV = Math.random() * Math.PI * 2;

      let h, w;
      if (surf === 'fairway' || surf === 'tee') {
        // Two-tier mown turf: a dense, very-short, WIDE ground-hugging under-
        // layer that closes the gaps between blades (so no bare soil shows in
        // the first ~20m), plus taller upright mown blades for texture. Real
        // tight fairway reads as a solid mat, not scattered spikes.
        if (Math.random() < 0.55) {
          h = (0.010 + Math.random() * 0.016) * gscale;   // ~1-2.6cm cover
          w = 0.010 + Math.random() * 0.006;              // wide -> overlaps
        } else {
          h = (0.030 + Math.random() * 0.026) * gscale;   // ~3-5.6cm upright
          w = 0.007 + Math.random() * 0.005;
        }
      } else {
        h = (spec.h[0] + Math.random() * (spec.h[1] - spec.h[0])) * gscale;
        if (spec.wispy > 0) h *= 0.7 + 0.6 * clumpC;   // taller inside a tuft
        w = spec.w[0] + Math.random() * (spec.w[1] - spec.w[0]);
      }
      scale.push(w, h);

      // Colour: start from the SAME muted surface base the turf ground uses, so
      // the canopy and the ground it sits on are one family and there is never a
      // bright bald seam where blades thin out.
      turfBase(surf, col);
      // Large patches of lighter/darker turf (low-freq), plus per-blade jitter.
      const drift = 0.86 + 0.22 * (0.5 + 0.5 * Math.sin(x * 0.15 + z * 0.13 + 2.0));
      const jit = 0.82 + Math.random() * 0.32;
      col.multiplyScalar(drift * jit);
      const rr = Math.random();
      if (spec.wispy > 0 && rr < 0.05) col.lerp(DRY, 0.45); // sparse sun-bleach (rough only)
      else if (rr < 0.15) col.multiplyScalar(0.82);          // shaded/darker blades

      // Mowing stripes: alternating down-range bands. The band sign both tints
      // the blade and (in the vertex shader) lays it toward or away from the
      // viewer — classic golf striping is really the light catching grass that
      // leans in opposite directions.
      let stripe = 0;
      if (surf === 'fairway' || surf === 'tee') {
        const band = Math.floor(z / STRIPE_M);
        stripe = (band & 1) ? -1 : 1;
        col.multiplyScalar(1 + 0.05 * stripe);
      }
      colorv.push(col.r, col.g, col.b);

      // Rest lean: a gentle per-blade curve so nothing is a straight spike;
      // wispier surfaces flop over further.
      const la = Math.random() * Math.PI * 2;
      const lm = spec.lean * (0.5 + Math.random());
      lean.push(Math.cos(la) * lm, Math.sin(la) * lm);

      const phaseV = Math.random() * Math.PI * 2;
      const stiffV = (spec.wispy > 0.5 ? 0.6 : 0.95) + Math.random() * 0.55;
      misc.push(orientV, phaseV, stiffV, stripe);
      placed++;
    }

    geo.setAttribute('aOffset', new InstancedBufferAttribute(new Float32Array(offsets), 3));
    geo.setAttribute('aScale', new InstancedBufferAttribute(new Float32Array(scale), 2));
    geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(colorv), 3));
    geo.setAttribute('aLean', new InstancedBufferAttribute(new Float32Array(lean), 2));
    geo.setAttribute('aMisc', new InstancedBufferAttribute(new Float32Array(misc), 4));
    geo.instanceCount = placed;

    // Bounding sphere so frustum culling doesn't drop the whole field.
    const cx = (region.minX + region.maxX) / 2;
    const cz = (region.minZ + region.maxZ) / 2;
    geo.boundingSphere = new Sphere(
      new Vector3(cx, 0, cz),
      Math.hypot(region.maxX - region.minX, region.maxZ - region.minZ),
    );

    const mesh = new Mesh(geo, this._material());
    mesh.frustumCulled = true;
    mesh.name = 'grass';
    this._placed = placed;
    return mesh;
  }

  // TSL NodeMaterial: the Ghost-of-Tsushima blade in a WebGPU node graph. Each
  // blade is a curved strip (rest lean + mow lay-over + wind, quadratic in
  // height) that carries a rounded cross-section normal so it shades like a
  // rounded surface, widens at grazing angles so it never vanishes edge-on, and
  // lies shorter with distance (LOD). Lit with soft wrap + back-lit translucency
  // + root AO, deliberately matched to the HDRI-lit ground.
  _material() {
    const t = positionLocal.y;                        // 0..1 up the blade (== uvY)
    const side = positionLocal.x;                     // -0.5 / +0.5 across width
    const aScale = attribute('aScale', 'vec2');
    const aOffset = attribute('aOffset', 'vec3');
    const aLean = attribute('aLean', 'vec2');
    const aColor = attribute('aColor', 'vec3');
    const aMisc = attribute('aMisc', 'vec4');         // [orient, phase, stiff, stripe]
    const aOrient = aMisc.x;
    const aPhase = aMisc.y;
    const aStiff = aMisc.z;
    const aStripe = aMisc.w;

    const cA = aOrient.cos();
    const sA = aOrient.sin();

    // Distance LOD: far blades lie shorter so the color-matched ground carries
    // the far field and the silhouette doesn't shimmer.
    const toCam = cameraPosition.xz.sub(aOffset.xz);
    const camDist = toCam.length();
    const H = aScale.y.mul(float(1).sub(smoothstep(35.0, 95.0, camDist).mul(0.5)));

    // Width taper to a point + grazing-angle widening (the key GoT coverage/perf
    // trick): a blade seen edge-on fattens so it stays visible instead of
    // aliasing away.
    const wBase = aScale.x.mul(float(1).sub(smoothstep(0.55, 1.0, t)));
    const facing = vec2(sA.negate(), cA);
    const viewDir = toCam.normalize();
    const edge = float(1).sub(facing.dot(viewDir).abs());
    const w = wBase.mul(float(1).add(edge.mul(edge).mul(2.0)));

    // Wind sway + rest lean + per-band mowing lay-over, curving quadratically.
    const wave = this.uTime.mul(1.6).add(aOffset.xz.dot(this.uWindDir).mul(0.35)).add(aPhase).sin();
    const wind = this.uWindStrength.mul(float(0.6).add(this.uGust.mul(0.6))).mul(wave).div(aStiff);
    const flow = aLean.add(vec2(0.0, aStripe.mul(0.5))).add(this.uWindDir.mul(wind).mul(2.2));
    const bend = flow.mul(t.mul(t)).mul(H);

    // Blade vertex position. Mesh sits at identity, aOffset is world, so object
    // space == world space here.
    const px = side.mul(w);
    const py = t.mul(H);
    const X = px.mul(cA).add(bend.x);
    const Z = px.mul(sA).add(bend.y);
    const worldP = aOffset.add(vec3(X, py, Z));

    // Rounded cross-section normal, oriented then tilted up as the blade leans.
    const round = 0.7;
    const n0x = side.mul(2.0 * round);
    const nx = n0x.mul(cA).sub(sA);
    const nz = n0x.mul(sA).add(cA);
    const slope = flow.length().mul(t);
    const N = vec3(nx, slope.mul(1.4), nz).normalize();

    // Lighting: soft wrap, back-lit translucency, gentle root-to-tip AO, plus the
    // striping tint and a faint tip sheen.
    const ndl = N.dot(this.uSunDir).max(0.0);
    const wrap = ndl.mul(0.6).add(0.4);
    const trans = N.negate().dot(this.uSunDir).max(0.0).pow(2.0).mul(0.4);
    const ao = mix(0.7, 1.0, t);
    const lightN = this.uAmbient.add(this.uSunColor.mul(wrap)).add(this.uSunColor.mul(trans));
    let c = aColor.mul(lightN).mul(ao);
    c = c.mul(float(1.0).add(aStripe.mul(0.15)));
    c = c.add(aColor.mul(t.pow(4.0).mul(0.10)));

    const mat = new MeshBasicNodeMaterial({ side: DoubleSide });
    mat.positionNode = worldP;
    // Compute the lit blade color per-vertex and interpolate (one varying) — this
    // keeps the color graph in the vertex stage where the instanced attributes
    // live, which the WebGPU node compiler is happiest with.
    mat.colorNode = varying(c);
    return mat;
  }

  update(t) {
    this.uTime.value = t;
    // Slow, breathing gust envelope.
    this.uGust.value = 0.5 + 0.5 * Math.sin(t * 0.35);
  }
}

// Mowing-stripe band width in meters (shared conceptually with the turf ground
// shader in Terrain.js so blade lean and ground bands line up in world Z).
const STRIPE_M = 6.0;

// A muted straw tone for the sparse sun-bleached blades in the rough.
const DRY = new Color(0xa79a5f);
const _hsl = { h: 0, s: 0, l: 0 };

// Turn the gameplay surface colors (tuned bright for the physics model, a bit
// neon) into natural sun-lit turf: pull the hue toward true green (cooler, less
// lime), desaturate hard to kill the neon, and drop the value for richness.
// Terrain.js runs the IDENTICAL transform on the same SURFACES color, which is
// what keeps the ground and the blades color-matched.
function turfBase(name, out) {
  out.set(surface(name).color);
  out.getHSL(_hsl, SRGBColorSpace);
  out.setHSL(
    _hsl.h + (0.31 - _hsl.h) * 0.32,
    _hsl.s * 0.68,
    _hsl.l * 0.82,
    SRGBColorSpace,
  );
  return out;
}

// Per-surface blade parameters. Real courses read as different heights of the
// same turf: tee/fairway tightly mown (2-4cm), fringe a touch longer, the green
// essentially smooth (almost no visible blades), rough tall and wispy, deep
// rough tallest and clumped.
//   keep  fraction of attempts to actually plant (before distance thinning)
//   h     [min,max] height meters   w [min,max] width meters
//   lean  rest lay-over amount      wispy 0..1 clump/floppiness
function bladeSpec(surf) {
  switch (surf) {
    case 'green':     return { keep: 0.12, h: [0.004, 0.014], w: [0.005, 0.008], lean: 0.10, wispy: 0.0 };
    case 'tee':
    case 'fairway':   return { keep: 1.00, h: [0.028, 0.050], w: [0.007, 0.011], lean: 0.14, wispy: 0.0 };
    case 'fringe':    return { keep: 1.00, h: [0.055, 0.090], w: [0.008, 0.012], lean: 0.22, wispy: 0.2 };
    case 'rough':     return { keep: 1.00, h: [0.110, 0.200], w: [0.006, 0.012], lean: 0.42, wispy: 0.7 };
    case 'deepRough': return { keep: 1.00, h: [0.170, 0.300], w: [0.006, 0.013], lean: 0.55, wispy: 1.0 };
    default:          return null; // sand / water / cartpath / hardpan -> bare
  }
}

// Smoothstep on the CPU.
function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
