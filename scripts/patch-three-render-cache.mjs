import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Exact-version native shader-cache correction. Each replacement is guarded and
// reversible; unrelated local Three modifications are preserved verbatim.
export const THREE_CACHE_PATCH_VERSION = '0.185.1';
export const replacements = [
  ["\t\t\trenderState.mrt = mrt;", "\t\t\trenderState.mrt = mrt;\n\t\t\t// Shader compatibility is independent of reentrant pass depth.\n\t\t\trenderState.shaderCacheKey = attachmentState + '-' + mrtState;"],
  ["\t\tcacheKey += this.context.id + ',';", "\t\tcacheKey += ( this.context.shaderCacheKey ?? this.context.id ) + ',';\n\t\tcacheKey += renderer.toneMapping + ',' + renderer.outputColorSpace + ',';"],
  ["attachmentState = `${ count }:${ format }:${ type }:${ renderTarget.samples }:${ renderTarget.depthBuffer }:${ renderTarget.stencilBuffer }`;",
    "attachmentState = `${ count }:${ renderTarget.textures.map( texture => `${ texture.format }:${ texture.type }:${ texture.colorSpace }` ).join( '/' ) }:${ renderTarget.samples }:${ renderTarget.depthBuffer }:${ renderTarget.stencilBuffer }`;"],
  ["\t\t\tthis._compilationPromises.push( {\n\t\t\t\tobject,\n\t\t\t\tmaterial,",
    "\t\t\tthis._compilationPromises.push( {\n\t\t\t\tobject,\n\t\t\t\tmaterial,\n\t\t\t\tmaterialSide: material.side,"],
  ["\t\tfor ( const item of compilationPromises ) {\n",
    "\t\tfor ( const item of compilationPromises ) {\n\n\t\t\t// Transparent two-pass rendering restores side before queued work runs.\n\t\t\tconst originalSide = item.material.side;\n\t\t\titem.material.side = item.materialSide;\n\t\t\ttry {\n"],
  ["\t\t\t// Yield between objects to allow animation frames",
    "\t\t\t} finally {\n\n\t\t\t\titem.material.side = originalSide;\n\n\t\t\t}\n\n\t\t\t// Yield between objects to allow animation frames"],
];

export function transformRenderCache(source, edits, reverse = false) {
  for (const pair of edits) {
    const [before, after] = reverse ? [...pair].reverse() : pair;
    if (after.includes(before) && source.split(after).length === 2) continue;
    const occurrences = source.split(before).length - 1;
    if (occurrences === 0 && source.split(after).length === 2) continue;
    if (occurrences !== 1) throw new Error('Three render-cache patch context mismatch; refusing mutation.');
    source = source.replace(before, after);
  }
  return source;
}

export async function patchThreeRenderCache({ reverse = false } = {}) {
  const root = new URL('../node_modules/three/', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  if (pkg.version !== THREE_CACHE_PATCH_VERSION) throw new Error(`Expected Three ${THREE_CACHE_PATCH_VERSION}, found ${pkg.version}.`);
  const targets = [
    ['src/renderers/common/RenderContexts.js', [replacements[0], replacements[2]]],
    ['src/renderers/common/RenderObject.js', [replacements[1]]],
    ['src/renderers/common/Renderer.js', replacements.slice(3)],
    ['build/three.webgpu.js', replacements],
    ['build/three.webgpu.nodes.js', replacements],
  ];
  // Validate every file before changing any file.
  const changes = await Promise.all(targets.map(async ([path, edits]) => {
    const url = new URL(path, root);
    const before = await readFile(url, 'utf8');
    return { url, before, after: transformRenderCache(before, edits, reverse) };
  }));
  for (const { url, before, after } of changes) if (before !== after) await writeFile(url, after);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await patchThreeRenderCache({ reverse: process.argv.includes('--reverse') });
  console.log(`Three render-cache patch ${process.argv.includes('--reverse') ? 'reversed' : 'applied'} (${THREE_CACHE_PATCH_VERSION}).`);
}
