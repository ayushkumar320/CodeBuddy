# Proposal 02 — Plan Panel

Status: Draft (revised — markdown-first)
Owner: @ayushkumar320
Target: v0.2.0
Depends on: Proposal 00 (Storage Model). Independent of 01 and 03.
Supersedes: the Postgres-first version of this doc previously at
            commit `34b65df`. Plans now live as markdown files;
            Postgres holds an index only.

## Why this exists

The default interface for telling an AI "do X" is a chat prompt. The model
inflates the prompt into an implicit plan, executes it, and the only artifact
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

Per Proposal 00, plans live as markdown files committed to git. The database
holds a derived index for fast filtering, not the plan content itself.

## Goals

1. Plans are markdown files under `.codebuddy/plans/`. One file per plan.
   Front-matter carries the structured fields; the body carries the prose
   goal and approach.
2. Plans are versioned by **git**, not by an in-database version column. A
   plan's history is `git log .codebuddy/plans/pln_<id>.md`.
3. Plans have an explicit lifecycle: `draft → approved → executing →
   complete | abandoned`. The current status is the `status:` field in the
   front-matter; transitions rewrite the file atomically.
4. Plans are addressable through MCP so any agent in any MCP-aware client
   can `plan_current` at the top of every turn and never lose context.
5. The plan generator is pluggable — `DefaultPlanGenerator` calls the LLM
   provider, but a project can ship a custom generator (e.g., one that
   refuses to write plans that touch `auth/`).
6. Concurrent transitions are race-safe via filesystem locks
   (`proper-lockfile`), not row-level Postgres locks.

## Non-goals (v0.2)

- No "auto-execute" mode. The plan describes intent; execution happens in
  whichever editor or MCP client the developer is using. CodeBuddy never
  edits files directly in this proposal.
- No UI in v0.2. The plan is created and edited through the CLI and the
  developer's text editor (`$EDITOR`). The workspace UI consumes the same
  files later; nothing in the schema is UI-specific.
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
codebuddy plan list                          # active + last 10 closed
codebuddy plan list --status approved
codebuddy plan list --all

# Show a single plan
codebuddy plan show <id>
codebuddy plan show <id> --version <commit-sha>

# Compare versions via git
codebuddy plan diff <id> --from HEAD~3 --to HEAD

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
  -> { plan: PlanSpec | null }            // the file with 'approved' or 'executing' status

plan_create({ brief, agentId? })
  -> { id, path, status: 'draft' }

plan_amend({ id, patch, agentId? })
  -> { id, path, status }                  // rewrites the file atomically

plan_status({ id, status, commitSha?, notes? })
  -> { id, path, status }                  // transitions through the lifecycle
```

`plan_current` is the load-bearing one. An agent's system prompt instructs
it to call this at the top of every turn. If a plan exists, the agent works
against the structured spec. If not, the agent prompts the developer to
write one before substantive code changes.

## Architecture

### File layout

```
<repo>/
└── .codebuddy/
    └── plans/
        ├── pln_01jc4ww4n6q7g3kc8x9wq4kfn2.md
        ├── pln_01jc4xa7k8m1...md
        └── .locks/                       # transient; gitignored
            └── pln_01jc4ww4n6q7g3kc8x9wq4kfn2.md.lock
```

`.locks/` is created on demand by `proper-lockfile` and added to the
gitignore generated by `codebuddy init`. Lock files are stale-collected
after 30 seconds.

### Plan file format

```markdown
---
id: pln_01jc4ww4n6q7g3kc8x9wq4kfn2
namespace: pathway
title: Add OAuth login flow
status: draft
brief: "Add OAuth login flow with Google as the first provider"
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
createdAt: 2026-06-21T08:21:00Z
createdByAgent: claude
approvedAt: null
executingAt: null
completedAt: null
abandonedAt: null
commitSha: null
abandonReason: null
---

# Goal

Allow users to sign in with a Google account so we can onboard the first
private-preview cohort without standing up our own credential store.

# Approach

1. Introduce `OAuthProvider` interface in `src/auth/oauth.ts` with
   `start()`, `callback()`, `validate()`.
2. Implement Google via `@google/oauth-handler`.
3. Mount `/oauth/google/start` and `/oauth/google/callback` in
   `src/api/login.ts`.
4. Persist user sessions in the existing `sessions` table (no schema
   change).
5. Add fixture-based tests for the happy path and signature mismatch.

# Notes

(developer-written; freeform; ignored by tooling)
```

Properties:

- `id` is a ULID and is **the filename minus extension**. Renaming the file
  is a non-event; the `id` is canonical.
- `status` is the source of truth for lifecycle state. The other
  `*At` fields are timestamps that get filled in as transitions happen.
- Front-matter is parsed with `gray-matter`, validated with Zod. Invalid
  files surface as errors; they are not silently coerced.
- The H1 section names (`Goal`, `Approach`, `Notes`) are conventions, not
  required structure. The CLI's `plan show` highlights them.

### TypeScript types

```ts
type PlanSpec = {
  id: string;
  namespace: string;
  title: string;
  status: "draft" | "approved" | "executing" | "complete" | "abandoned";
  brief: string;

  filesToTouch: PlannedFile[];
  testsToAdd: PlannedTest[];
  outOfScope: string[];
  risks: string[];

  createdAt: string;          // ISO 8601
  createdByAgent: string | null;
  approvedAt: string | null;
  executingAt: string | null;
  completedAt: string | null;
  abandonedAt: string | null;
  commitSha: string | null;
  abandonReason: string | null;

  // body of the markdown file, after front-matter
  body: string;
};

