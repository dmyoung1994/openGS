# Foliage source processor

The versioned processor converts an approved ImageGen RGBA contact sheet into
eight validated clusters, a padded 2K atlas, aligned material masks, explicit
coverage-preserving PNG mip evidence, UASTC KTX2 shipping textures, runtime UV
metadata, metrics, and a content-hashed foliage-pack manifest. It deliberately
does not invent independent normal maps or whole-tree impostors.
Version `foliage-pipeline-v3` retains only the connected antialiased silhouette
seeded by each selected cluster, so unrelated source flecks inside an otherwise
valid crop cannot become floating geometry in the assembled tree.

```sh
node tools/foliage-pipeline/process-source.mjs \
  --config tools/foliage-pipeline/species/douglas-fir.v1.json \
  --output public/assets/trees_candidates/generated_fir_clusters/processed/v2
```

Every source generation remains untouched and content-hashed. Connected-component
extraction rejects missing, merged, ambiguous, overlapping, or edge-cropped
clusters rather than trusting nominal grid lines. The processor rejects faint
generated haze, preserves needle-tip coverage, dilates RGB beneath transparent
pixels for the complete mip chain, derives conservative roughness/transmission,
and records every transform and metric in JSON.

UASTC KTX2 encoding uses the pinned `ktx2-encoder` development dependency. PNG
mips remain inspectable evidence; KTX2 is the runtime shipping format. Re-running
an unchanged source/config is deterministic up to the pinned processor and encoder
versions and never invokes image generation.

## Provider-neutral authoring workflow

`workflow-contract.mjs` defines the boundary for a future Codex, local generator,
or configured image-service adapter. A normalized local alias, botanical intent,
provider/model version, exact prompt, source layout, processor version, and config
hash form one deterministic cache key. A cache hit returns immutable source bytes
without invoking the provider again.

Network providers are never called unless the authoring caller passes explicit
`allowNetwork: true` consent. Providers receive only the normalized generation
spec—not course files, screenshots, local paths, or unrelated assets. Processing,
viewer review, and installation are injected stages. Installation requires both an
affirmative QA decision and an explicit `install: true`; candidate output cannot
silently enter the runtime registry.

An installed pack is exposed to the browser by the local authoring host before the
application module loads. The host injects only same-origin descriptors; course data
continues to carry the alias alone:

```js
globalThis.__GOLF_LOCAL_FOLIAGE_PACKS__ = {
  'local.monterey-cypress.coastal.v1': {
    rootUrl: '/local-foliage/monterey-cypress/coastal-v1',
    compatibilityVersion: 1,
  },
};
```

The registry is immutable after bootstrap. Runtime verification requires an
`approved` manifest and checks every declared file's byte length and SHA-256 before
loading; unresolved aliases never substitute a built-in species.

Course data selects either one pack or an ordered mix. The two forms are mutually
exclusive, and every alias remains versioned and path-free:

```json
{
  "environment": {
    "foliageAlias": "local.monterey-cypress.coastal.v1"
  }
}
```

```json
{
  "environment": {
    "foliageAliases": [
      "builtin.douglas-fir.pnw.v1",
      "builtin.italian-cypress.mediterranean.v1",
      "builtin.monterey-cypress.coastal.v1"
    ]
  }
}
```

The practice-range perimeter derives every planting slot from the declared list.
It never falls back from an unresolved or undeclared species to the first pack.

## Promotion

Promotion is a separate, fail-closed operation. It requires an affirmative review
record that pins the exact candidate-manifest SHA-256 and names the inspected
evidence. The promoter verifies every declared candidate byte before copying it,
never overwrites an existing destination, preserves every required asset byte, and
changes only the copied manifest's validation state and promotion record:

```sh
npm run promote:foliage -- \
  --source public/assets/trees_candidates/generated_monterey_cypress/processed/v1 \
  --output public/assets/foliage/monterey-cypress/coastal-v1 \
  --approval path/to/explicit-approval.json
```

Candidate packs are not promoted merely because this command exists. The approval
record is supplied only after all required visual, temporal, performance, integrity,
and user-review gates pass.

The transport remains deliberately replaceable. As documented by OpenAI on
2026-08-21, a direct single-prompt adapter can use the Image API, while a future
conversational/multi-step adapter can use the Responses API image-generation tool:
https://developers.openai.com/api/docs/guides/image-generation
