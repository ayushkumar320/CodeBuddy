# Models

## Defaults

Embedding models:

- primary: `sentence-transformers/all-MiniLM-L6-v2`
- fallback: `BAAI/bge-small-en-v1.5`
- both must stay on `384` dimensions for schema compatibility

LLM models:

- primary: `meta-llama/Llama-3.2-3B-Instruct`
- fallback: `Qwen/Qwen2.5-7B-Instruct`
- last resort: `mistralai/Mistral-7B-Instruct-v0.3`

## Why These Models

- `all-MiniLM-L6-v2` is hot often enough for free-tier friendly embeddings
- `bge-small-en-v1.5` keeps the same embedding size, which avoids schema churn on fallback
- Llama 3.2 3B is a reasonable first default for low-cost structured outputs
- Qwen and Mistral provide resilience when the primary model is cold, gated, or unstable

## Embedding Dimension Validation

`CodeBuddy.init()` and `codebuddy init` must:

- look up dimensions for primary and fallback embedding models
- refuse startup if configured dimensions do not match each other
- refuse startup if configured dimensions do not match existing stored embedding model data

The runtime should compare configured models against any existing rows in `embeddings` before serving traffic.

## Free-Tier Budget Assumptions

`codebuddy doctor` should report:

- calls in last 60 seconds per model
- calls in last hour per model
- calls in last 24 hours per model
- estimated daily cap remaining

Daily cap defaults should live in config and be documented here. Warn at 80% of the configured daily cap.

## Gated Models

403 responses from Hugging Face are hard failures.

They must not:

- be retried
- trigger fallback automatically

Expected error shape:

`Model <name> is gated. Accept the license at https://huggingface.co/<name> and retry.`

`codebuddy doctor` should surface this as a blocking diagnostic.

## Swapping Models

Models should be swappable through config, but only when:

- embedding dimensions remain compatible, or a migration is performed
- the runtime registry knows the target model capabilities
- the startup validation passes

## Warm Vs Cold Expectations

Expect two classes of behavior:

- warm: near-immediate response
- cold: 503 with `estimated_time`, which should trigger delayed retry behavior

The product should favor resilience over lowest-latency assumptions.

## Vector Index Tuning

Defaults:

- `m=16`
- `ef_construction=64`

Operational note:

- once a namespace exceeds `100k` vectors, start tuning `ef_search` per query

`codebuddy doctor` should report vector counts and recommend a reindex when this threshold is crossed.

Deferred command:

- `codebuddy reindex <namespace>` in v0.2

