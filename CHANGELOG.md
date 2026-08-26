# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-08-26

First tagged release line after the 2.0 automatic-context-engine work landed;
hardens concurrency, security boundaries, and payload bounds across the engine.

### Added

- **Lease-based embedding claims** — claimed rows move to a `processing` status with a
  `lease_until` deadline (migration `0001_embedding_lease`), so concurrent MCP clients
  never double-process a job and crashed workers' jobs become re-claimable after expiry.
  Failures back off exponentially (2s→60s) instead of hot-retrying every 250ms poll.
- **CI workflow** — typecheck, lint, test, build, and pack-check run on every push/PR.
- `getFactById` on the repository contract; snapshot shares now carry real content.
- Input size caps on every MCP tool (content ≤32k chars, batches ≤100 items,
  plan bodies ≤64k) matching the bounded-output convention.
- Sensitive-scan coverage for GitHub fine-grained PATs, npm tokens, GitLab tokens,
  Basic-auth headers, and authorization-keyword assignments; candidate subjects are
  scanned too.
- Watch coalescer max-wait (5s) so sustained file churn cannot starve indexing.
- Migration warns when a namespace hits the 100k-row read cap.

### Fixed

- A transient DB error no longer crashes the whole MCP server (worker loop contains
  poll failures with backoff; diagnostic-sink failures isolated).
- Path traversal: tool-supplied `../` escapes are rejected and resolved paths are
  capped (200) before reaching any file read.
- Plan lifecycle: amend and lifecycle transitions share one namespace mutex, ending
  lost-update interleaves that could resurrect abandoned plans; lock release verifies
  PID ownership after a stale-lock steal.
- Snapshot shares validate the source fact exists and copy its actual knowledge
  (previously a dangling `__snapshot:` pointer).
- Memory/review stores skip stray or corrupt Markdown files instead of bricking
  every future capture turn behind fail-soft hooks.
- Hooks uninstall keeps user commands that share a group with CodeBuddy hooks;
  install reconciles stale matchers (e.g. `Edit` without `MultiEdit`).
- Secrets hygiene: Claude Desktop / Codex configs written atomically at `0600`;
  connection-string passwords redacted from CLI error output; prune rejects
  non-positive durations; pruned owners' embeddings and share tombstones cleaned up.
- One namespace resolver everywhere (env → config → sanitized folder name), fixing
  doctor warnings immediately after init and CLI/MCP namespace split-brain.
- Architecture map: explicit `.js` specifiers resolve correctly when both `.ts` and
  `.js` siblings exist; commented-out imports no longer create phantom edges.
- Platform-correct Claude Desktop config path in tests (Linux CI green).

### Changed

- `pruneBefore` now also removes embeddings and tombstones reference shares for
  pruned rows (both Postgres and in-memory repositories).

## [2.0.0]

Automatic context engine (Proposal 04): `context_bootstrap` / `context_before_edit` /
`context_after_turn` / `code_suggestions` MCP tools, background indexing, automatic
memory extraction with review queue, token-savings engine, client workflow templates.
See [docs/proposals/04-automatic-context-engine.md](docs/proposals/04-automatic-context-engine.md).

## [0.1.x]

Initial MCP memory server: remember/recall/share/forget over Postgres + pgvector,
plan store, risk assessor, LangGraph adapter.
