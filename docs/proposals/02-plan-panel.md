# Proposal 02 — Plan Panel

Status: Draft
Owner: @ayushkumar320
Target: v0.2.0
Depends on: existing `MemoryRepository`, the LLM provider layer
Independent of: Proposal 01 (Architecture Map). The Plan panel ships
without the map; it just gains better defaults once 01 lands.

## Why this exists

The default interface for telling an AI "do X" is a chat prompt. The model
inflates the prompt into an implicit plan, executes it, and the only artefact
left behind is a stream of tool calls. If the developer disagreed with the
approach, the disagreement happens *after* the work, in the form of "no,
undo that and try again."

A Plan is a structured, persisted, versioned spec for a single piece of work.
It is written *before* the agent acts. The developer reviews and edits it as
data, not as conversation. The agent loads it on every turn so context resets
do not lose intent. The plan itself becomes the unit of review, the audit
trail, and the bridge between the developer's intent and the agent's actions.

Concretely, this proposal answers two questions that today's tools either
duck or smear across chat:

1. What is the agent about to do, exactly, in a form that fits on one screen
   and can be edited?
2. What did the agent end up doing, and how did that differ from the plan?

## Goals

1. Plans are first-class records in Postgres with a strict schema. Not chat.
   Not markdown blobs. Not LLM output buffered in memory.
2. Plans are versioned. Edits produce a new version row; diffs between
   versions are first-class and queryable.
3. Plans have an explicit lifecycle: `draft → approved → executing →
   complete | abandoned`. Each state transition is auditable.
4. Plans are addressable through MCP so any agent in any MCP-aware client
   can `plan_current` at the top of every turn and never lose context.
5. The plan generator is pluggable — `DefaultPlanGenerator` calls the LLM
   provider, but a project can ship a custom generator (e.g., one that
   refuses to write plans that touch `auth/`).

## Non-goals (v0.2)

- No "auto-execute" mode. The plan describes intent; execution happens in
  whichever editor or MCP client the developer is using. CodeBuddy never
  edits files directly in this proposal.
- No UI in v0.2. The plan is created and edited through the CLI and the
  developer's text editor (`$EDITOR`). The workspace UI consumes the same
  data later; nothing in the schema is UI-specific.
- No "multi-plan" or branching plans. One active plan per namespace at a
  time. Concurrency is a v0.3 problem.
- No automatic plan generation from raw chat history. The developer kicks
  off a plan with an explicit brief.

## User-visible behaviour

```bash
# Create a draft plan from a one-line brief. The plan generator inflates
# the brief into a structured spec; the developer's editor opens for review.
codebuddy plan new "Add OAuth login flow with Google as the first provider"

# List plans in this namespace
codebuddy plan list                          # active drafts + last 10 closed
codebuddy plan list --status approved
codebuddy plan list --all

# Show a single plan as formatted markdown
codebuddy plan show <id>
codebuddy plan show <id> --version 2

# Compare versions
codebuddy plan diff <id> --from 1 --to 2

# Promote a plan
codebuddy plan approve <id>

# Mark a plan as complete and link it to a git commit
codebuddy plan complete <id> --commit <sha> [--notes "diverged on tests/"]

# Abandon a plan without completing
codebuddy plan abandon <id> [--reason "blocked on external API"]
```

Through MCP, agents see four tools registered alongside the memory tools:

```
plan_current({})
  -> { plan: PlanSpec | null }            // the one in 'approved' or 'executing' state

plan_create({ brief, agentId? })
  -> { id, version, status: 'draft' }

plan_amend({ id, patch, agentId? })
  -> { id, version }                       // creates a new version row

plan_status({ id, status, commitSha?, notes? })
  -> { id, status }                        // transitions through the lifecycle
```

`plan_current` is the load-bearing one. An agent's system prompt instructs
it to call this at the top of every turn. If a plan exists, the agent works
against the structured spec. If not, the agent prompts the developer to
write one before substantive code changes.

## Architecture

### Plan schema

```ts
type PlanSpec = {
  id: string;                            // pln_<ulid>
  namespaceId: string;
  title: string;                         // 1-line summary
  brief: string;                         // original developer ask
  status: "draft" | "approved" | "executing" | "complete" | "abandoned";

  // Mutable across versions
  goal: string;                          // 2-3 sentences, written tone
  approach: string;                      // structured markdown
  filesToTouch: PlannedFile[];
  testsToAdd: PlannedTest[];
  outOfScope: string[];                  // explicit non-goals for this plan
  risks: string[];                       // free-text caveats

  // Immutable per row
  version: number;
  createdAt: string;
  createdByAgent: string | null;
};

type PlannedFile = {
  path: string;                          // repo-relative POSIX
  action: "create" | "edit" | "delete";
  notes: string;                         // why this file
};

type PlannedTest = {
  path: string;                          // repo-relative POSIX, e.g. "src/auth/oauth.test.ts"
  description: string;
};
```

