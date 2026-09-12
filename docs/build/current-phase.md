# Current Phase

Fast pointer to what's being built right now and which doc drives it. Update
this whenever a phase starts or lands.

## Now building

- **Phase:** none — the 05.x build track is complete.

## Next step

- **N.4 — Session capsule ledger** (roadmap, high priority, unblocked by N.3).
- **Driving doc:** [../roadmap.md](../roadmap.md) → "N.4 — Session capsule ledger".
- **Gist:** per-session ledger at `.codebuddy/cache/session/<sessionId>.json`
  keyed by capsule content-hash; an already-sent capsule collapses to a
  ~1-token reference (`capsule:ab12cd34`) until its hash changes. Deterministic,
  with a measured multi-turn savings test.
- After N.4: N.5 → N.6 → N.7; release items R.1 (publish the current release) /
  R.2 (Codex hooks).

## Last completed

- **Phase:** 05.4 — Repo Hygiene and Release Ergonomics
- **Driving doc:** [05.4-repo-hygiene-and-release-ergonomics.md](./05.4-repo-hygiene-and-release-ergonomics.md)
- **Closed:** improvements #10/#11 (single-source version via `src/version.ts`;
  CLI/MCP import it, `package.json` is canonical, drift guarded by a test) and a
  safe, dry-run-by-default branch-prune aid (`npm run branches:prune`). #12 was
  already resolved in 05.1. See [../maintenance.md](../maintenance.md).

## Phase order

1. ✅ [05.1 Correctness Hardening](./05.1-correctness-hardening.md)
2. ✅ [05.2 Capture and Sensitivity Hardening](./05.2-capture-and-sensitivity-hardening.md)
3. ✅ [05.3 Test Confidence and Recovery](./05.3-test-confidence-and-recovery.md)
4. ✅ [05.4 Repo Hygiene and Release Ergonomics](./05.4-repo-hygiene-and-release-ergonomics.md)

Roadmap items `N.4`–`N.7` / `R.2` are tracked separately in
[../roadmap.md](../roadmap.md).
