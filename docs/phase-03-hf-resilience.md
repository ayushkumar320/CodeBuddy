# Phase 3: HF Resilience Layer

## Objective

Build the Hugging Face provider layer before anything else depends on live model calls.

## Required references

Read before coding:

- `/.rules`
- `/MODELS.md`
- `/TROUBLESHOOTING.md`

## What to build

- provider adapter interface
- model registry
- Hugging Face adapter
- resilience orchestration
- per-model queues
- timeout wrapper
- retry/backoff behavior
- model-call diagnostics hooks

## Coding prompt

```md
Build Phase 3 for CodeBuddy.

Goal:
Implement a resilient Hugging Face provider layer that all future model calls must use.

Hard rules:
- Use `@huggingface/inference`.
- Use `p-retry`, `p-queue`, and `p-timeout`.
- No direct HF calls outside this layer.
- 403 gated-model responses are hard failures: do not retry and do not fallback.
- Embedding primary and fallback models must both be 384 dimensions.

Implement:
- `src/providers/adapter.ts` with typed methods for embeddings and text generation.
- `src/providers/models.ts` with model registry, dimensions, context windows, daily budget defaults, and capabilities.
- `src/providers/resilience.ts` for retry, timeout, queueing, cold-start handling, fallback orchestration, and warm cache.
- `src/providers/huggingface.ts` using the official HF client.

Behavior:
- 503 with `estimated_time`: wait estimated time plus jitter, then retry.
- 429: respect retry-after where available and queue limits.
- 404: treat as unavailable and fallback where allowed.
- 403: throw `Model <name> is gated. Accept the license at https://huggingface.co/<name> and retry.`
- Timeout every call at 90 seconds by default.
- Queue by model with configurable concurrency and rate limits.
- Cache warm-model state for 5 minutes.
- Record model-call metadata through an injectable hook so Phase 4 can persist it.

Testing:
- Unit test cold start.
- Unit test rate limit.
- Unit test gated model hard failure.
- Unit test fallback trigger.
- Unit test timeout.
- Keep live HF smoke tests behind an explicit env var.

Definition of done:
- Higher-level code has one provider interface to call.
- HF free-tier failure modes are handled before SDK, MCP, CLI, or LangGraph use the provider.
```

## Exit criteria

- provider interface exists
- HF adapter exists
- model registry exists
- resilience behavior is tested with mocked failures
- no higher-level code needs direct HF knowledge
