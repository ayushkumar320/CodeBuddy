# Current Phase

## Status

Current phase: `Phase 5 - Planner And Tracing`

Project state:

- Phase 1 foundation scaffold is complete
- Phase 2 storage and schema scaffold is complete
- Phase 3 Hugging Face resilience layer is complete
- Phase 4 core memory pipeline is complete
- `CodeBuddy` SDK validates config with Zod and resolves namespaces on `init`
- `remember` and `rememberBatch` are idempotent via content hash or `idempotencyKey`
- Session ids auto-generate as `sess_<ulid>` when omitted
- `MemoryRepository` abstraction backs both an in-memory test fake and a Drizzle-backed Postgres implementation
- In-process embedding worker supports start/notify/drain/stop/shutdown and persists `model_calls`
- `share` writes reference and snapshot rows + `audit_log`
- `forget` hard-deletes the interaction/fact, drops the embedding, tombstones reference shares, and marks dependent facts `source_deleted`
- typecheck, lint, build, and tests pass (28 tests across resilience, HF, and core)

## What to build next

Build the recall planner and tracing.

Next concrete tasks:

1. Implement `recall({ sessionId, query, budget?, callerModel?, conflictMode? })`.
2. Implement the default context policy with recency floor + vector similarity ranking.
3. Add budget packing keyed on `js-tiktoken` token counts.
4. Validate `budget` against the model context-window registry, warn, and clamp.
5. Implement fallback to recency + summaries when embeddings are pending or failed.
6. Wire LangSmith tracing around provider calls, planner decisions, and tool invocations.
7. Return `{ system, messages, stats }` with full stats fields.

## What not to build yet

- Docker
- MCP tools
- LangGraph integration
- CLI command behavior beyond placeholders

## Ready-to-use execution prompt

```md
We are in Phase 4 for CodeBuddy.

Build the core memory pipeline only.

Rules:
- Keep provider details behind the adapter.
- Validate public inputs with Zod.
- Implement idempotent remember and rememberBatch.
- Create embedding rows as pending inside the write transaction.
- Generate embeddings asynchronously outside the transaction.
- Add worker start, stop, drain, retry, and graceful shutdown hooks.
- Implement share and forget semantics from `/.rules`.
- Do not add Docker.
- Do not implement planner, MCP, CLI, or LangGraph behavior yet.
- Do not call Hugging Face directly outside the provider layer.

Expected outcome:
- core SDK methods are implemented
- memory writes are idempotent
- async embedding lifecycle works with mocked providers
- share and forget semantics are covered by tests
- the repo is ready for planner and tracing next
```

## When to update this file

Update this file immediately after Phase 4 is complete. The next version should point to `Phase 5 - Planner And Tracing` and list the exact recall/planner tasks to begin.
