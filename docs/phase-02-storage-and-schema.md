# Phase 2: Storage And Schema

## Objective

Build the Postgres and Drizzle foundation that supports idempotent memory writes, async embeddings, sharing, LangGraph checkpoints, diagnostics, and auditing.

## Required references

Read before coding:

- `/.rules`
- `/ARCHITECTURE.md`
- `/MODELS.md`
- `/WORKFLOW.md`

## What to build

- Drizzle schema
- migration files
- Postgres client helper
- pgvector bootstrap helper
- schema constants and enum types
- DB health-check helpers for later `doctor`

## Coding prompt

```md
Build Phase 2 for CodeBuddy.

Goal:
Implement the complete v0.1 storage foundation from `/.rules`.

Hard rules:
- Postgres is the only datastore.
- Use `drizzle-orm` and `postgres`.
- Use `vector(384)` for embeddings.
- Add HNSW cosine index defaults: `m=16`, `ef_construction=64`.
- Do not add Docker yet.
- Do not add provider calls yet.

Tables:
- `namespaces`
- `interactions`
- `session_summaries`
- `facts`
- `embeddings`
- `shares`
- `checkpoints`
- `model_calls`
- `audit_log`

Required schema behavior:
- App-generated ULID-compatible text IDs.
- Unique namespace names.
- `content_hash` on interactions and facts.
- Unique `(namespace_id, content_hash)` for interactions and facts.
- Nullable `created_by_agent` on interactions, facts, and shares.
- `facts.source_deleted` tombstone flag.
- Embeddings with `owner_type`, `owner_id`, `vector(384)`, `embedding_model`, `status`, `attempts`, and `last_error`.
- `status` enum values: `pending`, `ready`, `failed`.
- Shares support `reference` and `snapshot` modes.
- `model_calls` records provider-call diagnostics only.
- `audit_log` records write/share/forget/config-sensitive operational events.

Bootstrap:
- Add helper to enable `vector` extension.
- Add helper to verify `pgvector` availability.
- Add helper to verify embedding dimension compatibility with existing rows.

Validation:
- Add schema-level tests or type-level checks where practical.
- Run typecheck/tests if dependencies are installed.

Definition of done:
- The schema supports all improved v0.1 behavior before core code begins.
- There is no need to revisit core table shape for idempotency, async embeddings, sharing, checkpoints, doctor, or audit behavior.
```

## Exit criteria

- schema and migrations exist
- vector dimension and indexes are defined
- async embedding lifecycle is represented
- idempotency, agent attribution, sharing, auditing, and diagnostics are represented
