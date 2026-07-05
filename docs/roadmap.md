# CodeBuddy — Roadmap (what's left to build)

The authoritative list of remaining work. v2.0 (Proposal 04) and hook-enforced
automation (N.1/N.2) are **done and merged**; everything below is enhancement,
not a fix. Each item has a status, a priority, and acceptance criteria so it can
be picked up independently.

Guardrails apply to every item: local-first, bounded, deterministic,
explainable, no mandatory LLM in the core path, no fabricated numbers, and a
working offline fallback.

- Snapshot of what already ships: [current-version.md](current-version.md)
- How the tools fail soft: [degraded-mode.md](degraded-mode.md)

---

## Status at a glance

| ID | Item | Status | Priority |
|---|---|---|---|
| N.1 | `codebuddy hooks` — recall on prompt, capture on stop | ✅ shipped | — |
| N.2 | Deterministic capture from the real edited-file set | ✅ shipped | — |
| N.3 | Symbol-level slicing (send functions, not whole files) | ✅ shipped | — |
| **N.4** | **Session capsule ledger (never resend a capsule)** | ⏭️ **next** | **high** |
| N.5 | Relevance-ranked budget packing (embeddings → priority) | planned | medium |
| N.6 | Diff-aware context + prompt-cache-aware ordering | planned | medium |
| N.7 | Real tokenizer behind `estimateTokens` | planned | low |
| R.1 | Publish `2.0.0` to npm | pending your call | — |
| R.2 | Codex lifecycle hooks (`hooks install --client codex`) | planned | low |

Dependency order: N.3 unblocks N.4 and N.5. N.6 depends on N.2 + N.4.

---

## Theme A — Deeper token savings ("Savings v2")

v2.0's win is coarse: a one-line summary per file instead of raw source. The
next work attacks the three remaining sources of waste — **granularity,
repetition, relevance**.

### N.3 — Symbol-level slicing (granularity) — ✅ SHIPPED

Records a per-file **symbol table** in the indexer (`src/indexer/symbols.ts`) —
each top-level function/class/interface/type/enum/const with its line range and a
one-line signature — using the lightweight regex + brace-matching approach (no
native parser). `context_before_edit` now returns each target file's public API
as signatures (`symbols[]`) in place of its full source, and `codebuddy symbols
<file>` inspects it (e.g. *"5 symbols · signatures ~40 tokens vs full file ~72,
44% smaller"*). The manifest field is optional and backward-compatible;
non-code languages fall back to the whole-file summary. Covered by tests for
extraction, ranges, signatures, manifest round-trip, and the context payload.

### N.4 — Session capsule ledger (repetition)

**Problem:** across a session the same capsule can be sent every turn.

**Plan:** a per-session ledger keyed by capsule content-hash id at
`.codebuddy/cache/session/<sessionId>.json`. Once sent, a capsule is replaced by
a ~1-token reference (`capsule:ab12cd34`) until its hash changes. Turns repeated
context from O(turns × files) to O(distinct capsules).

**Acceptance criteria:** ledger read/write + eviction on hash change; context
tools emit references for already-sent capsules; measured saving across a
simulated multi-turn session; deterministic.

### N.5 — Relevance-ranked packing (relevance)

**Problem:** before-edit context is ranked by path membership + import degree,
not by relevance to *this* task.

**Plan:** when embeddings exist (pgvector already indexes summaries), score
candidate capsules by cosine similarity to the task string and feed that as the
`priority` into the existing budget packer. Deterministic fallback (path +
degree) when embeddings are unavailable.

**Acceptance criteria:** relevance scoring wired into `packByBudget` priority;
offline path unchanged; test that a tight budget keeps the most relevant files.

### N.6 — Diff-aware context + prompt-cache-aware ordering

- **Diff-aware:** for a modified file, return the changed hunks + a few
  surrounding lines + the enclosing symbol signature, not the whole file. Uses
  the `PostToolUse` edit hook (N.2) which already knows the diff.
- **Cache-aware ordering:** emit context in a stable order (project summary →
  policies → plan → capsules) so provider prompt-caching reuses the prefix.
  Pairs with N.4's ledger: stable prefix + references = minimal fresh tokens.

### N.7 — Real tokenizer (accuracy, not savings)

Swap the `~4 chars/token` estimate behind `savings/tokens.ts` for a real
tokenizer keyed to the caller model, so budgets and reported savings match
provider accounting exactly. The `estimateTokens` seam isolates this — no call
sites change.

---

## Theme B — Reach & release

### R.1 — Publish 2.0.0 to npm

The package is built and `npm pack`-validated but not published. Requires your
npm auth. See [live-test-checklist.md](live-test-checklist.md) for the pre-push
verification, then `npm publish --access public`.

### R.2 — Codex lifecycle hooks

`codebuddy hooks install` supports Claude Code today; `--client codex` errors on
purpose. When Codex exposes an equivalent hook model, wire the same three
triggers (context/stage/capture) through it.

---

## Explicitly out of scope

- A hosted CodeBuddy memory cloud.
- Autonomous code editing / self-merging.
- A full whole-repo knowledge graph — CodeBuddy models *the change in front of
  you*, not the whole project (see the README's savings comparison).

## See also

- Concrete quality/robustness improvements found by scanning the repo:
  [improvements.md](improvements.md)
- Pre-release live verification: [live-test-checklist.md](live-test-checklist.md)
