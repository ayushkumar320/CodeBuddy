# Current Phase

## Status

Current phase: `Phase 6 - MCP, LangGraph, CLI`

Project state:

- Phases 1–5 are complete
- `recall({ sessionId, query, budget?, callerModel?, conflictMode? })` orchestrates a planner pipeline that returns `{ system, messages, stats }`
- `DefaultPolicy` ranks ready embeddings by cosine similarity, applies a recency floor, supports `all`/`latest`/`highest_confidence` conflict modes, and packs into a token budget
- Token counting uses `js-tiktoken` (cl100k base) with a length-based fallback
- Caller-model budget clamp validates against `getModelContextWindow` and reports `budgetClamped` + `budgetClampReason`
- Embedding-coverage stats (`ready`, `pending`, `failed`) and `skipReasons` are surfaced on every recall
- Pending-embedding fallback returns recency + latest summary without blocking on the worker
- LangSmith tracing wrappers (`createTracer`) auto-enable on `LANGCHAIN_TRACING_V2=true` and wrap planner + provider spans
- typecheck, lint, build, and tests pass (36 tests; planner + recall covered)

## What to build next

Build the user-facing surfaces.

Next concrete tasks:

1. Implement MCP stdio server tools: `remember`, `remember_batch`, `recall`, `list_facts`, `list_namespaces`, `forget`, `share`.
2. Implement `list_facts` pagination with an opaque base64 cursor.
3. Implement `CodeBuddyNode` and `CodeBuddyCheckpointer` for LangGraph (with 30s recall cache).
4. Implement CLI commands: `init`, `serve`, `inspect`, `namespaces`, `prune`, `export`, `stats`, `doctor`.
5. Enforce `0600` permissions on `.codebuddy/config.json`; prefer `HF_TOKEN` over file tokens.
6. Wire structured logging via `pino` (JSON to stderr for MCP, `pino-pretty` for TTY CLI).
7. Add graceful shutdown to `serve` that drains the embedding worker.

## What not to build yet

- Docker
- examples beyond what already exists
- HTTP transport (deferred to v0.2)

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
