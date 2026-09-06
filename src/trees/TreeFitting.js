import { createRng, deriveSeed } from '../util/random.js';
import { normalizeTreeDefinition } from './TreeDefinition.js';
import { generateTreeSkeleton } from './TreeGenerator.js';

const FIT_FIELDS = Object.freeze([
  // Projection fitting normalizes the mask bounds, so global scale is not
  // observable and must retain its authored metre value.
  ['ratio', 0.25], ['ratioPower', 0.18], ['flare', 0.25],
  ['levelsParameters', 1, 'downAngle', 0.18], ['levelsParameters', 1, 'rotate', 0.12],
  ['levelsParameters', 1, 'branches', 0.2], ['levelsParameters', 1, 'length', 0.22],
  ['levelsParameters', 1, 'curve', 0.25], ['levelsParameters', 2, 'branches', 0.2],
  ['levelsParameters', 2, 'length', 0.22], ['levelsParameters', 2, 'downAngle', 0.18],
  ['pruning', 'width', 0.2], ['pruning', 'peak', 0.15],
]);
const PCA_FIELDS = Object.freeze([
  ['gScale'], ['gScaleV'], ['ratio'], ['ratioPower'], ['flare'], ['baseSplits'],
  ['levelsParameters', 1, 'downAngle'], ['levelsParameters', 1, 'rotate'],
  ['levelsParameters', 1, 'branches'], ['levelsParameters', 1, 'length'],
  ['levelsParameters', 1, 'curve'], ['levelsParameters', 2, 'branches'],
  ['levelsParameters', 2, 'length'], ['levelsParameters', 2, 'downAngle'],
  ['pruning', 'width'], ['pruning', 'peak'], ['leaves', 'scale'], ['leaves', 'scaleX'],
]);

export function rasterizeTreeSilhouette(skeleton, { view = 'front', width = 128, height = 128, padding = 5 } = {}) {
  if (!['front', 'side', 'top'].includes(view)) throw new TypeError(`Unsupported silhouette view "${view}".`);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 512 || height > 512) throw new RangeError('Silhouette dimensions must be integers in [16, 512].');
  const axes = view === 'front' ? [0, 1] : view === 'side' ? [2, 1] : [0, 2];
  const points = [];
  for (const segment of skeleton.segments) points.push(segment.start, segment.end);
  for (const leaf of [...skeleton.leaves, ...skeleton.blossoms]) points.push(leaf.position);
  if (!points.length) return new Uint8Array(width * height);
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 2; axis++) { min[axis] = Math.min(min[axis], point[axes[axis]]); max[axis] = Math.max(max[axis], point[axes[axis]]); }
  const span = [Math.max(0.001, max[0] - min[0]), Math.max(0.001, max[1] - min[1])];
  const scale = Math.min((width - padding * 2) / span[0], (height - padding * 2) / span[1]);
  const offset = [(width - span[0] * scale) * 0.5, (height - span[1] * scale) * 0.5];
  const project = (point) => [offset[0] + (point[axes[0]] - min[0]) * scale, height - 1 - (offset[1] + (point[axes[1]] - min[1]) * scale)];
  const pixels = new Uint8Array(width * height);
  for (const segment of skeleton.segments) drawThickLine(pixels, width, height, project(segment.start), project(segment.end), Math.max(0.55, (segment.radius0 + segment.radius1) * 0.5 * scale));
  const maxFoliage = Math.min(5000, skeleton.leaves.length);
  const leafStride = Math.max(1, Math.ceil(skeleton.leaves.length / Math.max(1, maxFoliage)));
  for (let index = 0; index < skeleton.leaves.length; index += leafStride) {
    const leaf = skeleton.leaves[index], center = project(leaf.position);
    drawDisc(pixels, width, height, center[0], center[1], Math.max(0.65, leaf.scale * scale * 0.6));
  }
  for (const blossom of skeleton.blossoms) { const center = project(blossom.position); drawDisc(pixels, width, height, center[0], center[1], Math.max(0.65, blossom.scale * scale)); }
  return pixels;
}

