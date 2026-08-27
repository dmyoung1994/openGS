# Engine contract

## Schema v3

`course.json` requires `meta.schema: 3`, a primary `biome`, and `biomeTransitions` (use `[]` to preserve current behavior).

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
- `validate_course {course?}`: complete normalization without writing.
- `set_course {course}`: validates the complete course before the single write.

The in-app creator runs the same full normalizer after an agent edit and restores the exact prior course bytes on invalid schema or transitions.
