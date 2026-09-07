import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeTreeDefinition } from '../../src/trees/TreeDefinition.js';
import { generateTreeSkeleton } from '../../src/trees/TreeGenerator.js';
import { compileTreeGeometry } from '../../src/trees/TreeGeometry.js';
import { promoteProceduralTreeAsset } from './course-authoring-kernel.mjs';
import { atomicJsonCheckpoint } from './atomic-json.mjs';
import { decodePNG } from './png.mjs';

export async function savePlantAsset(root, { definition: raw, thumbnail }) {
  const definition = normalizeTreeDefinition(raw);
  const skeleton = generateTreeSkeleton(definition), diagnostics = skeleton.diagnostics;
  if (diagnostics.limitsReached.length) throw new Error('Resolve generation limits before saving this plant');
  const geometry = compileTreeGeometry(skeleton, { plant: definition.plant, radialSegments: definition.plant?.quality.radialSegments ?? 9 });
  for (const part of Object.values(geometry)) part.dispose();
  if (typeof thumbnail !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(thumbnail) || thumbnail.length > 16 * 1024 * 1024) throw new TypeError('A bounded production PNG thumbnail is required');
  const bytes = Buffer.from(thumbnail.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 24 || bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096) throw new RangeError('Thumbnail dimensions exceed 4096 pixels');
  decodePNG(bytes);
  const directory = join(root, 'public/assets/procedural-trees', definition.id);
  await mkdir(directory, { recursive: true });
  // Keep the editable original when revising a library plant.
  try { const original = await readFile(join(directory, 'definition.json')); await writeFile(join(directory, 'definition.original.json'), original, { flag: 'wx' }); } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  // Fitting references are source assets. Never replace one with a UI thumbnail.
  try { await writeFile(join(directory, 'reference.png'), bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await writeFile(join(directory, 'thumbnail.png'), bytes);
  await atomicJsonCheckpoint(join(directory, 'definition.json'), definition);
  return promoteProceduralTreeAsset(root, { id: definition.id, label: definition.id.replaceAll('-', ' '), biomes: ['temperate-maritime'], form: definition.parameters?.shape ?? 'l-system', provenance: 'Procedural Plant Studio; editable definition; production screenshot', validation: 'tree-builder-v2', thumbnailUrl: `/assets/procedural-trees/${definition.id}/thumbnail.png` });
}