The schema is deliberately small. It is harder to argue with five required
fields than to argue with a half-page of free-form text. The `approach`
field carries the prose; everything else is structured so the Risk panel
(Proposal 03) can iterate over `filesToTouch` and compute blast radius.

### Database tables

```sql
create table plans (
  id                text primary key,
  namespace_id      text not null references namespaces(id) on delete cascade,
  title             text not null,
  brief             text not null,
  status            text not null default 'draft',
  current_version   integer not null default 1,
  created_at        timestamptz not null default now(),
  approved_at       timestamptz,
  executing_at      timestamptz,
  completed_at      timestamptz,
  abandoned_at      timestamptz,
  commit_sha        text,
  abandon_reason    text,
  created_by_agent  text,
  index (namespace_id, status, created_at desc)
);

create table plan_versions (
  id               text primary key,
  plan_id          text not null references plans(id) on delete cascade,
  version          integer not null,
  goal             text not null,
  approach         text not null,
  files_to_touch   jsonb not null,
  tests_to_add     jsonb not null,
  out_of_scope     text[] not null default '{}',
  risks            text[] not null default '{}',
  created_at       timestamptz not null default now(),
  created_by_agent text,
  unique (plan_id, version)
);
```

Reasoning:

- `plans` carries identity + lifecycle. `plan_versions` carries content.
  Status transitions never rewrite a version; they always create a new one
  if the content changed.
- A single active plan per namespace is enforced by an application-level
  check, not a partial unique index. Reason: race conditions in the
  application path are easier to recover from than constraint violations
  bubbling out through MCP errors.
- The `commit_sha` column is the bridge to git. Completing a plan without
  a commit is allowed (for plans that are decisions, not code) but the
  CLI warns about it.

### Plan generator

```ts
type PlanGenerator = {
  generate(input: PlanGenerateInput): Promise<DraftPlan>;
  amend(input: PlanAmendInput): Promise<DraftPlan>;
};

type PlanGenerateInput = {
  namespace: string;
  brief: string;
  recentMemory: PlannedContext;   // pulled from CodeBuddy's recall
  repoSnapshot?: RepoSnapshot;    // optional, lands with Proposal 01
};
```

`DefaultPlanGenerator` calls the configured LLM provider with a system
prompt that requires the model to return a JSON object matching `PlanSpec`
minus the lifecycle fields. The output is validated with Zod; malformed
output is rejected and retried once with the validation error appended to
the prompt. After two failures the user is shown the raw output and asked
to edit it manually.

The generator is registered in `src/plan/generator.ts` and selectable via
`.codebuddy/config.json`:

```json
{
  "plan": {
    "generator": "default",
    "model": "meta-llama/Llama-3.2-3B-Instruct",
    "maxFiles": 20
  }
}
```

### Lifecycle and locking

```
                  ┌──── approve ────┐
                  │                 │
   ┌── new ──▶ draft ──────────▶ approved
                  │                 │
                  │           start │ executing
                  │ amend           │
                  │                 ▼
                  └──── amend ── executing
                                   │
                       complete    │   abandon
                          ┌────────┴────────┐
                          ▼                 ▼
                       complete         abandoned
```

- `draft` and `executing` can both be amended. Amending creates a new
  `plan_versions` row and bumps `plans.current_version`.
- Transitions are guarded by row-level Postgres locks
  (`select ... for update`) inside the `forSession` advisory lock pattern
  already used by `MemoryRepository`. No two MCP clients can race a
  status change.

### Integration with the CLI

The CLI uses `$EDITOR` (defaulting to `vi`) for plan editing. Flow:

1. `codebuddy plan new "<brief>"` calls the generator, writes the draft
   to `~/.codebuddy/cache/plans/pln_<id>.v1.md` as a markdown rendering
   of `PlanSpec`.
2. The editor opens that file. The developer edits freely.
3. On editor exit, the markdown is parsed back into `PlanSpec`. Parse
   errors surface inline; the developer is given the choice to re-open
   the file or discard the edits.
4. The resulting spec is written as a new `plan_versions` row.

The markdown format is round-trippable. Front-matter carries the
structured fields:

```markdown
---
title: Add OAuth login flow
status: draft
version: 1
filesToTouch:
  - path: src/auth/oauth.ts
    action: create
    notes: Provider-agnostic OAuth handler
  - path: src/api/login.ts
    action: edit
    notes: Wire the new handler in
testsToAdd:
  - path: src/auth/oauth.test.ts
    description: Happy path + signature validation
outOfScope:
  - Persisting refresh tokens
  - Logout flow
risks:
  - Google may rate-limit on first deploy
---

# Goal

Allow users to sign in with a Google account...

# Approach

1. Add an `OAuthProvider` interface...
```

