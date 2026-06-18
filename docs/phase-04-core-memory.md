# Phase 4: Core Memory Pipeline

## Objective

Implement the `CodeBuddy` SDK core and memory lifecycle on top of the schema and provider foundation.

## Required references

Read before coding:

- `/.rules`
- `/README.md`
- `/ARCHITECTURE.md`
- `/WORKFLOW.md`

## What to build

- `CodeBuddy` class
- config validation
- namespace resolution
- session generation
- idempotent `remember`
- `rememberBatch`
- async embedding worker
- worker lifecycle controls for start, stop, drain, retry, and graceful shutdown
- `share`
- `forget`
- DB-backed model-call persistence hook
- audit logging helpers

## Coding prompt

```md
Build Phase 4 for CodeBuddy.

Goal:
Implement the core SDK behavior that CLI, MCP, and LangGraph will reuse.

Hard rules:
- Keep provider details behind the adapter.
- Public inputs must be validated with Zod.
- `remember` must be idempotent.
- Embeddings are async via an in-process worker.
- Do not block writes on HF cold starts.
- Do not implement MCP or CLI command behavior here.

Implement SDK methods:
- `init()`
- `remember({ sessionId?, content, type?, idempotencyKey?, agentId? })`
- `rememberBatch(items)`
- `recall(...)` as an orchestration placeholder that will call the planner in Phase 5
- `share({ from, to, factIds, mode?, agentId? })`
- `forget(id)`

Remember behavior:
- `type` defaults to `interaction`.
- Supported v0.1 types: `interaction`, `fact`, `summary`.
- Generate `sess_<ulid>` when sessionId is missing.
- Compute `sha256(namespace + sessionId + content)` when idempotencyKey is missing.
- Take advisory lock by `(namespace, sessionId)`.
- In one transaction, insert the memory row and create embedding row as `pending`.
- Return existing ID with `deduplicated: true` on duplicate.
- Start or schedule the in-process embedding worker after commit.
- Add worker lifecycle controls for start, stop, drain, retry, and graceful shutdown.

Share behavior:
- Default mode is `reference`.
- Snapshot mode copies the fact into target namespace.
- Reference mode stores live reference semantics.
- Write audit records.

Forget behavior:
- Follow `/.rules` exactly for interaction and fact deletion.
- Use `audit_log` as the durable audit trail.

Testing:
- idempotent remember
- generated session IDs
- rememberBatch dedupe
- embedding row starts pending
- async worker status ready/failed with mocked provider
- worker drain and graceful shutdown behavior
- share reference vs snapshot
- forget tombstone/cascade behavior

Definition of done:
- The SDK core owns memory semantics.
- CLI, MCP, and LangGraph can call the same methods without duplicating behavior.
```

## Exit criteria

- core SDK methods exist
- async embedding lifecycle works with mocked provider
- idempotency and advisory-lock flow are implemented
- share and forget semantics match `/.rules`
