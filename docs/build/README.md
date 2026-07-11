# Build Docs

Post-2.0 execution packets derived from the improvements backlog.

Use these when you want a scoped implementation brief instead of picking items
ad hoc from [../improvements.md](../improvements.md). The goal is the same as
the original build docs: tight scope, explicit acceptance criteria, and a clear
verification bar.

Each phase file contains:

- scope derived directly from [../improvements.md](../improvements.md);
- implementation goals;
- exact build targets;
- guardrails and non-goals;
- verification checklist;
- a Codex/Claude execution prompt.

**Start here:** [current-phase.md](./current-phase.md) — what's being built now
and which doc drives it.

## Status: 05.x track complete ✅

All four phases are implemented, verified (typecheck/lint/test green), and
merged/branched. The phase files below are kept as history — the scope,
acceptance criteria, and what each one closed.

| Phase | Status | Closed |
|---|---|---|
| [05.1 Correctness Hardening](./05.1-correctness-hardening.md) | ✅ | #1, #2, #12 |
| [05.2 Capture and Sensitivity Hardening](./05.2-capture-and-sensitivity-hardening.md) | ✅ | #3, #4 |
| [05.3 Test Confidence and Recovery](./05.3-test-confidence-and-recovery.md) | ✅ | #5, #6, #7 |
| [05.4 Repo Hygiene and Release Ergonomics](./05.4-repo-hygiene-and-release-ergonomics.md) | ✅ | #10, #11 |

## Next

The build-doc backlog (Proposal 04 improvements) is exhausted. Next work comes
from the roadmap, not this folder:

- **N.4 — Session capsule ledger** (next, high priority): never resend a capsule
  twice in a session; collapse an already-sent capsule to a ~1-token reference
  until its content hash changes. See [../roadmap.md](../roadmap.md).
- then N.5 (relevance-ranked packing) → N.6 (diff-aware + cache-aware ordering)
  → N.7 (real tokenizer). Release items: R.1 (publish 2.0.0), R.2 (Codex hooks).

If a future roadmap item needs a scoped brief, add a new `NN-*.md` execution
packet here and point `current-phase.md` at it.

## Rules

- complete one phase at a time unless the phase explicitly allows parallel work;
- do not widen scope beyond the listed improvement items;
- keep roadmap work (`N.3`–`N.7`, `R.2`) separate unless the phase explicitly
  calls it in;
- do not silently skip tests or quality gates;
- update the living docs when behavior changes.
