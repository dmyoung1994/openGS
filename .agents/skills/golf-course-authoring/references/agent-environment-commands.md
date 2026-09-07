# Agent environment commands

> **Design vocabulary from the prior engine.** claude-golfsim does have strict
> authored and procedural asset catalogs, but it represents these ideas as project-v5
> `site.environment` records rather than the command names below. Query assets and
> apply semantic mutations through `scripts/course-mcp.mjs`; never author
> `course.json` directly. Keep the composition guidance below and map it through
> `references/engine.md`.

Use semantic environment commands so authored ecology is reproducible, editable, and validated by the engine. Do not approximate a community with dozens of hand-authored `place` calls.

## Choose the narrowest command

- `place`: one intentional solitary accent with a known `catalogId`.
- `environmentAssembly`: a 3–9 piece landmark tree community or rock outcrop with shared composition logic.
- `dressCourseEdge`: a layered transition on the native side of an existing maintained-ground boundary.
- `scatter`: a broad secondary mass. Limit it to 2–4 related catalog IDs and never use it to trace a perimeter.
- `clearAssets`: remove an obsolete local dressing pass before replacing it.

## Tree community

```json
{
  "type": "environmentAssembly",
  "assembly": "treeCommunity",
  "biome": "parkland",
  "catalogIds": [
    "parkland-white-oak",
    "parkland-red-maple",
    "parkland-rhododendron",
    "parkland-wood-fern",
    "parkland-fallen-oak"
  ],
  "x": 118,
  "z": 76,
  "radiusM": 22,
  "rotationY": 0.7,
  "seed": 18421
}
```

The palette must contain at least one compatible tree. The engine builds an asymmetric tall anchor, smaller supports, middle story, and terrain-contact pieces. Omit `catalogIds` only when accepting an engine-selected biome palette.

## Rock outcrop

```json
{
  "type": "environmentAssembly",
  "assembly": "rockOutcrop",
  "biome": "desert",
  "catalogIds": [
    "sandstone-strata-stack",
    "red-sandstone-boulder",
    "creosote-bush",
    "brittlebush"
  ],
  "x": -84,
  "z": 142,
  "radiusM": 13,
  "rotationY": 1.25,
  "seed": 77104
}
```

The palette must contain a compatible rock. Rotation establishes the bedding direction. Supports and contact pieces share that direction instead of reading as unrelated boulders.

## Layered course edge

```json
{
  "type": "dressCourseEdge",
  "biome": "coastal",
  "catalogIds": [
    "coastal-monterey-cypress",
    "coastal-sage-scrub",
    "coastal-dune-grass",
    "coastal-driftwood-trunk"
  ],
  "centerX": 30,
  "centerZ": 85,
  "radiusM": 150,
  "bandWidthM": 28,
  "count": 90,
  "seed": 52917
}
```

The engine searches the requested region for the real native-to-maintained boundary. It places low contact forms nearest the boundary, middle story behind them, and tall or rocky silhouettes deeper into native ground. It does not invent a circular edge from the command radius.

## Validation contract

All three semantic placement commands are deterministic on unchanged course data. Catalog IDs must exist and be biome-compatible. The engine enforces course bounds, declared slope ranges, same-entry spacing, object budget, and resolved-footprint exclusion from water, bunkers, greens, and maintained fairway turf. A forest assembly's broad authoring bounds may overlap fairway clearance envelopes when the resolved trees occupy intentional separator rough between holes; validate the actual trees instead of rejecting the whole rectangle. Edge dressing protects tee and cup clearances.

A rejected command is a design signal: choose a dry center, move the region to a real maintained/native contact, reduce radius or count, or select compatible catalog IDs. Do not evade validation with raw primitives or unlicensed assets.

## Acceptance

Inspect the result from golfer height, low oblique, and overhead. Reject rows, rings, uniform disks, isolated prop confetti, repeated transforms, floating bases, blocked shot corridors, or a single sparse perimeter band. A completed environment pass needs foreground contact, middle-ground mass, backdrop silhouettes, and deliberate negative space.
