import { normalizePlantControls } from './PlantControls.js';
const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TREE_SHAPES = Object.freeze([
  'conical', 'spherical', 'hemispherical', 'cylindrical', 'tapered-cylindrical',
  'flame', 'inverse-conical', 'tend-flame', 'custom',
]);
const LEAF_SHAPES = Object.freeze(['oval', 'lanceolate', 'fan', 'needle', 'cluster', 'compound', 'spray', 'pinnate', 'flower']);
const BRANCH_PATTERNS = Object.freeze(['alternate', 'opposite', 'whorled']);

export const TREE_GENERATORS = Object.freeze(['parametric', 'l-system']);
export const TREE_LIMITS = Object.freeze({
  maxLevels: 5,
  maxStems: 1800,
  maxSegments: 12000,
  maxLeaves: 24000,
  maxSymbols: 50000,
  maxIterations: 8,
  maxVariants: 4,
});

const DEFAULT_LEVEL = Object.freeze({
  baseSize: 0.15, downAngle: 55, downAngleV: 8, rotate: 137.5, rotateV: 10,
  branches: 14, length: 0.42, lengthV: 0.08, taper: 1, segSplits: 0,
  splitAngle: 24, splitAngleV: 6, curveRes: 5, curve: 10, curveV: 8,
  curveBack: 0, bendV: 6, branchDist: 1, radiusMod: 0.55,
  branchPattern: 'alternate', helixTurns: 0,
});

export const DEFAULT_PARAMETRIC_TREE = deepFreeze({
  shape: 'spherical', gScale: 16, gScaleV: 0.8, levels: 3,
  ratio: 0.035, ratioPower: 1.45, flare: 0.7, baseSplits: 0,
  levelsParameters: [
    { ...DEFAULT_LEVEL, baseSize: 0.18, branches: 1, length: 1, lengthV: 0, curveRes: 9, curve: 3, radiusMod: 1 },
    { ...DEFAULT_LEVEL, branches: 18, length: 0.48, downAngle: 58, radiusMod: 0.5 },
    { ...DEFAULT_LEVEL, branches: 9, length: 0.45, downAngle: 42, radiusMod: 0.46, curveRes: 4 },
    { ...DEFAULT_LEVEL, branches: 5, length: 0.38, downAngle: 36, radiusMod: 0.42, curveRes: 3 },
    { ...DEFAULT_LEVEL, branches: 3, length: 0.3, downAngle: 30, radiusMod: 0.38, curveRes: 2 },
  ],
  leaves: { count: 1800, shape: 'oval', scale: 0.34, scaleX: 0.62, bend: 0.25, stemLength: 0.03 },
  blossoms: { count: 0, shape: 'oval', scale: 0.12, rate: 0 },
  tropism: [0, 0.18, 0],
  pruning: { ratio: 0, width: 0.5, peak: 0.5, powerLow: 0.5, powerHigh: 0.5 },
  pruningVolumes: [],
  multipleTrunks: { count: 1, radius: 0 },
});

const LEGACY = Object.freeze({
  'broadleaf-oak': { shape: 'spherical', gScale: 17, ratio: 0.038, flare: 0.9, leaf: '#31582e', bark: '#4a3828', branches: 18 },
  'live-oak': { shape: 'hemispherical', gScale: 15, ratio: 0.046, flare: 1.1, leaf: '#2d552f', bark: '#4b3a2b', branches: 21 },
  maple: { shape: 'spherical', gScale: 18, ratio: 0.032, flare: 0.55, leaf: '#376733', bark: '#51443a', branches: 17 },
  'monterey-cypress': { shape: 'tend-flame', gScale: 16, ratio: 0.04, flare: 0.8, leaf: '#274b36', bark: '#50402f', branches: 15 },
  'douglas-fir': { shape: 'conical', gScale: 23, ratio: 0.022, flare: 0.55, leaf: '#244b38', bark: '#59402c', branches: 23 },
  'loblolly-pine': { shape: 'tapered-cylindrical', gScale: 24, ratio: 0.021, flare: 0.45, leaf: '#31573b', bark: '#68462c', branches: 20 },
});

