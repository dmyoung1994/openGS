# Agent engine tools

> **This file described a prior engine (a bounded MCP command server with
> `inspect_course` / `stage_commands` / `run_course_analyzers` over a `.golfcourse`
> archive). That server does not exist in this repository.**
>
> For the engine you are actually authoring — its `course.json` feature schema, its
> coordinate system, and its real tools — read **`references/engine.md`**.

In brief, this engine's tools (course-engine MCP server, `scripts/course-mcp.mjs`,
or the in-app Course Creator) share one project-v5 authoring kernel:

- `describe_schema` — the feature schema + green-contour vocabulary.
- `get_context` — compact revision, route, feature, asset, decision, and scene-control context.
- `get_course` — authoritative `course.project.json` plus its compiled runtime.
- `classify_point {x,z}` — surface, fairway half-width, and nearby features at a
  point (use before placing features). Replaces the old `inspect_region`.
- `validate_course {project?}` — normalize, compile, and return design warnings (no write). Replaces the
  old `run_course_analyzers`.
- `query_tree_assets` — query authored and approved procedural tree catalogs.
- `apply_mutations {baseRevision,mutations}` — apply stable semantic-object edits,
  record history, and compile runtime. Replaces the old `stage_commands`.

The safety boundary still holds: author features only, never raw terrain; edits are
non-destructive until written; visual acceptance still requires inspecting the
running sim from golfer height, low oblique, and overhead.
