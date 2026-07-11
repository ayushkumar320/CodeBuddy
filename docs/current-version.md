# CodeBuddy — Current Version (2.0.0)

A precise, honest snapshot of what ships today: what is built, how automatic it
really is, how context is captured and recalled, and where the current limits
are. Companion to [roadmap.md](roadmap.md), which designs what comes next.

- **Version:** 2.0.0
- **Status:** Proposal 04 (Automatic Context Engine) complete. Full verification
  green (typecheck, lint, 224 tests / 1 Postgres-gated skip, build, `npm audit
  --omit=dev` clean, `npm pack` validated).

---

## 1. What CodeBuddy is, in one paragraph

A local-first project brain for AI coding agents. Durable knowledge (facts,
decisions, incidents, plans) lives as Markdown under `.codebuddy/`. On top of
that, a **context engine** prepares the smallest useful slice of project context
before an edit, captures durable knowledge after a turn, measures the token
savings, and warns before risky changes. PostgreSQL + pgvector is a derived
search index, never the source of truth. There is no hosted service.

---

## 2. Shipped capabilities

| Area | CLI | MCP tool(s) | DB needed? |
|---|---|---|---|
| Memory | `list-facts`, `inspect`, `export`, `stats`, `prune` | `remember`, `remember_batch`, `recall`, `list_facts`, `forget`, `share` | recall/embeddings only |
| Plans | `plan new/list/show/approve/start/complete/abandon/diff/policy` | `plan_current/create/amend/status` | no |
| Risk | `risk assess` | `risk_assess` | no |
| Architecture map | `map build/deps/dependents`, `symbols` | `map_query`, `map_neighbours` | no |
| Background index | `index [--full]`, `watch` | — | no |
| Context | `context bootstrap/preview/explain` | `context_bootstrap`, `context_before_edit` | no |
| Auto-capture + review | `memory review list/show/approve/reject/edit` | `context_after_turn` | no |
| Token savings | `savings` | (savings embedded in context tools) | no |
| Suggestions | `suggest` | `code_suggestions` | no |
| Client templates | `rules show/install` | — | no |
| Hook automation | `hooks install/status/uninstall` | — | no |
| Setup/health | `use`, `init`, `migrate`, `postgres`, `db doctor/test`, `doctor`, `claude`, `codex`, `serve` | — | varies |

Everything under Proposal 04 (04.1–04.8) is implemented. The only
environment-gated item is real PostgreSQL recovery/integration (one Vitest test
skips without a live database).

---

## 3. How "automatic" it is today — the honest version

CodeBuddy now supports **both** advisory, agent-driven automation and
deterministic hook-enforced automation. The distinction still matters, so it is
stated plainly below.

### What is automatic for the user

You do **not** manually call `remember` / `recall`. Once the workflow template
is installed (`codebuddy rules install --client claude|codex`), the agent is
instructed to:

1. call `context_bootstrap` at the start of a substantive turn (recall);
2. call `context_before_edit` before changing files (targeted recall);
3. call `context_after_turn` after a meaningful turn (capture);
4. optionally call `code_suggestions` before finalizing.

From your seat, context is captured and recalled without you typing memory
commands. That is the product promise, and it holds.

### What is *not* yet guaranteed

The steps above run because the **model chooses to follow the installed rules**.
There is currently no client-side hook that *forces* the calls. So:

- A model that ignores or forgets the rules will skip a call.
- Capture quality depends on the summary the agent passes to `context_after_turn`.
- There is no deterministic "on every prompt / on every edit / on turn end"
  trigger independent of the model.

In short, with the *advisory* rules alone (`codebuddy rules install`): it recalls
and captures on its own as part of an instructed workflow, but it is not
hard-wired.

### Hard-wired automation is now available (`codebuddy hooks`)

For a **guaranteed, model-independent** setup, install the Claude Code lifecycle
hooks:

```bash
codebuddy hooks install --client claude
```

This wires three deterministic triggers into `.claude/settings.json`:

- `UserPromptSubmit` → `codebuddy hooks context` — injects compact project
  context into every prompt (**recall, guaranteed**);
- `PostToolUse(Edit|Write|MultiEdit)` → `codebuddy hooks stage` — records the
  files each edit touched;
- `Stop` → `codebuddy hooks capture` — at turn end, captures durable memory from
  the *real* change set + the turn transcript (**capture, guaranteed**).

