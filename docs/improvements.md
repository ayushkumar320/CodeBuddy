# CodeBuddy — Improvements backlog

Concrete quality, robustness, and DX opportunities found by scanning the repo.
These are **not** blockers — the 2.1 code is clean (no TODO/FIXME debt, all
verification green). This is the "make it better" list, separate from the
feature [roadmap.md](roadmap.md).

Each item notes where it lives and why it matters, ranked within each group.

---

## Correctness & robustness

1. **Transcript parsing in the capture hook is best-effort.**
   `src/hooks/runtime.ts` reads the last assistant message from the Claude Code
   transcript with defensive JSON parsing. The format is client-defined and may
   change; capture still works (falls back to a file list), but the *content*
   quality depends on it. Add a small fixture-based test against a real
   transcript sample and revisit if the format drifts.

2. **Sensitivity scan is regex-based.**
   `src/memory-extract/sensitive.ts` catches common secret shapes but can miss
   novel ones. It is intentionally conservative (over-flags → review), and it
   only gates *auto-save*, never blocks. Consider periodic pattern review and an
   optional entropy check for high-entropy strings.

---

## Test coverage gaps

3. **The CLI command layer needs broader direct tests.**
   `src/cli/commands/*` (context, savings, suggest, indexing, memory-review,
   rules, hooks, risk, map) are thin wrappers tested only via their engines.
   Add a few end-to-end CLI tests (spawn the built binary against a temp repo,
   assert exit code + output shape) to catch wiring/flag regressions.

4. **A few small modules are only covered indirectly.**
   `savings/tokens.ts`, `hooks/staging.ts` (covered via runtime), and
   `memory-extract/review-store.ts` (covered via engine) have no colocated unit
   test. Cheap to add; makes intent explicit.

5. **Real PostgreSQL recovery is environment-gated.**
   One Vitest integration test skips without a live database, so DB
   recovery/reindex is not exercised in CI. Add a Dockerized Postgres job (or a
   documented local step) so recovery is verified before releases.

---

## Token-engine accuracy

6. **Token counts use a cl100k tokenizer, not the caller's exact tokenizer.**
   This is more accurate than the former character heuristic, but provider
   accounting can still differ. Tracked as roadmap **N.7**.

7. **Before-edit relevance is still partly deterministic.**
   The budget packer keeps "highest-value evidence first," but value is import
   degree, not similarity to the task. Tracked as roadmap **N.5**.

---

## Developer experience & hygiene

8. **Stale branches.** Merged local branches and older remotes can be pruned to
    keep the branch list readable.

9. **Version string is duplicated.** `2.1.0` is written in `package.json`, the
    CLI `--version`, and the MCP server version. Consider sourcing the CLI/MCP
    version from `package.json` at build time so a bump touches one place.

10. **`.codebuddy/plans/` in this repo holds design docs, not plans.** Either
    move them under `docs/` or implement improvement #2 so the tool tolerates
    them. Documented as a gotcha in [../CLAUDE.md](../CLAUDE.md).

---

## Suggested pickup order

Quick wins first: transcript fixtures and broader CLI e2e tests. Then improve
tokenizer selection and semantic ranking. The remaining items are release
hygiene or operational hardening.
