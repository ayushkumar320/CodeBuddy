# Architecture

## Concurrency Model

`remember` uses Postgres advisory locks keyed by `(namespace, session_id)` so concurrent writers for the same session do not race.

Write idempotency rules:

- callers may pass `idempotencyKey`
- when omitted, CodeBuddy computes `sha256(namespace + session_id + content)`
- `content_hash` exists on both `interactions` and `facts`
- both tables enforce unique `(namespace_id, content_hash)`

Transaction rules:

- `remember` stores the interaction and the matching `embeddings` row with `status=pending` in one transaction
- embedding generation happens outside the transaction
- `share` is a single transaction across share records and audit inserts
- `forget` performs cascade behavior inside one transaction

## Embedding Pipeline

Embeddings are asynchronous in v0.1 and run in an in-process worker.

Embedding record lifecycle:

- `pending`
- `ready`
- `failed`

Operational fields:

- `attempts`
- `last_error`

Recall behavior when embeddings are not ready:

- use recency and summary-based recall first
- skip pending vectors instead of blocking the caller

Rationale:

- better to return slightly stale ranking than block on Hugging Face cold starts or rate limits

## Sharing Model

Shares are references by default.

Modes:

- `reference`
- `snapshot`

Reference mode:

- target namespace points to the live source fact
- source updates propagate
- deleting the source fact tombstones dependent references

Snapshot mode:

- target namespace receives a copy
- later source changes do not propagate
- source deletion does not delete the snapshot

ASCII model:

```text
reference:
source fact A -----> shared reference in target
     update A -----> visible in target
     delete A -----> target reference tombstoned

snapshot:
source fact A -----> copied fact B in target
     update A -----> no change to B
     delete A -----> B remains
```

## Conflicts

v0.1 does not attempt automatic conflict resolution.

Default recall behavior:

- return all matching facts
- sort by `confidence x recency`

Supported recall modes:

- `all`
- `latest`
- `highest_confidence`

The downstream LLM or agent is responsible for reconciling contradictions in v0.1.

## MCP Surface

v0.1 intentionally ships tools only.

Deferred:

- resources such as `codebuddy://namespace/<name>/facts`
- prompts

Rationale:

- tools are enough for first release workflows
- resources and prompts add another compatibility surface and are deferred deliberately, not forgotten

## Caching

`CodeBuddyNode` supports recall caching with:

```ts
new CodeBuddyNode({ memory, mode: "recall", cacheTtlSeconds: 30 })
```

Default cache:

- 30 seconds
- keyed by `(namespace, sessionId, query)`

This is especially useful in cyclic LangGraph flows that would otherwise repeat identical recall calls.

## Logging

Use `pino` for structured logs.

Rules:

- MCP stdio server logs JSON to stderr
- CLI uses `pino-pretty` when attached to a TTY
- CLI falls back to JSON logs when not attached to a TTY
- logs must redact secrets such as `HF_TOKEN`
- LangSmith should capture the same structured fields where tracing is enabled

## Privacy

- CodeBuddy stores conversation and fact content in plaintext in Postgres
- encryption at rest is a deployment responsibility, not an app-layer feature in v0.1
- no automatic PII detection ships in v0.1
- later releases may add sensitivity metadata and redaction workflows

## Forget Semantics

`forget(interactionId)`:

- hard-deletes the interaction
- hard-deletes its embedding
- tombstones extracted facts with `source_deleted: true`

`forget(factId)`:

- hard-deletes the fact
- hard-deletes its embedding
- tombstones referenced facts in other namespaces unless they were shared as snapshots

Audit requirements:

- `model_calls` records provider calls only
- persist forget, share, and write audit events in `audit_log`