export function legacyTreeDefinition(archetype) {
  const legacy = LEGACY[archetype];
  if (!legacy) throw new TypeError(`Unknown legacy tree archetype "${archetype}".`);
  const conifer = archetype.includes('fir') || archetype.includes('pine') || archetype.includes('cypress');
  const parameters = structuredClone(DEFAULT_PARAMETRIC_TREE);
  Object.assign(parameters, { shape: legacy.shape, gScale: legacy.gScale, ratio: legacy.ratio, flare: legacy.flare });
  Object.assign(parameters.levelsParameters[1], {
    branches: legacy.branches,
    downAngle: conifer ? 78 : 55,
    length: conifer ? 0.34 : archetype === 'live-oak' ? 0.64 : 0.48,
    rotate: conifer ? 137.5 : 112,
  });
  if (conifer) Object.assign(parameters.leaves, { count: 3000, shape: 'needle', scale: 0.22, scaleX: 0.18 });
  return normalizeTreeDefinition({
    id: `builtin-${archetype}`,
    generator: 'parametric', seed: 1, variantCount: 3, parameters,
    materials: {
      bark: { color: legacy.bark, roughness: 0.96 },
      leaves: { color: legacy.leaf, roughness: 0.9, alphaCutoff: 0.32, doubleSided: true },
      blossoms: { color: '#f2d7d9', roughness: 0.8 },
    },
  });
}

export function normalizeTreeDefinition(raw, path = 'treeDefinition') {
  const value = object(raw, path);
  exact(value, ['id', 'generator', 'seed', 'variantCount', 'parameters', 'grammar', 'materials', 'source', 'version', 'plant'], path, ['parameters', 'grammar', 'source', 'version', 'plant']);
  if (value.version !== undefined && value.version !== 2) fail(`${path}.version must be 2`);
  if (value.plant !== undefined) { if (value.version !== 2) fail(`${path}.plant requires version 2`); value.plant = normalizePlantControls(value.plant); }
  identifier(value.id, `${path}.id`);
  oneOf(value.generator, TREE_GENERATORS, `${path}.generator`);
  uint32(value.seed, `${path}.seed`);
  integer(value.variantCount, 1, TREE_LIMITS.maxVariants, `${path}.variantCount`);
  if (value.generator === 'parametric') {
    if (!value.parameters || value.grammar !== undefined) fail(`${path} parametric definitions require parameters only`);
    value.parameters = normalizeParametricParameters(value.parameters, `${path}.parameters`);
  } else {
    if (!value.grammar || value.parameters !== undefined) fail(`${path} l-system definitions require grammar only`);
    value.grammar = normalizeLSystemGrammar(value.grammar, `${path}.grammar`);
  }
  value.materials = normalizeMaterials(value.materials, `${path}.materials`);
  if (value.source !== undefined) value.source = normalizeSource(value.source, `${path}.source`);
  return deepFreeze(value);
}

export function normalizeTreePlacement(raw, definitionIds, bounds, path = 'treePlacement') {
  const value = object(raw, path);
  exact(value, ['id', 'definitionId', 'x', 'z', 'rotationY', 'scale', 'seed', 'age', 'health', 'windExposure'], path);
  identifier(value.id, `${path}.id`); identifier(value.definitionId, `${path}.definitionId`);
  if (!definitionIds.has(value.definitionId)) fail(`${path}.definitionId references missing definition "${value.definitionId}"`);
  for (const key of ['x', 'z', 'rotationY', 'scale', 'age', 'health', 'windExposure']) finite(value[key], `${path}.${key}`);
  if (value.x < bounds.minX || value.x > bounds.maxX || value.z < bounds.minZ || value.z > bounds.maxZ) fail(`${path} is outside course bounds`);
  range(value.scale, 0.36, 2.5, `${path}.scale`); range(value.age, 0, 1, `${path}.age`);
  range(value.health, 0.25, 1, `${path}.health`); range(value.windExposure, 0, 1, `${path}.windExposure`);
  uint32(value.seed, `${path}.seed`);
  return deepFreeze(value);
}

export function estimateTreeCanopyRadius(definition) {
  const value = normalizeTreeDefinition(definition);
  if (value.generator === 'l-system') return value.grammar.step * Math.max(2, value.grammar.iterations * 0.85);
  const p = value.parameters;
  const first = p.levelsParameters[1] ?? p.levelsParameters[0];
  return Math.max(1, p.gScale * first.length * crownWidth(p.shape));
}

function crownWidth(shape) {
  if (shape === 'conical' || shape === 'tend-flame') return 0.27;
  if (shape === 'tapered-cylindrical' || shape === 'flame') return 0.34;
  if (shape === 'inverse-conical') return 0.42;
  return 0.48;
}