export function silhouetteFitness(candidate, target) {
  if (!(candidate instanceof Uint8Array) || !(target instanceof Uint8Array) || candidate.length !== target.length || candidate.length === 0) throw new TypeError('Silhouette masks must be equally sized Uint8Array values.');
  let different = 0;
  for (let index = 0; index < target.length; index++) if (Boolean(candidate[index]) !== Boolean(target[index])) different++;
  return 1 - different / target.length;
}

export function fitTreeToSilhouettes(rawDefinition, targets, {
  seed = 1, population = 12, generations = 24, onGeneration = null, locked = [],
} = {}) {
  if (!Array.isArray(locked) || locked.some(path => typeof path !== 'string')) throw new TypeError('locked must contain parameter paths');
  const definition = normalizeTreeDefinition(rawDefinition);
  if (definition.generator !== 'parametric') throw new TypeError('Image fitting currently requires a parametric tree definition.');
  for (const view of ['front', 'side', 'top']) if (!(targets?.[view] instanceof Uint8Array)) throw new TypeError(`Missing ${view} silhouette mask.`);
  const size = Math.sqrt(targets.front.length);
  if (!Number.isInteger(size) || targets.side.length !== size * size || targets.top.length !== size * size) throw new TypeError('Fitting masks must be equal square images.');
  population = boundedInteger(population, 4, 64, 'population');
  generations = boundedInteger(generations, 1, 200, 'generations');
  const rng = createRng(seed);
  let candidates = Array.from({ length: population }, (_, index) => mutateDefinition(definition, rng, index === 0 ? 0 : 0.32, locked));
  let best = null;
  const history = [];
  for (let generation = 0; generation < generations; generation++) {
    const scored = candidates.map((candidate, index) => scoreCandidate(candidate, targets, size, deriveSeed(seed, `${generation}:${index}`))).sort((a, b) => b.fitness - a.fitness);
    if (!best || scored[0].fitness > best.fitness) best = scored[0];
    history.push(best.fitness);
    onGeneration?.({ generation, fitness: best.fitness });
    const first = scored[0].definition, second = scored[1].definition;
    candidates = [first, second];
    while (candidates.length < population) candidates.push(mutateDefinition(blendTreeDefinitions(first, second, rng()), rng, Math.max(0.035, 0.24 * (1 - generation / generations)), locked));
  }
  return Object.freeze({ definition: best.definition, fitness: best.fitness, views: best.views, history: Object.freeze(history) });
}

function scoreCandidate(definition, targets, size, seed) {
  const fitDefinition = structuredClone(definition);
  fitDefinition.parameters.leaves.count = Math.min(fitDefinition.parameters.leaves.count, 600);
  fitDefinition.parameters.blossoms.count = 0;
  const skeleton = generateTreeSkeleton(fitDefinition, { seed });
  const views = {};
  let total = 0;
  for (const view of ['front', 'side', 'top']) {
    views[view] = rasterizeTreeSilhouette(skeleton, { view, width: size, height: size });
    total += silhouetteFitness(views[view], targets[view]);
  }
  const budgetPenalty = Math.max(0, skeleton.segments.length - 9000) / 90000;
  return { definition, views, fitness: Math.max(0, total / 3 - budgetPenalty) };
}

function mutateDefinition(rawDefinition, rng, strength, locked = []) {
  const definition = structuredClone(rawDefinition);
  for (const field of FIT_FIELDS) {
    if (strength === 0 || rng() > 0.68) continue;
    const factor = field.at(-1), path = field.slice(0, -1), current = readPath(definition.parameters, path);
    if (current === undefined || locked.some(lock => path.join('.') === lock || path.join('.').startsWith(`${lock}.`))) continue;
    const value = current * (1 + (rng() * 2 - 1) * factor * strength * 3);
    writePath(definition.parameters, path, Number.isInteger(current) ? Math.max(0, Math.round(value)) : value);
  }
  return normalizeTreeDefinition(definition);
}

