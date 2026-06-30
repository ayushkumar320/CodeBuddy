# Proposal 03 — Risk Panel

Status: In Progress
Owner: @ayushkumar320
Target: v0.2.x
Depends on: Implemented Plan Panel for `filesToTouch` as input.
            Proposal 01 (Architecture Map) only for optional call-graph signals.
            Existing memory layer for prior-incident signals.

## Why this exists

Every coding agent shows the developer two things: a plan and a diff. None
of them show the third thing that matters: what is about to break, where it
is likely to break, and what evidence supports that prediction.

The Risk panel takes a pending change set — explicitly from a Plan, or
implicitly from `git status` — and produces a ranked list of risks with
attribution. Each risk has a score, a reason, and a pointer to the
evidence. It is not an LLM hallucinating about "potential issues."
It is a deterministic, queryable join over the architecture graph, git
history, the memory layer, and a small set of heuristics that any senior
engineer would use during a pre-mortem.

A risk that cannot be explained is not a risk; it is noise. Every entry
this panel produces names its sources.

## Goals

1. Compute a ranked list of risk items for a given change set in under
   one second on a 50k-LOC repo.
2. Every risk item carries: a score (0-100), a category, a one-line
   reason, and a list of evidence rows with file/line citations.
3. Five signal sources, each turn-off-able via configuration:
   call-graph blast radius, git churn velocity, historical incident
   memory, type-error proximity, and policy violations.
4. Expose the result through the SDK, the CLI, and one MCP tool
   (`risk_assess`).
5. The output schema is stable so the eventual workspace UI is a thin
   renderer over identical JSON.

## Non-goals (v0.2)

- Static type analysis. The type-error signal in v0.2 is "does the file
  have a recent type-check failure recorded in CI metadata that we ingest."
  Real type-graph analysis is v0.3.
- ML-based risk prediction. No trained model. The heuristics are explicit
  and reviewable.
- Cross-repository risk. We only consider the current namespace.
- Risk for changes that haven't been described — there must be a Plan,
  a staged diff, or an explicit list of paths.

## User-visible behaviour

```bash
# Risk against the currently approved Plan
codebuddy risk assess

# Risk against a specific Plan
codebuddy risk assess --plan pln_abc123

# Risk against an arbitrary set of paths
codebuddy risk assess --paths src/auth/oauth.ts,src/api/login.ts

# Risk against staged + unstaged changes from git
codebuddy risk assess --git

# Verbose output with evidence
codebuddy risk assess --explain

# Output as JSON for tooling
codebuddy risk assess --json
```

Example output (`--explain`):

```
src/auth/middleware.ts                              score 84  category blast_radius
  47 modules transitively depend on this file
  ↳ src/api/login.ts, src/api/me.ts, src/api/admin.ts, +44 more
  ↳ See `codebuddy map dependents src/auth/middleware.ts`

src/db/repository.ts                                score 71  category churn
  changed 23 times in the last 30 days by 4 authors
  ↳ Last 5 commits: a4f1bb, 8b3290, c10dee, ...
  ↳ Average build pass rate after edits: 62%

src/billing/invoice.ts                              score 65  category incident
  Memory: "Invoice rounding bug in Feb 2026 took 6h to revert" — fact_018b...
  ↳ This file is implicated in 2 prior incidents on record.
```

Through MCP:

```
risk_assess({ planId?, paths?, useGit?, limit? })
  -> { items: RiskItem[]; stats: AssessmentStats }
```

`RiskItem` is the same JSON shape the CLI prints. `AssessmentStats`
includes the per-signal contribution so the UI can show a breakdown.

## Architecture

### Signal sources

Five sources, each implemented as a `Signal` returning a list of
`SignalContribution` records keyed by file path.

```ts
type Signal = {
  id: SignalId;
  enabled: boolean;
  assess(input: AssessmentInput): Promise<SignalContribution[]>;
};

type SignalContribution = {
  path: string;
  weight: number;           // 0-100 within this signal
  reason: string;           // one sentence
  evidence: Evidence[];
};

type Evidence =
  | { kind: "dependent_module"; path: string; depth: number }
  | { kind: "git_commit"; sha: string; message: string; ts: string }
  | { kind: "memory_fact"; factId: string; content: string; createdAt: string }
  | { kind: "ci_failure"; runId: string; conclusion: string; ts: string }
  | { kind: "policy_rule"; ruleId: string; pattern: string };
```

