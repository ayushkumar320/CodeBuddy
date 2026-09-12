# CodeBuddy

**A local-first project brain for AI coding agents.** CodeBuddy gives Claude
Code and Codex durable memory *and* prepares the smallest useful slice of
project context before every edit — so the agent works like a careful senior
engineer instead of re-reading your whole repo on every turn.

It runs on your machine. Knowledge lives as readable Markdown under
`.codebuddy/`. PostgreSQL + pgvector is only a search index, never the source of
truth. Nothing is sent to a hosted CodeBuddy service — there isn't one.

- **npm:** `@ayushkumar320/codebuddy` (v2.1.0)
- **Surfaces:** CLI · MCP stdio server · TypeScript SDK · LangGraph helpers

---

## Table of contents

- [The problem it solves](#the-problem-it-solves)
- [How it works (mental model)](#how-it-works-mental-model)
- [Install & setup](#install--setup)
- [Feature tour (with examples)](#feature-tour-with-examples)
  - [1. Durable Markdown memory](#1-durable-markdown-memory)
  - [2. Plans](#2-plans)
  - [3. Risk assessment](#3-risk-assessment)
  - [4. Architecture map](#4-architecture-map)
  - [5. Background indexing](#5-background-indexing)
  - [6. Automatic context (bootstrap & before-edit)](#6-automatic-context-bootstrap--before-edit)
  - [7. Automatic memory capture + review queue](#7-automatic-memory-capture--review-queue)
  - [8. Token savings](#8-token-savings)
  - [9. Read-only suggestions](#9-read-only-suggestions)
  - [10. Change readiness](#10-change-readiness)
  - [11. Client workflow templates](#11-client-workflow-templates)
  - [12. Fully automatic mode (hooks)](#12-fully-automatic-mode-hooks)
- [How CodeBuddy saves tokens vs. a big knowledge graph](#how-codebuddy-saves-tokens-vs-a-big-knowledge-graph)
- [MCP tools reference](#mcp-tools-reference)
- [SDK usage](#sdk-usage)
- [LangGraph](#langgraph)
- [Working as a team](#working-as-a-team)
- [Repo layout (for contributors)](#repo-layout-for-contributors)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)

---

## The problem it solves

When you code with an AI agent, two things quietly cost you money and quality:

1. **The agent forgets.** Every session starts cold. You re-explain the same
   decisions, the same "don't touch that file," the same past bug.
2. **The agent over-reads.** To answer "fix the OAuth callback," it opens and
   reads dozens of files — burning tokens on raw source it mostly doesn't need.

CodeBuddy fixes both:

- It **remembers** durable facts, decisions, and incidents as Markdown you can
  read and commit.
- It **prepares context** — a compact, bounded summary of the plan, risks, past
  incidents, and only the relevant files — so the agent gets what it needs
  without a repo dump. And it **measures** the tokens saved.

---

## How it works (mental model)

```text
                   .codebuddy/   (Markdown = source of truth, committable)
                   ├── memory/facts, summaries, review     (what we know)
                   ├── plans/                               (what we're doing)
                   ├── policies.yaml                        (what needs care)
                   └── cache/index.json                     (rebuildable index)
                          │
   ┌──────────────────────┼───────────────────────────────┐
   │                      │                                │
 CLI (codebuddy …)   MCP server (codebuddy serve)      SDK / LangGraph
   │                      │                                │
   └── file-based tools ──┴── Postgres-backed tools ───────┘
       (no DB needed)         (recall / embeddings)
```

A turn with an agent looks like this:

```text
turn starts
  → context_bootstrap        # identity, active plan, policies, incidents, architecture
  → context_before_edit      # for the files about to change: plan + risk + incidents + neighbours
agent edits with compact context (not a repo dump)
turn ends
  → context_after_turn       # capture durable facts/decisions/incidents (confidence-gated)
  → code_suggestions         # optional read-only quality findings
```

Two design rules run through everything:

- **Bounded, deterministic, explainable.** Every tool output is capped, produced
  the same way each run, and carries `explain[]` reasons. No black-box ranking.
- **Local-first & no mandatory LLM.** The core context/index/savings/suggestion
  paths use zero LLM calls. Embeddings (Hugging Face) power semantic recall only.

---

## Install & setup

### Requirements

- **Node 20+** (required)
- **PostgreSQL 16 + pgvector** — only for semantic `recall`/embeddings. Every
  new v2.0 feature works without it.
- **Hugging Face token** — only for embeddings. Optional otherwise.
- Optional: Docker (for the bundled Postgres), `@langchain/langgraph` peer dep.

### Fastest path

```bash
npm install -g @ayushkumar320/codebuddy
cd ~/Projects/your-project
codebuddy                         # first-run setup; offers to start Docker when needed
codebuddy use your-project        # repeat setup for a named namespace
codebuddy index                   # build the background index
codebuddy rules install --client claude   # teach the agent when to call the tools
```

For a zero-database setup that also enables PR reports:

```bash
npx @ayushkumar320/codebuddy init --non-interactive --github-action
```

This creates the local `.codebuddy/` scaffold and an idempotent
`.github/workflows/codebuddy.yml` workflow. Commit the workflow to start
receiving a CodeBuddy report on every pull request.

On the first run, `codebuddy` also asks whether to enable Graphify:

- **Yes:** it installs/detects Graphify, builds `graphify-out/graph.json`,
  registers its local MCP server in the project `.mcp.json`, and enables
  Graphify architecture input for CodeBuddy.
- **No:** it registers only CodeBuddy. The MCP context workflow is unchanged;
  CodeBuddy uses its own local architecture index.

In both cases it writes the CodeBuddy MCP entry without putting database
credentials in `.mcp.json`, and adds managed instructions to `CLAUDE.md` and
`AGENTS.md` so the agent knows to use `context_pack`. The Graphify MCP entry is
added only when Graphify is enabled.

Graphify runs locally. Its current installer is `uv tool install graphifyy`
(with pipx/pip alternatives). Setup generates `graphify-out/graph.json` using
Graphify's code-only extractor before registering the MCP server. Regenerate it
after repository changes with:

```bash
codebuddy graphify index
```

`codebuddy serve` also checks an enabled Graphify configuration and prepares a
missing or invalid graph automatically. Graph output is staged and validated
before replacement, so a valid existing graph is preserved if extraction fails.

### How CodeBuddy helps, in plain English

CodeBuddy is a small context and memory layer between your repository and your
coding agent. You describe a task once, and CodeBuddy prepares the useful
project information before Claude or Codex starts editing:

1. It finds the files, functions, tests, rules, previous incidents, and related
   architecture that matter to the task.
2. It sends a compact, token-budgeted `context_pack` instead of making the
   agent repeatedly read the whole repository.
3. The agent makes the change with more relevant evidence and less guessing.
4. CodeBuddy can record durable decisions and change outcomes for future tasks.
5. Pull requests can receive a readiness report covering risk, tests, plan drift,
   and architecture impact.

The practical result is less repeated reading, lower context cost, fewer
irrelevant edits, and a project that becomes easier for new agents to
understand over time. Graphify is optional: it adds a richer local map of how
the codebase connects, while CodeBuddy's own MCP context workflow works either
way.

### No-database path (try the context engine in 30 seconds)

Everything except semantic recall is file-based, so you can skip Postgres:

```bash
npm install -g @ayushkumar320/codebuddy
cd ~/Projects/your-project
codebuddy init --non-interactive  # just creates the .codebuddy/ scaffold
codebuddy index
codebuddy savings                 # see measured token savings immediately
codebuddy suggest --git
```

### Bring-your-own vs. bundled Postgres

The normal setup flow checks the default local Postgres URL first. If it is not
reachable, CodeBuddy offers to start Docker Desktop and its bundled pgvector
database automatically. Choose `No` if you want to configure Postgres yourself.
Use `codebuddy use --no-docker` to skip that offer in scripts or controlled
environments.

```bash
# Manual control is still available:
codebuddy postgres up
codebuddy doctor                  # DB, pgvector, scaffold, model health

# Or your own database — the URL must include real user:password
export DATABASE_URL="postgres://user:pass@host:5432/db"
codebuddy migrate
```

> If `codebuddy doctor` says `password authentication failed for user "<you>"`,
> your `DATABASE_URL` has no credentials and Postgres fell back to your OS
> username. Set the URL as above. This does **not** affect the file-based tools.

---

## Feature tour (with examples)

### 1. Durable Markdown memory

Facts and summaries are written as Markdown under `.codebuddy/memory/`. They
survive database loss and are diffable in git.

```bash
codebuddy list-facts
codebuddy inspect your-project
codebuddy export your-project > backup.json
codebuddy stats
```

Through MCP an agent calls `remember` / `recall` / `share` / `forget`. Facts can
be tagged as **incidents** (with `paths` and `severity`) so CodeBuddy can warn
when a future change touches a file that broke before.

### 2. Plans

A plan is a durable Markdown work-order: title, brief, files to touch, tests to
add, risks, out-of-scope. At most one plan is "active" per namespace.

```bash
codebuddy plan new "Add OAuth login flow"   # opens $EDITOR
codebuddy plan list
codebuddy plan approve pln_abc123
codebuddy plan start pln_abc123
codebuddy plan complete pln_abc123 --commit <sha>
```

### 3. Risk assessment

Deterministic, evidence-backed risk scoring from incident memory, project
policy, and recent git churn — no LLM.

```bash
codebuddy risk assess --git
codebuddy risk assess --paths src/auth/oauth.ts,src/api/login.ts
codebuddy risk assess --plan pln_abc123 --explain
```

Policy lives in `.codebuddy/policies.yaml`:

```yaml
rules:
  - id: auth-sensitive
    pattern: "src/auth/**"
    message: "Auth changes need careful review."
    weight: 70
```

### 4. Architecture map

A lightweight import graph, scanned on demand.

```bash
codebuddy map build
codebuddy map deps src/cli/index.ts          # what this file imports
codebuddy map dependents src/core/codebuddy.ts   # what imports this file (blast radius)
```

### 5. Background indexing

Builds a content-hash + one-line summary for every file, cached at
`.codebuddy/cache/index.json` (gitignored, rebuildable). Incremental: unchanged
files are skipped. Respects `.gitignore`.

```bash
codebuddy index          # e.g. "128 indexed (+128 ~0 =0 -0) in 40ms"
codebuddy index          # again → "=128" (all unchanged)
codebuddy watch          # re-index on save; coalesces bursts; Ctrl+C to stop
```

The index also records a per-file **symbol table** (functions, classes, types),
so context can send a file's public API instead of its whole body:

```bash
codebuddy symbols src/service.ts
# export function getUser  L3-5
# ...
# 5 symbol(s) · signatures ~40 tokens vs full file ~72 (44% smaller)
```

### 6. Automatic context (bootstrap & before-edit)

The heart of v2.0. Preview exactly what the agent would receive:

```bash
codebuddy context bootstrap
# project + active plan + policy + incident hotspots + architecture summary + token stats

codebuddy context preview "fix the OAuth callback" --paths src/auth/oauth.ts
# target files + relevant plan + matching policy + incidents + risk + import neighbours

codebuddy context explain --git
# the same, plus WHY each piece was included and per-stage token accounting
```

Over MCP these are `context_bootstrap` and `context_before_edit`.

For Claude and Codex, the simplest integration is the single-call
`context_pack` tool:

```text
context_pack({
  "task": "fix the OAuth callback",
  "tokenBudget": 4000
})
```

It automatically ranks files from the local index when paths are omitted, then
returns bounded symbols, policies, risks, incidents, architecture neighbours,
and relevant team facts. The agent does not need to manually chain recall,
risk, map, and context tools. The response includes token accounting and what
was omitted when the budget is tight.

### 7. Automatic memory capture + review queue

After a turn, `context_after_turn` (MCP) turns a summary into classified
candidates and **gates** them:

- **Auto-saved** as durable Markdown: confident facts, decisions, incidents.
- **Queued for review:** temporary notes, low-confidence items, anything
  sensitive (secrets/keys/tokens are **never** auto-saved).
- **Dropped:** chatter.

Curate the queue from the CLI:

```bash
codebuddy memory review                 # list pending candidates (⚠ marks sensitive)
codebuddy memory review show <id>
codebuddy memory review approve <id>    # promote to a durable fact
codebuddy memory review reject <id>
```

Bias by design: **prefer a missed memory over a false durable fact.**

### 8. Token savings

CodeBuddy proves the reduction against a real baseline — the cost of reading the
represented files' raw source.

```bash
codebuddy index
codebuddy savings
# savings 367 tokens (95% smaller)
#   baseline 385 → returned 18 across 2 file(s)
#   project 2 files, 43 lines, ts:2
```

Numbers are clamped so they can never exceed the baseline or go negative. No
fabricated stats. See the [comparison below](#how-codebuddy-saves-tokens-vs-a-big-knowledge-graph).

### 9. Read-only suggestions

Evidence-backed, severity-ranked findings — a careful reviewer, not a noisy
linter. It **never edits code.**

```bash
codebuddy suggest --git
codebuddy suggest --paths src/auth/oauth.ts
# [med ] Review high-risk change to src/auth/oauth.ts
#   ↳ risk_score: score 70 (policy)
# [low ] No test found for src/auth/oauth.ts
# [low ] Stale policy rule "gone" → legacy/** does not exist
```

Categories: risk · plan divergence · architecture blast radius · incident
history · missing tests · stale policies. Over MCP: `code_suggestions`.

### 10. Change readiness

Turn the existing signals into one evidence-backed change report. It combines
the current diff, active plan, risk, architecture dependents, incident history,
and test coverage into a single readiness decision.

```bash
codebuddy change
codebuddy change --paths src/auth/oauth.ts --no-git
codebuddy change --json       # stable output for CI or another agent
# [review ] change report
#   highest risk: 70
#   verification: 1 test file(s) changed; 0 code file(s) without a discovered test

codebuddy change verify     # detects and runs npm/pnpm/yarn/bun test
codebuddy change verify --command "npm run test:unit" --timeout 300000

codebuddy eval             # run the committed readiness evaluation cases
```

The status is `ready`, `review`, `blocked`, or `no_changes`. The command is
read-only and is designed to run before a commit or as an agent checkpoint.
`change verify` returns a non-zero exit code when tests fail, time out, or no
test command can be found, and supports `--json` for CI integration.

The evaluation dataset lives under `evals/` and is intentionally small,
readable, and versioned. Extend it when changing risk thresholds or adding a
new signal so product claims remain reproducible.

Record the outcome of a real change so future reports learn from the project:

```bash
codebuddy learn outcome --outcome safe \
  --paths src/auth/oauth.ts \
  --summary "OAuth callback change passed review and regression tests."

codebuddy learn outcome --outcome regression \
  --paths src/auth/oauth.ts \
  --severity high \
  --summary "Dropped callback state caused a production login failure."
```

Outcomes are stored as reviewable Markdown under `.codebuddy/memory/`. A
regression becomes path-specific incident memory and raises the next change's
risk score for that area.

If a repository already uses Graphify, CodeBuddy can consume its local graph
without taking a Graphify dependency:

```bash
codebuddy change --graphify graphify-out/graph.json
codebuddy change verify --graphify graphify-out/graph.json
```

The imported relationships enrich architecture dependents while CodeBuddy
keeps its own policy, plan, verification, and team-memory signals layered on
top.

### 11. Client workflow templates

Teach Claude/Codex *when* to call each tool. Install writes an idempotent
managed block into `CLAUDE.md` / `AGENTS.md` between clear markers — re-running
updates it in place and never touches your other content.

```bash
codebuddy rules show --client claude       # preview the exact text
codebuddy rules install --client claude    # → managed block in CLAUDE.md
codebuddy rules install --client codex     # → managed block in AGENTS.md
```

See [docs/degraded-mode.md](docs/degraded-mode.md) for how the tools fail soft
(a tool missing, Postgres down, empty retrieval).

### 12. Fully automatic mode (hooks)

Templates *ask* the agent to call the tools. **Hooks guarantee it** — CodeBuddy
wires into Claude Code's lifecycle so recall and capture fire deterministically,
whether or not the model remembers to.

```bash
codebuddy hooks install --client claude    # → .claude/settings.json (idempotent)
codebuddy hooks status
codebuddy hooks uninstall --client claude  # removes only CodeBuddy's hooks
```

- `UserPromptSubmit` → inject compact project context into every prompt (**recall**)
- `PostToolUse(Edit|Write|MultiEdit)` → record the changed files
- `Stop` → capture durable memory from the real change set + transcript (**capture**)

Set this up once and you never call `remember`/`recall` — it happens on its own.
Hooks are fail-soft (a hook never breaks a turn) and capture still runs through
the same confidence + sensitivity gating. Restart Claude Code after installing.

---

## How CodeBuddy saves tokens vs. a big knowledge graph

A popular alternative is to build a **whole-repo knowledge graph** (GraphRAG
style): parse every file into nodes and edges, cluster them, and retrieve
subgraphs to answer questions. That's great for *exploration* ("how does X
connect to Y across the codebase?"). It is expensive for *day-to-day editing*.

The difference in one line: **a graph models the entire repo; CodeBuddy models
just the change in front of you.**

| | Whole-repo knowledge graph | CodeBuddy context engine |
|---|---|---|
| Unit | thousands of nodes + edges | a few file "capsules" + the active plan/risk |
| What the LLM sees | a retrieved subgraph (size varies, can be large) | a **bounded, budgeted** payload with `explain[]` |
| Scope | the whole project | target files + their direct import neighbours |
| Build cost | LLM extraction over every file (tokens $$) | deterministic hashes + summaries (no LLM) |
| Freshness | re-extract on change (often another LLM pass) | incremental hash diff, milliseconds |
| Measurability | hard to say what a query "cost" | every payload reports baseline → returned → saved |

Concretely, for a change touching `src/auth/oauth.ts`:

- **Graph approach:** to be safe, retrieval pulls the auth community — many
  nodes, their neighbours, and descriptions — and drops a large subgraph into
  context. The token cost scales with how big and connected that region is.
- **CodeBuddy:** sends the file's one-line summary + exported symbols, its direct
  import neighbours, the matching policy rule, any past incident, and the active
  plan — then **packs it into a token budget, keeping the highest-value evidence
  first.** If it doesn't fit, low-value context is dropped (and reported), never
  the risk finding.

Why the summaries win on tokens: a file capsule is
`"ts • 42 lines • exports login, verify"` (~18 tokens) standing in for the raw
source (hundreds of tokens). CodeBuddy's [`savings`](#8-token-savings) command
measures this directly — on a small demo, 2 files went from **385 tokens of raw
source to 18 tokens of summary (95% smaller)**. The bigger and more files a task
would otherwise drag in, the larger the gap.

The honest caveats:

- These are **complementary tools.** Use a knowledge graph to *understand* an
  unfamiliar codebase; use CodeBuddy to *edit* one efficiently and safely.
- CodeBuddy's token counts are a deterministic ~4-chars/token estimate, and the
  baseline models "the agent reads the raw files" — the most common alternative,
  not the only one. It's designed to *understate*, never inflate.
- CodeBuddy does **not** try to answer arbitrary cross-repo questions; that's
  what the graph is for.

---

## MCP tools reference

CodeBuddy ships tools over stdio (`codebuddy serve`). HTTP transport is deferred.

| Tool | Input | Output |
|---|---|---|
| `remember` | `{ sessionId?, content, type?, idempotencyKey?, agentId? }` | `{ id, sessionId, deduplicated }` |
| `remember_batch` | `{ items: [...] }` | `{ items: [...] }` |
| `recall` | `{ sessionId, query, budget?, callerModel?, conflictMode? }` | `{ system, messages, stats }` |
| `list_facts` | `{ subject?, limit?, cursor? }` | `{ facts[], nextCursor? }` |
| `list_namespaces` | `{}` | `{ namespaces[] }` |
| `forget` | `{ id }` | `{ ok, entityType }` |
| `share` | `{ to_namespace, factIds, mode?, agentId? }` | `{ shared }` |
| `plan_current` | `{}` | `{ plan, policy }` |
| `plan_create` / `plan_amend` / `plan_status` | plan fields | `{ plan }` |
| `risk_assess` | `{ planId?, paths?, useGit?, limit? }` | `{ items, stats }` |
| `map_query` / `map_neighbours` | graph query | edges / `{ modules, edges }` |
| `context_bootstrap` | `{}` | `{ project, plan, policy, policyRules, incidents, architecture, tokens }` |
| `context_before_edit` | `{ task?, paths?, planId?, useGit? }` | `{ targetPaths, plan, policyRules, incidents, risks, neighbours, tokens }` |
| `context_pack` | `{ task, paths?, planId?, useGit?, tokenBudget? }` | `{ targetPaths, symbols, plan, policyRules, incidents, risks, neighbours, facts, tokens }` |
| `context_after_turn` | `{ summary, changedFiles?, planId?, taskType?, agentId? }` | `{ saved, queuedForReview, ignored, reasons }` |
| `code_suggestions` | `{ paths?, planId?, useGit?, limit? }` | `{ suggestions, stats }` |

Wire it into a client with `codebuddy use`, or a project `.mcp.json` (see
[CLAUDE_CODEX.md](CLAUDE_CODEX.md)).

---

## SDK usage

`createRuntime` wires the Postgres repository, initializes `CodeBuddy`, and
returns a `close()` hook that drains the worker and closes the client.

```ts
import { createRuntime } from "codebuddy";

const runtime = await createRuntime({
  postgresUrl: process.env.DATABASE_URL!,
  provider: { type: "huggingface", apiKey: process.env.HF_TOKEN },
  namespace: "research-agent",
  tokenBudget: 8000,
});

await runtime.memory.remember({
  sessionId: "sess_123",
  content: "Use layer caching for the Docker build.",
  type: "fact",
});

const context = await runtime.memory.recall({
  sessionId: "sess_123",
  query: "What do we know about deployment?",
  budget: 6000,
});

await runtime.close();
```

Notes: `remember` defaults to `type: "interaction"`; repeated writes with the
same idempotency key or content return `deduplicated: true`; embeddings are
prepared asynchronously and recall falls back to recency while vectors are
pending.

---

## LangGraph

```ts
import { CodeBuddyNode, CodeBuddyCheckpointer } from "codebuddy/langgraph";

const graph = new StateGraph(State)
  .addNode("recall", new CodeBuddyNode({ memory, mode: "recall", cacheTtlSeconds: 30 }))
  .addNode("agent", agentNode)
  .addNode("remember", new CodeBuddyNode({ memory, mode: "remember" }))
  .compile({ checkpointer: new CodeBuddyCheckpointer({ namespace: "research-agent" }) });
```

Recall caching defaults to 30s, keyed by `(namespace, sessionId, query)`.

---

## Working as a team

CodeBuddy is built so teammates share project knowledge without sharing secrets.

`codebuddy use` / `codebuddy init` create this scaffold:

```text
.codebuddy/
├── .gitignore          # keeps config, cache, locks, and review queue out of git
├── config.json         # LOCAL ONLY — never commit (your DB URL + token)
├── policies.yaml        # commit: shared "handle with care" rules
├── memory/
│   ├── facts/          # commit: reviewable Markdown facts
│   ├── summaries/      # commit: reviewable summaries
│   └── review/         # local: un-approved candidates
├── plans/              # commit: shared work plans
└── cache/index.json    # local: rebuildable index
```

- **Commit** `memory/facts`, `memory/summaries`, `plans/*.md`, and
  `policies.yaml` to share memory, plans, and policy with the team.
- **Never commit** `config.json` — each teammate runs `codebuddy use` locally
  with their own token and database.
- One namespace per project (`codebuddy use my-project`); use the `share` tool to
  explicitly hand facts between namespaces.
- If project memory is private, add `.codebuddy/memory/` to the repo `.gitignore`.

New collaborator quickstart:

```bash
git clone <repo> && cd <repo>
npm install -g @ayushkumar320/codebuddy
codebuddy use <project>      # local DB + migrations + client wiring
codebuddy index
codebuddy rules install --client claude
codebuddy context bootstrap  # sanity-check what the agent will see
```

---

## Repo layout (for contributors)

```text
src/
├── core/            config, Markdown stores, plan lifecycle, runtime
├── db/              Drizzle schema, migrations, client
├── mcp/             stdio server + tool registration (Zod schemas)
├── risk/            evidence-backed risk assessor + signals (no LLM)
├── map/             import-graph architecture map
├── context/         [04.2] context bootstrap + before-edit engine
├── indexer/         [04.3] scan, summaries, incremental index, watch
├── memory-extract/  [04.4] auto-capture, sensitivity scan, review queue
├── savings/         [04.5] token estimator, packer, summaries, savings engine
├── suggest/         [04.6] read-only suggestion engine
├── templates/       [04.7] client workflow templates + safe install
├── planner/ providers/ langgraph/
└── cli/             commander CLI (commands/*)
```

Dev workflow (see [CLAUDE.md](CLAUDE.md) for agent-oriented notes):

```bash
npm run typecheck     # tsc --noEmit (strict)
npm run lint          # biome check .  (npx biome check --write . to fix)
npm test              # vitest (one integration test skips without Postgres)
npm run build         # tsup → dist/
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `password authentication failed` | `DATABASE_URL` needs `user:password`; use the bundled DB URL or `codebuddy use`. File tools are unaffected. |
| `namespace ... differs from folder default` | Run `codebuddy use <name>` or set `CODEBUDDY_NAMESPACE`. |
| `model ... unknown` in doctor | No HF token / model check skipped — informational, not a failure. |
| `codebuddy savings` says "No index found" | Run `codebuddy index` first (or it falls back to reading files). |
| Client doesn't show CodeBuddy tools | Confirm MCP registration (`codebuddy claude list` / `codebuddy codex list`) and restart the client. |
| `plan list` errors on this repo | Its `.codebuddy/plans/` holds hand-written docs, not generated plans — test plan/context features in a clean scaffold. |

`codebuddy doctor` reports DB connectivity, pgvector, vector/index health, model
reachability, recent usage, and config permissions.

---

## Privacy

- Facts, summaries, and plans are plaintext Markdown — inspect before committing.
- Conversations, shares, telemetry, and indexes live in PostgreSQL.
- `context_after_turn` never auto-saves sensitive content (keys, tokens,
  credentials, emails); such items are flagged and queued for review.
- For private memory, add `.codebuddy/memory/` to `.gitignore`.
- Encryption at rest is the deployment owner's responsibility.

## License

MIT — see [LICENSE](LICENSE).

**Project docs:** start at the [docs index](docs/README.md).
[current-version.md](docs/current-version.md) (what ships today + how automatic
it really is) · [roadmap.md](docs/roadmap.md) (what's left to build) ·
[improvements.md](docs/improvements.md) (quality/robustness backlog) ·
[live-test-checklist.md](docs/live-test-checklist.md) (pre-release verification) ·
[migration-2.0.md](docs/migration-2.0.md) · [degraded-mode.md](docs/degraded-mode.md) ·
[CLAUDE_CODEX.md](CLAUDE_CODEX.md).
