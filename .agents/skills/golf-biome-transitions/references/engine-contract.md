# Engine contract

## Project v5 and compiled runtime

Author `course.project.json` with `meta.schema: 5`; its `site` owns the primary
`biome` and `biomeTransitions` (use `[]` to preserve current behavior). The
compiler emits the corresponding fields in `course.json` runtime schema v4 for a
routed project, or legacy schema v3 for an unrouted practice project.

```json
{
  "biomeTransitions": [{
    "id": "ocean-edge",
    "from": "temperate-maritime",
    "to": "marine-ocean",
    "boundary": { "kind": "course-edge", "sides": ["min-x", "max-x", "min-z"] },
    "profile": "natural-resort-beach",
    "seed": 1843021,
    "widthScale": 1,
    "priority": 100
  }]
}
```

- `course-edge.sides`: one or more of `min-x`, `max-x`, `min-z`, `max-z`.
- `polygon-region.points`: 3–64 finite, in-bounds, non-self-intersecting world-space `{x,z}` points with meaningful area.
- `widthScale`: 0.5–2.
- `seed`: uint32. `priority`: integer.
- `from` must equal the course's primary biome and the pair must match the profile registry.
- Water profiles reject `polygon-region` boundaries.
- Equal-priority overlapping transition influence regions reject validation.

## Registry and compiled field

`src/course/BiomeRegistry.js` owns biome/profile registration, semantic validation, CPU classification, and compilation. The field exposes normalized weights for:

`primary`, `strandGrass`, `dune`, `drySand`, `wetSand`, `shallowShelf`, `deepOcean`, `alpine`.

Terrain, grass, backdrop, environment placement, minimap, and diagnostics consume this field. Gameplay surface classification continues to come from the existing zone SDF and feature authority.

## MCP and validation

- `describe_schema`: schema/profile vocabulary.
- `get_course`: current course plus transition count.
- `classify_point {x,z}`: gameplay surface and biome classification.
- `classify_biome {x,z}`: transition owner, habitat, distance, and normalized weights.
- `validate_course {project?}`: complete project normalization without writing.
- `apply_mutations {baseRevision, mutations}`: validates semantic source
  mutations, creates one undo checkpoint, writes `course.project.json`, and
  compiles `course.json`.

The in-app creator and MCP server share the same authoring kernel. Invalid schema
or transition changes fail before either source or runtime is committed.
