import { createRng, deriveSeed } from '../util/random.js';
import { normalizeTreeDefinition, TREE_LIMITS } from './TreeDefinition.js';

import { samplePlantProfile } from './PlantControls.js';

const DEG = Math.PI / 180;

export function generateTreeSkeleton(rawDefinition, { seed } = {}) {
  const definition = normalizeTreeDefinition(rawDefinition);
  const generationSeed = deriveSeed(definition.seed, seed ?? 0);
  const skeleton = definition.generator === 'parametric'
    ? generateParametric(definition.parameters, generationSeed, definition.plant)
    : generateLSystem(definition.grammar, generationSeed);
  skeleton.definitionId = definition.id;
  skeleton.generator = definition.generator;
  skeleton.seed = generationSeed;
  skeleton.bounds = boundsFor(skeleton);
  skeleton.diagnostics = Object.freeze({
    generator: definition.generator,
    stems: skeleton.stemCount,
    segments: skeleton.segments.length,
    leaves: skeleton.leaves.length,
    blossoms: skeleton.blossoms.length,
    symbols: skeleton.symbolCount ?? 0,
    bounds: skeleton.bounds,
    limitsReached: skeleton.limitsReached ?? [],
  });
  return deepFreeze(skeleton);
}

// Surface roots. These exist so a trunk reads as grown out of the ground rather than
// pushed into it: each one leaves the trunk above grade, arches outward, and dives
// below it. They are ordinary stems, so they inherit bark, UVs, normals, wind and LOD
// compilation, and they carry `role: 'root'` so the higher tiers and the shadow pass
// can drop them - a root is near-field detail that casts nothing useful.
//
// The geometry here is only the resting shape. Seating each root against the real
// surface happens per instance on the GPU, because one shared geometry has to serve
// placements standing on entirely different slopes.
function addRoots({ segments, start, trunkRadius, plant, azimuth, trunk, rng, limitsReached, clump }) {
  const { rootCount, rootSpread, rootDepth, rootRise } = plant.structure;
  const count = Math.round(rootCount);
  if (count < 1 || trunkRadius <= 0) return;
  const resolution = 6;
  for (let index = 0; index < count; index++) {
    // Roots are stems and spend the same budget every other stem does. A multi-stem
    // shrub multiplies its trunk count by its root count, so this is the difference
    // between a bounded plant and one that quietly overruns the documented limit.
    if (segments.length + resolution > TREE_LIMITS.maxSegments) { limitsReached.add('structure'); return; }
    // Spread the roots around the trunk, jittered so they never read as a turbine.
    const around = azimuth + (index + 0.5) / count * Math.PI * 2 + varied(rng, 2.0 / count);
    const outward = [Math.cos(around), 0, Math.sin(around)];
    // In a clump each stem is crowded by its neighbours, so roots run out into open
    // ground and stay stubby where they would otherwise drive into the next stem.
    const openness = clump ? 0.5 + 0.5 * (outward[0] * clump[0] + outward[2] * clump[1]) : 1;
    const reach = trunkRadius * rootSpread * (0.55 + rng() * 0.9) * (0.35 + 0.65 * openness);
    const depth = trunkRadius * rootDepth * (0.8 + rng() * 0.4);
    const rise = trunkRadius * rootRise * (0.8 + rng() * 0.4);
    // Start inside the trunk so the root emerges from its flare instead of being
    // stuck to the outside of it.
    let point = add(start, [outward[0] * trunkRadius * 0.35, rise, outward[2] * trunkRadius * 0.35]);
    // The roots are the flare, so they leave the trunk thick and shed it quickly.
    const sway = (rng() - 0.5) * 0.9;
    // A surface root is mostly buried and shows as a run of intermittent humps, not
    // as a limb lying on the lawn. This rides each station relative to the ground it
    // will be seated against: under for stretches, breaking through between them.
    // Each root gets its own rhythm, or a whole flare ripples in unison.
    const emerge = 2.5 + rng() * 2.5, phase = rng() * Math.PI * 2;
    const knuckleRate = 6 + rng() * 6, knucklePhase = rng() * Math.PI * 2;
    // Low relief. In photographed oak flares the radiating roots are barely proud
    // of the soil and covered by it; the trunk's own flare is what reads, not a set
    // of limbs standing clear of the ground.
    const surfaceAt = (at, atRadius) => atRadius * (Math.sin(at * emerge + phase) * 0.6 - 0.2);
    const radius0Start = trunkRadius * (0.34 + rng() * 0.18);
    let radius = radius0Start;
    const stem = -1 - (trunk * count + index);
    const id = `root-${trunk}-${index}`;
    // Photographed surface roots divide as they run: a main runner splits and sends
    // secondaries off at a shallow angle. An undivided tube is the giveaway that
    // something was extruded rather than grown, so each root forks once partway out.
    const forkAt = Math.floor(resolution * (0.45 + rng() * 0.25));
    const forkSide = rng() < 0.5 ? -1 : 1;
    const forkSpread = 0.35 + rng() * 0.45;
    let forkFrom = null;
    for (let step = 0; step < resolution; step++) {
      const t = (step + 1) / resolution;
      // Arch out and down: mostly outward near the trunk, mostly downward at the tip.
      // Wander off the radial line as it runs. Roots that stay in one vertical plane
      // are what make a set of them read as machined fins rather than as growth.
      const wander = Math.sin(t * Math.PI * (0.7 + sway)) * sway * reach * 0.45;
      const span = trunkRadius * 0.35 + reach * Math.sin(t * Math.PI * 0.5);
      const next = add(start, [
        outward[0] * span - outward[2] * wander,
        rise - (rise + depth) * t * t,
        outward[2] * span + outward[0] * wander,
      ]);
      // Danjon's "zone of rapid taper": structural roots lose diameter steeply over
      // the first couple of trunk diameters and then run on thin. A gentle linear
      // taper is what makes a root read as a foot rather than a buttress.
      // Knuckle the taper. A root photographed at the collar is lumpy - it swells
      // where it forks and pinches between - and a clean monotonic cone is the last
      // thing separating this from growth. Bounded so it never necks to a thread.
      const knuckle = 1 + Math.sin(t * knuckleRate + knucklePhase) * 0.17
        + Math.sin(t * knuckleRate * 2.3 + knucklePhase * 1.7) * 0.08;
      const nextRadius = Math.max(0.004, (radius0Start * (1 - t) ** 1.15 + trunkRadius * 0.09) * knuckle);
      const was = step / resolution;
      segments.push({ start: point, end: next, radius0: radius, radius1: nextRadius,
        level: 0, stem, id, parent: null, role: 'root', rootFork: false,
        // 0 where the root leaves the trunk, 1 at the tip: how strongly the GPU is
        // allowed to pull this station onto the terrain surface.
        rootBlend0: was ** 1.5, rootBlend1: t ** 1.5,
        // And where it rides once seated, so the seating buries it rather than
        // laying it on top of the turf.
        rootSurface0: surfaceAt(was, radius), rootSurface1: surfaceAt(t, nextRadius) });
      if (step === forkAt) forkFrom = { at: next, t, radius: nextRadius };
      point = next;
      radius = nextRadius;
    }

    // The secondary carries on shallower and thinner than the runner that shed it.
    if (!forkFrom || segments.length + resolution > TREE_LIMITS.maxSegments) continue;
    const forkAzimuth = around + forkSide * forkSpread;
    const forkOut = [Math.cos(forkAzimuth), 0, Math.sin(forkAzimuth)];
    const forkReach = reach * (0.45 + rng() * 0.3);
    let forkPoint = forkFrom.at;
    let forkRadius = forkFrom.radius * (0.55 + rng() * 0.2);
    const forkStem = stem - count * 64;
    for (let step = 0; step < resolution; step++) {
      const t = (step + 1) / resolution;
      const span = forkReach * Math.sin(t * Math.PI * 0.5);
      const next = [
        forkFrom.at[0] + forkOut[0] * span,
        forkFrom.at[1] - (Math.abs(forkFrom.at[1]) + depth * 0.5) * t * t,
        forkFrom.at[2] + forkOut[2] * span,
      ];
      const knuckle = 1 + Math.sin(t * knuckleRate * 1.4 + knucklePhase) * 0.15;
      const nextRadius = Math.max(0.003, forkRadius * (1 - t) ** 1.1 * knuckle + trunkRadius * 0.03);
      const was = step / resolution;
      segments.push({ start: forkPoint, end: next, radius0: forkRadius, radius1: nextRadius,
        level: 0, stem: forkStem, id: `${id}-f`, parent: null, role: 'root', rootFork: true,
        // Already well out from the trunk, so a secondary is seated on the surface
        // along its whole length rather than easing in from a collar.
        rootBlend0: Math.max(0.55, forkFrom.t), rootBlend1: 1,
        rootSurface0: surfaceAt(forkFrom.t + was * 0.4, forkRadius),
        rootSurface1: surfaceAt(forkFrom.t + t * 0.4, nextRadius) });
      forkPoint = next;
      forkRadius = nextRadius;
    }
  }
}

