# Migrating to CodeBuddy 2.0.0

CodeBuddy 2.0 adds the **Automatic Context Engine**: background indexing,
automatic before-edit context, confidence-gated memory capture, measured token
savings, read-only suggestions, and client workflow templates. It is additive —
existing memory, plans, risk, and the MCP surface from 0.1.x keep working.

## TL;DR

- No database migration is required beyond the usual `codebuddy migrate`.
- Existing `.codebuddy/memory/**/*.md` and `.codebuddy/plans/*.md` are unchanged
  and fully compatible.
- New artifacts appear under `.codebuddy/`: a rebuildable index cache and a
  memory review queue (both safe to delete).
- `remember` / `recall` still work exactly as before; they are just no longer
  the only way to get context.

## Upgrade steps

```bash
npm install -g @ayushkumar320/codebuddy@2.0.0
codebuddy migrate            # apply any pending DB migrations (safe if none)
codebuddy index              # build the background index (optional but recommended)
codebuddy doctor             # confirm DB, pgvector, and scaffold health
```

To wire the automatic workflow into your agent client:

```bash
codebuddy rules install --client claude   # writes a managed block into CLAUDE.md
codebuddy rules install --client codex    # or AGENTS.md for Codex
```

Preview the exact text first with `codebuddy rules show --client claude`.

## What is new

| Area | Command / tool | Notes |
|---|---|---|
| Background index | `codebuddy index [--full]`, `codebuddy watch` | Content hashes + summaries cached at `.codebuddy/cache/index.json` (gitignored, rebuildable). |
| Context bootstrap | `context_bootstrap` MCP tool, `codebuddy context bootstrap` | Compact project awareness at turn start. |
| Before-edit context | `context_before_edit` MCP tool, `codebuddy context preview\|explain` | Plan, policy, incidents, risk, and neighbours for a change set. |
| Automatic capture | `context_after_turn` MCP tool, `codebuddy memory review …` | Confidence- and sensitivity-gated; review queue at `.codebuddy/memory/review/`. |
| Token savings | `codebuddy savings`, savings fields in context tools | Measured against raw-source baseline; never fabricated. |
| Suggestions | `code_suggestions` MCP tool, `codebuddy suggest` | Read-only, evidence-backed, severity-ranked. |
| Client templates | `codebuddy rules show\|install` | Idempotent managed block in CLAUDE.md / AGENTS.md. |

## New on-disk artifacts

```text
.codebuddy/
├── cache/
│   └── index.json          # background index (gitignored, rebuildable)
└── memory/
    └── review/             # queued memory candidates awaiting approval
```

Both are safe to delete: the index is rebuilt by `codebuddy index`, and the
review queue only holds un-approved candidates. Add `.codebuddy/memory/review/`
to `.gitignore` if you do not want pending candidates shared.

## Behavior changes to know about

- `context_after_turn` can auto-save durable facts. It is conservative
  (confidence + sensitivity gated) and never auto-saves sensitive content, but
  if you want zero automatic writes, simply do not call the tool — nothing
  captures memory unless invoked.
- Token-savings numbers depend on the index. Without `codebuddy index`, savings
  fall back to reading files directly (slightly slower, same result).
- No breaking changes to `remember`, `recall`, `share`, `forget`, the plan
  lifecycle, `risk_assess`, or the `map_*` tools.

## Rollback

Downgrade the package (`npm install -g @ayushkumar320/codebuddy@0.1.2`). The
2.0 artifacts under `.codebuddy/cache/` and `.codebuddy/memory/review/` are
ignored by older versions and can be deleted. Committed facts, summaries, and
plans remain readable by both versions.
