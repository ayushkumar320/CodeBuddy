# Current Phase

## Status

Current phase: `Phase 2 - Storage And Schema`

Project state:

- documentation has been updated to the upgraded single-package plan
- root product docs now define the improved target behavior
- `/.rules` now consolidates the complete build context
- `/WORKFLOW.md` explains the app flow in plain language and detail
- Phase 1 foundation scaffold is complete
- root package/tooling files now exist
- source and example placeholders now exist
- dependencies have not been installed yet

## What to build next

Build the Postgres and Drizzle storage foundation next.

Next concrete tasks:

1. Add Drizzle schema for namespaces, interactions, session summaries, facts, embeddings, shares, checkpoints, model calls, and audit log.
2. Add the first migration with `pgvector` extension setup.
3. Add HNSW cosine index definitions for `vector(384)`.
4. Add database client and bootstrap helpers.
5. Add dimension-compatibility checks for configured and existing embedding models.
6. Keep Docker out of this phase.

## What not to build yet

- Docker
- Hugging Face runtime integration
- resilience layer implementation
- planner logic
- MCP tools
- LangGraph integration
- CLI command behavior beyond placeholders

## Ready-to-use execution prompt

```md
We are in Phase 2 for CodeBuddy.

Build the storage and schema foundation only.

Rules:
- Use Drizzle ORM and Postgres.
- Implement the schema required by `/.rules`.
- Use `vector(384)` for embeddings.
- Add HNSW cosine index defaults.
- Add idempotency, async embedding status, agent attribution, sharing, audit, and diagnostics tables/fields.
- Do not add Docker.
- Do not add Hugging Face runtime logic yet.
- Do not implement planner, MCP, CLI, or LangGraph behavior yet.

Expected outcome:
- the schema and migration artifacts exist
- database bootstrap helpers exist
- storage shape supports the full improved v0.1 product
- the repo is ready for the HF resilience layer next
```

## When to update this file

Update this file immediately after Phase 2 is complete. The next version should point to `Phase 3 - HF Resilience Layer` and list the exact provider-resilience tasks to begin.