function generateParametric(parameters, seed, plant) {
  const rng = createRng(seed);
  const segments = [], terminals = [], leaves = [], blossoms = [];
  let stemCount = 0;
  const height = Math.max(0.05, parameters.gScale + varied(rng, parameters.gScaleV)) * (plant ? 0.3 + 0.7 * plant.life.age : 1);
  const limitsReached = new Set();
  const legacyRng = rng;
  const trunkCount = parameters.multipleTrunks.count;

  const addStem = ({ start, direction, length, radius, level, azimuth = 0, parent = null, id = "root" }) => {
    const rng = plant ? createRng(deriveSeed(seed, id)) : legacyRng;
    if (stemCount >= TREE_LIMITS.maxStems || segments.length >= TREE_LIMITS.maxSegments) { limitsReached.add('structure'); return; }
    if (length < 0.025 || radius < 0.001) return;
    const stem = stemCount++;
    const spec = parameters.levelsParameters[Math.min(level, parameters.levelsParameters.length - 1)];
    const resolution = Math.max(1, Math.round(spec.curveRes));
    let point = [...start], heading = normalize(direction);
    const points = [{ point, direction: heading, radius: radiusAt(radius, 0, spec.taper, level === 0 ? parameters.flare : 0) }];
    for (let segmentIndex = 0; segmentIndex < resolution && segments.length < TREE_LIMITS.maxSegments; segmentIndex++) {
      const t = segmentIndex / resolution;
      const curveDegrees = (segmentIndex < resolution / 2 || spec.curveBack === 0 ? spec.curve : spec.curveBack) / resolution
        + varied(rng, spec.curveV / resolution) + varied(rng, spec.bendV / resolution);
      const helix = spec.helixTurns * Math.PI * 2 * t;
      const curveAxis = normalize([Math.cos(azimuth + helix), 0, Math.sin(azimuth + helix)]);
      heading = rotateAroundAxis(heading, curveAxis, curveDegrees * DEG);
      heading = normalize(add(heading, scale(parameters.tropism, 1 / resolution)));
      if (plant && level > 0) heading = normalize(add(heading, [0, -plant.structure.droop * t / resolution, 0]));
      const next = add(point, scale(heading, length / resolution));
      if (pruned(next, height, parameters, rng) || outsidePlantEnvelope(next, plant)) break;
      const taperProgress = (segmentIndex + 1) / resolution;
      const nextRadius = Math.max(0.0008, radiusAt(radius, taperProgress, spec.taper, level === 0 ? parameters.flare : 0));
      segments.push({ start: point, end: next, radius0: points.at(-1).radius, radius1: nextRadius, level, stem, id, parent });
      point = next;
      points.push({ point, direction: heading, radius: nextRadius });
    }
    if (points.length < 2) return;

    if (level + 1 >= parameters.levels) {
      const first = Math.max(1, Math.floor(points.length * (plant?.foliage.attachmentStart ?? 0.55)));
      terminals.push(...points.slice(first).map((entry, index) => ({ ...entry, startPoint: points[first + index - 1].point, level, stem, id })));
      return;
    }

    const child = parameters.levelsParameters[level + 1];
    const available = Math.max(0, TREE_LIMITS.maxStems - stemCount);
    const baseCount = Math.min(available, stochasticCount(child.branches, rng));
    const patternSize = child.branchPattern === 'opposite' ? 2 : child.branchPattern === 'whorled' ? 3 : 1;
    const groups = Math.ceil(baseCount / patternSize);
    for (let group = 0, emitted = 0; group < groups && emitted < baseCount; group++) {
      const u = child.baseSize + (1 - child.baseSize) * ((group + 0.5) / Math.max(1, groups)) ** child.branchDist;
      const anchor = sampleStem(points, u);
      const baseRotation = azimuth + (group * child.rotate + varied(rng, child.rotateV)) * DEG;
      for (let member = 0; member < patternSize && emitted < baseCount; member++, emitted++) {
        const around = baseRotation + member * Math.PI * 2 / patternSize;
        const down = (child.downAngle + varied(rng, child.downAngleV)) * DEG;
        const right = normalize(cross(anchor.direction, Math.abs(anchor.direction[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0]));
        const forward = cross(right, anchor.direction);
        const radial = plant ? add(scale(right, Math.sin(around)), scale(forward, Math.cos(around))) : normalize([Math.sin(around), 0, Math.cos(around)]);
        const childDirection = normalize(add(scale(anchor.direction, Math.cos(down)), scale(radial, Math.sin(down))));
        const profile = plant && parameters.shape === 'custom' ? samplePlantProfile(plant.profiles.crown, anchor.point[1] / height) : crownProfile(parameters.shape, anchor.point[1] / height);
        const envelope = plant && level === 0 && ['conical', 'custom'].includes(parameters.shape) ? Math.max(0.03, profile) : 0.55 + profile * 0.65;
        const childLength = Math.max(0.04, length * (child.length + varied(rng, child.lengthV)) * envelope * (plant ? samplePlantProfile(plant.profiles.length, u) : 1));
        const childRadius = Math.max(0.001, anchor.radius * child.radiusMod * Math.pow(childLength / Math.max(length, 0.001), parameters.ratioPower - 1));
        addStem({ start: anchor.point, direction: childDirection, length: childLength, radius: childRadius, level: level + 1, azimuth: around, parent: id, id: `${id}/b${emitted}` });
      }
    }

    const splitCount = stochasticCount((level === 0 ? parameters.baseSplits : 0) + spec.segSplits, rng);
    for (let split = 0; split < splitCount && stemCount < TREE_LIMITS.maxStems; split++) {
      const u = 0.45 + 0.45 * rng();
      const anchor = sampleStem(points, u);
      const splitAzimuth = azimuth + Math.PI * 2 * split / Math.max(1, splitCount) + varied(rng, 0.25);
      const splitAngle = (spec.splitAngle + varied(rng, spec.splitAngleV)) * DEG;
      const axis = normalize([Math.cos(splitAzimuth), 0, Math.sin(splitAzimuth)]);
      addStem({
        start: anchor.point,
        direction: rotateAroundAxis(anchor.direction, axis, splitAngle),
        length: length * (1 - u) * 0.92,
        radius: anchor.radius * 0.72,
        level,
        azimuth: splitAzimuth, parent: id, id: `${id}/s${split}`,
      });
    }
  };

  for (let trunk = 0; trunk < trunkCount; trunk++) {
    const distance = trunkCount === 1 ? 0 : parameters.multipleTrunks.radius * Math.sqrt((trunk + 0.5) / trunkCount);
    const angle = trunk * 2.399963229728653;
    const start = [Math.sin(angle) * distance, 0, Math.cos(angle) * distance];
    let lean = trunkCount === 1 ? [0, 1, 0] : normalize([start[0] * 0.045, 1, start[2] * 0.045]);
    if (plant) lean = normalize(add(lean, [plant.structure.leanX, 0, plant.structure.leanZ]));
    // Begin the trunk below grade so the terrain cuts it. Ending exactly at grade
    // leaves the flare's base ring as a hard rim lying on the ground; a real trunk
    // simply disappears into the soil. The above-ground length is unchanged.
    const sink = plant ? height * parameters.ratio * 0.7 : 0;
    addStem({ start: [start[0], start[1] - sink, start[2]], direction: lean, length: height + sink,
      radius: height * parameters.ratio, level: 0, azimuth: angle, id: `trunk-${trunk}` });
    if (plant) addRoots({
      segments, start, trunkRadius: height * parameters.ratio, plant, azimuth: angle, trunk, limitsReached,
      // Direction out of the clump for a multi-stem plant; null for a single trunk.
      clump: distance > 1e-4 ? [start[0] / distance, start[2] / distance] : null,
      rng: createRng(deriveSeed(seed, `roots:${trunk}`)),
    });
  }

  const leafSpec = { ...parameters.leaves };
  if (plant) {
    const foliage = plant.foliage, life = plant.life;
    leafSpec.count = Math.round(leafSpec.count * foliage.density * life.health * (1 - life.deciduous * Math.max(0, life.season - 0.5) * 2));
    if (leafSpec.count > TREE_LIMITS.maxLeaves) limitsReached.add('leaves');
  }
  distributeTerminalGeometry(terminals, leafSpec, leaves, plant ? createRng(deriveSeed(seed, 'foliage')) : rng, 1, plant, height);
  distributeTerminalGeometry(terminals, parameters.blossoms, blossoms, plant ? createRng(deriveSeed(seed, 'blossoms')) : rng, parameters.blossoms.rate * (plant?.life.flowering ?? 1), plant, height);
  if (plant) {
    const transform = point => [point[0] * plant.structure.crownX, point[1], point[2] * plant.structure.crownZ];
    for (const segment of segments) { segment.start = transform(segment.start); segment.end = transform(segment.end); }
    for (const leaf of [...leaves, ...blossoms]) leaf.position = transform(leaf.position);
  }
  if (segments.length >= TREE_LIMITS.maxSegments || stemCount >= TREE_LIMITS.maxStems) limitsReached.add('structure');
  return { segments, leaves: leaves.filter(leaf => !outsidePlantEnvelope(leaf.position, plant)), blossoms: blossoms.filter(leaf => !outsidePlantEnvelope(leaf.position, plant)), stemCount, limitsReached: [...limitsReached] };
}

function outsidePlantEnvelope(point, plant) {
  const e = plant?.envelope;
  if (!e || e.shape === 'none') return false;
  const x = point[0] / (e.width / 2), y = (point[1] - e.baseHeight - e.height / 2) / (e.height / 2), z = point[2] / (e.depth / 2);
  if (point[1] < e.baseHeight) return false;
  return e.shape === 'box' ? Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1 : x * x + y * y + z * z > 1;
}

function generateLSystem(grammar, seed) {
  const rng = createRng(seed);
  let tokens = grammar.axiom.map((token) => numericToken(token, { level: 0, iteration: 0 }));
  for (let iteration = 0; iteration < grammar.iterations; iteration++) {
    const next = [];
    for (const token of tokens) {
      const alternatives = grammar.productions[token.symbol];
      if (!alternatives) { next.push(token); continue; }
      const scope = tokenScope(token, iteration);
      const eligible = alternatives.filter((candidate) => candidate.condition === undefined || Boolean(evaluate(candidate.condition, scope)));
      if (!eligible.length) { next.push(token); continue; }
      const total = eligible.reduce((sum, candidate) => sum + candidate.weight, 0);
      let choice = rng() * total, selected = eligible.at(-1);
      for (const candidate of eligible) { choice -= candidate.weight; if (choice <= 0) { selected = candidate; break; } }
      for (const successor of selected.successor) next.push(numericToken(successor, scope));
      if (next.length > TREE_LIMITS.maxSymbols) throw new RangeError(`L-system exceeded ${TREE_LIMITS.maxSymbols} symbols.`);
    }
    tokens = next;
  }

  const segments = [], leaves = [], blossoms = [], stack = [];
  const turtle = { position: [0, 0, 0], heading: [0, 1, 0], left: [-1, 0, 0], up: [0, 0, 1], radius: grammar.radius, level: 0, stem: 0, parent: null };
  let stemCount = 1;
  for (const token of tokens) {
    const amount = token.parameters[0];
    if (token.symbol === 'F' || token.symbol === 'f') {
      const step = Number.isFinite(amount) ? amount : grammar.step;
      turtle.heading = normalize(add(turtle.heading, scale(grammar.tropism, 0.08)));
      const end = add(turtle.position, scale(turtle.heading, step));
      if (token.symbol === 'F') {
        if (segments.length >= TREE_LIMITS.maxSegments) throw new RangeError(`L-system exceeded ${TREE_LIMITS.maxSegments} segments.`);
        segments.push({ start: turtle.position, end, radius0: turtle.radius, radius1: turtle.radius * 0.97, level: turtle.level, stem: turtle.stem, id: `ls-${turtle.stem}`, parent: turtle.parent });
        turtle.radius *= 0.97;
      }
      turtle.position = end;
    } else if (token.symbol === 'L') leaves.push({ position: turtle.position, direction: turtle.heading, scale: amount ?? 0.25, scaleX: 0.65, shape: 'oval', bend: 0 });
    else if (token.symbol === 'B') blossoms.push({ position: turtle.position, direction: turtle.heading, scale: amount ?? 0.12, scaleX: 1, shape: 'oval', bend: 0 });
    else if (token.symbol === '[') { stack.push(structuredClone(turtle)); turtle.level++; turtle.parent = `ls-${turtle.stem}`; turtle.stem = stemCount++; if (stemCount > TREE_LIMITS.maxStems) throw new RangeError(`L-system exceeded ${TREE_LIMITS.maxStems} stems.`); }
    else if (token.symbol === ']') { const restored = stack.pop(); if (!restored) throw new TypeError('L-system contains an unmatched closing branch token.'); Object.assign(turtle, restored); }
    else if (token.symbol === '!') turtle.radius = Math.max(0.0008, amount ?? turtle.radius * 0.75);
    else turnTurtle(turtle, token.symbol, (amount ?? grammar.angle) * DEG);
  }
  if (stack.length) throw new TypeError('L-system contains an unmatched opening branch token.');
  return { segments, leaves, blossoms, stemCount, symbolCount: tokens.length };
}

function turnTurtle(turtle, symbol, angle) {
  let axis = null, signed = angle;
  if (symbol === '+') axis = turtle.up;
  else if (symbol === '-') { axis = turtle.up; signed = -angle; }
  else if (symbol === '&') axis = turtle.left;
  else if (symbol === '^') { axis = turtle.left; signed = -angle; }
  else if (symbol === '\\') axis = turtle.heading;
  else if (symbol === '/') { axis = turtle.heading; signed = -angle; }
  else if (symbol === '|') { axis = turtle.up; signed = Math.PI; }
  if (!axis) return;
  turtle.heading = normalize(rotateAroundAxis(turtle.heading, axis, signed));
  turtle.left = normalize(rotateAroundAxis(turtle.left, axis, signed));
  turtle.up = normalize(cross(turtle.heading, turtle.left));
}

function numericToken(token, scope) {
  return { symbol: token.symbol, parameters: token.parameters.map((parameter) => evaluate(parameter, scope)) };
}

function tokenScope(token, iteration) {
  return { p0: token.parameters[0] ?? 0, p1: token.parameters[1] ?? 0, p2: token.parameters[2] ?? 0, p3: token.parameters[3] ?? 0, level: 0, iteration };
}

export function evaluateTreeExpression(expression, scope = {}) { return evaluate(expression, scope); }

function evaluate(expression, scope) {
  if (typeof expression === 'number') return expression;
  if ('var' in expression) return scope[expression.var] ?? 0;
  const args = expression.args.map((arg) => evaluate(arg, scope));
  switch (expression.op) {
    case '+': return args.reduce((a, b) => a + b, 0);
    case '-': return args.length === 1 ? -args[0] : args.slice(1).reduce((a, b) => a - b, args[0]);
    case '*': return args.reduce((a, b) => a * b, 1);
    case '/': return args.slice(1).reduce((a, b) => a / (Math.abs(b) < 1e-9 ? 1e-9 : b), args[0]);
    case 'min': return Math.min(...args);
    case 'max': return Math.max(...args);
    case 'pow': return Math.pow(args[0], args[1]);
    case '<': return Number(args[0] < args[1]);
    case '<=': return Number(args[0] <= args[1]);
    case '>': return Number(args[0] > args[1]);
    case '>=': return Number(args[0] >= args[1]);
    case '==': return Number(args[0] === args[1]);
    case 'and': return Number(args.every(Boolean));
    case 'or': return Number(args.some(Boolean));
    default: throw new TypeError(`Unsupported tree expression operator ${expression.op}.`);
  }
}

function distributeTerminalGeometry(terminals, spec, output, rng, rate = 1, plant, height = 1) {
  const wanted = Math.min(spec.count, TREE_LIMITS.maxLeaves);
  if (!terminals.length || wanted === 0 || rate <= 0) return;
  for (let index = 0; index < wanted; index++) {
    if (rng() > rate) continue;
    const terminal = terminals[Math.floor(rng() * terminals.length)];
    if (plant && rng() > Math.min(1, samplePlantProfile(plant.profiles.density, terminal.point[1] / height))) continue;
    const around = rng() * Math.PI * 2;
    const direction = normalize(add(terminal.direction, [Math.sin(around) * 0.45, (rng() - 0.5) * 0.3, Math.cos(around) * 0.45]));
    output.push({
      position: add(plant && terminal.startPoint ? mix(terminal.startPoint, terminal.point, rng()) : terminal.point, scale(direction, (spec.stemLength ?? 0) + (plant ? rng() * plant.foliage.spread : 0))),
      stem: terminal.stem, parent: terminal.id, roll: plant ? around * plant.foliage.roll : 0, leaflets: Math.round(plant?.foliage.leaflets ?? 9),
      colorVariation: plant?.foliage.colorVariation ?? 0,
      direction,
      scale: spec.scale * (plant ? 1 + varied(rng, plant.foliage.variation) : 1),
      scaleX: spec.scaleX ?? 1,
      shape: spec.shape,
      bend: spec.bend ?? 0,
    });
  }
}

function pruned(point, height, parameters, rng) {
  for (const sphere of parameters.pruningVolumes) if (Math.hypot(point[0] - sphere.x, point[1] - sphere.y, point[2] - sphere.z) < sphere.radius) return true;
  if (parameters.pruning.ratio <= 0 || rng() > parameters.pruning.ratio) return false;
  const y = clamp(point[1] / height, 0, 1);
  const prune = parameters.pruning;
  const profile = y <= prune.peak
    ? Math.pow(y / prune.peak, prune.powerLow)
    : Math.pow((1 - y) / (1 - prune.peak), prune.powerHigh);
  const envelope = height * prune.width * profile;
  return Math.hypot(point[0], point[2]) > envelope;
}

function crownProfile(shape, ratio) {
  const y = clamp(ratio, 0, 1);
  if (shape === 'conical') return 1 - y;
  if (shape === 'spherical') return Math.sqrt(Math.max(0, 1 - (y * 2 - 1) ** 2));
  if (shape === 'hemispherical') return Math.sqrt(Math.max(0, 1 - y * y));
  if (shape === 'cylindrical') return 1;
  if (shape === 'tapered-cylindrical') return 0.5 + 0.5 * (1 - y);
  if (shape === 'flame') return y < 0.7 ? y / 0.7 : (1 - y) / 0.3;
  if (shape === 'inverse-conical') return y;
  if (shape === 'tend-flame') return y < 0.7 ? 0.5 + 0.5 * y / 0.7 : (1 - y) / 0.3;
  return 0.65 + 0.25 * Math.sin(y * Math.PI);
}

function radiusAt(base, progress, taper, flare) {
  const tapered = taper <= 1 ? 1 - taper * progress : Math.max(0, (1 - progress) * (2 - Math.min(2, taper)));
  const baseFlare = 1 + flare * Math.max(0, 1 - progress * 8) ** 2;
  return base * Math.max(0.015, tapered) * baseFlare;
}

function sampleStem(points, progress) {
  const scaled = clamp(progress, 0, 1) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const amount = scaled - index, a = points[index], b = points[index + 1];
  return { point: mix(a.point, b.point, amount), direction: normalize(mix(a.direction, b.direction, amount)), radius: a.radius + (b.radius - a.radius) * amount };
}

function boundsFor(skeleton) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const visit = (point, radius = 0) => { for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis] - radius); max[axis] = Math.max(max[axis], point[axis] + radius); } };
  for (const segment of skeleton.segments) { visit(segment.start, segment.radius0); visit(segment.end, segment.radius1); }
  for (const leaf of [...skeleton.leaves, ...skeleton.blossoms]) visit(leaf.position, leaf.scale * Math.max(2, (leaf.scaleX ?? 1) * 2));
  if (!Number.isFinite(min[0])) return Object.freeze({ min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0], canopyRadius: 0 });
  const size = max.map((value, axis) => value - min[axis]);
  const center = max.map((value, axis) => (value + min[axis]) * 0.5);
  return Object.freeze({ min, max, size, center, canopyRadius: Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2])) });
}

function stochasticCount(value, rng) { const floor = Math.floor(Math.max(0, value)); return floor + (rng() < value - floor ? 1 : 0); }
function varied(rng, amount) { return (rng() * 2 - 1) * amount; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, value) { return [a[0] * value, a[1] * value, a[2] * value]; }
function mix(a, b, amount) { return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(value) { const length = Math.hypot(...value); return length > 1e-9 ? scale(value, 1 / length) : [0, 1, 0]; }
function rotateAroundAxis(vector, rawAxis, angle) { const axis = normalize(rawAxis), cosine = Math.cos(angle), sine = Math.sin(angle); return add(add(scale(vector, cosine), scale(cross(axis, vector), sine)), scale(axis, dot(axis, vector) * (1 - cosine))); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
