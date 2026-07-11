# Architecture

## Storage Model

CodeBuddy uses a dual-write transition model:

- facts and summaries are written to PostgreSQL and Markdown
- files live under `.codebuddy/memory/facts/` and
  `.codebuddy/memory/summaries/`
- PostgreSQL remains the active query/index layer
- `codebuddy reindex --full` can recreate fact, summary, and pending embedding
  records from those files

The files use versioned YAML front matter, atomic temporary-file writes,
`fsync`, and rename. Repository-root validation rejects traversal and
symlinked memory paths.

The following data remains database-only:

- raw interactions
- share relationships and tombstones
- audit logs
- model diagnostics
- generated embedding vectors

`codebuddy migrate to-files` is a non-writing preview. `--write` exports
missing files but never truncates database tables or overwrites conflicts.
Same-ID/different-content conflicts are reported with SHA-256 checksums.

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

Embeddings are asynchronous and run in an in-process worker.

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

CodeBuddy does not attempt automatic conflict resolution yet.

Default recall behavior:

- return all matching facts
- sort by `confidence x recency`

Supported recall modes:

- `all`
- `latest`
- `highest_confidence`

The downstream LLM or agent is responsible for reconciling contradictions.

## MCP Surface

The current MCP server intentionally ships tools only.

Deferred:

- resources such as `codebuddy://namespace/<name>/facts`
- prompts

Rationale:

- tools are enough for first release workflows
- resources and prompts add another compatibility surface and are deferred deliberately, not forgotten

## Caching

The background index maintains `.codebuddy/cache/architecture.json` as a
versioned, rebuildable import-graph cache. Content hashes from `index.json`
identify changed modules. When the source-file set is stable, only changed
modules are reparsed and unchanged nodes/edges are reused; additions, removals,
and renames trigger a correctness-first graph rebuild. Context retrieval shares
one index snapshot across graph, symbol, and savings stages. Missing, corrupt,
or incompatible caches fall back to rebuilding and never become source of
truth.

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

- facts and summaries are plaintext Markdown
- conversations, shares, telemetry, and indexes are plaintext in PostgreSQL
- project owners decide whether `.codebuddy/memory/` is committed or ignored
- encryption at rest is a deployment responsibility, not an app-layer feature
- automatic PII detection is planned but not shipped
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
