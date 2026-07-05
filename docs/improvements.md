# CodeBuddy — Improvements backlog

Concrete quality, robustness, and DX opportunities found by scanning the repo.
These are **not** blockers — the 2.0 code is clean (no TODO/FIXME debt, all
verification green). This is the "make it better" list, separate from the
feature [roadmap.md](roadmap.md).

Each item notes where it lives and why it matters, ranked within each group.

---

## Correctness & robustness

1. **Architecture-map import resolver ignores `.js` specifiers.**
   `src/map/indexer.ts` appends extensions to the raw specifier and does not
   strip a trailing `.js`, so ESM-style `import "./x.js"` fails to resolve to
   `x.ts`. This repo uses `.js` specifiers throughout, so the map under-reports
   its own edges. Fix: strip a trailing `.js`/`.jsx` before candidate matching.
   *Impact: architecture map, blast-radius suggestions, before-edit neighbours.*

2. **`PlanFileStore.listPlans()` throws on any non-plan `.md`.**
   It parses every file in `.codebuddy/plans/` and errors on missing front
   matter, which breaks `plan list` / `context bootstrap` in repos that keep
   hand-written docs there (including this one). Fix: skip files that aren't
   `pln_*.md`, or skip-with-warning on parse failure instead of throwing.
   *Impact: usability on real repos.*

3. **Transcript parsing in the capture hook is best-effort.**
   `src/hooks/runtime.ts` reads the last assistant message from the Claude Code
   transcript with defensive JSON parsing. The format is client-defined and may
   change; capture still works (falls back to a file list), but the *content*
   quality depends on it. Add a small fixture-based test against a real
   transcript sample and revisit if the format drifts.

4. **Sensitivity scan is regex-based.**
   `src/memory-extract/sensitive.ts` catches common secret shapes but can miss
   novel ones. It is intentionally conservative (over-flags → review), and it
   only gates *auto-save*, never blocks. Consider periodic pattern review and an
   optional entropy check for high-entropy strings.

---

## Test coverage gaps

5. **The CLI command layer has no direct tests.**
   `src/cli/commands/*` (context, savings, suggest, indexing, memory-review,
   rules, hooks, risk, map) are thin wrappers tested only via their engines.
   Add a few end-to-end CLI tests (spawn the built binary against a temp repo,
   assert exit code + output shape) to catch wiring/flag regressions.

6. **A few small modules are only covered indirectly.**
   `savings/tokens.ts`, `hooks/staging.ts` (covered via runtime), and
   `memory-extract/review-store.ts` (covered via engine) have no colocated unit
   test. Cheap to add; makes intent explicit.

7. **Real PostgreSQL recovery is environment-gated.**
   One Vitest integration test skips without a live database, so DB
   recovery/reindex is not exercised in CI. Add a Dockerized Postgres job (or a
   documented local step) so recovery is verified before releases.

---

## Token-engine accuracy

8. **Token counts are a `~4 chars/token` estimate, not a tokenizer.**
   Good for comparison and budgeting; not exact provider accounting. Tracked as
   roadmap **N.7** (swap behind the `estimateTokens` seam — no call-site
   changes).

9. **Before-edit relevance is path/degree-ranked, not semantic.**
   The budget packer keeps "highest-value evidence first," but value is import
   degree, not similarity to the task. Tracked as roadmap **N.5**.

---

## Developer experience & hygiene

10. **Stale branches.** Merged local branches (`feat/04.6-suggestion-engine`,
    `feat/04.8-release-hardening`, `feat/hooks-automation`) and older remotes
    (`feat/cli-quickstart`, `feat/cli-use-command`, `feat/groq-provider`) can be
    pruned to keep the branch list readable.

11. **Version string is duplicated.** `2.0.0` is written in `package.json`, the
    CLI `--version`, and the MCP server version. Consider sourcing the CLI/MCP
    version from `package.json` at build time so a bump touches one place.

12. **`.codebuddy/plans/` in this repo holds design docs, not plans.** Either
    move them under `docs/` or implement improvement #2 so the tool tolerates
    them. Documented as a gotcha in [../CLAUDE.md](../CLAUDE.md).

---

## Suggested pickup order

Quick wins first: **#1** (map `.js` resolver) and **#2** (plan-list tolerance)
are small, high-impact correctness fixes. Then **#5** (CLI e2e tests) for
release confidence. The rest fold naturally into roadmap phases (#8→N.7,
#9→N.5) or are one-line hygiene (#10, #11).
