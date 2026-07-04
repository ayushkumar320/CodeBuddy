# CodeBuddy — Next Plans

Where CodeBuddy goes after 2.0. Two themes drive this roadmap:

1. **True automation** — context is captured and recalled deterministically, not
   because the model remembered to. (Closes the gap called out in
   [current-version.md §3](current-version.md).)
2. **Deeper token savings** — go from "summaries instead of files" to
   "send only what this turn actually needs, and never resend it."

Everything here follows the existing product rules: local-first, bounded,
deterministic, explainable, no mandatory LLM in the core path, no fabricated
numbers.

---

## Theme 1 — Make it truly hands-free (hook-enforced automation)

> **Status: shipped (N.1 + N.2).** `codebuddy hooks install --client claude`
> wires `UserPromptSubmit→context`, `PostToolUse(edit)→stage`, and
> `Stop→capture` into `.claude/settings.json`. Recall and capture now fire
> deterministically, independent of the model. The rest of this section is the
> original design, kept for reference.

### The gap

Today the four context tools fire because the installed workflow rules *tell the
agent* to call them. If the model skips a step, context is not captured or
recalled. There is no deterministic trigger.

### The plan: `codebuddy hooks`

Client agents (Claude Code, and Codex via its equivalent) support lifecycle
**hooks** — shell commands the client runs at fixed points, independent of the
model's choices. CodeBuddy should ship a first-class hook installer:

```bash
codebuddy hooks install --client claude
```

which wires three deterministic triggers:

| Hook point | CodeBuddy action | Effect |
|---|---|---|
| `UserPromptSubmit` (turn start) | run `context_bootstrap` (+ `context_before_edit` if paths are inferable) and inject the compact result into the prompt | **recall, guaranteed** |
| `PostToolUse` on file edits | stage the changed paths for capture | tracks the real change set, not a model-written summary |
| `Stop` (turn end) | run `context_after_turn` using the staged diff + the turn transcript | **capture, guaranteed** |

Design constraints:

- **Visible & reversible.** Hooks are written into the client's settings behind
  clear markers (same managed-block approach as `rules install`), and
  `codebuddy hooks uninstall` removes them. No hidden mutation.
- **Deterministic capture input.** Capture uses the *actual* changed files
  (from the edit hook) and the turn text, so it no longer depends on the model
  authoring a good summary. The existing confidence + sensitivity gating still
  applies.
- **Degrade cleanly.** If a hook fails or CodeBuddy is unavailable, the turn
  proceeds normally (fail-soft, per `degraded-mode.md`).
- **Opt-in.** `rules install` (advisory) stays the default; `hooks install`
  (enforced) is for users who want zero-reliance automation.

Definition of done: with hooks installed, a fresh session recalls project
context on the first prompt and captures durable memory at turn end **without
the model choosing to** — verified by disabling the workflow rules and confirming
capture/recall still happen.

---

## Theme 2 — A better token-saving engine ("Savings v2")

Today's win is real but coarse: send a one-line summary per represented file
instead of its raw source. The next design attacks the three biggest remaining
sources of waste — **granularity, repetition, and relevance** — and is expected
to cut per-turn context tokens by a further large margin on top of 2.0.

### 2a. Symbol-level slicing (granularity)

**Problem:** a file capsule still stands in for the *whole* file. If a task
touches one function, the agent often still reads the whole file.

**Plan:** extend the indexer with a real parser (tree-sitter) to record, per
file, a **symbol table**: each top-level function/class/type with its byte range
and a one-line signature. Then `context_before_edit` can return **symbol
capsules** — the exact signatures (and, on demand, the exact body slice) of the
symbols relevant to the task — instead of the whole file.

- Baseline for savings becomes "read the whole file"; returned becomes "the 1–3
  relevant symbols." Expected savings on large files: another order of magnitude.
- Fully deterministic; tree-sitter is a parser, not an LLM.
- Falls back to the current whole-file summary when no parser exists for a
  language.

### 2b. Session capsule ledger — never resend (repetition)

**Problem:** across a multi-turn session, the same file/symbol capsule can be
sent again and again.

**Plan:** a per-session **ledger** keyed by capsule `id` (already a content
hash). Once a capsule has been sent in a session:

- subsequent turns send a **reference** (`capsule:ab12cd34`, ~1 token) instead of
  the full capsule;
- the capsule is re-sent in full only if its content hash changed (the file was
  edited) or the ledger was evicted.

This turns repeated context from O(turns × files) to O(distinct-capsules). The
ledger lives at `.codebuddy/cache/session/<sessionId>.json` (rebuildable, local).

### 2c. Relevance-ranked budget packing (relevance)

**Problem:** before-edit context is ranked by path membership and import degree,
not by how relevant a file is to *this* task.

**Plan:** when embeddings are available (pgvector already indexes summaries),
score candidate capsules by cosine similarity to the task string, and feed that
score as the `priority` into the existing budget packer. The packer already
"keeps highest-value evidence first" — this makes "value" mean *relevance*, so a
tight budget spends tokens on the files that actually matter.

- Deterministic fallback (path + degree) when embeddings are unavailable — the
  offline path never regresses.

### 2d. Compression tiers in the packer

**Problem:** the packer's compression is binary (full text or a single
`compressedText`).

**Plan:** give each capsule an ordered set of renderings — `full body → signature
→ name-only` — and let the packer **step down tiers** per candidate until the
budget fits, recording the tier used. High-value evidence keeps its full tier;
low-value context degrades to a name reference rather than being dropped
entirely. The `packer` and `FileCapsule` types already anticipate this.

### 2e. Diff-aware context for edits

**Problem:** for a change to an existing file, sending the whole file (or even
whole symbols) is often more than needed.

**Plan:** when the target is a modified file, return the **changed hunks plus a
few lines of surrounding context** and the enclosing symbol's signature, instead
of the full file. Ties naturally into the `PostToolUse` edit hook from Theme 1,
which already knows the exact diff.

### 2f. Prompt-cache-aware ordering

**Problem:** even compact context is re-billed every turn if it moves around.

**Plan:** emit context in a **stable order** with the most durable, least-changing
material first (project summary → policies → plan → capsules), so provider-side
prompt caching (e.g. Anthropic prompt caching) can reuse the prefix across turns.
Pair with the session ledger (2b): stable prefix + references = minimal fresh
tokens per turn.

### 2g. Real tokenizer (accuracy, not savings)

Swap the `~4 chars/token` estimator behind `savings/tokens.ts` for a real
tokenizer keyed to the caller model, so budgets and reported savings match
provider accounting exactly. The `estimateTokens` seam already isolates this —
no call sites change.

---

## Suggested build order

Small, verifiable phases, one at a time (same discipline as Proposal 04):

| Phase | Deliverable | Depends on |
|---|---|---|
| ✅ N.1 | `codebuddy hooks install/uninstall/status` (recall on prompt, capture on stop) | — |
| ✅ N.2 | Deterministic capture from the real edited-file set (edit hook → `context_after_turn`) | N.1 |
| N.3 | Symbol table in the indexer (tree-sitter) + symbol capsules | — |
| N.4 | Session capsule ledger + reference-instead-of-resend | N.3 |
| N.5 | Relevance-ranked packing (embeddings → priority) + compression tiers | N.3 |
| N.6 | Diff-aware context + prompt-cache-aware ordering | N.2, N.4 |
| N.7 | Real tokenizer behind `estimateTokens` | — |

Each phase ships with tests, a measured savings delta (before/after on a fixture
repo), and a docs update — no phase lands without proving its number.

---

## What stays the same

- Markdown remains the source of truth; Postgres stays a derived index.
- No hosted service; no telemetry leaves the machine.
- Savings are always measured against a concrete baseline and clamped — never
  fabricated.
- Every context payload stays bounded and carries `explain[]`.
- The offline (no-LLM, no-embeddings) path always works; every enhancement above
  has a deterministic fallback.

---

## Explicitly out of scope (for now)

- A hosted CodeBuddy memory cloud.
- Autonomous code editing / self-merging.
- A full whole-repo knowledge graph. CodeBuddy models *the change in front of
  you*, not the entire project; graph tools remain the right choice for
  open-ended cross-repo exploration (see the README's savings comparison).
