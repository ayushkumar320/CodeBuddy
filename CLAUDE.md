# CLAUDE.md

Operating notes for AI agents (Claude Code / Codex) working in this repo. Keep
this file current as phases land. Deep design docs live in
[ARCHITECTURE.md](ARCHITECTURE.md) and [WORKFLOW.md](WORKFLOW.md); this file is
the fast orientation layer.

## What CodeBuddy is

A local-first, Markdown-backed MCP memory + project-context engine for
multi-agent coding workflows. Facts/summaries/plans are durable Markdown under
`.codebuddy/`; PostgreSQL + pgvector is a derived query/index layer, never the
source of truth. The v2.0 goal is an **automatic context engine** that prepares
the smallest useful context for an agent, captures durable knowledge, and warns
before risky edits — without the user manually calling `remember`/`recall`.

## Commands

- `npm run typecheck` — `tsc --noEmit` (strict, `exactOptionalPropertyTypes`).
- `npm run lint` — Biome check. `npx biome check --write .` to autofix (esp. import order).
- `npm test` — Vitest. One integration test skips without Postgres.
- `npm run dev -- <args>` / `npx tsx src/cli/index.ts <args>` — run the CLI locally.
- `npm run build` — tsup bundle to `dist/`.

Always run typecheck + lint + tests before considering a change done.

## Layout (`src/`)

- `core/` — config, memory/plan file stores, plan lifecycle, operations/runtime.
- `db/` — Drizzle schema, migrations, client, bootstrap, migrator.
- `mcp/` — stdio server (`server.ts`) and tool registration + Zod schemas (`tools/index.ts`).
- `risk/` — evidence-backed risk assessor + signals (incident, policy, churn). No LLM.
- `map/` — lightweight import-graph architecture map (regex import extraction).
- `context/` — **Phase 04.2** context engine (`engine.ts`, `types.ts`).
- `indexer/` — **Phase 04.3** background indexer: `scan` (gitignore-aware), deterministic
  `summary`, incremental `engine`, `watch` coalescer. Manifest cached at
  `.codebuddy/cache/index.json` (gitignored, rebuildable — not a source of truth).
- `planner/`, `providers/`, `langgraph/` — budget/policy, HF adapter, LangGraph node.
- `cli/` — commander CLI; `commands/*` register subcommands via `register*Commands(program, runSafely)`.

CLI subcommands that only touch files (plan, risk, map, context) resolve the
namespace from `CODEBUDDY_NAMESPACE` / `.codebuddy/config.json` and run without
a DB. DB-backed commands use `withRuntime`.

## Conventions

- ESM, Node 20+, `.js` import specifiers in source.
- Reuse existing services; don't duplicate path resolution or glob matching
  (`resolveRiskPaths` in `risk/service.ts`, `matchesPolicyGlob` in `risk/signals/policy.ts`).
- Tool/engine outputs must be **bounded, deterministic, and explainable**
  (include `explain[]` reasons). Cap payloads so large repos can't blow context.
- No LLM in the core retrieval/risk path. Placeholders over fabricated stats
  (e.g. token savings are `{ available: false }` until Phase 04.5).
- Tests: temp repos via `mkdtemp`, cleaned in `afterEach`. Schema tests parse
  `mcpToolInputSchemas` directly.

## v2.0 build workflow (Proposal 04)

Source of truth: [docs/proposals/04-automatic-context-engine.md](docs/proposals/04-automatic-context-engine.md).
Per-phase execution packets: [docs/build/](docs/build/README.md). Build one
phase at a time; don't widen scope beyond a packet's build targets.

Phase status:

- ✅ 04.1 Setup hardening & trust checks (`db doctor`/`db test`, policies scaffold).
- ✅ 04.2 Context bootstrap & before-edit retrieval — `context_bootstrap` +
  `context_before_edit` MCP tools, `codebuddy context bootstrap|preview|explain`
  CLI, shared engine in `src/context/`.
- ✅ 04.3 Background indexing — `codebuddy index [--full]` + `codebuddy watch`,
  `src/indexer/`. Gitignore-aware scan, content hashes, deterministic summaries,
  incremental refresh, coalesced watch. No LLM, no hidden daemon.
- ⏭️ 04.4 Automatic memory extraction + review queue — next.
- ⏳ 04.5 Token savings engine (fills in the savings placeholders).
- ⏳ 04.6 Suggestion engine · 04.7 Client workflow templates · 04.8 Release hardening.

## Gotchas

- `PlanFileStore.listPlans()` parses every `*.md` in `.codebuddy/plans/` and
  throws on files without valid plan front matter. This repo's own
  `.codebuddy/plans/` contains hand-written planning docs (READMEs, build
  plans), so `plan list` / `context bootstrap` / `plan_current` error here with
  "Markdown file must start with YAML front matter." Test context features in a
  clean scaffold, not against this repo's dirty plans dir.
- The architecture map's import resolver matches relative imports and appends
  extensions to the specifier; it does not strip a trailing `.js`, so
  `./x.js`-style specifiers may not resolve to `x.ts`. Use extensionless
  specifiers in map/context test fixtures.
