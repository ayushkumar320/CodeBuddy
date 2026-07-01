# Proposal 04 — Automatic Context Engine

Status: Draft
Owner: @ayushkumar320
Target: v2.0.0
Depends on: shipped Markdown memory foundation, shipped Plan Panel, shipped
Risk Panel MVP, shipped Architecture Map MVP.

## Why this exists

CodeBuddy already stores useful memory, durable plans, risk evidence, and a
lightweight repository graph. But the current workflow still leans on the user
or agent to explicitly ask for memory and to explicitly write it back. That is
better than chat-only tooling, but it still leaves too much manual work in the
loop for a senior developer trying to reduce token usage and keep coding flow
smooth.

The next leap is not "more memory." It is **automatic context compression**.

The product should evolve from:

> "A tool that can store project memory if the user remembers to use it."

into:

> "A local project brain that automatically prepares the smallest useful
> context for Claude/Codex, captures durable knowledge, and warns before risky
> edits."

The core user value for v2.0 is:

1. The user does not manually juggle `remember` and `recall`.
2. Claude/Codex gets context at the right time with a bounded token budget.
3. CodeBuddy measures and proves token savings.
4. Project knowledge remains local-first, inspectable, and reviewable.

## Goals

1. Make project-context retrieval effectively automatic for Claude and Codex.
2. Reduce token usage through summaries, deduplication, and budget-aware
   packing, with measurable savings stats.
3. Automatically capture high-value facts, decisions, incidents, and temporary
   notes from agent turns with confidence-based review.
4. Provide stronger local setup and background indexing so useful context
   exists before the user manually saves anything.
5. Add evidence-backed code quality suggestions without silently editing code.
6. Preserve a local-first trust model: user-owned Postgres, Markdown
   artefacts, no hidden hosted memory service.

## Non-goals (v2.0)

- No hosted CodeBuddy cloud memory service.
- No autonomous code editing or self-merging workflows.
- No mandatory LLM dependency for the core retrieval path.
- No multi-repository enterprise graph or org-wide dashboard.
- No full type-accurate architecture analysis for every language.
- No hidden background behavior that the user cannot inspect or disable.

## User-visible behaviour

```bash
# One-command project setup
codebuddy use

# Background indexing
codebuddy index
codebuddy watch

# Preview the exact context CodeBuddy would send
codebuddy context preview "fix OAuth callback regression"

# Explain why specific context was included
codebuddy context explain --plan pln_abc123

# Show token savings
codebuddy savings

# Review automatically captured memory
codebuddy memory review

# Ask for code quality suggestions
codebuddy suggest --git
```

Through MCP, agents gain four new workflow tools:

```text
context_bootstrap({})
  -> { project, plan, rules, incidents, summaries, savings }

context_before_edit({ paths?, planId?, task })
  -> { context, risks, stats }

context_after_turn({ summary, changedFiles?, planId?, taskType? })
  -> { saved, queuedForReview, ignored, reasons }

code_suggestions({ paths?, planId?, useGit?, limit? })
  -> { suggestions, stats }
```

These tools are complemented by Claude/Codex instruction snippets that tell
the agent when to call them.

## Architecture

### End-to-end workflow

```text
project setup
    |
    +--> local Postgres (BYO or bundled Docker)
    +--> local .codebuddy scaffold
    +--> Claude/Codex integration
    |
    v
background indexing
    |
    +--> file scan
    +--> summaries
    +--> embeddings
    +--> risk/policy metadata
    |
    v
agent turn starts
    |
    +--> context_bootstrap
    +--> context_before_edit
    |
    v
agent works with compressed context
    |
    v
turn ends
    |
    +--> context_after_turn
    +--> classify facts / decisions / incidents / notes
    +--> save or queue for review
```

### Core subsystems

#### 1. Automatic context bootstrap

Purpose: provide compact project awareness at the beginning of a turn.

Returns:

- project identity and namespace;
- active plan and plan policy;
- compact architecture summary;
- top policy rules;
- recent important decisions;
- incident hotspots;
- token budget and savings metrics.

#### 2. Context-before-edit retrieval

Purpose: assemble the most relevant context before code changes happen.

Retrieval pipeline:

1. determine target files from `paths`, `planId`, or git;
2. retrieve relevant plan content;
3. retrieve incident memories for those files;
4. retrieve policy matches;
5. retrieve architecture neighbours and summaries;
6. retrieve recent facts/decisions for the same area;
7. dedupe overlapping items;
8. compress where possible;
9. pack into the caller budget.