function normalizeParametricParameters(raw, path) {
  const value = object(raw, path);
  exact(value, ['shape', 'gScale', 'gScaleV', 'levels', 'ratio', 'ratioPower', 'flare', 'baseSplits', 'levelsParameters', 'leaves', 'blossoms', 'tropism', 'pruning', 'pruningVolumes', 'multipleTrunks'], path);
  oneOf(value.shape, TREE_SHAPES, `${path}.shape`);
  range(value.gScale, 0.5, 80, `${path}.gScale`); range(value.gScaleV, 0, 20, `${path}.gScaleV`);
  integer(value.levels, 1, TREE_LIMITS.maxLevels, `${path}.levels`);
  range(value.ratio, 0.002, 0.2, `${path}.ratio`); range(value.ratioPower, 0.2, 4, `${path}.ratioPower`);
  range(value.flare, 0, 3, `${path}.flare`); range(value.baseSplits, 0, 8, `${path}.baseSplits`);
  if (!Array.isArray(value.levelsParameters) || value.levelsParameters.length < value.levels || value.levelsParameters.length > TREE_LIMITS.maxLevels) fail(`${path}.levelsParameters must cover levels and contain at most ${TREE_LIMITS.maxLevels} entries`);
  value.levelsParameters = value.levelsParameters.map((entry, index) => normalizeLevel(entry, `${path}.levelsParameters[${index}]`));
  value.leaves = normalizeLeaves(value.leaves, `${path}.leaves`);
  value.blossoms = normalizeBlossoms(value.blossoms, `${path}.blossoms`);
  if (!Array.isArray(value.tropism) || value.tropism.length !== 3) fail(`${path}.tropism must contain three numbers`);
  value.tropism.forEach((entry, index) => range(entry, -2, 2, `${path}.tropism[${index}]`));
  value.pruning = normalizePruning(value.pruning, `${path}.pruning`);
  if (!Array.isArray(value.pruningVolumes) || value.pruningVolumes.length > 32) fail(`${path}.pruningVolumes must contain at most 32 spheres`);
  value.pruningVolumes = value.pruningVolumes.map((entry, index) => {
    const sphere = object(entry, `${path}.pruningVolumes[${index}]`);
    exact(sphere, ['x', 'y', 'z', 'radius'], `${path}.pruningVolumes[${index}]`);
    for (const key of ['x', 'y', 'z']) range(sphere[key], -100, 100, `${path}.pruningVolumes[${index}].${key}`);
    range(sphere.radius, 0.05, 100, `${path}.pruningVolumes[${index}].radius`); return sphere;
  });
  const trunks = object(value.multipleTrunks, `${path}.multipleTrunks`);
  exact(trunks, ['count', 'radius'], `${path}.multipleTrunks`);
  integer(trunks.count, 1, 16, `${path}.multipleTrunks.count`); range(trunks.radius, 0, 8, `${path}.multipleTrunks.radius`);
  return value;
}

function normalizeLevel(raw, path) {
  const value = object(raw, path);
  exact(value, Object.keys(DEFAULT_LEVEL), path);
  for (const key of Object.keys(DEFAULT_LEVEL).filter((key) => key !== 'branchPattern')) finite(value[key], `${path}.${key}`);
  range(value.baseSize, 0, 0.95, `${path}.baseSize`); range(value.branches, 0, 64, `${path}.branches`);
  range(value.length, 0.02, 2, `${path}.length`); range(value.lengthV, 0, 1, `${path}.lengthV`);
  range(value.taper, 0, 3, `${path}.taper`); range(value.segSplits, 0, 4, `${path}.segSplits`);
  range(value.curveRes, 1, 24, `${path}.curveRes`); range(value.branchDist, 0.05, 4, `${path}.branchDist`);
  range(value.radiusMod, 0.05, 1, `${path}.radiusMod`); range(value.helixTurns, -6, 6, `${path}.helixTurns`);
  oneOf(value.branchPattern, BRANCH_PATTERNS, `${path}.branchPattern`);
  return value;
}

function normalizeLeaves(raw, path) {
  const value = object(raw, path); exact(value, ['count', 'shape', 'scale', 'scaleX', 'bend', 'stemLength'], path);
  integer(value.count, 0, TREE_LIMITS.maxLeaves, `${path}.count`); oneOf(value.shape, LEAF_SHAPES, `${path}.shape`);
  range(value.scale, 0.01, 3, `${path}.scale`); range(value.scaleX, 0.05, 2, `${path}.scaleX`);
  range(value.bend, -2, 2, `${path}.bend`); range(value.stemLength, 0, 2, `${path}.stemLength`); return value;
}

