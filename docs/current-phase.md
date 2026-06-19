# Current Phase

## Status

Current phase: `Phase 7 - Examples, Docker, Release`

Project state:

- Phases 1-6 are complete
- SDK remember, rememberBatch, recall, share, and forget are implemented
- Planner and LangSmith tracing are implemented
- MCP v0.1 stdio server exists with tools only
- MCP tools: `remember`, `remember_batch`, `recall`, `list_facts`, `list_namespaces`, `forget`, `share`
- `list_facts` uses opaque base64url cursors based on `(created_at, id)`
- LangGraph helpers exist: `CodeBuddyNode` and `CodeBuddyCheckpointer`
- `CodeBuddyNode` supports expected state: `messages`, `memory`, `sessionId`, `agentId`
- Recall node cache defaults to 30 seconds and is keyed by `(namespace, sessionId, query)`
- CLI commands exist: `init`, `serve`, `inspect`, `namespaces`, `prune`, `export`, `stats`, `doctor`
- Config loading prefers `HF_TOKEN` over file tokens and `init` writes `.codebuddy/config.json` with `0600`
- `doctor` reports DB, pgvector, vector/index health, model status, recent usage, daily cap estimate, and config permissions
- typecheck, lint, build, and tests pass (42 tests)

## What to build next

Build final developer experience and release artifacts.

Next concrete tasks:

1. Flesh out examples for Claude Desktop, LangGraph agent, and multi-agent handoff.
2. Add Docker Compose for PostgreSQL 16 plus pgvector.
3. Finalize release documentation.
4. Add any missing package metadata, contribution docs, and license artifacts required for release.
5. Verify the package can be built and used from the documented install paths.

## What not to build yet

- HTTP MCP transport
- Hosted service behavior
- Dashboard UI
- Provider support beyond Hugging Face

## Ready-to-use execution prompt

```md
Build Phase 7 for CodeBuddy.

Goal:
Finish examples, Docker, and release documentation without adding new product scope.

Rules:
- Do not add HTTP MCP transport.
- Do not add Redis, hosted service behavior, dashboard UI, or non-Hugging Face providers.
- Keep examples runnable and aligned with the README public APIs.
- Docker is for local Postgres + pgvector support only.
- Release docs must reflect the actual Phase 6 CLI, MCP, SDK, and LangGraph surfaces.

Expected outcome:
- examples are complete and accurate
- Docker Compose can start the required database
- release docs and package metadata are ready
- verification commands pass
```

## When to update this file

Update this file after Phase 7 is complete to mark the implementation release-ready.