These fire whether or not the model chooses to call anything. The runtime
commands are fail-soft (a hook never breaks a turn), the install is idempotent
and visible, and `codebuddy hooks uninstall` removes them cleanly. Capture still
runs through the same confidence + sensitivity gating.

### Capture gating (what actually gets saved)

`context_after_turn` is deliberately conservative:

- **Auto-saved** (durable Markdown): confident facts, decisions, incidents
  (confidence ≥ 0.7, not sensitive).
- **Queued for review** (`.codebuddy/memory/review/`): temporary notes,
  low-confidence items, and anything the sensitivity scan flags (keys, tokens,
  credentials, emails are **never** auto-saved).
- **Dropped:** chatter.

Bias: prefer a missed memory over a false durable fact.

---

## 4. Data-flow reference

### Recall path (start of turn / before edit)

```text
context_bootstrap / context_before_edit
  → resolve target files (paths | plan | git)         [risk/service.resolveRiskPaths]
  → active/referenced plan                            [core/plan-*]
  → policy rules matching those files                 [risk/signals/policy]
  → incident memory for those files                   [core/memory-file-store]
  → risk assessment                                   [risk/service.assessRisk]
  → cached/incremental import neighbours              [map/cache + map/indexer]
  → measure token savings vs raw source               [savings/engine]
  → return bounded, explainable payload (+ tokens)
```

No LLM is involved in this path. Outputs are capped and carry `explain[]`.

### Capture path (end of turn)

```text
context_after_turn({ summary, changedFiles?, planId? })
  → extract candidates      [memory-extract/deterministic  | optional LLM w/ strict validation]
  → sensitivity scan        [memory-extract/sensitive]
  → gate each candidate     [memory-extract/engine]
        save → .codebuddy/memory/facts/*.md
        queue → .codebuddy/memory/review/*.md
        drop
  → return { saved, queuedForReview, ignored, reasons }
```

### Index + savings

```text
codebuddy index → .codebuddy/cache/index.json   (hash + summary per file; incremental; gitignore-aware)
savings          = baseline (raw source tokens of represented files) − returned (compact payload)
                   clamped ≥ 0 and ≤ baseline; never fabricated
```

---

## 5. On-disk layout

```text
.codebuddy/
├── config.json          # LOCAL ONLY (DB URL, token) — never commit
├── policies.yaml         # shared "handle with care" rules — commit
├── memory/
│   ├── facts/*.md        # durable facts — commit
│   ├── summaries/*.md     # durable summaries — commit
│   └── review/*.md        # queued candidates — local
├── plans/*.md            # durable plans — commit
└── cache/index.json      # rebuildable index — local (gitignored)
```

---

## 6. Token savings — what the numbers mean today

- **Baseline** = tokens to read the represented files' *raw source*.
- **Returned** = tokens of the compact payload CodeBuddy actually sends.
- **Saved** = `max(0, baseline − returned)`; **ratio** = `returned / baseline`.
- Estimation is deterministic (~4 chars/token). It is designed to *understate*
  (the returned payload also carries non-file context), never to inflate.

Measured example (small demo repo): 2 files, **385 raw tokens → 18 summary
tokens, 95% smaller**. The larger the change set an agent would otherwise pull
in, the bigger the absolute saving.

---

## 7. Known limitations (today)

1. **Hooks are Claude-only.** Deterministic hook-enforced automation is shipped
   for Claude Code; Codex still relies on the advisory workflow template.
2. **Hook-only cross-turn dedupe.** Claude hook context uses a session capsule
   ledger; MCP callers do not yet pass session identity and therefore receive
   complete responses on each call.
3. **Deterministic relevance with optional semantic extension.** Before-edit
   facts and symbols are task/path ranked offline. A semantic ranker interface
   exists, but the default MCP path does not yet wire pgvector similarity into
   packing priority.
4. **Estimated tokens, not a real tokenizer.** Good for comparison and budgeting;
   not exact provider accounting.
5. **Postgres recovery/integration is environment-gated** in CI (one skipped test).

Each of these is addressed as a concrete milestone in
[roadmap.md](roadmap.md).

---

## 8. Verification status

```text
npm run typecheck   ✅
npm run lint        ✅
npm test            ✅ 224 passed, 1 skipped (Postgres integration)
npm run build       ✅
npm audit --omit=dev ✅ 0 vulnerabilities
npm pack --dry-run  ✅ codebuddy-2.0.0.tgz (bin + migrations + docs + examples)
```
