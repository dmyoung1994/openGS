# Agent engine tools

> **This file described a prior engine (a bounded MCP command server with
> `inspect_course` / `stage_commands` / `run_course_analyzers` over a `.golfcourse`
> archive). That server does not exist in this repository.**
>
> For the engine you are actually authoring — its `course.json` feature schema, its
> coordinate system, and its real tools — read **`references/engine.md`**.

In brief, this engine's tools (course-engine MCP server, `scripts/course-mcp.mjs`,
or the in-app `/api/build` prompt) are:

- `describe_schema` — the feature schema + green-contour vocabulary.
- `get_course` — the current `course.json` + a summary.
- `classify_point {x,z}` — surface, fairway half-width, and nearby features at a
  point (use before placing features). Replaces the old `inspect_region`.
- `validate_course {course?}` — normalize + design warnings (no write). Replaces the
  old `run_course_analyzers`.
- `set_course {course}` — validate then write the full course, which live-reloads
  the sim. Replaces the old `stage_commands`.

The safety boundary still holds: author features only, never raw terrain; edits are
non-destructive until written; visual acceptance still requires inspecting the
running sim from golfer height, low oblique, and overhead.