The five signals:

1. **blast_radius** — `getDependents(path, depth=∞)` from the Architecture
   Map. Score = `clip(log2(count) * 20, 0, 100)`. Evidence cites the top
   N dependents.

2. **churn** — git log over the last 30 days for the path. Score weighs
   commit count, author diversity, and post-edit revert ratio.
   Implementation: `git log --follow --since='30 days ago' --format='%H%n%an%n%s' -- <path>`.

3. **incident** — recall against the memory layer with the query
   `"incident OR bug OR revert OR regression near <path>"`. Score is the
   max confidence among returned facts. Evidence cites the fact IDs.

4. **type_failure** — looks for a `ci-failures.json` artefact in
   `.codebuddy/cache/` (populated by an opt-in GitHub Action) and matches
   on path. Score reflects recency and frequency.

5. **policy** — checks each path against rules in
   `.codebuddy/policies.yaml`:

   ```yaml
   rules:
     - id: no-auth-without-review
       pattern: "src/auth/**"
       message: "Auth changes require a second reviewer; flag them."
       weight: 60
     - id: deprecated-module
       pattern: "src/legacy/**"
       message: "Legacy module slated for removal in Q3 2026."
       weight: 30
   ```

   Score is the rule's weight.

### Aggregation

`Assessor` is the orchestrator. It runs each enabled signal in parallel,
then folds per-path contributions:

```
itemScore(path) = clip(
  sum(signal.weight × signal.config.coefficient for signal in signals) / Σ coefficients,
  0,
  100
)
```

Default coefficients in `src/risk/defaults.ts`:

```ts
{
  blast_radius: 1.0,
  churn:        0.7,
  incident:     1.2,   // historical pain is the loudest signal
  type_failure: 0.8,
  policy:       1.0,
}
```

Coefficients are overridable in `.codebuddy/config.json`. Changing them
emits a structured log line so the choice is auditable.

### Data sources

No new tables. Risk reads from:

- `map_modules`, `map_edges` (Proposal 01).
- `facts`, `audit_log` (existing memory layer).
- Git via `child_process.spawn('git', ...)`.
- Optional CI cache at `.codebuddy/cache/ci-failures.json`.

Three derived caches (memoised in `~/.codebuddy/cache/risk/<namespace>/`)
so repeated assessments are cheap:

- `churn-30d.json` — last 30d git churn per path. Invalidated by
  `git diff HEAD~1 --name-only` since last cache build.
- `dependents.json` — flattened transitive dependents map. Invalidated by
  any `map_edges` write.
- `policy-compiled.json` — compiled glob → rule lookup.

### CLI rendering

The CLI groups items by category for the human-readable view and emits
flat JSON for `--json`. Default limit is 10 items; `--limit N` for more.
`--explain` expands every evidence row. Without `--explain` evidence is
collapsed to a count.

## Implementation phases

### Phase 1 — types and signal scaffolding (1 day)

- `src/risk/types.ts`: `Signal`, `SignalContribution`, `Evidence`,
  `RiskItem`, `AssessmentInput`, `AssessmentStats`.
- `src/risk/assessor.ts`: `Assessor` with parallel signal execution and
  aggregation. No signals wired in yet; takes a `signals: Signal[]`
  array so tests can pass in fakes.
- Tests exercise aggregation math against fake signals: ranking,
  coefficient application, clipping at 100, tie-breaking by signal
  diversity.

### Phase 2 — blast_radius signal (1 day)

- `src/risk/signals/blast-radius.ts`. Reads from the Architecture Map.
- Test against a fixture graph (independent of Proposal 01's
  implementation; injected via a `MapReader` interface).
- Special case: a brand-new file (`action: create`) has no inbound edges
  but may be transitively dependent on by the changes the plan describes.
  Solved by treating the plan's filesToTouch as a virtual subgraph.

### Phase 3 — churn signal (1 day)

