import { YARD_TO_M } from '../util/units.js';

// The named internal green contours the engine can bake (see greenContour in
// Range.js). The authoring agent must choose from these — it never writes raw
// height noise (that's the "no terrain editing" contract).
export const CONTOURS = ['tilt', 'punchbowl', 'spine', 'tier', 'crown', 'saddle'];

// Normalize a raw course.json into the internal spec Range consumes: derive green
// z from yardage, fill defaults, coerce types, and drop malformed features. This
// is the ONLY doorway course data takes into the engine — the builder agent edits
// course.json (features), and the engine bakes terrain from these features. Nobody
// edits a heightfield.
export function normalizeCourse(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const bounds = { minX: -110, maxX: 110, minZ: -340, maxZ: 30, ...(c.bounds || {}) };
  const tee = { x: 0, z: 2, boxHalfX: 3.2, z0: -2, z1: 6, ...(c.tee || {}) };
  const corridor = { c0: 32, k: 0.11, rough: 26, ...(c.corridor || {}) };
  const fringeW = num(c.fringeW, 2.2);

  const greens = arr(c.greens).map((g) => ({
    yards: g.yards,
    x: num(g.x, 0),
    z: g.z != null ? num(g.z, 0) : (g.yards != null ? -num(g.yards, 0) * YARD_TO_M : 0),
    r: clamp(num(g.r, 8), 3, 40),
    contour: CONTOURS.includes(g.contour) ? g.contour : 'tilt',
  })).filter((g) => Number.isFinite(g.x) && Number.isFinite(g.z));

  const bunkers = arr(c.bunkers).map((b) => ({
    x: num(b.x, 0), z: num(b.z, 0),
    r: clamp(num(b.r, 5), 1.5, 30),
    depth: clamp(num(b.depth, 1), 0.3, 4),
    pot: !!b.pot,
  })).filter((b) => Number.isFinite(b.x) && Number.isFinite(b.z));

  const ponds = arr(c.ponds).map((p) => ({
    x: num(p.x, 0), z: num(p.z, 0),
    r: clamp(num(p.r, 10), 2, 80),
    depth: clamp(num(p.depth, 1.4), 0.3, 6),
  })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));

  return { meta: c.meta || {}, bounds, tee, corridor, fringeW, greens, bunkers, ponds };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Fetch + normalize the live course.json (cache-busted so a fresh agent edit is
// picked up on rebuild). Falls back to an empty course on failure.
export async function loadCourse(url = '/course.json') {
  try {
    const res = await fetch(`${url}?t=${Date.now()}`);
    return normalizeCourse(await res.json());
  } catch (e) {
    console.warn('course load failed', e);
    return normalizeCourse({});
  }
}