#### 3. Automatic memory extraction

Purpose: capture useful project knowledge without the user manually calling
`remember`.

Sources:

- explicit turn summary from the agent;
- changed files;
- active plan;
- completion notes;
- commit message parsing (optional path).

Outputs:

- durable facts;
- decisions;
- incidents;
- temporary notes;
- ignored chatter.

Validation:

- schema-validated candidate outputs;
- confidence score;
- sensitive-content scan;
- review queue for low-confidence or risky items.

#### 4. Token savings engine

Purpose: reduce repeated context transmission and prove the savings.

Mechanisms:

- file summaries;
- directory summaries;
- project summary;
- plan summary;
- context capsules for repeated topics;
- semantic and hash dedupe;
- budget-aware packing;
- compression with deterministic fallback.

Metrics:

- candidate tokens;
- returned tokens;
- estimated saved tokens;
- cache hits;
- skipped items;
- compression ratio.

#### 5. Suggestion engine

Purpose: use project context to help the user improve code quality without
silently editing code.

Signals:

- risk outputs;
- plan divergence;
- missing tests in touched areas;
- repeated incident hotspots;
- architecture hotspots;
- stale docs/policies;
- inconsistent patterns.

Outputs:

- suggestions with severity;
- evidence;
- likely impact;
- optional follow-up command hints.

### Operating modes

The engine must support multiple reliability modes:

- `offline`: no LLM generation, deterministic retrieval only.
- `assist`: embeddings + deterministic retrieval + limited summaries.
- `agentic`: full extraction, summaries, and suggestion generation.

Mode is configured in `.codebuddy/config.json` and surfaced in `doctor`.

## Implementation phases

### Phase 1 — local setup and trust hardening

Outcome: setup is fast, local-first, and hard to misconfigure.

Build:

- strengthen `codebuddy use` as the main entrypoint;
- add `codebuddy db doctor`, `codebuddy db test`;
- extend scaffold with `.codebuddy/policies.yaml`;
- improve setup messages for BYO Postgres vs bundled Docker;
- improve config/repo safety checks.

Definition of done:

- fresh machine setup works in under five minutes;
- existing local Postgres works without Docker;
- no secrets are committed by default;
- doctor explains every common setup failure clearly.

### Phase 2 — context bootstrap tools

Outcome: users stop needing to manually ask for project recall.

Build:

- add `context_bootstrap`;
- add `context_before_edit`;
- add MCP schemas and tests;
- add CLI preview commands;
- return token budget + savings stats;
- add installation snippets for Claude/Codex instructions.

Definition of done:

- a new agent session gets useful context with one tool call;
- before-edit retrieval includes plan + risk context automatically;
- returned context is bounded and explainable.

### Phase 3 — background project indexing

Outcome: CodeBuddy can know the codebase before manual memory exists.

Build:

- `codebuddy index`;
- `codebuddy watch`;
- file scanning with `.gitignore` respect;
- file content hashes;
- file summaries;
- embeddings for summaries/chunks;
- incremental refresh.

Definition of done:

- repeated indexing is incremental;
- unchanged files are skipped;
- project summaries exist before manual facts are written.

### Phase 4 — automatic memory extraction and review queue

Outcome: durable project knowledge is captured automatically but safely.

Build:

- add `context_after_turn`;
- LLM extraction prompt + Zod validation;
- deterministic fallback parser;
- review queue under `.codebuddy/memory/review/`;
- CLI review flow (`list`, `approve`, `reject`, `edit`);
- sensitive-content and low-confidence gating.

Definition of done:

- good memories can be captured automatically;
- low-confidence memories do not silently pollute recall;
- manual `remember` remains available.

### Phase 5 — token savings engine

Outcome: users can feel and measure the reduction in context size.

Build:

- add file/directory/project summaries;
- add context capsules for repeated topics;
- add budget-aware packer improvements;
- add token accounting across retrieval stages;
- add `codebuddy savings`;
- add `codebuddy context explain`.

Definition of done:

- savings are measurable per request/session;
- compressed context remains useful;
- repeated sessions resend much less boilerplate context.

### Phase 6 — suggestion engine

Outcome: CodeBuddy helps the user improve quality before code breaks.

Build:

- add `codebuddy suggest`;
- add `code_suggestions` MCP tool;
- connect risk + plan + architecture + incident context;
- group findings by severity and evidence;
- support read-only suggestions only.

