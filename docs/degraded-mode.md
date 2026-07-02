# Degraded-mode behavior

CodeBuddy is designed to fail soft. When a piece of the system is unavailable,
the agent should keep working with whatever is still trustworthy — never block,
and never invent context. The workflow templates (`codebuddy rules show`) embed
a short version of this; the full guidance lives here.

## Principles

- The working tree is always authoritative. If retrieval is unavailable or
  empty, read the relevant files directly.
- Prefer a truthful "I couldn't retrieve that" over a fabricated memory.
- File-based features do not depend on the database.

## Failure scenarios

### A CodeBuddy MCP tool errors or is missing

The client may be running an older CodeBuddy, or the server failed to start.
Proceed using the repository itself; treat the tool result as absent, not as an
empty-but-authoritative answer. Re-check the MCP server registration with
`codebuddy claude list` / `codebuddy codex list` if tools are consistently
missing.

### Postgres is unreachable

The file-based tools keep working with no database:

- `context_bootstrap`, `context_before_edit` (plan, policy, incidents, risk, map)
- `code_suggestions`
- `codebuddy plan`, `codebuddy risk`, `codebuddy map`, `codebuddy context`,
  `codebuddy index`, `codebuddy savings`, `codebuddy suggest`, `codebuddy memory review`

Only recall/embeddings and other DB-backed commands are degraded. Run
`codebuddy db doctor` to diagnose, and say recall is unavailable rather than
guessing at remembered facts.

### Retrieval returns no context

An empty result is not the same as "there is nothing relevant." Read the target
files directly and proceed. If a plan was expected but none is active, continue
without one rather than fabricating scope.

### The index is stale or missing

`codebuddy savings` and file capsules fall back to reading files directly when
`.codebuddy/cache/index.json` is absent. Run `codebuddy index` to refresh; the
manifest is a rebuildable cache, never a source of truth.

## Installing the workflow templates

`codebuddy rules install --client claude` (or `--client codex`) writes a managed
block into `CLAUDE.md` / `AGENTS.md`. The block is delimited by
`codebuddy:workflow` markers, so re-running updates it in place and never
touches the rest of the file. Use `codebuddy rules show --client <client>` to
preview the exact text first.