## Implementation phases

### Phase 1 — schema + repository methods (1 day)

- `src/db/schema-plan.ts` with the two tables.
- Drizzle migration.
- Repository methods on `MemoryRepository`:
  - `createPlan(input)`
  - `getPlan(id, version?)`
  - `listPlans(namespaceId, filter)`
  - `appendPlanVersion(id, content)`
  - `transitionPlan(id, status, metadata)`
- `InMemoryMemoryRepository` implementations (used by tests).

### Phase 2 — markdown round-trip (1 day)

- `src/plan/markdown.ts`: `toMarkdown(spec)` and `fromMarkdown(text)`.
- Properties-based tests under `src/plan/__tests__/markdown.property.test.ts`
  using `fast-check`: round-trip a generated spec, assert structural
  equality.

### Phase 3 — default generator + LLM call (2 days)

- `src/plan/generator.ts`: `DefaultPlanGenerator` calling the existing
  provider layer.
- System prompt lives in `src/plan/prompts/system.md` (templated, not
  inlined as a string).
- Zod validation against `PlanSpec`. One retry on validation failure.
- Tests: mock the provider, assert that malformed JSON triggers a retry
  and that the final fallback opens the editor with the raw output.

### Phase 4 — CLI surface (2 days)

- `src/cli/commands/plan.ts` with all subcommands above.
- Editor integration via Node's `spawn(process.env.EDITOR ?? 'vi', [path])`.
- Coloured output via `picocolors`, status banners via `@clack/prompts`.
- Manual smoke test on macOS + Linux + WSL.

### Phase 5 — MCP tools (1 day)

- `src/mcp/tools/plan.ts` with the four tools listed above.
- Each tool returns content small enough to fit in any reasonable context
  window — the plan is at most ~2-4 KB of text.
- Tests in `src/mcp/tools/plan.test.ts` against the in-memory repository.

### Phase 6 — git completion hook (1 day)

- `src/plan/git.ts`: on `plan complete`, validate the commit SHA exists,
  read its message, attach the message to the plan record.
- Optional `git note` written to the commit linking back to the plan ID.
  Toggled by `.codebuddy/config.json#plan.writeGitNote`.

### Phase 7 — `plan_current` system-prompt snippet (half day)

- `codebuddy plan inject` prints a system-prompt snippet the developer can
  paste into their MCP client's settings:
  > "At the top of every turn, call `plan_current`. If a plan exists, work
  > against the structured spec. If not, ask the developer to write one."
- Documented in `docs/proposals/02-plan-panel.md` (this file) and in the
  README quickstart.

## Open questions

1. **Plan templates**: do we ship a small set of templates (refactor,
   bug fix, feature, spike) that bias the generator? Probably yes, but
   not in v0.2 — too much surface area to design without user signal.
2. **Per-plan recall budget**: when the agent loads `plan_current`, should
   CodeBuddy also auto-recall memory tagged to the plan ID? Useful but
   couples the two surfaces; defer to v0.3 once usage tells us if the
   coupling matters.
3. **Plan acceptance criteria**: should `complete` require all
   `filesToTouch` paths to exist (or not, for deletes)? This is a strong
   guarantee but punishing for plans that genuinely change scope.
   v0.2 warns but does not block.

## Rejected alternatives

- **Plans as markdown files in `.codebuddy/plans/`**: easier to grep, but
  no versioning, no schema validation, no MCP exposure, no way to
  enforce "one active plan." Rejected because the discipline only works
  if the schema is enforced.
- **Plans inside the existing `summary` write type**: piggybacking on
  the memory schema looked tempting (no new tables). Rejected because
  plans have a lifecycle (`approved`, `executing`) that doesn't fit the
  memory model, and recall would surface stale plans as if they were
  facts.
- **Generator as a one-shot LLM call without validation**: validating
  the output against `PlanSpec` adds latency and a retry path, but the
  alternative is shipping malformed plans to the user. The cost is
  worth it.

## Definition of done for v0.2

- `codebuddy plan new "<brief>"` produces a draft plan, opens the editor,
  saves on exit, and `codebuddy plan show <id>` re-renders it.
- `codebuddy plan diff <id> --from 1 --to 2` shows a coloured per-field
  diff.
- `plan_current` returns the active plan (or null) over MCP and is callable
  from Claude Desktop with a registered codebuddy entry.
- A completed plan stores the commit SHA and surfaces it in `plan show`.
- Round-trip property tests pass on 200+ random `PlanSpec`s.
- Status transitions are race-safe under concurrent MCP clients (test:
  spawn two `plan approve` calls against the same plan; exactly one
  succeeds, the other returns a clear conflict error).