- `src/risk/signals/churn.ts`. Shell to git.
- Cache to `~/.codebuddy/cache/risk/<ns>/churn-30d.json`.
- Cache invalidation by recording the HEAD sha alongside the cache;
  rebuild if HEAD has moved.

### Phase 4 — incident signal (half day)

- `src/risk/signals/incident.ts`. Uses the existing planner's `recall`
  in `highest_confidence` conflict mode with a focused query template.
- Test against a seeded fact set in the in-memory repository.

### Phase 5 — type_failure signal (1 day)

- `src/risk/signals/type-failure.ts`.
- Schema for `ci-failures.json` documented in
  `docs/proposals/03-risk-panel.md#ci-cache-schema` (below).
- A reference GitHub Action under `examples/ci/type-failures.yml` writes
  the cache. Adoption is opt-in.

### Phase 6 — policy signal (half day)

- `src/risk/signals/policy.ts`.
- `.codebuddy/policies.yaml` parser with Zod validation.
- Glob matching via `micromatch`.

### Phase 7 — CLI + MCP surface (1 day)

- `src/cli/commands/risk.ts` with subcommands listed above.
- `src/mcp/tools/risk.ts` with the single `risk_assess` tool.

### Phase 8 — performance pass (1 day)

- Profile against this repo (a small TS project) and a fixture monorepo
  (synthetic 50k-LOC TS).
- Targets: assessment under 1s on the synthetic monorepo with all signals
  enabled and warm caches; under 5s cold.
- The performance test sits in `src/risk/__perf__/large-repo.test.ts`
  and fails the build on >25% regression.

## CI cache schema

```json
{
  "generatedAt": "2026-06-21T08:21:00Z",
  "head": "a4f1bb3...",
  "failures": [
    {
      "path": "src/auth/oauth.ts",
      "runId": "github-action-12345",
      "conclusion": "type_error",
      "ts": "2026-06-21T08:00:00Z",
      "message": "Type 'string | undefined' is not assignable to 'string'"
    }
  ]
}
```

The reference GitHub Action runs `tsc --noEmit`, parses errors, groups by
path, and writes the JSON to `.codebuddy/cache/ci-failures.json`. The
file is committed (small, line-oriented) so risk assessment works
locally without a network call to GitHub.

## Open questions

1. **Negative-evidence signals**: should we deduct from the score when a
   file has *no* recent churn and *no* dependents? "This file is sleepy"
   is information. v0.2 does not deduct; v0.3 might.
2. **Author-specific risk**: should we surface "the only person who knows
   this code left the company"? Tempting but politically loaded. Not in
   v0.2.
3. **Cross-signal correlation**: a churn signal *and* an incident signal
   on the same path probably deserves more than a linear sum.
   Multiplicative interaction is a v0.3 idea behind a feature flag.
4. **Latency for very large repos**: a 500k-LOC monorepo will exceed
   the 1s target. The fallback is to compute risk only for paths in the
   change set's transitive 2-hop neighbourhood, not the whole graph. The
   schema accommodates this; the CLI ships with `--neighbourhood-only`
   off by default.

## Rejected alternatives

- **One signal: "ask the LLM if this is risky"**. The whole point of this
  panel is determinism and evidence. An LLM-judged risk score with no
  citations is exactly the kind of magic the workspace exists to remove.
- **Embed risk in the Plan generator output**. Plans should be intent;
  risk is an analysis of consequences. Coupling them means a risky plan
  cannot be discussed without re-running the generator.
- **Compute risk only at commit time (a pre-commit hook)**. Useful but
  late. The whole value is showing risk *before* the developer approves
  the plan. Pre-commit risk lives in a separate proposal.

## Definition of done for v0.2

- `codebuddy risk assess --plan <id>` produces ranked output on a plan
  in this repo with all five signals enabled.
- Output is deterministic given the same inputs and cache state.
- `--json` output validates against a published JSON schema in
  `docs/schemas/risk-item.json`.
- `risk_assess` is exposed over MCP and callable from Claude Desktop.
- Performance test passes within budget on the synthetic monorepo.
- Adding a fact tagged as an incident causes the affected file to gain
  risk score on the next assessment, with the fact ID surfaced as
  evidence.
- Toggling a signal off in config removes its contribution from both
  the score and the evidence list.
