import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  applyCourseMutations, compileActiveCourse, normalizeCourseProject, projectRevision,
} from '../../src/course/CourseProject.js';
import { normalizeTreeDefinition } from '../../src/trees/TreeDefinition.js';
import { CourseHistoryStore } from './course-history-store.mjs';
import { atomicJsonCheckpoint } from './atomic-json.mjs';

export const AUTHORING_CAPABILITIES = Object.freeze({
  version: 1,
  source: 'course.project.json@v5',
  runtime: 'course.json@compiled',
  controls: Object.freeze(['select-hole', 'set-view', 'present-trees', 'clear-preview', 'observe']),
  views: Object.freeze(['current', 'tee', 'landing', 'approach', 'overview', 'point']),
  limits: Object.freeze({ controlRounds: 6, capturesPerTurn: 8, treeCandidates: 3 }),
});

export async function loadAuthoringProject(root) {
  const project = normalizeCourseProject(JSON.parse(await readFile(join(resolve(root), 'course.project.json'), 'utf8')));
  return { project, revision: projectRevision(project), runtime: compileActiveCourse(project).runtime };
}

export async function buildAuthoringContext(root, { selection = null, state = null } = {}) {
  const { project, revision, runtime } = await loadAuthoringProject(root);
  let authoredCatalog = { assets: [] };
  let proceduralCatalog = { assets: [] };
  try { authoredCatalog = JSON.parse(await readFile(join(resolve(root), 'public/assets/environment/catalog.json'), 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  try { proceduralCatalog = await readProceduralTreeCatalog(root); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const active = project.holes.find((hole) => hole.id === project.activeHoleId) ?? project.holes[0];
  return {
    version: 1,
    revision,
    runtimeSchema: runtime.meta.schema,
    project: {
      id: project.meta.id,
      name: project.meta.name,
      mode: project.meta.mode,
      activeHoleId: project.activeHoleId,
      site: {
        bounds: project.site.bounds, biome: project.site.biome,
        surfaceMaterials: project.site.surfaceMaterials, routed: Boolean(project.site.routing),
      },
      holes: project.holes.map((hole) => ({
        id: hole.id, number: hole.number, name: hole.name, par: hole.par,
        routePoints: hole.route.points.length, tees: hole.tees.length, greens: hole.greens.length,
        bunkers: hole.bunkers.length, ponds: hole.ponds.length, landforms: hole.landforms.length,
      })),
      activeHole: active ? {
        id: active.id, route: active.route, tees: active.tees, greens: active.greens,
        bunkers: active.bunkers, ponds: active.ponds, landforms: active.landforms,
      } : null,
      environment: {
        objectBudget: project.site.environment.objectBudget,
        placements: project.site.environment.placements.length,
        scatter: project.site.environment.scatter.length,
        assemblies: project.site.environment.assembly.length,
        edgeDressing: project.site.environment.edgeDressing.length,
        proceduralDefinitions: project.site.environment.proceduralTreeDefinitions.map(({ id }) => id),
        proceduralTrees: project.site.environment.proceduralTrees.length,
      },
    },
    assets: {
      authoredTrees: authoredCatalog.assets.filter(({ category }) => category === 'tree').map((asset) => ({
        id: asset.id, biomes: asset.biomes, dimensions: asset.dimensions, bounds: asset.bounds,
      })),
      proceduralTrees: proceduralCatalog.assets.map(({ id, label, biomes, form, definitionUrl, referenceUrl }) => ({
        id, label, biomes, form, definitionUrl, referenceUrl,
      })),
    },
    selection,
    recentDecisions: (state?.history ?? []).slice(-8).map((event) => ({
      id: event.id, intent: event.intent ?? null, optionId: event.optionId ?? null,
      beforeRevision: event.beforeRevision, afterRevision: event.afterRevision,
    })),
    capabilities: AUTHORING_CAPABILITIES,
  };
}

export async function applyAuthoringMutations(root, { baseRevision, mutations, intent = 'Course authoring mutation', threadId = null } = {}) {
  const store = new CourseHistoryStore({ root: resolve(root) });
  const ledger = await store.load();
  const currentRevision = projectRevision(ledger.project);
  if (baseRevision !== currentRevision) throw new Error(`stale authoring mutation: expected ${currentRevision}, received ${baseRevision}`);
  const project = applyCourseMutations(ledger.project, mutations);
  const id = `kernel-${Date.now().toString(36)}`;
  ledger.recordExternalProjectChange({
    id,
    summary: intent,
    title: 'Semantic course mutation',
    rationale: 'Applied through the shared project-v5 authoring kernel.',
    threadId,
    project,
  });
  const snapshot = await store.save(ledger);
  return { revision: snapshot.revision, project: snapshot.project, runtime: compileActiveCourse(snapshot.project).runtime };
}

export async function queryTreeAssets(root, { biome = null, source = null } = {}) {
  const authored = JSON.parse(await readFile(join(resolve(root), 'public/assets/environment/catalog.json'), 'utf8')).assets
    .filter((asset) => asset.category === 'tree')
    .filter((asset) => !biome || asset.biomes.includes(biome))
    .map((asset) => ({ source: 'catalog', id: asset.id, biomes: asset.biomes, dimensions: asset.dimensions }));
  const procedural = (await readProceduralTreeCatalog(root)).assets
    .filter((asset) => !biome || asset.biomes.includes(biome))
    .map((asset) => ({ source: 'procedural', ...asset }));
  return [...(source === 'procedural' ? [] : authored), ...(source === 'catalog' ? [] : procedural)];
}

export async function readProceduralTreeCatalog(root) {
  const path = join(resolve(root), 'public/assets/procedural-trees/catalog.json');
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (!raw || raw.version !== 1 || raw.catalogId !== 'claude-golfsim-procedural-trees' || !Array.isArray(raw.assets)) {
    throw new Error('procedural tree catalog must use version 1 and contain assets');
  }
  const ids = new Set();
  for (const asset of raw.assets) {
    if (!asset || !/^[a-z][a-z0-9-]{2,63}$/.test(asset.id) || ids.has(asset.id)) throw new Error(`invalid or duplicate procedural tree catalog ID "${asset?.id}"`);
    ids.add(asset.id);
    if (!Array.isArray(asset.biomes) || !asset.biomes.length || typeof asset.label !== 'string' || !asset.label.trim()) throw new Error(`procedural tree catalog asset "${asset.id}" is incomplete`);
    if (!/^\/assets\/procedural-trees\/[a-z0-9_./-]+\/definition\.json$/i.test(asset.definitionUrl)) throw new Error(`procedural tree catalog asset "${asset.id}" has an invalid definitionUrl`);
    if (!/^\/assets\/procedural-trees\/[a-z0-9_./-]+\/reference\.png$/i.test(asset.referenceUrl)) throw new Error(`procedural tree catalog asset "${asset.id}" has an invalid referenceUrl`);
    const definition = JSON.parse(await readFile(join(resolve(root), 'public', asset.definitionUrl), 'utf8'));
    if (normalizeTreeDefinition(definition).id !== asset.id) throw new Error(`procedural tree catalog asset "${asset.id}" does not match its definition`);
  }
  return raw;
}

export async function promoteProceduralTreeAsset(root, { id, label, biomes, form, provenance = 'Approved procedural tree', validation = 'tree-builder-v1', thumbnailUrl } = {}) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id ?? '')) throw new Error('procedural tree asset id must be stable kebab-case');
  if (typeof label !== 'string' || !label.trim() || !Array.isArray(biomes) || !biomes.length || typeof form !== 'string' || !form.trim()) throw new Error('procedural tree promotion requires label, biomes, and form');
  const base = `/assets/procedural-trees/${id}`;
  const definitionUrl = `${base}/definition.json`;
  const referenceUrl = `${base}/reference.png`;
  if (thumbnailUrl !== undefined && thumbnailUrl !== `${base}/thumbnail.png`) throw new Error('Plant thumbnail must belong to its definition directory');
  const definition = normalizeTreeDefinition(JSON.parse(await readFile(join(resolve(root), 'public', definitionUrl), 'utf8')));
  if (definition.id !== id) throw new Error(`procedural tree definition ID "${definition.id}" does not match "${id}"`);
  const reference = await readFile(join(resolve(root), 'public', referenceUrl));
  if (!reference.length) throw new Error('procedural tree reference image is empty');
  const catalog = await readProceduralTreeCatalog(root);
  const record = { id, label: label.trim(), biomes: [...new Set(biomes)], form: form.trim(), definitionUrl, referenceUrl, provenance, validation, ...(thumbnailUrl ? { thumbnailUrl } : {}) };
  const index = catalog.assets.findIndex((asset) => asset.id === id);
  if (index >= 0) catalog.assets[index] = record;
  else catalog.assets.push(record);
  catalog.assets.sort((a, b) => a.id.localeCompare(b.id));
  await atomicJsonCheckpoint(join(resolve(root), 'public/assets/procedural-trees/catalog.json'), catalog);
  return record;
}