Definition of done:

- suggestions are evidence-backed;
- suggestions do not silently edit files;
- users can run them on git diff, paths, or a plan.

### Phase 7 — Claude/Codex workflow templates

Outcome: automation becomes reliable in real clients.

Build:

- add Codex and Claude rules snippets;
- add install commands to write/update rules safely where possible;
- add system prompt templates for strict quality workflows;
- document degraded-mode behavior when tools fail.

Definition of done:

- new client installs guide the agent to call the right tools;
- manual `remember`/`recall` becomes optional in day-to-day use.

### Phase 8 — launch hardening and release

Outcome: v2.0 is publishable and trustworthy.

Build:

- package verification;
- migration notes;
- updated README quickstart;
- examples for Claude, Codex, and local Postgres;
- token-savings demo path;
- npm publish workflow.

Definition of done:

- `2.0.0` can be installed cleanly;
- upgrade path is documented;
- users understand the product value within the first session.

## Claude and Codex prompt templates

These are reference templates for the clients that should use CodeBuddy as a
senior software developer assistant rather than as a naive memory tool.

### Template 1 — turn bootstrap

Use at the start of any substantive coding turn:

```text
You are working with CodeBuddy as a local project-context engine.

Before making substantive code changes:
1. Call `context_bootstrap`.
2. If the task may change files, call `context_before_edit` with the planned
   paths or plan id.
3. Use the returned plan, policies, incident history, and architecture summary
   before deciding what to edit.

When you answer:
- Prefer the smallest sufficient set of file edits.
- Preserve existing behavior unless the task explicitly changes it.
- Call out risk before editing sensitive areas.
- Keep context usage efficient; do not re-request broad context if the existing
  bootstrap answer is already sufficient.
```

### Template 2 — senior developer execution

Use when the client should behave like a careful senior engineer:

```text
Develop like a senior software engineer working in a shared production codebase.

Rules:
- Understand the current code before changing it.
- Favor simple, durable implementations over clever ones.
- Minimize surface area and avoid breaking unrelated behavior.
- Add tests for changed behavior whenever practical.
- Keep the change coherent: implementation, validation, and documentation.
- If a risk warning exists, incorporate it into your plan before editing.
- If context is insufficient, ask CodeBuddy for targeted context instead of
  broad repository dumps.

Never:
- invent behavior that the codebase does not support;
- ignore failing tests or lint errors;
- make speculative wide changes without evidence;
- save low-confidence project memory as durable fact.
```

### Template 3 — post-turn memory capture

Use after a meaningful turn or completed task:

```text
After completing useful work:
1. Summarize only the durable knowledge gained from the turn.
2. Call `context_after_turn` with:
   - a concise summary of the decision/fix;
   - changed files;
   - plan id if present;
   - whether an incident was discovered or resolved.

Only capture memory that is likely to matter later:
- decisions;
- incidents;
- stable facts;
- architecture findings;
- follow-up risks.

Do not store:
- routine chatter;
- speculative guesses;
- redundant restatements of code already obvious from file summaries.
```

### Template 4 — quality gate

Use before presenting a final coding answer:

```text
Before finalizing:
1. Check whether the implementation matches the active plan.
2. Re-check risk for touched files if scope expanded.
3. Run the smallest relevant verification commands.
4. Prefer fixing the root cause over patching symptoms.
5. If tests or lint fail, resolve them before presenting completion.

Your job is not only to write code. Your job is to leave the repository in a
better, stable state with minimal surprise for the next developer.
```

## Rejected alternatives

- **Fully automatic hidden memory capture**. Rejected because it destroys
  trust and floods the system with junk knowledge.
- **Hosted sync as the default architecture**. Rejected because the product's
  local-first trust model is a core differentiator.
- **LLM-only retrieval ranking**. Rejected because users need predictable,
  measurable, reviewable context packing.
- **Auto-apply code improvements**. Rejected for v2.0 because trust should be
  earned with suggestions first.

## Definition of done for v2.0

- Claude/Codex workflows can operate without manual `remember`/`recall` for
  normal project use.
- CodeBuddy reports token savings for context retrieval.
- Automatic memory capture is confidence-gated and reviewable.
- Suggestions are evidence-backed and read-only by default.
- Local Postgres remains the default trust model.
- Setup, retrieval, capture, and review are documented and tested.