function normalizeBlossoms(raw, path) {
  const value = object(raw, path); exact(value, ['count', 'shape', 'scale', 'rate'], path);
  integer(value.count, 0, TREE_LIMITS.maxLeaves, `${path}.count`); oneOf(value.shape, LEAF_SHAPES, `${path}.shape`);
  range(value.scale, 0.01, 2, `${path}.scale`); range(value.rate, 0, 1, `${path}.rate`); return value;
}

function normalizePruning(raw, path) {
  const value = object(raw, path); exact(value, ['ratio', 'width', 'peak', 'powerLow', 'powerHigh'], path);
  range(value.ratio, 0, 1, `${path}.ratio`); range(value.width, 0.02, 2, `${path}.width`);
  range(value.peak, 0.01, 0.99, `${path}.peak`); range(value.powerLow, 0.01, 8, `${path}.powerLow`);
  range(value.powerHigh, 0.01, 8, `${path}.powerHigh`); return value;
}

function normalizeLSystemGrammar(raw, path) {
  const value = object(raw, path);
  exact(value, ['axiom', 'iterations', 'angle', 'step', 'radius', 'tropism', 'productions'], path);
  integer(value.iterations, 0, TREE_LIMITS.maxIterations, `${path}.iterations`);
  range(value.angle, 0.1, 180, `${path}.angle`); range(value.step, 0.01, 20, `${path}.step`);
  range(value.radius, 0.001, 4, `${path}.radius`);
  if (!Array.isArray(value.tropism) || value.tropism.length !== 3) fail(`${path}.tropism must contain three numbers`);
  value.tropism.forEach((entry, index) => range(entry, -2, 2, `${path}.tropism[${index}]`));
  value.axiom = normalizeTokens(value.axiom, `${path}.axiom`);
  const productions = object(value.productions, `${path}.productions`);
  for (const [symbol, alternatives] of Object.entries(productions)) {
    if (!/^[A-Za-z]$/.test(symbol) || !Array.isArray(alternatives) || !alternatives.length || alternatives.length > 16) fail(`${path}.productions.${symbol} is malformed`);
    productions[symbol] = alternatives.map((alternative, index) => {
      const item = object(alternative, `${path}.productions.${symbol}[${index}]`);
      exact(item, ['weight', 'condition', 'successor'], `${path}.productions.${symbol}[${index}]`, ['condition']);
      range(item.weight, 0.0001, 1000, `${path}.productions.${symbol}[${index}].weight`);
      if (item.condition !== undefined) validateExpression(item.condition, `${path}.productions.${symbol}[${index}].condition`);
      item.successor = normalizeTokens(item.successor, `${path}.productions.${symbol}[${index}].successor`); return item;
    });
  }
  value.productions = productions;
  return value;
}

function normalizeTokens(raw, path) {
  if (!Array.isArray(raw) || raw.length > TREE_LIMITS.maxSymbols) fail(`${path} must be a bounded token array`);
  return raw.map((entry, index) => {
    const token = typeof entry === 'string' ? { symbol: entry, parameters: [] } : object(entry, `${path}[${index}]`);
    exact(token, ['symbol', 'parameters'], `${path}[${index}]`, ['parameters']);
    if (typeof token.symbol !== 'string' || !/^[A-Za-z+\-&^\\/|\[\]!]$/.test(token.symbol)) fail(`${path}[${index}].symbol is unsupported`);
    token.parameters ??= [];
    if (!Array.isArray(token.parameters) || token.parameters.length > 4) fail(`${path}[${index}].parameters must be a short array`);
    token.parameters.forEach((expression, parameterIndex) => validateExpression(expression, `${path}[${index}].parameters[${parameterIndex}]`));
    return token;
  });
}

function validateExpression(value, path, depth = 0) {
  if (depth > 12) fail(`${path} expression is too deep`);
  if (typeof value === 'number') return finite(value, path);
  const expression = object(value, path);
  if ('var' in expression) { exact(expression, ['var'], path); if (!/^(p[0-3]|level|iteration)$/.test(expression.var)) fail(`${path}.var is unsupported`); return; }
  exact(expression, ['op', 'args'], path);
  oneOf(expression.op, ['+', '-', '*', '/', 'min', 'max', 'pow', '<', '<=', '>', '>=', '==', 'and', 'or'], `${path}.op`);
  if (!Array.isArray(expression.args) || expression.args.length < 1 || expression.args.length > 4) fail(`${path}.args is malformed`);
  expression.args.forEach((arg, index) => validateExpression(arg, `${path}.args[${index}]`, depth + 1));
}