type PlannedFile = {
  path: string;
  action: "create" | "edit" | "delete";
  notes: string;
};

type PlannedTest = {
  path: string;
  description: string;
};
```

### Database role

Per Proposal 00, the DB holds a derived index, not the plan content.

```sql
create table plan_index (
  id              text primary key,             -- pln_<ulid>
  namespace_id    text not null references namespaces(id) on delete cascade,
  path            text not null,                -- repo-relative .md path
  status          text not null,
  title           text not null,
  brief           text not null,
  created_at      timestamptz not null,
  approved_at     timestamptz,
  executing_at    timestamptz,
  completed_at    timestamptz,
  abandoned_at    timestamptz,
  commit_sha      text,
  file_hash       text not null,                -- sha256 of file content
  indexed_at      timestamptz not null default now(),
  index (namespace_id, status, created_at desc),
  index (namespace_id, commit_sha)
);
```

Reasoning:

- `plan_index` is rebuildable by walking `.codebuddy/plans/*.md` and
  parsing each file. The `reindex` contract from Proposal 00 covers it.
- `file_hash` makes incremental reindex cheap — unchanged file ⇒ skip.
- "One active plan per namespace" is enforced by querying this table
  before transitioning, not by a Postgres constraint. The check holds the
  filesystem lock during the read-then-write window.

The `plan_versions` table from the previous draft is removed. Version
history is `git log`.

### Lifecycle and concurrency

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

- `draft` and `executing` can both be amended.
- Amending rewrites the file with new front-matter; git stores the diff.
- Transitions acquire a lock on `.codebuddy/plans/.locks/<id>.md.lock`
  via `proper-lockfile`, then read-modify-write atomically (write to
  `.tmp`, `fsync`, `rename`).
- A second concurrent transition waits on the lock; if it can't acquire
  within 5 seconds it fails fast with a clear error.

Approving a plan requires no other plan in this namespace to be in
`approved` or `executing`. The check happens inside the lock window.
Same for transitioning `draft → executing`.

### Generator

```ts
type PlanGenerator = {
  generate(input: PlanGenerateInput): Promise<DraftPlan>;
  amend(input: PlanAmendInput): Promise<DraftPlan>;
};

type PlanGenerateInput = {
  namespace: string;
  brief: string;
  recentMemory: PlannedContext;    // pulled from CodeBuddy's recall
  repoSnapshot?: RepoSnapshot;     // optional, lands with Proposal 01
};
```

`DefaultPlanGenerator` calls the configured LLM provider with a system
prompt that requires the model to return a JSON object matching the
front-matter schema. Output is validated with Zod; malformed output is
rejected and retried once with the validation error appended to the
prompt. After two failures the user is shown the raw output and asked
to edit the file manually.

Generator config in `.codebuddy/config.json`:

```json
{
  "plan": {
    "generator": "default",
    "model": "meta-llama/Llama-3.2-3B-Instruct",
    "maxFiles": 20
  }
}
```

### CLI integration

Flow for `plan new`:

1. Generator produces a draft `PlanSpec`.
2. CLI writes `.codebuddy/plans/pln_<id>.md` with `status: draft`.
3. Updates `plan_index`.
4. Opens `$EDITOR` (defaulting to `vi`) on the file.
5. On editor exit, re-parses the file with Zod. Parse errors surface
   inline; the developer can re-open the file or discard.
6. Re-runs the reindex for that single file.

`approve`, `complete`, `abandon`, `amend` all:

1. Acquire the file lock.
2. Read the current file.
3. Validate front-matter.
4. Mutate the relevant fields + timestamps.
5. Write atomically (tmp + rename).
6. Update `plan_index`.
7. Release the lock.

## Implementation phases

### Phase 1 — schema + readers (1 day)

- `src/db/schema-plan.ts` with the single `plan_index` table.
- Drizzle migration.
- `src/plan/repository.ts`: file walker + reader. Returns `PlanSpec[]`.
- `InMemoryPlanRepository` for tests (returns whatever was registered).
- Repository methods:
  - `listPlans(namespaceId, filter)`
  - `getPlan(id)`
  - `findByStatus(namespaceId, status[])`
  - `reindexPath(path)` — single-file reindex of the index table

### Phase 2 — front-matter round-trip (1 day)

- `src/plan/markdown.ts`: `toMarkdown(spec)` and `fromMarkdown(text)`.
- `gray-matter` for parsing, custom serializer for stability (yaml-stringify
  with sorted keys so git diffs are minimal).
- Property tests under `src/plan/__tests__/markdown.property.test.ts`
  using `fast-check`: round-trip a generated spec, assert structural
  equality with the original.

### Phase 3 — file lock + atomic write (half day)

- `src/plan/storage.ts`: `withPlanLock(id, fn)` wrapping `proper-lockfile`.
- `writePlanFile(spec)`: lock + tmp + fsync + rename.
- Tests: spawn N concurrent transitions in-process; assert only one
  succeeds, others get a clear conflict error.

### Phase 4 — default generator (2 days)

- `src/plan/generator.ts`: `DefaultPlanGenerator` calling the existing
  provider layer.
- System prompt in `src/plan/prompts/system.md` (templated file, not
  inline string).
- Zod validation against the front-matter schema. One retry on
  validation failure with the schema error appended.
- Tests: mock the provider, assert that malformed JSON triggers a retry
  and that the final fallback opens the editor with the raw output
  preserved.

### Phase 5 — CLI surface (2 days)

- `src/cli/commands/plan.ts` with all subcommands above.
- Editor integration via `spawn(process.env.EDITOR ?? 'vi', [path])`.
- Coloured output via `picocolors`, status banners via `@clack/prompts`.
- `plan diff <id>` shells to `git diff` against the plan file.
- Manual smoke test on macOS + Linux + WSL.

### Phase 6 — MCP tools (1 day)

- `src/mcp/tools/plan.ts` with the four tools listed above.
- Tools return `PlanSpec` shape; body included up to 8 KB (truncated
  with a marker beyond that).
- Tests in `src/mcp/tools/plan.test.ts` against the in-memory repository.

### Phase 7 — git completion hook (1 day)

- `src/plan/git.ts`: on `plan complete`, validate the commit SHA
  exists, read its message, attach it to the plan front-matter.
- Optional `git note add --ref=codebuddy-plan` linking the commit back
  to the plan id. Toggled by `.codebuddy/config.json#plan.writeGitNote`.

### Phase 8 — `plan_current` system-prompt snippet (half day)

- `codebuddy plan inject` prints a system-prompt snippet the developer
  can paste into their MCP client's settings:
  > "At the top of every turn, call `plan_current`. If a plan exists,
  > work against the structured spec. If not, ask the developer to
  > write one."
- Documented in this proposal and in the README quickstart.

## Open questions

1. **Plan templates**: do we ship a small set of templates (refactor,
   bug fix, feature, spike) that bias the generator? Probably yes, but
   not in v0.2 — too much surface area to design without user signal.
2. **Per-plan recall budget**: when the agent loads `plan_current`,
   should CodeBuddy also auto-recall memory tagged to the plan ID?
   Useful but couples the two surfaces; defer to v0.3.
3. **Plan acceptance criteria**: should `complete` require all
   `filesToTouch` paths to exist (or not, for deletes)? Strong
   guarantee but punishing for plans that genuinely change scope.
   v0.2 warns but does not block.
4. **Should the body section be free-form markdown or sub-fielded?**
   Free-form for v0.2. If the workspace UI grows to render the body in
   a structured way later, we add optional sub-sections behind heading
   conventions (`# Goal`, `# Approach`, `# Notes`) and keep
   backward-compat.

## Rejected alternatives

- **Plans as Postgres rows** (the previous draft of this doc). Loses
  reviewability in PRs, breaks compatibility with the CLAUDE.md
  ecosystem, makes the database load-bearing for user-authored content.
  Superseded by Proposal 00.
- **One markdown file per plan version**. Considered. Rejected because
  `git log` already gives us version history without proliferating
  files, and listing plans becomes painful with N×V files instead of N.
- **JSON files instead of markdown**. Machine-cleaner but hostile to
  humans editing in their editor and unfriendly to GitHub's renderer.
  Markdown with YAML front-matter is the de facto standard for this
  kind of thing.
- **One generator output, no validation/retry**. Validating costs
  latency and adds a retry path; the alternative is shipping malformed
  files to the user. Worth the cost.

## Definition of done for v0.2

- `codebuddy plan new "<brief>"` produces a draft markdown file under
  `.codebuddy/plans/`, opens the editor, saves on exit, and
  `codebuddy plan show <id>` re-renders it from the file.
- `codebuddy plan diff <id>` shells to `git diff` and shows a coloured
  diff between versions of the plan file.
- `plan_current` returns the active plan (or null) over MCP and is
  callable from Claude Desktop with a registered codebuddy entry.
- A completed plan stores the commit SHA in its front-matter and
  surfaces it in `plan show`.
- Round-trip property tests pass on 200+ random `PlanSpec`s.
- Status transitions are race-safe under concurrent MCP clients:
  spawn two `plan approve` calls against the same plan; exactly one
  succeeds, the other returns a clear conflict error within 5 seconds.
- Wiping the database and running `codebuddy reindex` rebuilds
  `plan_index` from the files; subsequent `plan list` returns the
  same results as before the wipe.
