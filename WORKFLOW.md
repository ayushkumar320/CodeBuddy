# CodeBuddy Workflow

This is the simple mental model for how CodeBuddy works.

## Layman View

CodeBuddy is a shared notebook for AI agents.

- Agents write memories into the notebook.
- CodeBuddy stores the memories in Postgres.
- Embeddings are prepared in the background so related memories can be found later.
- When an agent asks a question, CodeBuddy picks the most useful memories that fit inside the token budget.
- Agents can share facts with other agents through namespaces.
- The CLI helps you see whether the database, Hugging Face models, and memory index are healthy.

## Graphical Flow

```text
User or Agent
     |
     v
SDK / MCP Tool / CLI
     |
     v
CodeBuddy Core
     |
     +--> Postgres transaction
     |      |
     |      +--> write interaction/fact/summary
     |      +--> create embedding row as pending
     |      +--> write audit record when needed
     |
     +--> In-process embedding worker
     |      |
     |      +--> Hugging Face resilience layer
     |      |      |
     |      |      +--> retry/backoff
     |      |      +--> cold-start wait
     |      |      +--> rate-limit queue
     |      |      +--> fallback model
     |      |
     |      +--> update embedding status to ready or failed
     |
     v
Recall request
     |
     +--> recent session memory
     +--> ready vector matches
     +--> available summaries
     +--> shared facts
     |
     v
Planner packs best items under token budget
     |
     v
{ system, messages, stats }
```

## Remember Flow In Detail

1. A caller sends `remember({ sessionId?, content, type?, idempotencyKey?, agentId? })`.
2. If `sessionId` is missing, CodeBuddy creates `sess_<ulid>`.
3. CodeBuddy computes a content hash if no idempotency key is provided.
4. It takes a Postgres advisory lock for `(namespace, sessionId)`.
5. In one transaction, it writes the memory row and creates an embedding row with `status=pending`.
6. If the same content or idempotency key already exists, it returns the original ID with `deduplicated: true`.
7. After the transaction, the in-process worker asks Hugging Face for embeddings.
8. The embedding row becomes `ready` or `failed`.

## Recall Flow In Detail

1. A caller sends `recall({ sessionId, query, budget?, callerModel?, conflictMode? })`.
2. If `callerModel` is present, CodeBuddy checks the budget against known model context windows.
3. The planner always includes a recency floor from the current session.
4. It searches ready embeddings for related facts and interactions.
5. If embeddings are still pending, it falls back to recency and available summaries.
6. It applies conflict behavior: `all`, `latest`, or `highest_confidence`.
7. It greedily packs the best items until the token budget is reached.
8. It returns prompt-ready context plus stats explaining what was included and skipped.

## Sharing Flow In Detail

```text
reference mode:
research-agent fact A ---> ops-agent reads fact A
source update          ---> target sees update
source delete          ---> target reference is tombstoned

snapshot mode:
research-agent fact A ---> copied as ops-agent fact B
source update          ---> B does not change
source delete          ---> B remains
```

## Doctor Flow

`codebuddy doctor` checks the things most likely to make the system feel broken:

- database connection
- `pgvector` extension
- vector index health
- Hugging Face model reachability
- gated model errors
- cold vs warm model state
- rate-limit pressure
- calls in the last 60 seconds, hour, and 24 hours
- daily budget estimate
- config file permissions

## Why Async Embeddings Matter

Hugging Face free-tier models can be cold or rate-limited. CodeBuddy should not block a memory write just because a model needs time to wake up. It stores the memory first, marks the embedding as pending, and lets recall use recency until vectors are ready.

## What The User Sees

- Writes return quickly and safely.
- Repeated writes do not duplicate memory.
- Recall works even if embeddings are still warming up.
- `stats` explains memory selection.
- `doctor` explains operational problems.
- Agent handoffs are explicit through namespaces and shares.

