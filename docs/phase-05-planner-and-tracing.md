# Phase 5: Planner And Tracing

## Objective

Implement recall planning, token-budget packing, conflict behavior, and LangSmith tracing.

## Required references

Read before coding:

- `/.rules`
- `/README.md`
- `/ARCHITECTURE.md`
- `/MODELS.md`

## What to build

- planner types
- `ContextPolicy`
- `DefaultPolicy`
- token counting
- caller-model budget clamping
- pending-embedding fallback
- conflict modes
- recall stats
- LangSmith tracing wrappers

## Coding prompt

```md
Build Phase 5 for CodeBuddy.

Goal:
Make `recall` produce prompt-ready context with transparent stats.

Hard rules:
- Planner behavior must be deterministic and testable.
- Pending embeddings must not block recall.
- Budget handling must be explicit.
- Tracing must capture decisions, not just success paths.

Implement:
- `ContextPolicy` interface.
- `DefaultPolicy`.
- `recall({ sessionId, query, budget?, callerModel?, conflictMode? })`.
- Built-in caller model context-window registry.
- Budget warning and clamp when `callerModel` is known and budget is too large.
- Token counting with `js-tiktoken`.
- Recency floor.
- Vector lookup over ready embeddings.
- Summary fallback when available.
- Conflict modes: `all`, `latest`, `highest_confidence`.
- Greedy token packing by score.
- Stats with tokens used, items included, items skipped, skip reasons, fallback state, and budget headroom.
- LangSmith wrappers for provider calls, planner decisions, and later MCP tool invocations.

Testing:
- planner ranking with mocked candidates
- token-budget packing snapshot
- pending embedding fallback
- conflict modes
- caller-model clamp
- tracing metadata shape where practical

Definition of done:
- `recall` returns `{ system, messages, stats }`.
- Planner decisions can be inspected and tested.
- LangSmith integration has clear hooks for provider, planner, and MCP surfaces.
```

## Exit criteria

- recall works through planner
- stats are transparent
- conflict and budget behavior are covered by tests
- tracing hooks are ready for CLI/MCP/LangGraph use