export function analyzeTreeSpace(rawDefinitions) {
  if (!Array.isArray(rawDefinitions) || rawDefinitions.length < 3) throw new TypeError('PCA requires at least three tree definitions.');
  const definitions = rawDefinitions.map((definition) => normalizeTreeDefinition(definition));
  if (definitions.some((definition) => definition.generator !== 'parametric')) throw new TypeError('PCA currently accepts parametric definitions only.');
  const rows = definitions.map(flattenDefinition);
  const means = columnMeans(rows), deviations = columnStddev(rows, means);
  const standardized = rows.map((row) => row.map((value, index) => (value - means[index]) / deviations[index]));
  const covariance = covarianceMatrix(standardized);
  const first = powerIteration(covariance, 0);
  const deflated = covariance.map((row, i) => row.map((value, j) => value - first.value * first.vector[i] * first.vector[j]));
  const second = powerIteration(deflated, 1);
  const projections = standardized.map((row, index) => ({
    id: definitions[index].id,
    x: dot(row, first.vector),
    y: dot(row, second.vector),
  }));
  return deepFreeze({ fields: PCA_FIELDS.map((path) => path.join('.')), means, deviations, components: [first.vector, second.vector], eigenvalues: [first.value, second.value], projections });
}

export function blendTreeDefinitions(firstRaw, secondRaw, amount = 0.5) {
  const first = normalizeTreeDefinition(firstRaw), second = normalizeTreeDefinition(secondRaw);
  if (first.generator !== 'parametric' || second.generator !== 'parametric') throw new TypeError('Tree blending requires parametric definitions.');
  if (first.parameters.leaves.shape !== second.parameters.leaves.shape) throw new TypeError('Cannot blend incompatible foliage families');
  amount = Math.max(0, Math.min(1, amount));
  const result = structuredClone(amount < 0.5 ? first : second);
  result.id = first.id;
  result.seed = Math.round(first.seed + (second.seed - first.seed) * amount) >>> 0;
  for (const path of PCA_FIELDS) {
    const a = readPath(first.parameters, path), b = readPath(second.parameters, path);
    if (a === undefined || b === undefined) continue;
    writePath(result.parameters, path, Number.isInteger(a) && Number.isInteger(b) ? Math.round(a + (b - a) * amount) : a + (b - a) * amount);
  }
  return normalizeTreeDefinition(result);
}

function flattenDefinition(definition) { return PCA_FIELDS.map((path) => readPath(definition.parameters, path)); }
function readPath(value, path) { return path.reduce((current, key) => current?.[key], value); }
function writePath(value, path, replacement) { const parent = path.slice(0, -1).reduce((current, key) => current?.[key], value); parent[path.at(-1)] = replacement; }
function columnMeans(rows) { return rows[0].map((_, column) => rows.reduce((sum, row) => sum + row[column], 0) / rows.length); }
function columnStddev(rows, means) { return means.map((mean, column) => Math.sqrt(rows.reduce((sum, row) => sum + (row[column] - mean) ** 2, 0) / Math.max(1, rows.length - 1)) || 1); }
function covarianceMatrix(rows) { const columns = rows[0].length; return Array.from({ length: columns }, (_, i) => Array.from({ length: columns }, (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0) / Math.max(1, rows.length - 1))); }
function powerIteration(matrix, offset) { let vector = Array.from({ length: matrix.length }, (_, index) => ((index + offset) % matrix.length) + 1); vector = unit(vector); for (let iteration = 0; iteration < 80; iteration++) vector = unit(matrix.map((row) => dot(row, vector))); const multiplied = matrix.map((row) => dot(row, vector)); return { vector, value: dot(vector, multiplied) }; }
function unit(vector) { const length = Math.hypot(...vector) || 1; return vector.map((value) => value / length); }
function dot(first, second) { return first.reduce((sum, value, index) => sum + value * second[index], 0); }
function boundedInteger(value, min, max, name) { if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}].`); return value; }
function drawThickLine(pixels, width, height, start, end, radius) { const distance = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]))); for (let step = 0; step <= distance; step++) { const amount = step / distance; drawDisc(pixels, width, height, start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount, radius); } }
function drawDisc(pixels, width, height, cx, cy, radius) { const minX = Math.max(0, Math.floor(cx - radius)), maxX = Math.min(width - 1, Math.ceil(cx + radius)), minY = Math.max(0, Math.floor(cy - radius)), maxY = Math.min(height - 1, Math.ceil(cy + radius)), r2 = radius * radius; for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) pixels[y * width + x] = 255; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
