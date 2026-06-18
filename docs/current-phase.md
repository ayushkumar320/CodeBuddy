# Current Phase

## Status

Current phase: `Phase 3 - HF Resilience Layer`

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

## What to build next

Build the Hugging Face resilience layer next.

Next concrete tasks:

1. Implement the provider adapter behavior for embeddings and text generation.
2. Build the model registry around the default Hugging Face embedding and LLM models.
3. Add retry/backoff, timeout, queueing, cold-start handling, warm-cache behavior, and fallback orchestration.
4. Treat gated model 403s as hard failures with clear guidance.
5. Add model-call diagnostics hooks for later persistence.
6. Add mocked unit tests for the resilience failure modes.

## What not to build yet

- Docker
- planner logic
- MCP tools
- LangGraph integration
- CLI command behavior beyond placeholders
- direct Hugging Face calls outside the provider layer

## Ready-to-use execution prompt

```md
We are in Phase 3 for CodeBuddy.

Build the Hugging Face resilience layer only.

Rules:
- Use `@huggingface/inference`.
- Use `p-retry`, `p-queue`, and `p-timeout`.
- Implement all live provider behavior behind `src/providers`.
- Handle 503 cold starts, 429 rate limits, 404 unavailability, 403 gated models, fallback chains, and 90-second timeouts.
- Record model-call metadata through an injectable hook.
- Do not add Docker.
- Do not implement planner, MCP, CLI, or LangGraph behavior yet.
- Do not call Hugging Face directly outside the provider layer.

Expected outcome:
- provider contracts are implemented
- Hugging Face adapter is resilient and testable
- mocked resilience tests exist
- the repo is ready for the core memory pipeline next
```

## When to update this file

Update this file immediately after Phase 3 is complete. The next version should point to `Phase 4 - Core Memory Pipeline` and list the exact SDK memory tasks to begin.