function normalizeMaterials(raw, path) {
  const value = object(raw, path); exact(value, ['bark', 'leaves', 'blossoms'], path);
  value.bark = normalizeMaterial(value.bark, `${path}.bark`, false);
  value.leaves = normalizeMaterial(value.leaves, `${path}.leaves`, true);
  value.blossoms = normalizeMaterial(value.blossoms, `${path}.blossoms`, true);
  return value;
}

function normalizeMaterial(raw, path, alpha) {
  const value = object(raw, path);
  exact(value, ['color', 'roughness', 'textureUrl', 'alphaCutoff', 'doubleSided', 'normalUrl', 'roughnessUrl', 'aoUrl', 'textureScale', 'translucency'], path, ['textureUrl', 'alphaCutoff', 'doubleSided', 'normalUrl', 'roughnessUrl', 'aoUrl', 'textureScale', 'translucency']);
  if (!COLOR_RE.test(value.color)) fail(`${path}.color must be a six-digit hex colour`);
  range(value.roughness, 0, 1, `${path}.roughness`);
  if (value.textureUrl !== undefined && !/^\/assets\/procedural-trees\/[a-z0-9_./-]+\.(ktx2|png)$/i.test(value.textureUrl)) fail(`${path}.textureUrl must be a same-origin procedural-tree KTX2 or PNG asset`);
  if (value.alphaCutoff !== undefined) range(value.alphaCutoff, 0, 0.95, `${path}.alphaCutoff`);
  if (value.doubleSided !== undefined && typeof value.doubleSided !== 'boolean') fail(`${path}.doubleSided must be boolean`);
  for (const key of ['normalUrl', 'roughnessUrl', 'aoUrl']) if (value[key] !== undefined && !/^\/assets\/procedural-trees\/[a-z0-9_./-]+\.(ktx2|png)$/i.test(value[key])) fail(`${path}.${key} must be a procedural-tree texture`);
  if (value.textureScale !== undefined) range(value.textureScale, 0.01, 100, `${path}.textureScale`);
  for (const key of ['textureUrl', 'normalUrl', 'roughnessUrl', 'aoUrl']) if (value[key]?.split('/').includes('..')) fail(`${path}.${key} cannot traverse asset directories`);
  if (value.translucency !== undefined) range(value.translucency, 0, 1, `${path}.translucency`);
  if (!alpha && (value.alphaCutoff !== undefined || value.doubleSided !== undefined)) fail(`${path} bark does not accept alpha controls`);
  return value;
}

function normalizeSource(raw, path) {
  const value = object(raw, path); exact(value, ['kind', 'referenceUrl', 'promptHash', 'fitness'], path);
  if (value.kind !== 'imagegen') fail(`${path}.kind must be imagegen`);
  if (!/^\/assets\/procedural-trees\/[a-z0-9_./-]+\.png$/i.test(value.referenceUrl)) fail(`${path}.referenceUrl is invalid`);
  if (!/^[a-f0-9]{64}$/.test(value.promptHash)) fail(`${path}.promptHash must be sha256`);
  range(value.fitness, 0, 1, `${path}.fitness`); return value;
}

function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`); return structuredClone(value); }
function exact(value, allowed, path, optional = []) { const keys = new Set(allowed), omissions = new Set(optional); for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${path}.${key} is not allowed`); for (const key of allowed) if (!(key in value) && !omissions.has(key)) fail(`${path}.${key} is required`); }
function finite(value, path) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be finite`); }
function range(value, min, max, path) { finite(value, path); if (value < min || value > max) fail(`${path} must be in [${min}, ${max}]`); }
function integer(value, min, max, path) { if (!Number.isInteger(value) || value < min || value > max) fail(`${path} must be an integer in [${min}, ${max}]`); }
function uint32(value, path) { integer(value, 0, 0xffffffff, path); }
function identifier(value, path) { if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${path} must be a stable kebab-case identifier`); }
function oneOf(value, choices, path) { if (!choices.includes(value)) fail(`${path} has unsupported value "${value}"`); }
function fail(message) { throw new TypeError(`Procedural tree schema invalid: ${message}`); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
