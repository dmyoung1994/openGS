# Local Course Agent Architecture

## Decision

The Course Creator ships on the [OpenAI Codex SDK](https://developers.openai.com/codex/sdk).
It uses the user's existing Codex login as a hard requirement, runs in an isolated
temporary working directory with read-only sandboxing, network and web search
disabled, and asks only for schema-constrained proposal data. The model cannot edit
the repository. Local application code validates every proposed mutation before it
can be previewed or applied.

The [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
is the better fit when this evolves into a hosted, long-running application with
first-class tools, handoffs, guardrails, traces, voice, or a provider-neutral model
boundary. It is not the default local creator path today because this product needs
Codex authentication, image/file context, persistent coding-agent threads, and a
small local sidecar more than it needs a multi-agent runtime. No second live runtime
arm is maintained; this avoids divergent proposal semantics and evaluation results.

## Trust boundary

```text
WebGPU view captures + prompt
             |
             v
Vite local sidecar -> isolated temp context -> Codex SDK (read-only, no network)
             |                                  |
             |<---- schema-constrained proposal-|
             v
local schema + dependency validation -> proposal cards -> designer selection
             |
             v
course.project.json v4 -> active-hole compiler -> course.json v3 -> renderer/physics
             |
             v
per-object persistent history, undo, and redo
```

The course model is the only writable product surface. Renderer code, shaders,
assets, and arbitrary filesystem paths are outside the agent boundary. Captures are
stored only in temporary directories for a turn. Proposal/history state lives under
`.course-builder/` locally; the accepted source of truth is `course.project.json`.

## Review flow

1. Capture the current production WebGPU frame.
2. Ask Codex for dependency-aware, one-object proposal cards.
3. Validate the complete proposed project without writing.
4. Preview the selected proposal through the normal course rebuild path.
5. Capture tee, landing, approach, overview, and current views; permit at most two
   critique passes.
6. Let the designer revise a single card as a branch, reject it, or apply selected
   cards. Dependencies are applied in deterministic order.
7. Save every accepted object as its own history event and atomically compile the
   active hole runtime.

One schema covers a single hole, practice range, or an 18-hole site. Progressive
full-course authoring is represented as bounded proposal/review stages rather than a
single unreviewable repository mutation.
