# Phase 6: MCP, LangGraph, And CLI

## Objective

Expose CodeBuddy through the product surfaces users will actually operate: MCP tools, LangGraph helpers, and CLI commands.

## Required references

Read before coding:

- `/.rules`
- `/README.md`
- `/TROUBLESHOOTING.md`
- `/WORKFLOW.md`

## What to build

- MCP stdio server
- MCP tools
- LangGraph node
- LangGraph checkpointer
- CLI command implementations
- doctor diagnostics
- config file handling

## Coding prompt

```md
Build Phase 6 for CodeBuddy.

Goal:
Expose the already-built SDK behavior through MCP, LangGraph, and CLI without duplicating core logic.

Hard rules:
- MCP v0.1 is stdio only.
- MCP v0.1 ships tools only; resources and prompts are deferred.
- CLI must never print secrets.
- `doctor` is a first-class feature.
- LangGraph peer dependency is `^0.2.0 || ^0.3.0`.

MCP tools:
- `remember`
- `remember_batch`
- `recall`
- `list_facts`
- `list_namespaces`
- `forget`
- `share`

MCP behavior:
- Tool schemas must match `/README.md` and `/.rules`.
- `remember` and `remember_batch` return `deduplicated`.
- `list_facts` supports `{ subject?, limit?: number = 50, cursor?: string }`.
- Cursor is opaque base64 of `(created_at, id)`.
- `share` may infer `from` from configured namespace.

LangGraph:
- Implement `CodeBuddyNode`.
- Implement `CodeBuddyCheckpointer`.
- Support expected state: `messages`, `memory`, `sessionId`, `agentId`.
- Recall node supports `cacheTtlSeconds`, default 30 seconds.
- Cache key: `(namespace, sessionId, query)`.

CLI:
- `codebuddy init`
- `codebuddy serve`
- `codebuddy inspect <namespace>`
- `codebuddy namespaces`
- `codebuddy prune --older-than 30d`
- `codebuddy export <namespace>`
- `codebuddy stats`
- `codebuddy doctor`

Doctor must report:
- DB connectivity
- `pgvector` availability
- vector count and index health
- model reachability
- gated model hard failures
- cold/warm status
- recent calls in last 60s, hour, and 24h
- estimated daily cap remaining
- warning at 80% cap
- config file permissions

Testing:
- MCP tool schema tests
- CLI command smoke tests
- doctor mocked diagnostics
- LangGraph state and cache behavior
- config redaction and permission checks

Definition of done:
- Users can operate CodeBuddy through MCP, CLI, SDK, and LangGraph.
- All public surfaces call the same core methods.
```

## Exit criteria

- MCP stdio server exists
- tool schemas match docs
- LangGraph helpers exist
- CLI commands exist
- doctor catches the expected operational failures
