# Environment kit rules

> **Not applicable to this engine.** claude-golfsim ships no licensed-asset kit; it
> renders a procedural tree line and cannot place catalog props. This file documents
> a prior engine and is retained only for design intent — see `references/engine.md`.

- Select catalog assets by biome and category; do not substitute a generic primitive when a matching catalog entry exists.
- Use real-world dimensions. Randomize only within each asset's declared scale and yaw ranges.
- Scatter deterministically from a supplied seed. Respect slope limits, minimum spacing, cluster radius, density, water affinity, and exclusion zones.
- Build natural groups with multiple species, ages, heights, and rotations. Avoid grids, repeated silhouettes, uniform scale, and identical color.
- Keep large trees outside greens, tees, bunker interiors, water, and primary landing corridors unless explicitly requested.
- Use LOD0 nearby, simplified meshes at mid-range, and impostors or aggressive simplification far away. Cross-fade when possible and preserve silhouette.
- Use alpha-tested foliage, physically based bark/stone materials, shared atlases, mesh compression, and texture compression. Do not use translucent leaf blobs or untextured geometric proxies as the intended final asset.
- Record stable ID, category, biome, dimensions, placement rules, source URL, author, license, and asset version for every distributed entry.
