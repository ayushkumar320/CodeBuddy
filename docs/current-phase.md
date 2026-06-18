# Current Phase

## Status

Current phase: `Phase 4 - Core Memory Pipeline`

Project state:

- documentation has been updated to the upgraded single-package plan
- root product docs now define the improved target behavior
- `/.rules` now consolidates the complete build context
- `/WORKFLOW.md` explains the app flow in plain language and detail
- Phase 1 foundation scaffold is complete
- root package/tooling files now exist
- source and example placeholders now exist
- dependencies are installed
- Phase 2 storage and schema scaffold is complete
- typecheck, lint, and build pass
- Phase 3 Hugging Face resilience layer is complete
- provider-layer tests pass

## What to build next

Build the core SDK memory pipeline next.

Next concrete tasks:

1. Implement `CodeBuddy` config validation with Zod.
2. Add namespace resolution and session generation.
3. Implement idempotent `remember` and `rememberBatch`.
4. Add the in-process async embedding worker lifecycle.
5. Implement `share` reference/snapshot semantics.
6. Implement `forget` tombstone/cascade behavior.
7. Persist provider diagnostics into `model_calls` and operational events into `audit_log`.

## What not to build yet

- Docker
- planner logic
- MCP tools
- LangGraph integration
- CLI command behavior beyond placeholders
- direct Hugging Face calls outside the provider layer

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
