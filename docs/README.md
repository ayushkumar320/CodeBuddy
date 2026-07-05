# CodeBuddy docs

Index of all project documentation. Start here.

## Understand the project

- [../README.md](../README.md) — what CodeBuddy is, setup, every feature with
  examples, and the token-savings-vs-graph comparison. **Read this first.**
- [current-version.md](current-version.md) — precise snapshot of what ships in
  2.0, and an honest account of how automatic it really is.
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — storage model, concurrency,
  embeddings, sharing, forget semantics.
- [../WORKFLOW.md](../WORKFLOW.md) — the intended agent workflow.

## Operate it

- [../CLAUDE_CODEX.md](../CLAUDE_CODEX.md) — Claude Code / Codex + Docker setup.
- [migration-2.0.md](migration-2.0.md) — upgrading from 0.1.x to 2.0.
- [degraded-mode.md](degraded-mode.md) — how the tools fail soft.
- [live-test-checklist.md](live-test-checklist.md) — manual verification before
  publishing and final deployment.

## Build on it

- [roadmap.md](roadmap.md) — what's left to build, with status + acceptance
  criteria (Savings v2, Codex hooks, publish).
- [improvements.md](improvements.md) — quality/robustness/DX backlog found by
  scanning the repo.
- [build/](build/README.md) — post-2.0 execution packets for shipping the
  improvements backlog in scoped phases.
- [../CLAUDE.md](../CLAUDE.md) — agent-oriented operating notes (layout,
  commands, conventions, gotchas).

## History / source of truth

- [proposals/04-automatic-context-engine.md](proposals/04-automatic-context-engine.md)
  — the design proposal the 2.0 engine was built from.
- [plans.md](plans.md) — the plan-artifact model.
